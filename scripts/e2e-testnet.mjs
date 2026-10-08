#!/usr/bin/env node
// Sparecycle money-path run on Robinhood Chain TESTNET (chain id 46630). Pons is not deployed there, so the fee
// escrow is MockPonsFeeEscrow. Real (testnet) ETH, real blocks, real 180 s epoch.
//
//   node scripts/e2e-testnet.mjs                  dev-runner nodes (no GPU)
//   node scripts/e2e-testnet.mjs --real-text      two `--backend vulkan` nodes on this machine's GPU (text jobs only)
//   node scripts/e2e-testnet.mjs --fresh          redeploy even if src/contracts/deployments.json has a 46630 entry
//   amounts (ETH): --threshold 0.009 --owner-gas 0.0008 --fund 0.003 --escrow-credit 0.002 --gas-reserve 0.0005
//                  (env: E2E_TESTNET_*). --threshold gates a fresh deploy; a resumed run (reusing the 46630 deployment)
//                  needs only the missing top-ups + the gas reserve. fund / escrow credit are top-ups to these targets.
//
// Keys: three encrypted Foundry keystores in .keys/ (evm-testnet = deployer = admin = scheduler, owner-a, owner-b),
// each with .keys/<name>.pass. They are decrypted in-process with `cast wallet decrypt-keystore` (password passed in
// the CAST_UNSAFE_PASSWORD env, never on a command line) and handed to child processes only through env
// (SCHEDULER_SIGNER_KEY, SWEEP_SIGNER_KEY). forge deploys straight from the keystore + password file. No private key
// is ever printed, logged or written: every line this script echoes is scrubbed.
//
// Steps: balance gate (exits 0 with funding instructions when the deployer is short) -> deploy (forge script) or reuse
// -> sync-deployments -> top up owners -> fund() + mock escrow credit + sweep bot claimFeesFromEscrow() -> scheduler
// (isolated `next dev`, 127.0.0.1:3240) + two nodes -> jobs -> wait for the on-chain epoch end -> close (root posted)
// -> on-chain checks -> owner-a / owner-b claim -> balances moved by exactly the leaf amount minus fees -> second claim
// reverts -> tx list with explorer links, ETH spent, L1 fee observed. Every process it starts is stopped.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN_ID = 46630;
const RPC = "https://rpc.testnet.chain.robinhood.com";
const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
const FAUCETS = ["https://faucet.testnet.chain.robinhood.com", "https://www.alchemy.com/faucets/robinhood-testnet"];
const PORT = 3240;
const SITE = `http://127.0.0.1:${PORT}`;
const API = `${SITE}/api/v1`;
const EPOCH_LENGTH = 180;
const KEYS_DIR = join(ROOT, ".keys");
const ACCOUNTS = {
  deployer: { keystore: "evm-testnet", address: "0xc0077257d617d2D3196D59968FD28af056B5fAde" },
  ownerA: { keystore: "owner-a", address: "0x503ecd2D1e47610882D27fD743bfB3a5c7611bD9" },
  ownerB: { keystore: "owner-b", address: "0xf9D7AD726Bb997DC601cF2A99a3AF80C79C4A711" },
};
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin");
const exe = (n) => join(FOUNDRY_BIN, process.platform === "win32" ? `${n}.exe` : n);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const amountOpt = (n, envName, dflt) => {
  const raw = argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : (process.env[envName] ?? dflt);
  if (!/^\d+(\.\d+)?$/.test(String(raw))) throw new Error(`--${n} must be an ETH amount, got ${raw}`);
  return parseEther(String(raw));
};
const THRESHOLD = amountOpt("threshold", "E2E_TESTNET_THRESHOLD", "0.009");
const OWNER_GAS = amountOpt("owner-gas", "E2E_TESTNET_OWNER_GAS", "0.0008");
const FUND = amountOpt("fund", "E2E_TESTNET_FUND", "0.003");
const ESCROW_CREDIT = amountOpt("escrow-credit", "E2E_TESTNET_ESCROW_CREDIT", "0.002");
const GAS_RESERVE = amountOpt("gas-reserve", "E2E_TESTNET_GAS_RESERVE", "0.0005");
const FRESH = flag("fresh");
const REAL_TEXT = flag("real-text");

