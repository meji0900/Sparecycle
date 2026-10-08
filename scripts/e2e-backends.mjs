#!/usr/bin/env node
// Sparecycle backend test on REAL hardware (no chain): text jobs on non-NVIDIA GPUs and the like-for-like pairing rule.
//
//   node scripts/e2e-backends.mjs [--prompts 6] [--max-tokens 128]
//
// Needs node-client/bin/llama-vulkan and node-client/bin/llama-cpu plus the Qwen GGUF in node-client/models
// (install.ps1 -Backend vulkan / -Backend cpu, or install.sh --backend …).
//
//  1. scheduler (`next dev` on 127.0.0.1:3230) from a throw-away copy of the app, scheduler-local epochs, scratch DB
//  2. two `--backend vulkan` nodes on this machine's GPU (distinct test owners and GPU-UUID overrides); submit the
//     text prompts; report agreement rate, tokens/s and per-job time from the nodes' own llama.cpp timings
//  3. pairing: one cuda dev-runner node joins -> an image job must stay queued (no CUDA peer) and never reach a Vulkan
//     node; a second cuda dev-runner node joins -> the image job agrees on the CUDA pair; no job ever has results
//     from two different backends (checked in the scratch DB)
//  4. nodes stopped; the same prompts run through llama-server Vulkan and CPU directly; Vulkan-vs-CPU similarity with
//     the scheduler's own textSimilarity (informational: the pairing rule stays like-for-like regardless)
// The anvil keys below are public dev keys, used here only to sign local owner-link messages. No chain is involved.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3230;
const SITE = `http://127.0.0.1:${PORT}`;
const API = `${SITE}/api/v1`;
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const N_PROMPTS = Number(opt("prompts", "6"));
const MAX_TOKENS = Number(opt("max-tokens", "128"));
const KEYS = [
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // anvil 2
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // anvil 3
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // anvil 4
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // anvil 5
];
const PROMPTS = [
  { system: "Be concise.", prompt: "Explain in three sentences why the sky looks blue." },
  { system: "", prompt: "Write a haiku about a graphics card that works at night." },
  { system: "You are a helpful assistant.", prompt: "List five practical tips for saving electricity at home." },
  { system: "", prompt: "What is a Merkle tree? Answer for a beginner." },
  { system: "Answer in one paragraph.", prompt: "Summarize the plot of Romeo and Juliet." },
  { system: "", prompt: "Write a short Python function that returns the n-th Fibonacci number, with a docstring." },
  { system: "", prompt: "Give three reasons people keep houseplants." },
  { system: "Be precise.", prompt: "Convert 72 degrees Fahrenheit to Celsius and show the formula." },
].slice(0, N_PROMPTS);

