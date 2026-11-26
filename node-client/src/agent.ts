// Portions derived from https://github.com/idlexnetwork/idlex (MIT License, Copyright (c) 2026 Idlex) — see NOTICE.
//
// Sparecycle node: the program a GPU owner runs to take part in the network.
//
//   node src/agent.ts init                                   create the node key (~/.sparecycle-node/key.json)
//   node src/agent.ts link-message --owner 0xWALLET          print the message the owner wallet signs (no gas)
//   node src/agent.ts start --network <url> --owner 0x… --owner-sig 0x…
//        [--backend cuda|vulkan|cpu] [--hours 1-8,22-24] [--no-image] [--no-text] [--dev-runner] [--key-file path]
//   node src/agent.ts bench [--backend cuda|vulkan|cpu] [--out folder] [--repeat 2] [--no-image] [--no-text]
//        fixed jobs, outputs saved locally, nothing sent: compare devices with scripts/compare-bench.mjs
//
// --backend: cuda (default, NVIDIA: image + text), vulkan (any Vulkan GPU incl. AMD / Intel iGPUs) or cpu: text
// jobs only, via llama.cpp. A job's two copies always run on nodes with the same backend.
//
// The node key only signs scheduler requests and job receipts. The owner wallet (linked once with a signature)
// is the account in the payout Merkle tree, so this program never needs the owner's private key.
// --dev-runner: synthetic outputs with no GPU, for local end-to-end tests only (never paid on a real network).
import { getAddress, isAddress, verifyMessage, type Address, type Hex, type LocalAccount } from "viem";
import {
  BACKENDS,
  capabilityTagsFor,
  CHALLENGE_FEATURE,
  isBackend,
  linkMessage,
  MODELS,
  requestNonce,
  sha256Hex,
  signChallengeResult,
  signReceipt,
  signRequest,
  validateSpec,
  type Backend,
  type JobSpec,
} from "#protocol";
import { DEFAULT_KEY_FILE, loadKey, loadOrCreateKey } from "#keys";
import { gpuBusyOrHot, inHours, parseHours, probeDevice, probeDeviceInfo, sharedMemoryMb, simulatedPause, type Gpu } from "#gpu";
import { currentState, heartbeatBody, heartbeatDue, pauseSleepMs, STATE_TEXT, type GpuPause, type NodeState, type Sent } from "#idle-guard";
import { ImageRunner, TextRunner } from "#runners";
import { DEV_BANNER, devImage, devText } from "#dev-runner";
import { bench } from "#bench";

// 0.3.0: device info + GPU challenge support at registration. 0.4.0: Idle Guard heartbeat (the node reports active /
// paused and why, as a code only). Inference settings are unchanged since 0.2.0 (llama.cpp -ub 1, same models and
// runtimes), so 0.2.0, 0.3.0 and 0.4.0 nodes produce the same outputs and pair normally.
const VERSION = "sparecycle-node/0.4.0";

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const flag = (name: string) => argv.includes(`--${name}`);
const say = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      r();
    });
  });