const RUN_DIR = join(ROOT, "data", `testnet-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const APP_DIR = join(RUN_DIR, "app");

// ---- secrets: kept in memory only; every echoed line goes through scrub() ---------------------------------
const secrets = new Set();
const scrub = (s) => {
  let out = String(s);
  for (const k of secrets) out = out.split(k).join("[redacted]").split(k.slice(2)).join("[redacted]");
  return out;
};
const t0 = Date.now();
const log = (m) => console.log(scrub(`[testnet ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`));
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`assertion failed: ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txs = []; // { label, hash }
const link = (hash) => `${EXPLORER}/tx/${hash}`;
const record = (label, hash) => {
  txs.push({ label, hash });
  log(`tx ${label}: ${link(hash)}`);
};

function decryptKey(name) {
  const pass = readFileSync(join(KEYS_DIR, `${name}.pass`), "utf8").replace(/\r?\n$/, "");
  const r = spawnSync(exe("cast"), ["wallet", "decrypt-keystore", "--keystore-dir", KEYS_DIR, name], {
    env: { ...process.env, CAST_UNSAFE_PASSWORD: pass },
    encoding: "utf8",
    windowsHide: true,
  });
  const key = /0x[0-9a-fA-F]{64}/.exec(r.stdout ?? "")?.[0];
  if (r.status !== 0 || !key) throw new Error(`could not decrypt keystore ${name} (cast exit ${r.status})`);
  secrets.add(key);
  return key;
}

// ---- processes ----------------------------------------------------------------------------------------------
const children = [];
function start(name, cmd, args, opts = {}) {
  const out = createWriteStream(join(RUN_DIR, `${name}.log`));
  const child = spawn(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  const pipe = (s) => s.on("data", (d) => out.write(scrub(d.toString())));
  pipe(child.stdout);
  pipe(child.stderr);
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

/** Env for children: parent env minus Sparecycle / scheduler variables, plus `extra`. */
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|SPARECYCLE_|E2E_TESTNET_)/.test(k) || ["DB_PATH", "PAYOUT_CAP_PER_UNIT", "JOB_RATE_LIMIT", "NODE_OPTIONS", "CAST_UNSAFE_PASSWORD"].includes(k)) continue;
    env[k] = v;
  }
  return { ...env, NEXT_TELEMETRY_DISABLED: "1", ...extra };
}
async function waitFor(label, fn, timeoutMs, intervalMs = 2000) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message ?? last}` : ""}`);
}
async function api(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(240_000),
  });
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, data: type.includes("json") ? await res.json() : await res.text() };
}
function revertName(e) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.signature ?? "unknown";
  }
  return null;
}
const eth = (wei) => `${formatEther(wei)} ETH`;
const big = (v) => (v === undefined || v === null ? 0n : typeof v === "bigint" ? v : BigInt(v));

// ---- main ------------------------------------------------------------------------------------------------------
const chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "Explorer", url: EXPLORER } },
});
const pub = createPublicClient({ chain, transport: http(RPC, { retryCount: 4, timeout: 30_000 }) });
let report = null;