const RUN_DIR = join(ROOT, "data", `backends-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const APP_DIR = join(RUN_DIR, "app");
const DB = join(RUN_DIR, "sparecycle.db");
const t0 = Date.now();
const log = (m) => console.log(`[backends ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`assertion failed: ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
function start(name, cmd, args, opts = {}) {
  const out = createWriteStream(join(RUN_DIR, `${name}.log`));
  const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
  return child;
}
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    /* gone */
  }
}
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const c of children.reverse()) killTree(c);
  try {
    rmSync(APP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* best effort */
  }
}
process.on("exit", cleanup);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => (cleanup(), process.exit(130)));

async function waitFor(label, fn, timeoutMs, intervalMs = 1000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, data: type.includes("json") ? await res.json() : await res.text() };
}
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|SPARECYCLE_)/.test(k) || ["DB_PATH", "PAYOUT_CAP_PER_UNIT", "JOB_RATE_LIMIT", "NODE_OPTIONS"].includes(k)) continue;
    env[k] = v;
  }
  return { ...env, NEXT_TELEMETRY_DISABLED: "1", ...extra };
}
const db = () => new DatabaseSync(DB, { readOnly: true });
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : "n/a");
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

async function startNode(name, ownerKey, backend, { dev = false, uuid }) {
  const agent = join(ROOT, "node-client", "src", "agent.ts");
  const keyFile = join(RUN_DIR, `${name}-key.json`);
  spawnSync(process.execPath, [agent, "init", "--key-file", keyFile], { cwd: ROOT, encoding: "utf8" });
  const nodeKey = privateKeyToAccount(JSON.parse(readFileSync(keyFile, "utf8")).privateKey).address;
  const owner = privateKeyToAccount(ownerKey);
  const sig = await owner.signMessage({ message: `Sparecycle: link node ${nodeKey.toLowerCase()} to wallet ${owner.address.toLowerCase()}` });
  const args = [agent, "start", "--network", SITE, "--owner", owner.address, "--owner-sig", sig, "--backend", backend, "--key-file", keyFile];
  if (dev) args.push("--dev-runner");
  start(name, process.execPath, args, { env: cleanEnv({ SPARECYCLE_GPU_UUID: uuid }) });
  return { name, nodeKey, owner: owner.address, backend, dev };
}

/** Per-job lines of a node log: "text job 0x12345678 done in 3.2 s · 128 tok at 40.1 tok/s -> agreed". */
function nodeJobStats(name) {
  const text = existsSync(join(RUN_DIR, `${name}.log`)) ? readFileSync(join(RUN_DIR, `${name}.log`), "utf8") : "";
  const out = [];
  for (const m of text.matchAll(/text job (0x[0-9a-f]{8}) done in ([\d.]+) s(?: · (\d+) tok(?: at ([\d.]+) tok\/s)?)? -> (\S+)/g)) {
    out.push({ job: m[1], seconds: Number(m[2]), tokens: m[3] ? Number(m[3]) : null, tps: m[4] ? Number(m[4]) : null, verdict: m[5] });
  }
  return out;
}

async function main() {
  mkdirSync(RUN_DIR, { recursive: true });
  log(`run dir ${RUN_DIR}`);
  const nc = join(ROOT, "node-client");
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  check("llama.cpp Vulkan and CPU builds + GGUF installed", ["vulkan", "cpu"].every((b) => existsSync(join(nc, "bin", `llama-${b}`, exe))) && existsSync(join(nc, "models", "qwen2.5-1.5b-instruct-q4_k_m.gguf")));
  const { textFingerprint, textSimilarity, TEXT_MIN_SIMILARITY } = await srcImport("server/verify.ts");
  const { TextRunner } = await import(pathToFileURL(join(nc, "src", "runners.ts")).href);

  // ---- 1. scheduler -------------------------------------------------------------------------------------------
  mkdirSync(APP_DIR, { recursive: true });
  for (const f of ["src", "public", "next.config.ts", "tsconfig.json", "package.json", "postcss.config.mjs"]) {
    if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(APP_DIR, f), { recursive: true });
  }
  start("next", process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: APP_DIR,
    env: cleanEnv({ NEXT_PUBLIC_NETWORK: "local", NEXT_PUBLIC_EPOCH_LENGTH: "86400", DB_PATH: DB, SCHEDULER_ALLOW_DEV_RUNNER: "1", JOB_RATE_LIMIT: "100", SCHEDULER_ADMIN_TOKEN: "test" }),
  });
  await waitFor("scheduler health", async () => (await api("GET", "/health")).data?.ok === true, 180_000);
  check("scheduler up", true, SITE);

  // ---- 2. two Vulkan nodes on this GPU ------------------------------------------------------------------------
  const vkA = await startNode("vulkan-a", KEYS[0], "vulkan", { uuid: "TEST-VULKAN-A" });
  const vkB = await startNode("vulkan-b", KEYS[1], "vulkan", { uuid: "TEST-VULKAN-B" });
  await waitFor("two vulkan nodes online", async () => (await api("GET", "/nodes")).data.nodes.filter((n) => n.backend === "vulkan" && n.online).length === 2, 120_000);
  const nodes = (await api("GET", "/nodes")).data.nodes;
  check("vulkan nodes registered text-only", nodes.every((n) => n.backend === "vulkan" && JSON.stringify(n.caps) === JSON.stringify(["text:qwen2.5-1.5b"])), nodes.map((n) => n.gpu).join(" | "));
  const st = (await api("GET", "/status")).data;
  check("status counts nodes per backend", st.nodes.byBackend?.vulkan?.registered === 2 && st.nodes.byBackend?.cuda?.registered === 0, JSON.stringify(st.nodes.byBackend));

  const jobIds = [];
  const tSubmit = Date.now();
  for (const p of PROMPTS) {
    const r = await api("POST", "/jobs", { kind: "text", params: { model: "qwen2.5-1.5b", prompt: p.prompt, system: p.system, maxTokens: MAX_TOKENS } });
    if (r.status !== 201) throw new Error(`submit failed: ${JSON.stringify(r.data)}`);
    jobIds.push(r.data.id);
  }
  log(`submitted ${jobIds.length} text jobs (maxTokens ${MAX_TOKENS}); waiting for both Vulkan nodes…`);
  await waitFor("all text jobs decided", async () => {
    const js = (await api("GET", "/jobs?limit=100")).data.jobs.filter((j) => jobIds.includes(j.id));
    return js.length === jobIds.length && js.every((j) => ["agreed", "disagreed", "expired", "rejected"].includes(j.status));
  }, 30 * 60_000, 2000);
  const wall = (Date.now() - tSubmit) / 1000;
  const decided = (await api("GET", "/jobs?limit=100")).data.jobs.filter((j) => jobIds.includes(j.id));
  const agreed = decided.filter((j) => j.status === "agreed");
  const stats = [...nodeJobStats("vulkan-a"), ...nodeJobStats("vulkan-b")].filter((s) => jobIds.some((id) => id.startsWith(s.job)));
  const tps = stats.map((s) => s.tps).filter((x) => x !== null);
  const secs = stats.map((s) => s.seconds);
  const vkOutputs = {};
  for (const id of jobIds) {
    const r = await api("GET", `/jobs/${id}/output`);
    if (r.status === 200) vkOutputs[id] = r.data;
  }
  const measured = {
    jobs: jobIds.length,
    agreed: agreed.length,
    agreement: pct(agreed.length, jobIds.length),
    wallSeconds: wall.toFixed(1),
    perTask: stats.map((s) => ({ job: s.job, seconds: s.seconds, tokens: s.tokens, tokPerSec: s.tps })),
    medianTokPerSec: median(tps).toFixed(1),
    medianSecondsPerTask: median(secs).toFixed(1),
  };
  log(`VULKAN (2 nodes sharing one iGPU): ${JSON.stringify({ ...measured, perTask: undefined })}`);
  for (const s of measured.perTask) log(`  task ${s.job}: ${s.seconds} s, ${s.tokens} tok, ${s.tokPerSec} tok/s`);
  check("every Vulkan text job reached a verdict", decided.length === jobIds.length);

  // ---- 3. pairing with CUDA (dev-runner) nodes ----------------------------------------------------------------
  const cudaA = await startNode("cuda-dev-a", KEYS[2], "cuda", { dev: true, uuid: "TEST-CUDA-A" });
  await waitFor("cuda dev node online", async () => (await api("GET", "/nodes")).data.nodes.some((n) => n.nodeKey === cudaA.nodeKey && n.online), 60_000);
  const img = await api("POST", "/jobs", { kind: "image", params: { model: "sd15", prompt: "a lighthouse", width: 256, height: 256, steps: 10 } });
  const extraText = [];
  for (let i = 0; i < 2; i++) {
    const r = await api("POST", "/jobs", { kind: "text", params: { model: "qwen2.5-1.5b", prompt: `Name a color, test ${i}.`, maxTokens: 16 } });
    extraText.push(r.data.id);
  }
  await sleep(20_000);
  const imgNow = (await api("GET", `/jobs/${img.data.id}`)).data;
  check("image job with one CUDA node stays queued (no CUDA peer)", imgNow.status === "queued", imgNow.status);
  {
    const d = db();
    const vkKeys = [vkA.nodeKey, vkB.nodeKey];
    const leasedToVk = d.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE job_id = ? AND node_key IN (?, ?)`).get(img.data.id, ...vkKeys).n;
    d.close();
    check("image job never assigned to a Vulkan node", leasedToVk === 0);
  }
  const cudaB = await startNode("cuda-dev-b", KEYS[3], "cuda", { dev: true, uuid: "TEST-CUDA-B" });
  await waitFor("image job agreed on the CUDA pair", async () => (await api("GET", `/jobs/${img.data.id}`)).data.status === "agreed", 120_000);
  await waitFor("extra text jobs decided", async () => {
    const js = await Promise.all(extraText.map(async (id) => (await api("GET", `/jobs/${id}`)).data.status));
    return js.every((s) => ["agreed", "disagreed"].includes(s));
  }, 10 * 60_000, 2000);
  {
    const d = db();
    const pairs = d
      .prepare(`SELECT r.job_id AS job, j.kind AS kind, GROUP_CONCAT(r.backend || '/' || r.dev, ',') AS classes, COUNT(*) AS n FROM results r JOIN jobs j ON j.id = r.job_id GROUP BY r.job_id`)
      .all();
    const imgRows = d.prepare(`SELECT r.backend AS backend, n.backend AS nodeBackend FROM results r JOIN nodes n ON n.node_key = r.node_key WHERE r.job_id = ?`).all(img.data.id);
    d.close();
    const mixed = pairs.filter((p) => p.n === 2 && new Set(p.classes.split(",")).size !== 1);
    check("no job ever paired two different backends (or dev with real)", mixed.length === 0, `${pairs.filter((p) => p.n === 2).length} paired jobs checked`);
    check("image job ran on two CUDA nodes", imgRows.length === 2 && imgRows.every((r) => r.backend === "cuda" && r.nodeBackend === "cuda"));
  }
  const vkNodesOnImage = [vkA, vkB].some((n) => readFileSync(join(RUN_DIR, `${n.name}.log`), "utf8").includes("image job"));
  check("Vulkan node logs never show an image job", !vkNodesOnImage);
  void cudaB;

  // ---- 4. Vulkan vs CPU, same prompts, direct llama-server runs ------------------------------------------------
  for (const c of children.slice(1)) killTree(c); // stop the nodes, keep the scheduler for nothing else
  await sleep(2000);
  const say = (m) => log(`  ${m}`);
  const runAll = async (backend) => {
    const r = new TextRunner(backend);
    const outs = [];
    try {
      for (const p of PROMPTS) {
        const t = Date.now();
        const o = await r.run({ model: "qwen2.5-1.5b", prompt: p.prompt, system: p.system, maxTokens: MAX_TOKENS }, say);
        outs.push({ ...o, wallMs: Date.now() - t });
      }
    } finally {
      r.stop();
    }
    return outs;
  };
  log("direct runs: Vulkan (alone on the iGPU)…");
  const vk = await runAll("vulkan");
  log("direct runs: CPU…");
  const cpu = await runAll("cpu");
  const rows = PROMPTS.map((p, i) => {
    const simVkCpu = textSimilarity(textFingerprint(vk[i].text), textFingerprint(cpu[i].text));
    const sched = vkOutputs[jobIds[i]];
    const simVkSched = typeof sched === "string" ? textSimilarity(textFingerprint(vk[i].text), textFingerprint(sched)) : null;
    return {
      prompt: p.prompt.slice(0, 48),
      vkTokPerSec: vk[i].tokensPerSecond?.toFixed(1),
      cpuTokPerSec: cpu[i].tokensPerSecond?.toFixed(1),
      vkSeconds: (vk[i].gpuMs / 1000).toFixed(1),
      cpuSeconds: (cpu[i].gpuMs / 1000).toFixed(1),
      simVulkanCpu: simVkCpu.toFixed(3),
      wouldAgree: simVkCpu >= TEXT_MIN_SIMILARITY,
      identical: vk[i].text === cpu[i].text,
      simVulkanVsScheduledVulkan: simVkSched === null ? "n/a" : simVkSched.toFixed(3),
    };
  });
  console.table(rows);
  const summary = {
    vulkanPair: { agreement: measured.agreement, medianTokPerSec: measured.medianTokPerSec, medianSecondsPerTask: measured.medianSecondsPerTask, wallSeconds: measured.wallSeconds },
    vulkanAlone: { medianTokPerSec: median(vk.map((o) => o.tokensPerSecond ?? NaN)).toFixed(1) },
    cpu: { medianTokPerSec: median(cpu.map((o) => o.tokensPerSecond ?? NaN)).toFixed(1) },
    vulkanVsCpu: {
      wouldAgree: `${rows.filter((r) => r.wouldAgree).length}/${rows.length}`,
      identical: `${rows.filter((r) => r.identical).length}/${rows.length}`,
      minSimilarity: Math.min(...rows.map((r) => Number(r.simVulkanCpu))).toFixed(3),
      medianSimilarity: median(rows.map((r) => Number(r.simVulkanCpu))).toFixed(3),
    },
  };
  log(`SUMMARY ${JSON.stringify(summary)}`);
  check("measurements collected", rows.length === PROMPTS.length);
}

let failed = null;
try {
  await main();
} catch (e) {
  failed = e;
  log(`ERROR: ${e?.stack ?? e}`);
}
cleanup();
console.log(`\nchecks passed: ${results.filter((r) => r.ok).length}/${results.length}`);
console.log(`logs and scratch DB: ${RUN_DIR}`);
console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