/** "https://host" or "https://host/api/v1" -> "https://host/api/v1". */
export function apiBase(network: string): string {
  const u = new URL(network);
  const base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

type CallResult = { status: number; data: Record<string, unknown> | null };

async function call(account: LocalAccount, base: string, suffix: string, body: unknown, signal?: AbortSignal): Promise<CallResult> {
  const url = base + suffix;
  const text = JSON.stringify({ ...(body as Record<string, unknown> | undefined), nonce: requestNonce() });
  const headers = await signRequest(account, "POST", new URL(url).pathname, text);
  const timeout = AbortSignal.timeout(120_000);
  const res = await fetch(url, { method: "POST", headers, body: text, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const data = res.status === 204 ? null : ((await res.json().catch(() => null)) as Record<string, unknown> | null);
  return { status: res.status, data };
}

const errText = (r: CallResult) => `${r.status} ${String(r.data?.error ?? "")}${r.data?.message ? `: ${String(r.data.message)}` : ""}`;

type StartOptions = {
  network: string;
  keyFile: string;
  owner: Address;
  ownerSig: Hex;
  hours: [number, number][] | null;
  image: boolean;
  text: boolean;
  dev: boolean;
  backend: Backend;
};

async function start(opts: StartOptions) {
  const account = loadKey(opts.keyFile);
  if (!account) throw new Error(`no node key at ${opts.keyFile}: run "node src/agent.ts init" first`);
  const base = apiBase(opts.network);

  // The owner signature is checked by the scheduler; check it here too for a clearer error (EOA wallets).
  const sigOk = await verifyMessage({ address: opts.owner, message: linkMessage(account.address, opts.owner), signature: opts.ownerSig }).catch(
    () => false,
  );
  if (!sigOk) say("warning: --owner-sig does not verify as a plain wallet signature here (fine for contract wallets; the scheduler decides)");

  let gpu: Gpu;
  if (opts.dev) {
    console.log(DEV_BANNER);
    gpu = {
      name: `dev-runner (no GPU, ${opts.backend})`,
      uuid: process.env.SPARECYCLE_GPU_UUID ?? `dev-${account.address.toLowerCase()}`,
      vramMb: Number(process.env.SPARECYCLE_VRAM_MB ?? 8192),
    };
  } else {
    gpu = await probeDevice(opts.backend).catch((e: unknown) => {
      throw new Error(`no NVIDIA GPU found (nvidia-smi: ${e instanceof Error ? e.message : String(e)}); use --backend vulkan or cpu for text jobs`);
    });
  }
  say(`node key ${account.address} · owner ${opts.owner} · backend ${opts.backend} · ${gpu.name} · ${gpu.vramMb} MB`);
  if (opts.backend !== "cuda" && !opts.dev) {
    say(`${opts.backend}: text jobs only; reporting ${sharedMemoryMb()} MB (a quarter of system RAM, max 4096) as VRAM`);
  }

  const image = new ImageRunner();
  const text = new TextRunner(opts.backend);
  const allowed = capabilityTagsFor(opts.backend);
  process.on("exit", () => {
    image.stop();
    text.stop();
  });
  const caps: string[] = [];
  if (opts.image && allowed.includes(MODELS.sd15.tag) && gpu.vramMb >= MODELS.sd15.vramMb) {
    if (opts.dev) caps.push(MODELS.sd15.tag);
    else if (image.available()) {
      say("starting Stable Diffusion 1.5 (the first run downloads the model)…");
      await image.start(say);
      caps.push(MODELS.sd15.tag);
    } else say("image jobs off: the Python environment is missing (run the installer)");
  }
  if (opts.text && gpu.vramMb >= MODELS["qwen2.5-1.5b"].vramMb) {
    if (opts.dev || text.available()) caps.push(MODELS["qwen2.5-1.5b"].tag);
    else say(`text jobs off: ${text.serverPath} or ${TextRunner.modelFile()} is missing (run the installer with backend ${opts.backend})`);
  }
  if (!caps.length) throw new Error("no runtime available for either model: run the installer, or check --no-image / --no-text");
  say(`capabilities: ${caps.join(", ")}`);

  const reg = await call(account, base, "/nodes/register", {
    gpu: gpu.name,
    gpuUuid: gpu.uuid,
    vramMb: gpu.vramMb,
    caps,
    owner: opts.owner,
    ownerSig: opts.ownerSig,
    dev: opts.dev,
    backend: opts.backend,
    version: VERSION,
    // 0.3.0+: structured device info for the scheduler's GPU allowlist, and the challenge feature. Both are extra
    // fields: older schedulers ignore them.
    ...(opts.dev ? {} : { device: await probeDeviceInfo(opts.backend) }),
    features: [CHALLENGE_FEATURE],
  });
  if (reg.status !== 200 || !reg.data) {
    const support = typeof reg.data?.supported === "string" ? ` (supported GPUs: ${reg.data.supported})` : "";
    throw new Error(`register failed: ${errText(reg)}${support}`);
  }
  const chainId = Number(reg.data.chainId);
  say(`registered with ${base} · payouts go to ${String(reg.data.owner)} · chain ${chainId}`);
  const gpuGate = reg.data.gpu as { family?: string; status?: string } | undefined;
  if (gpuGate?.status === "untested") {
    say(`GPU family ${gpuGate.family}: not benched yet, so this node may get no paid jobs (see ${String((reg.data.gpu as { supported?: string }).supported ?? "the GPU support list")})`);
  }
  if (opts.backend !== "cuda" && !opts.dev) {
    say(`${opts.backend}: no reliable cross-vendor GPU temperature / VRAM reading, so the busy/hot pause is off (--hours still applies)`);
  }
  const simulated = simulatedPause();
  if (simulated) say(`SPARECYCLE_SIMULATE_PAUSE is set: the GPU check reports ${simulated} without reading the GPU (testing only)`);

  const stop = new AbortController();
  let stopping = false;
  // Ctrl+C / SIGTERM: finish the current job, then stop. A second signal stops at once.
  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    stop.abort();
    say("stopping after the current job (Ctrl+C again to quit now)…");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // Idle Guard (0.4.0): the busy/hot check runs on CUDA only (or when simulated for a test); --hours on every backend.
  // Every change of state, and every HEARTBEAT_SECONDS while paused, goes to the scheduler as a signed heartbeat with
  // the state code and when it began. Nothing else: no temperature, no VRAM figure, no process name, no PID.
  const own = new Set<number>([process.pid]);
  const gpuCheck = (!opts.dev && opts.backend === "cuda") || simulated !== null;
  let local: { state: NodeState; sinceMs: number } | null = null;
  let sent: Sent | null = null; // the last heartbeat the scheduler accepted
  let heartbeats = true; // off once the scheduler answers 404 (a version without the endpoint)
  let lastHeartbeatError = "";
  const heartbeat = async (state: NodeState, sinceMs: number) => {
    let problem = "";
    try {
      const r = await call(account, base, "/nodes/heartbeat", heartbeatBody(state, sinceMs), stop.signal);
      if (r.status === 200) sent = { state, atMs: Date.now() };
      else if (r.status === 404) {
        heartbeats = false;
        say("this scheduler has no heartbeat endpoint (older version): pauses show there as offline, jobs work as before");
      } else problem = `heartbeat ${errText(r)}`;
    } catch (e) {
      if (!stopping) problem = `heartbeat not sent (${e instanceof Error ? e.message : String(e)}); retrying`;
    }
    if (problem && problem !== lastHeartbeatError) say(problem);
    lastHeartbeatError = problem;
  };
  while (!stopping) {
    const insideHours = inHours(opts.hours);
    let gpu: GpuPause | null = null;
    if (insideHours && gpuCheck) {
      for (const pid of [image.pid, text.pid]) if (pid) own.add(pid);
      gpu = await gpuBusyOrHot(own);
    }
    const state = currentState(insideHours, gpu);
    if (!local || local.state !== state) {
      if (local || state !== "active") say(STATE_TEXT[state]);
      local = { state, sinceMs: Date.now() };
    }
    if (heartbeats && heartbeatDue(state, sent, Date.now())) await heartbeat(state, local.sinceMs);
    if (stopping) break;
    if (state !== "active") {
      const recheckMs = state === "paused-hours" ? 60_000 : 30_000;
      await sleep(heartbeats ? pauseSleepMs(state, recheckMs, sent, Date.now()) : recheckMs, stop.signal);
      continue;
    }

    let task: CallResult;
    try {
      task = await call(account, base, "/nodes/poll", {}, stop.signal);
    } catch (e) {
      if (stopping) break;
      say(`scheduler unreachable (${e instanceof Error ? e.message : String(e)}); retrying in 5 s`);
      await sleep(5_000, stop.signal);
      continue;
    }
    if (task.status === 204) {
      await sleep(250, stop.signal);
      continue;
    }
    if (task.status !== 200 || !task.data) {
      say(`poll ${errText(task)}`);
      await sleep(task.status === 403 ? 30_000 : 5_000, stop.signal);
      continue;
    }
    let spec: JobSpec;
    try {
      spec = validateSpec(task.data.spec);
    } catch (e) {
      say(`bad job spec from scheduler: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const runRunner = async (s: JobSpec) => {
      if (s.kind === "image") {
        const r = opts.dev ? devImage(s.params) : await image.run(s.params);
        return { outputHash: sha256Hex(r.png), gpuMs: Math.round(r.gpuMs), speed: "", body: { png: r.png.toString("base64"), nsfw: r.nsfw } };
      }
      const r = opts.dev ? devText(s.params) : await text.run(s.params, say);
      const speed = r.tokens !== null ? ` · ${r.tokens} tok${r.tokensPerSecond ? ` at ${r.tokensPerSecond.toFixed(1)} tok/s` : ""}` : "";
      return { outputHash: sha256Hex(r.text), gpuMs: Math.round(r.gpuMs), speed, body: { text: r.text } as Record<string, unknown> };
    };
    const runner = opts.dev ? "dev" : spec.kind === "image" ? "sd15-diffusers" : `llama.cpp-${opts.backend}`;

    // A GPU challenge (one fixed bench case, compared with published reference outputs). Unpaid; not a job.
    if (task.data.type === "challenge") {
      const challengeId = String(task.data.challengeId) as Hex;
      try {
        const { outputHash, gpuMs, body } = await runRunner(spec);
        const signature = await signChallengeResult(account, chainId, { challengeId, node: account.address, outputHash, gpuMs: BigInt(gpuMs) });
        const done = await call(account, base, `/challenges/${challengeId}/result`, { ...body, outputHash, gpuMs, signature, dev: opts.dev, runner });
        const verdict = done.status === 200 ? `${done.data?.passed ? "passed" : "did not match the reference"} (${String(done.data?.state ?? "-")})` : errText(done);
        say(`GPU challenge ${String(task.data.caseId)} (${spec.kind}) done in ${(gpuMs / 1000).toFixed(1)} s -> ${verdict}`);
      } catch (e) {
        say(`GPU challenge ${challengeId.slice(0, 10)} could not run: ${e instanceof Error ? e.message : String(e)}`);
      }
      continue;
    }

    const taskId = String(task.data.taskId);
    const jobId = String(task.data.jobId) as Hex;
    const epoch = Number(task.data.epoch);
    try {
      const { outputHash, gpuMs, speed, body } = await runRunner(spec);
      const signature = await signReceipt(account, chainId, {
        jobId,
        node: account.address,
        outputHash,
        gpuMs: BigInt(gpuMs),
        epoch: BigInt(epoch),
      });
      const done = await call(account, base, `/tasks/${taskId}/result`, {
        ...body,
        outputHash,
        gpuMs,
        epoch,
        signature,
        dev: opts.dev,
        runner,
      });
      const verdict = done.status === 200 ? String(done.data?.status) : errText(done);
      say(`${spec.kind} job ${jobId.slice(0, 10)} done in ${(gpuMs / 1000).toFixed(1)} s${speed} -> ${verdict}`);
    } catch (e) {
      say(`job ${jobId.slice(0, 10)} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  image.stop();
  text.stop();
  say("stopped");
}

async function main() {
  const cmd = argv[0];
  const keyFile = arg("key-file", DEFAULT_KEY_FILE)!;
  if (cmd === "init") {
    const { account, created } = loadOrCreateKey(keyFile);
    console.log(
      `${created ? "Created" : "Existing"} node key: ${account.address}\nKey file: ${keyFile}\n` +
        "This key only signs for the node. Never send funds to it; never share the key file.\n" +
        `Next: node src/agent.ts link-message --owner 0xYOUR_WALLET`,
    );
    return;
  }
  if (cmd === "link-message") {
    const owner = arg("owner");
    if (!owner || !isAddress(owner)) throw new Error("--owner 0xYOUR_WALLET is required");
    const { account } = loadOrCreateKey(keyFile);
    console.log(
      `Sign this exact message with ${getAddress(owner)} (personal_sign / "Sign message", no gas), then pass the signature as --owner-sig:\n\n` +
        `${linkMessage(account.address, owner)}\n\n` +
        "This wallet is the payout account in the Merkle tree. The node never needs its private key.",
    );
    return;
  }
  if (cmd === "start") {
    const network = arg("network");
    const owner = arg("owner");
    const ownerSig = arg("owner-sig");
    if (!network) throw new Error("--network <scheduler URL> is required (the Sparecycle site, e.g. https://<domain>)");
    if (!owner || !isAddress(owner)) throw new Error("--owner 0xYOUR_WALLET is required");
    if (!ownerSig || !/^0x[0-9a-fA-F]+$/.test(ownerSig)) throw new Error("--owner-sig 0x… is required (see link-message)");
    const backend = arg("backend", "cuda");
    if (!isBackend(backend)) throw new Error(`--backend must be one of ${BACKENDS.join(", ")}`);
    await start({
      network,
      keyFile,
      owner: getAddress(owner),
      ownerSig: ownerSig as Hex,
      hours: parseHours(arg("hours")),
      image: !flag("no-image"),
      text: !flag("no-text"),
      dev: flag("dev-runner"),
      backend,
    });
    return;
  }
  if (cmd === "bench") {
    const backend = arg("backend", "cuda");
    if (!isBackend(backend)) throw new Error(`--backend must be one of ${BACKENDS.join(", ")}`);
    const repeat = Number(arg("repeat", "2"));
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) throw new Error("--repeat must be 1..5");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    await bench({
      backend,
      out: arg("out", `bench-${backend}-${stamp}`)!,
      repeat,
      image: !flag("no-image"),
      text: !flag("no-text"),
      log: say,
      client: VERSION,
    });
    return;
  }
  console.log(
    [
      "Sparecycle node",
      "  node src/agent.ts init [--key-file path]",
      "  node src/agent.ts link-message --owner 0xWALLET [--key-file path]",
      "  node src/agent.ts start --network <url> --owner 0xWALLET --owner-sig 0xSIG",
      "       [--backend cuda|vulkan|cpu] [--hours 1-8,22-24] [--no-image] [--no-text] [--dev-runner] [--key-file path]",
      "  node src/agent.ts bench [--backend cuda|vulkan|cpu] [--out folder] [--repeat 2] [--no-image] [--no-text]",
    ].join("\n"),
  );
}

main().catch((e: unknown) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