async function main() {
  mkdirSync(RUN_DIR, { recursive: true });
  log(`run dir ${RUN_DIR}`);
  check("RPC is Robinhood Chain testnet (46630)", (await pub.getChainId()) === CHAIN_ID);

  const { sparecycleRewardsAbi } = await srcImport("contracts/sparecycleRewards.ts");
  const { buildTree, leafOf, verifyProof } = await srcImport("lib/merkle.ts");
  const escrowAbi = [
    { type: "function", name: "credit", stateMutability: "payable", inputs: [{ name: "recipient", type: "address" }], outputs: [] },
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "recipient", type: "address" }], outputs: [{ type: "uint256" }] },
  ];
  const deployerAddr = getAddress(ACCOUNTS.deployer.address);

  // 1. What already exists (public reads only): a reusable 46630 deployment, the open epoch's pot, the escrow
  //    balance waiting to be claimed, and the owners' gas. A resumed run only tops up what is missing.
  const deploymentsFile = join(ROOT, "src", "contracts", "deployments.json");
  const known = existsSync(deploymentsFile) ? JSON.parse(readFileSync(deploymentsFile, "utf8"))[String(CHAIN_ID)] : undefined;
  let rewards = known?.SparecycleRewards ?? null;
  let escrow = known?.MockPonsFeeEscrow ?? null;
  let reuse = false;
  if (!FRESH && rewards && escrow) {
    const [code, sched, len, esc] = await Promise.all([
      pub.getCode({ address: rewards }),
      pub.readContract({ address: rewards, abi: sparecycleRewardsAbi, functionName: "scheduler" }).catch(() => null),
      pub.readContract({ address: rewards, abi: sparecycleRewardsAbi, functionName: "epochLength" }).catch(() => null),
      pub.readContract({ address: rewards, abi: sparecycleRewardsAbi, functionName: "feeEscrow" }).catch(() => null),
    ]);
    reuse = Boolean(code && code !== "0x" && sched === deployerAddr && len === BigInt(EPOCH_LENGTH) && esc && getAddress(esc) === getAddress(escrow));
    log(reuse ? `reusing deployment ${rewards} (escrow ${escrow})` : "existing 46630 entry is unusable; deploying fresh");
  }
  const ownerTopUp = async () => {
    let sum = 0n;
    for (const a of [ACCOUNTS.ownerA.address, ACCOUNTS.ownerB.address]) {
      const bal = await pub.getBalance({ address: a });
      if (bal < OWNER_GAS) sum += OWNER_GAS - bal;
    }
    return sum;
  };
  const potState = async () => {
    const id = await pub.readContract({ address: rewards, abi: sparecycleRewardsAbi, functionName: "currentEpoch" });
    const pot = (await pub.readContract({ address: rewards, abi: sparecycleRewardsAbi, functionName: "getEpoch", args: [id] })).pot;
    const esc = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "balanceOf", args: [rewards] });
    return { id, pot, esc };
  };
  const target = FUND + ESCROW_CREDIT;
  let needed;
  if (reuse) {
    const s = await potState();
    const fundMissing = s.pot + s.esc >= target ? 0n : s.pot >= FUND ? 0n : FUND - s.pot;
    const creditMissing = s.pot + s.esc >= target ? 0n : s.esc >= ESCROW_CREDIT ? 0n : ESCROW_CREDIT - s.esc;
    needed = (await ownerTopUp()) + fundMissing + creditMissing + GAS_RESERVE;
  } else {
    needed = THRESHOLD;
  }

  // 2. Balance gate (before touching any key).
  const deployerStart = await pub.getBalance({ address: deployerAddr });
  log(`deployer ${deployerAddr}: ${eth(deployerStart)} (this run needs ${eth(needed)}${reuse ? ", resume" : ", fresh deploy"})`);
  if (deployerStart < needed) {
    console.log(
      [
        "",
        "Deployer is not funded enough for the testnet run. Nothing was sent.",
        `  address: ${deployerAddr}`,
        `  needs:   at least ${formatEther(needed)} ETH on Robinhood Chain testnet (has ${formatEther(deployerStart)})`,
        `  faucets: ${FAUCETS.join("  |  ")}`,
        "Re-run this script after funding.",
      ].join("\n"),
    );
    report = { stopped: "unfunded" };
    return;
  }

  // 3. Keys (in memory only).
  const deployerKey = decryptKey(ACCOUNTS.deployer.keystore);
  const ownerAKey = decryptKey(ACCOUNTS.ownerA.keystore);
  const ownerBKey = decryptKey(ACCOUNTS.ownerB.keystore);
  const deployer = privateKeyToAccount(deployerKey);
  const ownerA = privateKeyToAccount(ownerAKey);
  const ownerB = privateKeyToAccount(ownerBKey);
  check(
    "keystores decrypt to the expected addresses",
    deployer.address === deployerAddr && ownerA.address === getAddress(ACCOUNTS.ownerA.address) && ownerB.address === getAddress(ACCOUNTS.ownerB.address),
  );
  const wallet = (a) => createWalletClient({ account: a, chain, transport: http(RPC, { retryCount: 4, timeout: 30_000 }) });
  const send = async (label, account, req) => {
    const hash = await wallet(account).writeContract(req);
    record(label, hash);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") throw new Error(`${label} reverted (${hash})`);
    return r;
  };

  // 4. Deployment (forge script from the keystore) unless reusing.
  if (!reuse) {
    log("deploying SparecycleRewards + MockPonsFeeEscrow with forge script (keystore + password file)…");
    const r = spawnSync(
      exe("forge"),
      [
        "script", "script/Deploy.s.sol",
        "--rpc-url", RPC,
        "--broadcast",
        "--keystore", join(KEYS_DIR, ACCOUNTS.deployer.keystore),
        "--password-file", join(KEYS_DIR, `${ACCOUNTS.deployer.keystore}.pass`),
        "--sender", deployer.address,
        "--gas-estimate-multiplier", "200",
        "--slow",
      ],
      {
        cwd: join(ROOT, "contracts"),
        env: cleanEnv({ ADMIN: deployer.address, SCHEDULER: deployer.address, EPOCH_LENGTH: String(EPOCH_LENGTH), DEPLOY_MOCK_ESCROW: "1" }),
        encoding: "utf8",
        windowsHide: true,
      },
    );
    writeFileSync(join(RUN_DIR, "forge-deploy.log"), scrub(`${r.stdout}\n${r.stderr}`));
    check("forge script deploy", r.status === 0, `log: ${join(RUN_DIR, "forge-deploy.log")}`);
    const sync = spawnSync(process.execPath, [join(ROOT, "scripts", "sync-deployments.mjs"), "Deploy.s.sol", "--chain", String(CHAIN_ID)], { cwd: ROOT, encoding: "utf8" });
    log(sync.stdout.trim());
    check("sync-deployments wrote the 46630 entry", sync.status === 0);
    const dep = JSON.parse(readFileSync(deploymentsFile, "utf8"))[String(CHAIN_ID)];
    rewards = dep.SparecycleRewards;
    escrow = dep.MockPonsFeeEscrow;
    const run = JSON.parse(readFileSync(join(ROOT, "contracts", "broadcast", "Deploy.s.sol", String(CHAIN_ID), "run-latest.json"), "utf8"));
    for (const t of run.transactions ?? []) if (t.hash) record(`deploy ${t.contractName ?? "tx"}`, t.hash);
  }
  const read = (functionName, args = []) => pub.readContract({ address: rewards, abi: sparecycleRewardsAbi, functionName, args });
  check("reward contract: scheduler = deployer, 180 s epochs, ETH payouts, mock escrow", (await read("scheduler")) === deployer.address && (await read("epochLength")) === BigInt(EPOCH_LENGTH) && (await read("payoutToken")) === "0x0000000000000000000000000000000000000000" && getAddress(await read("feeEscrow")) === getAddress(escrow), `${rewards}`);

  // 5. Owners get claim gas (only what's missing).
  for (const o of [ownerA, ownerB]) {
    const bal = await pub.getBalance({ address: o.address });
    if (bal >= OWNER_GAS) {
      log(`owner ${o.address} already has ${eth(bal)}`);
      continue;
    }
    const hash = await wallet(deployer).sendTransaction({ to: o.address, value: OWNER_GAS - bal });
    record(`gas to ${o.address.slice(0, 8)}`, hash);
    await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  }

  // 6. Pot: fund() + mock escrow credit (each only up to its target), the escrow claimed by the sweep bot.
  const s0 = await potState();
  const epochId = s0.id;
  if (s0.pot + s0.esc < target && s0.pot < FUND) {
    await send("fund()", deployer, { address: rewards, abi: sparecycleRewardsAbi, functionName: "fund", value: FUND - s0.pot });
  } else log(`epoch ${epochId} pot already ${eth(s0.pot)}: fund() skipped`);
  const s1 = await potState();
  if (s1.pot + s1.esc < target && s1.esc < ESCROW_CREDIT) {
    await send("mock escrow credit(reward)", deployer, { address: escrow, abi: escrowAbi, functionName: "credit", args: [rewards], value: ESCROW_CREDIT - s1.esc });
  } else log(`escrow already holds ${eth(s1.esc)} for the reward contract: credit skipped`);
  const s2 = await potState();
  check("escrow holds fees for the reward contract", s2.esc > 0n, eth(s2.esc));
  const sweep = spawnSync(process.execPath, [join(ROOT, "scripts", "sweep.mjs"), "--send"], {
    cwd: ROOT,
    env: cleanEnv({ NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_RPC_URL: RPC, NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS: rewards, SWEEP_SIGNER_KEY: deployerKey }),
    encoding: "utf8",
    windowsHide: true,
  });
  log(`sweep --send:\n${sweep.stdout.trim()}`);
  const sweepHash = /sent: rewards\.claimFeesFromEscrow\(\) -> (0x[0-9a-f]{64})/.exec(sweep.stdout)?.[1];
  if (sweepHash) record("claimFeesFromEscrow() (sweep bot)", sweepHash);
  check("sweep bot claimed the escrow into the pot (signed locally)", sweep.status === 0 && Boolean(sweepHash) && (await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "balanceOf", args: [rewards] })) === 0n);
  const potFunded = (await read("getEpoch", [epochId])).pot;
  check("pot grew by exactly the escrow amount claimed", potFunded === s2.pot + s2.esc, `epoch ${epochId}: ${eth(potFunded)}`);

  // 6. Scheduler from an isolated copy of the app.
  mkdirSync(APP_DIR, { recursive: true });
  for (const f of ["src", "public", "next.config.ts", "tsconfig.json", "package.json", "postcss.config.mjs"]) {
    if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(APP_DIR, f), { recursive: true });
  }
  const adminToken = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  secrets.add(`0x${adminToken}`); // scrub() matches with and without 0x
  start("next", process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: APP_DIR,
    env: cleanEnv({
      NEXT_PUBLIC_NETWORK: "testnet",
      NEXT_PUBLIC_RPC_URL: RPC,
      NEXT_PUBLIC_EXPLORER_URL: EXPLORER,
      NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS: rewards,
      NEXT_PUBLIC_NODE_PAYOUT_ASSET: "ETH",
      SCHEDULER_SIGNER_KEY: deployerKey,
      SCHEDULER_ADMIN_TOKEN: adminToken,
      SCHEDULER_ALLOW_DEV_RUNNER: REAL_TEXT ? "0" : "1",
      DB_PATH: join(RUN_DIR, "sparecycle.db"),
    }),
  });
  await waitFor("scheduler health", async () => (await api("GET", "/health")).data?.ok === true, 180_000);
  const st = (await api("GET", "/status")).data;
  check("scheduler follows the testnet contract", st.epoch?.clock === "contract" && st.epoch.id === Number(epochId) && st.rootPosting === "configured", JSON.stringify(st.epoch));

  // 7. Two nodes (owner-a, owner-b).
  const agent = join(ROOT, "node-client", "src", "agent.ts");
  for (const [name, owner, uuid] of [["node-a", ownerA, "TESTNET-A"], ["node-b", ownerB, "TESTNET-B"]]) {
    const keyFile = join(RUN_DIR, `${name}-key.json`);
    spawnSync(process.execPath, [agent, "init", "--key-file", keyFile], { cwd: ROOT, encoding: "utf8" });
    const nodeKey = privateKeyToAccount(JSON.parse(readFileSync(keyFile, "utf8")).privateKey).address;
    const sig = await owner.signMessage({ message: `Sparecycle: link node ${nodeKey.toLowerCase()} to wallet ${owner.address.toLowerCase()}` });
    const args = [agent, "start", "--network", SITE, "--owner", owner.address, "--owner-sig", sig, "--key-file", keyFile];
    args.push(...(REAL_TEXT ? ["--backend", "vulkan"] : ["--dev-runner"]));
    start(name, process.execPath, args, { env: cleanEnv({ SPARECYCLE_GPU_UUID: uuid }) });
  }
  await waitFor("two nodes online", async () => (await api("GET", "/nodes")).data.nodes.filter((n) => n.online).length === 2, 120_000);
  check(`two ${REAL_TEXT ? "Vulkan" : "dev-runner"} nodes online`, true);

  // 8. Jobs.
  const specs = REAL_TEXT
    ? [
        { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "Explain an epoch in one sentence.", maxTokens: 48 } },
        { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "Name three uses of an idle GPU.", maxTokens: 48 } },
        { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "What does a Merkle proof prove?", maxTokens: 48 } },
      ]
    : [
        { kind: "image", params: { model: "sd15", prompt: "a lighthouse at dusk", width: 256, height: 256, steps: 10 } },
        { kind: "image", params: { model: "sd15", prompt: "a red bicycle", width: 256, height: 256, steps: 12, seed: 7 } },
        { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "Explain an epoch in one sentence.", maxTokens: 64 } },
      ];
  const jobIds = [];
  for (const s of specs) {
    const r = await api("POST", "/jobs", s);
    if (r.status !== 201) throw new Error(`job submit failed: ${JSON.stringify(r.data)}`);
    jobIds.push(r.data.id);
  }
  await waitFor("jobs agreed", async () => {
    const js = (await api("GET", "/jobs?limit=50")).data.jobs.filter((j) => jobIds.includes(j.id));
    if (js.some((j) => ["disagreed", "expired", "rejected"].includes(j.status))) throw new Error(`job failed: ${JSON.stringify(js)}`);
    return js.length === jobIds.length && js.every((j) => j.status === "agreed");
  }, REAL_TEXT ? 15 * 60_000 : 180_000);
  const agreed = (await api("GET", "/jobs?limit=50")).data.jobs.filter((j) => jobIds.includes(j.id));
  check(`${jobIds.length} jobs agreed in epoch ${epochId}`, agreed.every((j) => j.epochId === Number(epochId)));

  // 9. Wait for the real on-chain epoch end, then close.
  const ep = await read("getEpoch", [epochId]);
  const endsAt = Number(ep.startedAt) + EPOCH_LENGTH;
  log(`epoch ${epochId} started ${new Date(Number(ep.startedAt) * 1000).toISOString()}, closable from ${new Date(endsAt * 1000).toISOString()}`);
  await waitFor("canClose on-chain", () => read("canClose", [epochId]), (EPOCH_LENGTH + 300) * 1000, 10_000);
  const close = await api("POST", "/epochs/close", undefined, { authorization: `Bearer ${adminToken}` });
  log(`close -> ${close.status} ${JSON.stringify(close.data)}`);
  check("close posted the root on testnet", close.status === 200 && close.data.epoch?.status === "posted" && /^0x[0-9a-f]{64}$/.test(close.data.epoch.postedTx ?? ""));
  record("closeEpochAndPostRoot (scheduler)", close.data.epoch.postedTx);

  // 10. On-chain checks.
  const e = await read("getEpoch", [epochId]);
  const next = await read("getEpoch", [epochId + 1n]);
  const tree = (await api("GET", `/epochs/${epochId}/tree`)).data;
  check("settled; on-chain root == published root", e.settled && e.merkleRoot.toLowerCase() === tree.root.toLowerCase(), tree.root);
  check("on-chain reserved == published reserved", e.reserved.toString() === tree.reserved, eth(e.reserved));
  check("scheduler's pot == on-chain pot", tree.potAtClose === e.pot.toString(), eth(e.pot));
  check("reserved <= pot", e.reserved <= e.pot);
  check("rollover landed in the next epoch", next.pot === e.pot - e.reserved, `${next.pot} wei`);
  check("one leaf per owner, leaves sum to reserved", tree.leaves.length === 2 && tree.leaves.reduce((s, l) => s + BigInt(l.amount), 0n) === e.reserved);
  check("merkle.ts rebuilds the posted root", buildTree(tree.leaves.map((l) => leafOf(epochId, l.account, BigInt(l.amount)))).root === tree.root);

  // 11. Claims.
  for (const o of [ownerA, ownerB]) {
    const p = (await api("GET", `/epochs/${epochId}/proof?account=${o.address}`)).data;
    const amount = BigInt(p.amount);
    check(`${o.address.slice(0, 8)}: proof verifies locally`, verifyProof(p.proof, p.root, leafOf(epochId, o.address, amount)));
    const { request } = await pub.simulateContract({ account: o, address: rewards, abi: sparecycleRewardsAbi, functionName: "claim", args: [epochId, amount, p.proof] });
    const hash = await wallet(o).writeContract(request);
    record(`claim ${o.address.slice(0, 8)}`, hash);
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    const before = await pub.getBalance({ address: o.address, blockNumber: rc.blockNumber - 1n });
    const after = await pub.getBalance({ address: o.address, blockNumber: rc.blockNumber });
    const fee = rc.gasUsed * rc.effectiveGasPrice + big(rc.l1Fee);
    check(`${o.address.slice(0, 8)}: balance moved by exactly the leaf amount minus the fee`, rc.status === "success" && after - before === amount - fee, `+${eth(amount)} - fee ${eth(fee)}`);
    let second = null;
    try {
      await pub.simulateContract({ account: o, address: rewards, abi: sparecycleRewardsAbi, functionName: "claim", args: [epochId, amount, p.proof] });
    } catch (err) {
      second = revertName(err);
    }
    check(`${o.address.slice(0, 8)}: second claim reverts AlreadyClaimed`, second === "AlreadyClaimed", String(second));
  }
  check("claimed == reserved", (await read("getEpoch", [epochId])).claimed === e.reserved);

  // 12. Costs.
  const rows = [];
  let feesTotal = 0n;
  let l1Total = 0n;
  for (const t of txs) {
    const rc = await pub.getTransactionReceipt({ hash: t.hash });
    const tx = await pub.getTransaction({ hash: t.hash });
    const fee = rc.gasUsed * rc.effectiveGasPrice + big(rc.l1Fee);
    const l1Gas = big(rc.gasUsedForL1);
    const l1Fee = l1Gas * rc.effectiveGasPrice + big(rc.l1Fee);
    feesTotal += fee;
    l1Total += l1Fee;
    rows.push({ label: t.label, from: rc.from, gasUsed: rc.gasUsed.toString(), l1Gas: l1Gas.toString(), feeWei: fee.toString(), l1FeeWei: l1Fee.toString(), valueWei: tx.value.toString(), url: link(t.hash) });
  }
  const deployerEnd = await pub.getBalance({ address: deployer.address });
  report = {
    chainId: CHAIN_ID,
    rewards,
    escrow,
    reusedDeployment: reuse,
    epoch: Number(epochId),
    pot: e.pot.toString(),
    reserved: e.reserved.toString(),
    rollover: next.pot.toString(),
    leaves: tree.leaves,
    deployerSpentWei: (deployerStart - deployerEnd).toString(),
    feesTotalWei: feesTotal.toString(),
    l1FeesTotalWei: l1Total.toString(),
    txs: rows,
  };
  writeFileSync(join(RUN_DIR, "report.json"), scrub(JSON.stringify(report, null, 2)));
  console.log(scrub(`\nTransactions (${EXPLORER}):`));
  for (const r of rows) console.log(scrub(`  ${r.label.padEnd(36)} fee ${formatEther(BigInt(r.feeWei)).padEnd(22)} L1 part ${formatEther(BigInt(r.l1FeeWei)).padEnd(22)} ${r.url}`));
  console.log(scrub(`Deployed: SparecycleRewards ${rewards} · MockPonsFeeEscrow ${escrow}`));
  console.log(scrub(`Deployer spent ${eth(deployerStart - deployerEnd)} (value moved + its own fees); all fees ${eth(feesTotal)}, of which L1 data ${eth(l1Total)}`));
  console.log(scrub(`Epoch ${epochId}: pot ${eth(e.pot)}, reserved ${eth(e.reserved)}, rollover ${next.pot} wei`));
}

let failed = null;
try {
  await main();
} catch (e) {
  failed = e;
  log(`ERROR: ${e?.stack ?? e}`);
}
cleanup();
if (txs.length && failed) {
  console.log(scrub("\nTransactions sent before the failure:"));
  for (const t of txs) console.log(scrub(`  ${t.label}: ${link(t.hash)}`));
}
console.log(scrub(`\nchecks passed: ${results.filter((r) => r.ok).length}/${results.length}`));
console.log(scrub(`logs and scratch DB: ${RUN_DIR}`));
console.log(failed ? "RESULT: FAIL" : report?.stopped === "unfunded" ? "RESULT: NOT FUNDED (nothing sent)" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
