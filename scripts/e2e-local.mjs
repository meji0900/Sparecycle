#!/usr/bin/env node
// Sparecycle local end-to-end test: proves the money path with NO GPU and NO real funds.
//
//   node scripts/e2e-local.mjs          (npm run e2e:local)
//
//  1. anvil on 127.0.0.1:8548 (local chain 31337)
//  2. forge-build and deploy SparecycleRewards (30 s epochs) + MockPonsFeeEscrow; scheduler = anvil account 1,
//     admin = anvil account 0
//  3. fund the pot: fund() 1 ETH and 1 wei pushed straight to receive() (credited by sync() inside the close);
//     the sweep bot moves 0.25 ETH of mock curve fees along the fork-verified path hook.feeSweepOperator() ->
//     operator.sweepCurve(curve) -> escrow -> claimFeesFromEscrow(), plus a paused-operator alert and a dry-run
//  4. `next dev` on 127.0.0.1:3210 from a throw-away copy of the app (so it never collides with another
//     `next dev` lock and never reads the user's .env files), env passed inline, scratch DB under data/
//  5. two node clients with --dev-runner (synthetic outputs, no GPU), owners = anvil accounts 2 and 3,
//     distinct node keys and fake GPU UUIDs
//  6. submit 2 image + 1 text jobs, wait until both nodes agree
//  7. warp anvil past the epoch end, POST /api/v1/epochs/close (posts the root on-chain)
//  8. each owner fetches its proof and claims; balances must rise by exactly the leaf amount; a second claim
//     must revert AlreadyClaimed; reserved <= pot; the rollover lands in epoch 1
//  9. rate limit; restart the scheduler on the same DB with SCHEDULER_AUTOCLOSE=1 and let the timer close a funded
//     epoch and then an empty one (root 0x00…00, reserved 0)
// 10. PASS / FAIL summary; every process started here is stopped, even on failure
//
// The anvil keys below are the well-known public anvil/hardhat dev keys. They are for this local test only and
// must never be used anywhere else.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANVIL_PORT = 8548;
const NEXT_PORT = 3210;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const SITE = `http://127.0.0.1:${NEXT_PORT}`;
const API = `${SITE}/api/v1`;
const ADMIN_TOKEN = "test";
const EPOCH_LENGTH = 30;
const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin");
const ANVIL = join(FOUNDRY_BIN, exe("anvil"));
const FORGE = join(FOUNDRY_BIN, exe("forge"));
const CONTRACT_SRC = join(ROOT, "contracts", "src", "SparecycleRewards.sol");
const MOCK_SRC = join(ROOT, "contracts", "test", "mocks", "MockPonsFeeEscrow.sol");

// Well-known anvil dev keys (accounts 0..5 of the default test mnemonic). LOCAL TESTS ONLY.
const ANVIL_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];
const acct = ANVIL_KEYS.map((k) => privateKeyToAccount(k));
const [admin, scheduler, ownerA, ownerB, sweeper, customer] = acct;
const treasury = privateKeyToAccount(generatePrivateKey()).address; // stands in for the treasury Safe
const PRICE_WEI_PER_UNIT = 1_000_000_000n; // 1 gwei per work unit in this test

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = join(ROOT, "data", `e2e-${RUN_ID}`);
const APP_DIR = join(RUN_DIR, "app");

// ---- bookkeeping ---------------------------------------------------------------------------------
const results = [];
let currentStep = "start";
const t0 = Date.now();
const log = (m) => console.log(`[e2e ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${m}`);
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`assertion failed: ${name}${detail ? ` (${detail})` : ""}`);
}
const step = (name) => {
  currentStep = name;
  log(`== ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = [];
function start(name, cmd, args, opts = {}) {
  const out = createWriteStream(join(RUN_DIR, `${name}.log`));
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push({ name, child });
  return child;
}

function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const { child } of children.reverse()) killTree(child);
  // The app copy holds a full src/ tree; never leave it behind for lint / tsc to pick up. Forge output is scratch.
  for (const dir of [APP_DIR, join(RUN_DIR, "forge-out"), join(RUN_DIR, "forge-cache"), join(RUN_DIR, "sweep-mocks")]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* best effort */
    }
  }
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig}: cleaning up`);
    cleanup();
    process.exit(130);
  });
}
process.on("exit", cleanup);

// ---- helpers --------------------------------------------------------------------------------------
async function portBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch (e) {
    return e?.cause?.code !== "ECONNREFUSED"; // a timeout means something holds the port
  }
}

async function waitFor(label, fn, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
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
    signal: AbortSignal.timeout(120_000),
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, type, data };
}

function revertName(e) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.signature ?? "unknown";
  }
  return null;
}

function artifact(outDir, file, name) {
  const j = JSON.parse(readFileSync(join(outDir, file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

/** Env for child processes: the parent env minus anything Sparecycle-related, plus `extra`. */
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|SPARECYCLE_)/.test(k)) continue;
    if (["DB_PATH", "PAYOUT_CAP_PER_UNIT", "JOB_RATE_LIMIT", "LAUNCHER_WALLET", "EPOCH_POST_GAS_COST", "NODE_OPTIONS"].includes(k)) continue;
    env[k] = v;
  }
  return { ...env, NEXT_TELEMETRY_DISABLED: "1", ...extra };
}

// Mocks for the sweep step, modelled on the fork-observed Pons behaviour (contracts/test/fork/PonsEscrowFork.t.sol).
// Compiled into the run dir and only ever deployed on the local anvil chain.
const SWEEP_MOCKS_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IEscrowCredit {
    function credit(address recipient) external payable;
}

contract SweepMockCurve {
    error NotFeeSweepOperator();
    address public immutable escrow;
    address public immutable recipient;
    address public immutable operator;
    uint256 public quoteFeeBalance;
    uint256 public creatorTaxBalance;

    constructor(address escrow_, address recipient_, address operator_) payable {
        escrow = escrow_;
        recipient = recipient_;
        operator = operator_;
        quoteFeeBalance = msg.value;
    }

    function sweepFees(uint256) external {
        if (msg.sender != operator && msg.sender != recipient) revert NotFeeSweepOperator();
        _sweep();
    }

    function operatorSweep() external {
        if (msg.sender != operator) revert NotFeeSweepOperator();
        _sweep();
    }

    function _sweep() internal {
        uint256 v = quoteFeeBalance + creatorTaxBalance;
        quoteFeeBalance = 0;
        creatorTaxBalance = 0;
        IEscrowCredit(escrow).credit{value: v}(recipient);
    }
}

contract SweepMockOperator {
    error SweepPaused();
    bool public paused;

    function setPaused(bool p) external {
        paused = p;
    }

    function sweepCurve(address curve) external {
        if (paused) revert SweepPaused();
        SweepMockCurve(curve).operatorSweep();
    }
}

contract SweepMockHook {
    address public feeSweepOperator;

    constructor(address op) {
        feeSweepOperator = op;
    }
}
`;

// ---- the test --------------------------------------------------------------------------------------
async function main() {
  mkdirSync(RUN_DIR, { recursive: true });
  // Stale app copies from an interrupted earlier run.
  for (const d of readdirSync(join(ROOT, "data"))) {
    if (d.startsWith("e2e-") && d !== `e2e-${RUN_ID}`) rmSync(join(ROOT, "data", d, "app"), { recursive: true, force: true });
  }
  log(`run dir ${RUN_DIR}`);

  step("1. preflight");
  const protoA = readFileSync(join(ROOT, "src", "lib", "protocol.ts"), "utf8");
  const protoB = readFileSync(join(ROOT, "node-client", "src", "protocol.ts"), "utf8");
  check("node-client/src/protocol.ts is identical to src/lib/protocol.ts", protoA === protoB);
  check("anvil and forge installed", existsSync(ANVIL) && existsSync(FORGE), FOUNDRY_BIN);
  check(`port ${ANVIL_PORT} free`, !(await portBusy(ANVIL_PORT)));
  check(`port ${NEXT_PORT} free`, !(await portBusy(NEXT_PORT)));

  step("2. reward contract sources");
  await waitFor("contracts/src/SparecycleRewards.sol", () => existsSync(CONTRACT_SRC) && existsSync(MOCK_SRC), {
    timeoutMs: 20 * 60_000,
    intervalMs: 15_000,
  });
  const forgeOut = join(RUN_DIR, "forge-out");
  await waitFor(
    "a clean forge build",
    () => {
      const r = spawnSync(
        FORGE,
        ["build", "--out", forgeOut, "--cache-path", join(RUN_DIR, "forge-cache"), "src/SparecycleRewards.sol", "src/SparecycleJobPayments.sol", "test/mocks/MockPonsFeeEscrow.sol"],
        { cwd: join(ROOT, "contracts"), encoding: "utf8" },
      );
      if (r.status !== 0) log(`forge build not clean yet: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
      return r.status === 0;
    },
    { timeoutMs: 20 * 60_000, intervalMs: 30_000 },
  );
  const rewardsArt = artifact(forgeOut, "SparecycleRewards.sol", "SparecycleRewards");
  const mockArt = artifact(forgeOut, "MockPonsFeeEscrow.sol", "MockPonsFeeEscrow");
  const payArt = artifact(forgeOut, "SparecycleJobPayments.sol", "SparecycleJobPayments");
  check("forge build", true);

  step("3. anvil");
  start("anvil", ANVIL, ["--port", String(ANVIL_PORT), "--host", "127.0.0.1", "--chain-id", "31337"]);
  const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
  await waitFor("anvil RPC", () => pub.getChainId().then((id) => id === 31337), { timeoutMs: 30_000 });
  const wallet = (a) => createWalletClient({ account: a, chain: foundry, transport: http(RPC) });
  check("anvil up", true, RPC);

  step("4. deploy");
  const { sparecycleRewardsAbi } = await srcImport("contracts/sparecycleRewards.ts");
  const { buildTree, getProof, leafOf, verifyProof } = await srcImport("lib/merkle.ts");
  const deploy = async (art, args) => {
    const hash = await wallet(admin).deployContract({ abi: art.abi, bytecode: art.bytecode, args });
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.contractAddress;
  };
  const escrow = await deploy(mockArt, []);
  const rewards = await deploy(rewardsArt, [admin.address, scheduler.address, "0x0000000000000000000000000000000000000000", escrow, BigInt(EPOCH_LENGTH)]);
  const read = (functionName, args = []) => pub.readContract({ address: rewards, abi: sparecycleRewardsAbi, functionName, args });
  const write = async (account, functionName, args = [], value) => {
    const { request } = await pub.simulateContract({ account, address: rewards, abi: sparecycleRewardsAbi, functionName, args, value });
    const hash = await wallet(account).writeContract(request);
    return pub.waitForTransactionReceipt({ hash });
  };
  check("SparecycleRewards deployed", Boolean(rewards), `${rewards} (escrow mock ${escrow})`);
  const payments = await deploy(payArt, [rewards, treasury]);
  check("SparecycleJobPayments deployed on the reward contract", Boolean(payments), payments);
  check("scheduler = anvil account 1", (await read("scheduler")).toLowerCase() === scheduler.address.toLowerCase());
  check("epoch length 30 s", (await read("epochLength")) === BigInt(EPOCH_LENGTH));
  // TS leaf == Solidity leaf
  const probeLeaf = leafOf(7n, ownerA.address, 123456789n);
  check("merkle.ts leafOf == contract leafOf", (await read("leafOf", [7n, ownerA.address, 123456789n])) === probeLeaf);

  step("5. fund the pot (local test ETH only)");
  await write(admin, "fund", [], parseEther("1"));
  {
    const hash = await wallet(admin).sendTransaction({ to: rewards, value: 1n }); // straight to receive(): unaccounted
    await pub.waitForTransactionReceipt({ hash });
  }
  check("fund() 1 ETH credited to epoch 0", (await read("getEpoch", [0n])).pot === parseEther("1"));
  check("1 wei pushed to receive() is unaccounted", (await read("unaccounted")) === 1n);

  step("6. sweep bot: curve -> Pons operator sweepCurve -> escrow -> claimFeesFromEscrow");
  const selfCheck = spawnSync(process.execPath, [join(ROOT, "scripts", "sweep.mjs"), "--self-check"], { cwd: ROOT, encoding: "utf8" });
  check("sweep --self-check: ABI selectors match the fork test", selfCheck.status === 0 && !selfCheck.stdout.includes("FAIL"), `${selfCheck.stdout.trim().split("\n").length - 1} selectors`);
  // Mocks of the fork-observed behaviour, compiled into the run dir: the curve's sweepFees() reverts
  // NotFeeSweepOperator() for anyone but the operator / recipient; the operator's sweepCurve(curve) is open (and can be
  // paused); the hook at the Pons hook address returns the operator from feeSweepOperator().
  const mockDir = join(RUN_DIR, "sweep-mocks");
  mkdirSync(join(mockDir, "src"), { recursive: true });
  writeFileSync(join(mockDir, "src", "SweepMocks.sol"), SWEEP_MOCKS_SOL);
  const mb = spawnSync(FORGE, ["build", "--root", mockDir], { cwd: mockDir, encoding: "utf8" });
  check("sweep mocks compiled", mb.status === 0, (mb.stderr || "").trim().split("\n").slice(-1)[0]);
  const mockOut = join(mockDir, "out");
  const opArt = artifact(mockOut, "SweepMocks.sol", "SweepMockOperator");
  const curveArt = artifact(mockOut, "SweepMocks.sol", "SweepMockCurve");
  const hookArt = artifact(mockOut, "SweepMocks.sol", "SweepMockHook");
  const operator = await deploy(opArt, []);
  const curveFees = parseEther("0.25");
  const curve = await (async () => {
    const hash = await wallet(admin).deployContract({ abi: curveArt.abi, bytecode: curveArt.bytecode, args: [escrow, rewards, operator], value: curveFees });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
  })();
  const { PONS } = await srcImport("lib/pons.ts");
  const hookTmp = await deploy(hookArt, [operator]);
  await pub.request({ method: "anvil_setCode", params: [PONS.memeHook, await pub.getCode({ address: hookTmp })] });
  await pub.request({ method: "anvil_setStorageAt", params: [PONS.memeHook, `0x${"0".repeat(64)}`, `0x${operator.slice(2).toLowerCase().padStart(64, "0")}`] });
  const sweepEnv = cleanEnv({ NEXT_PUBLIC_NETWORK: "local", NEXT_PUBLIC_RPC_URL: RPC, NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS: rewards, NEXT_PUBLIC_CURVE_ADDRESS: curve });
  // A fresh key that anvil has NOT unlocked: the bot must sign locally (real RPCs refuse eth_sendTransaction).
  const sweepKey = generatePrivateKey();
  await pub.request({ method: "anvil_setBalance", params: [privateKeyToAccount(sweepKey).address, "0xde0b6b3a7640000"] });
  const sweep = (args, extra = {}) =>
    spawnSync(process.execPath, [join(ROOT, "scripts", "sweep.mjs"), ...args], { cwd: ROOT, env: { ...sweepEnv, ...extra }, encoding: "utf8" });
  const curveRead = (functionName) => pub.readContract({ address: curve, abi: curveArt.abi, functionName });
  let directSweep = null;
  try {
    await pub.simulateContract({ account: sweeper, address: curve, abi: curveArt.abi, functionName: "sweepFees", args: [0n] });
  } catch (e) {
    directSweep = revertName(e);
  }
  check("mock curve holds 0.25 ETH of fees; a direct sweepFees(0) reverts NotFeeSweepOperator()", (await curveRead("quoteFeeBalance")) === curveFees && directSweep === "NotFeeSweepOperator");

  // a) operator paused: the bot alerts, keeps going, and skips the empty escrow claim (NoBalance) without an error.
  {
    const hash = await wallet(admin).writeContract({ address: operator, abi: opArt.abi, functionName: "setPaused", args: [true] });
    await pub.waitForTransactionReceipt({ hash });
  }
  const paused = sweep(["--send"], { SWEEP_SIGNER_KEY: sweepKey });
  log(`sweep --send, operator paused:\n${paused.stdout.trim()}`);
  check("paused operator: ALERT with the raw revert selector, exit 0", paused.status === 0 && /ALERT: operator\.sweepCurve reverted \(reverted with undecoded error 0x[0-9a-f]{8}\)/.test(paused.stdout));
  check("empty escrow: claim skipped with a NoBalance note", /balance is 0, skipping claimFeesFromEscrow\(\) \(the escrow reverts NoBalance\(\)/.test(paused.stdout) && !paused.stdout.includes("sent: rewards.claimFeesFromEscrow"));
  check("nothing moved while paused", (await curveRead("quoteFeeBalance")) === curveFees && (await read("getEpoch", [0n])).pot === parseEther("1"));
  {
    const hash = await wallet(admin).writeContract({ address: operator, abi: opArt.abi, functionName: "setPaused", args: [false] });
    await pub.waitForTransactionReceipt({ hash });
  }

  // b) dry-run: reads the operator live from the hook and simulates sweepCurve; no state change.
  const dry = sweep([]);
  log(`sweep dry-run:\n${dry.stdout.trim()}`);
  check("dry-run: operator read live from hook.feeSweepOperator()", dry.status === 0 && dry.stdout.toLowerCase().includes(`feesweepoperator()): ${operator.toLowerCase()}`));
  check("dry-run: sweepCurve simulated, nothing sent", dry.stdout.toLowerCase().includes(`dry-run: operator.sweepcurve(${curve.toLowerCase()}) would succeed`) && !dry.stdout.includes("sent:") && (await curveRead("quoteFeeBalance")) === curveFees);

  // c) --send: sweep through the operator, then claim the escrow into the pot, in one run.
  const sent = sweep(["--send"], { SWEEP_SIGNER_KEY: sweepKey });
  log(`sweep --send:\n${sent.stdout.trim()}`);
  check("--send: operator.sweepCurve then rewards.claimFeesFromEscrow() sent", sent.status === 0 && /sent: operator\.sweepCurve/.test(sent.stdout) && /sent: rewards\.claimFeesFromEscrow\(\)/.test(sent.stdout));
  const escrowLeft = await pub.readContract({ address: escrow, abi: mockArt.abi, functionName: "balanceOf", args: [rewards] });
  check("curve swept, escrow emptied, pot = 1.25 ETH", (await curveRead("quoteFeeBalance")) === 0n && escrowLeft === 0n && (await read("getEpoch", [0n])).pot === parseEther("1.25"));
  check("sweep never printed the signer key", ![paused, sent].some((r) => (r.stdout + r.stderr).includes(sweepKey.slice(2))));
  let expectedPot = parseEther("1.25") + 1n; // + 95% of the paid job, added after the close

  step("7. scheduler (next dev) from an isolated app copy");
  mkdirSync(APP_DIR, { recursive: true });
  for (const f of ["src", "public", "next.config.ts", "tsconfig.json", "package.json", "postcss.config.mjs"]) {
    if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(APP_DIR, f), { recursive: true });
  }
  const dbPath = join(RUN_DIR, "sparecycle.db");
  const startNext = async (name, extra = {}) => {
    const child = start(name, process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(NEXT_PORT), "-H", "127.0.0.1"], {
      cwd: APP_DIR,
      env: cleanEnv({
        NEXT_PUBLIC_NETWORK: "local",
        NEXT_PUBLIC_RPC_URL: RPC,
        NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS: rewards,
        NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS: payments,
        NEXT_PUBLIC_JOB_PRICE_WEI_PER_UNIT: PRICE_WEI_PER_UNIT.toString(),
        TEAM_JOB_WALLETS: sweeper.address,
        NEXT_PUBLIC_EPOCH_LENGTH: String(EPOCH_LENGTH),
        NEXT_PUBLIC_NODE_PAYOUT_ASSET: "ETH",
        SCHEDULER_SIGNER_KEY: ANVIL_KEYS[1],
        SCHEDULER_ADMIN_TOKEN: ADMIN_TOKEN,
        SCHEDULER_ALLOW_DEV_RUNNER: "1",
        JOB_RATE_LIMIT: "4",
        DB_PATH: dbPath,
        ...extra,
      }),
    });
    await waitFor("GET /api/v1/health", async () => (await api("GET", "/health")).data?.ok === true, { timeoutMs: 180_000, intervalMs: 1000 });
    return child;
  };
  let nextProc = await startNext("next");
  const st0 = await api("GET", "/status");
  check("status: contract clock, epoch 0, root posting configured", st0.status === 200 && st0.data.epoch.clock === "contract" && st0.data.epoch.id === 0 && st0.data.rootPosting === "configured", JSON.stringify(st0.data.epoch));
  check("status: trust = centralized-scheduler", st0.data.trust === "centralized-scheduler");
  const early = await api("GET", `/epochs/0/proof?account=${ownerA.address}`);
  check("proof of an open epoch -> 409 epoch-open", early.status === 409 && early.data.error === "epoch-open");
  const unauth = await api("POST", "/epochs/close");
  check("close without the admin token -> 401", unauth.status === 401 && unauth.data.error === "unauthorized");

  step("8. two dev-runner node clients (owners = anvil accounts 2 and 3)");
  const agent = join(ROOT, "node-client", "src", "agent.ts");
  const nodes = [
    { name: "node-a", owner: ownerA, gpu: "E2E-GPU-A" },
    { name: "node-b", owner: ownerB, gpu: "E2E-GPU-B" },
  ];
  for (const n of nodes) {
    n.keyFile = join(RUN_DIR, `${n.name}-key.json`);
    const init = spawnSync(process.execPath, [agent, "init", "--key-file", n.keyFile], { cwd: ROOT, encoding: "utf8" });
    check(`${n.name}: init`, init.status === 0 && !init.stdout.includes(JSON.parse(readFileSync(n.keyFile, "utf8")).privateKey.slice(2)), "private key not printed");
    const nodeKey = privateKeyToAccount(JSON.parse(readFileSync(n.keyFile, "utf8")).privateKey).address;
    const msg = `Sparecycle: link node ${nodeKey.toLowerCase()} to wallet ${n.owner.address.toLowerCase()}`;
    const lm = spawnSync(process.execPath, [agent, "link-message", "--owner", n.owner.address, "--key-file", n.keyFile], { cwd: ROOT, encoding: "utf8" });
    check(`${n.name}: link-message prints the exact message`, lm.status === 0 && lm.stdout.includes(msg));
    const sig = await n.owner.signMessage({ message: msg });
    start(n.name, process.execPath, [agent, "start", "--network", SITE, "--owner", n.owner.address, "--owner-sig", sig, "--dev-runner", "--key-file", n.keyFile], {
      env: cleanEnv({ SPARECYCLE_GPU_UUID: n.gpu }),
    });
  }
  await waitFor("2 registered online nodes", async () => {
    const r = await api("GET", "/nodes");
    return r.data.nodes?.filter((x) => x.online).length === 2;
  }, { timeoutMs: 60_000 });
  check("both nodes registered and online", true);

  step("9. submit 2 image + 1 text jobs and wait for agreement");
  const specs = [
    { kind: "image", params: { model: "sd15", prompt: "a lighthouse at dusk, oil painting", width: 256, height: 256, steps: 10 } },
    { kind: "image", params: { model: "sd15", prompt: "a red bicycle", negative: "blurry", width: 320, height: 256, steps: 12, guidance: 6.5, seed: 42 } },
    { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "Explain an epoch in one sentence.", system: "Be brief.", maxTokens: 64 } },
  ];
  const jobIds = [];
  for (const s of specs) {
    const r = await api("POST", "/jobs", s);
    check(`POST /jobs ${s.kind}`, r.status === 201 && r.data.status === "queued", r.data.id ?? JSON.stringify(r.data));
    jobIds.push(r.data.id);
  }
  const bad = await api("POST", "/jobs", { kind: "image", params: { model: "sdxl", prompt: "x", width: 256, height: 256, steps: 10 } });
  check("non-MVP model rejected", bad.status === 400 && bad.data.error === "invalid-job");
  await waitFor("all jobs agreed", async () => {
    const r = await api("GET", "/jobs?limit=20");
    const mine = r.data.jobs.filter((j) => jobIds.includes(j.id));
    if (mine.some((j) => ["disagreed", "expired", "rejected"].includes(j.status))) throw new Error(`job failed: ${JSON.stringify(mine)}`);
    return mine.length === 3 && mine.every((j) => j.status === "agreed");
  }, { timeoutMs: 120_000, intervalMs: 1000 });
  const list = (await api("GET", "/jobs?limit=20")).data.jobs;
  check("3 jobs agreed in epoch 0, eligible, not yet paid", list.filter((j) => jobIds.includes(j.id)).every((j) => j.epochId === 0 && j.eligible && !j.paid));
  check("job list never carries prompts", !JSON.stringify(list).includes("lighthouse"));
  const img = await api("GET", `/jobs/${jobIds[0]}/output`);
  check("image output is a PNG", img.status === 200 && img.type === "image/png" && img.data.subarray(1, 4).toString() === "PNG");
  const txt = await api("GET", `/jobs/${jobIds[2]}/output`);
  check("text output served", txt.status === 200 && txt.type.startsWith("text/plain") && txt.data.toString().length > 0);
  const detail = await api("GET", `/jobs/${jobIds[1]}`);
  check("job detail: seed kept, output url, no prompt", detail.data.params.seed === 42 && detail.data.output?.endsWith("/output") && !JSON.stringify(detail.data).includes("bicycle"));

  step("9b. paid job: deposit, signed payment, held balance");
  const { jobPaymentsAbi } = await srcImport("contracts/jobPayments.ts");
  const { jobPaymentMessage, jobPriceWei, jobRequestHash } = await srcImport("lib/job-payment.ts");
  {
    const hash = await wallet(customer).writeContract({ address: payments, abi: jobPaymentsAbi, functionName: "deposit", value: parseEther("0.01") });
    await pub.waitForTransactionReceipt({ hash });
  }
  const acct0 = (await api("GET", "/payments/account?address=" + customer.address)).data;
  check("account: 0.01 ETH deposited, all available", acct0.balance === parseEther("0.01").toString() && acct0.available === acct0.balance, JSON.stringify(acct0));
  const paidReq = { kind: "image", params: { model: "sd15", prompt: "a paid lighthouse", width: 256, height: 256, steps: 10 } };
  const paidPrice = jobPriceWei(paidReq, PRICE_WEI_PER_UNIT);
  const signPayment = async (who, request, priceWei, issued = Math.floor(Date.now() / 1000)) => ({
    payer: who.address,
    issued,
    priceWei: priceWei.toString(),
    signature: await who.signMessage({
      message: jobPaymentMessage({ chainId: 31337, contract: payments, requestHash: jobRequestHash(request), priceWei, issued }),
    }),
  });
  const payment = await signPayment(customer, paidReq, paidPrice);
  const paid = await api("POST", "/jobs", { request: paidReq, payment });
  check("paid job accepted with the quoted price", paid.status === 201 && paid.data.priceWei === paidPrice.toString(), JSON.stringify(paid.data));
  const replay = await api("POST", "/jobs", { request: paidReq, payment });
  check("same payment signature twice -> 409 payment-used", replay.status === 409 && replay.data.error === "payment-used", replay.data.error);
  const wrongPrice = await api("POST", "/jobs", { request: paidReq, payment: await signPayment(customer, paidReq, paidPrice - 1n) });
  check("wrong price -> 409 price-changed", wrongPrice.status === 409 && wrongPrice.data.error === "price-changed");
  const swapped = { ...paidReq, params: { ...paidReq.params, prompt: "swapped" } };
  const forged = await api("POST", "/jobs", { request: swapped, payment: await signPayment(customer, paidReq, paidPrice) });
  check("payment for another request -> 401", forged.status === 401 && forged.data.error === "bad-payment-signature");
  const broke = await api("POST", "/jobs", { request: paidReq, payment: await signPayment(ownerA, paidReq, paidPrice) });
  check("no deposit -> 402 insufficient-balance", broke.status === 402 && broke.data.error === "insufficient-balance");
  const stale = await api("POST", "/jobs", { request: paidReq, payment: await signPayment(customer, paidReq, paidPrice, Math.floor(Date.now() / 1000) - 3600) });
  check("hour-old signature -> 400 stale-payment", stale.status === 400 && stale.data.error === "stale-payment");
  const acct1 = (await api("GET", "/payments/account?address=" + customer.address)).data;
  check("price held from the available balance", BigInt(acct1.held) === paidPrice && BigInt(acct1.available) === parseEther("0.01") - paidPrice, JSON.stringify(acct1));
  await waitFor("paid job agreed", async () => {
    const r = await api("GET", "/jobs/" + paid.data.id);
    if (["disagreed", "expired", "rejected"].includes(r.data.status)) throw new Error("paid job " + r.data.status);
    return r.data.status === "agreed";
  }, { timeoutMs: 120_000, intervalMs: 1000 });
  const paidRow = (await api("GET", "/jobs?limit=20")).data.jobs.find((j) => j.id === paid.data.id);
  check("job list marks it paid, charge pending", paidRow.payment === "paid" && paidRow.chargeStatus === "pending" && paidRow.priceWei === paidPrice.toString(), JSON.stringify(paidRow));
  check("free jobs are marked free", (await api("GET", "/jobs?limit=20")).data.jobs.filter((j) => jobIds.includes(j.id)).every((j) => j.payment === "free"));
  const treasuryBefore = await pub.getBalance({ address: treasury });

  step("10. warp past the epoch end and close");
  const canEarly = await read("canClose", [0n]);
  if (!canEarly) {
    const tooEarly = await api("POST", "/epochs/close", undefined, { authorization: `Bearer ${ADMIN_TOKEN}` });
    check("close before the on-chain end -> 409 epoch-not-over", tooEarly.status === 409 && tooEarly.data.error === "epoch-not-over");
  }
  await pub.request({ method: "evm_increaseTime", params: [EPOCH_LENGTH * 2] });
  await pub.request({ method: "evm_mine", params: [] });
  check("canClose(0) after the warp", await read("canClose", [0n]));
  const close = await api("POST", "/epochs/close", undefined, { authorization: `Bearer ${ADMIN_TOKEN}` });
  log(`close -> ${close.status} ${JSON.stringify(close.data)}`);
  check("close posted the root", close.status === 200 && close.data.epoch.status === "posted" && /^0x[0-9a-f]{64}$/.test(close.data.epoch.postedTx ?? ""));
  const postTx = await pub.getTransactionReceipt({ hash: close.data.epoch.postedTx });
  check("root posted from the scheduler key (anvil account 1)", postTx.from.toLowerCase() === scheduler.address.toLowerCase() && postTx.status === "success");

  step("11. on-chain settlement checks");
  const e0 = await read("getEpoch", [0n]);
  const e1 = await read("getEpoch", [1n]);
  const tree = (await api("GET", "/epochs/0/tree")).data;
  check("epoch 0 settled on-chain", e0.settled === true && (await read("currentEpoch")) === 1n);
  const toTreasury = (paidPrice * 500n) / 10_000n;
  expectedPot += paidPrice - toTreasury;
  check("pot = 1 ETH fund + 0.25 ETH escrow + 1 wei unaccounted + 95% of the paid job", e0.pot === expectedPot, String(e0.pot));
  const charges = (await api("GET", "/epochs/0/charges")).data;
  check("charge list published, done, one job", charges.status === "done" && charges.jobs.length === 1 && charges.jobs[0].jobId === paid.data.id, JSON.stringify(charges));
  const chargeRcpt = await pub.getTransactionReceipt({ hash: charges.tx });
  check("charge sent from the scheduler key", chargeRcpt.status === "success" && chargeRcpt.from.toLowerCase() === scheduler.address.toLowerCase());
  const viem = await import("viem");
  check("published list hashes to the on-chain listHash", charges.listHash === viem.keccak256(viem.toHex(JSON.stringify(charges.jobs))));
  check("treasury got 5%", (await pub.getBalance({ address: treasury })) - treasuryBefore === toTreasury, toTreasury + " wei");
  const acct2 = (await api("GET", "/payments/account?address=" + customer.address)).data;
  check("customer balance reduced by the price, nothing held", BigInt(acct2.balance) === parseEther("0.01") - paidPrice && acct2.held === "0", JSON.stringify(acct2));
  check("job marked charged", (await api("GET", "/jobs?limit=20")).data.jobs.find((j) => j.id === paid.data.id)?.chargeStatus === "charged");
  check("scheduler read the same pot", tree.potAtClose === expectedPot.toString(), `${tree.potAtClose}`);
  check("on-chain root == published root", e0.merkleRoot.toLowerCase() === tree.root.toLowerCase(), tree.root);
  check("on-chain reserved == published reserved", e0.reserved.toString() === tree.reserved, tree.reserved);
  check("reserved <= pot", e0.reserved <= e0.pot, `${e0.reserved} <= ${e0.pot}`);
  check("rollover landed in epoch 1", e1.pot === e0.pot - e0.reserved, `${e1.pot} wei`);
  check("two leaves: one per owner", tree.leaves.length === 2 && [ownerA, ownerB].every((o) => tree.leaves.some((l) => l.account === o.address)));
  check("leaves sum to reserved", tree.leaves.reduce((s, l) => s + BigInt(l.amount), 0n) === e0.reserved);
  const rebuilt = buildTree(tree.leaves.map((l) => leafOf(0n, l.account, BigInt(l.amount))));
  check("merkle.ts rebuilds the posted root from the leaves", rebuilt.root === tree.root);
  const epochs = (await api("GET", "/epochs")).data.epochs;
  check("/epochs lists 0 posted and 1 open", epochs.find((e) => e.id === 0)?.status === "posted" && epochs.find((e) => e.id === 1)?.status === "open");
  const st1 = (await api("GET", "/status")).data;
  check("status: lastSettled = epoch 0 with tx, current epoch 1", st1.lastSettled?.id === 0 && st1.lastSettled.postedTx === close.data.epoch.postedTx && st1.epoch.id === 1);
  const paidList = (await api("GET", "/jobs?limit=20")).data.jobs.filter((j) => jobIds.includes(j.id));
  check("jobs now marked paid", paidList.every((j) => j.paid));

  step("12. claims");
  const stranger = await api("GET", `/epochs/0/proof?account=${sweeper.address}`);
  check("proof for a non-member -> 404 not-in-root", stranger.status === 404 && stranger.data.error === "not-in-root");
  for (const o of [ownerA, ownerB]) {
    const p = (await api("GET", `/epochs/0/proof?account=${o.address}`)).data;
    const amount = BigInt(p.amount);
    check(`${o.address.slice(0, 8)}: proof verifies locally`, verifyProof(p.proof, p.root, leafOf(0n, o.address, amount)) && p.leaf === leafOf(0n, o.address, amount));
    check(`${o.address.slice(0, 8)}: local proof == merkle.ts proof`, JSON.stringify(getProof(rebuilt, p.leaf)) === JSON.stringify(p.proof));
    const before = await pub.getBalance({ address: o.address });
    const rcpt = await write(o, "claim", [0n, amount, p.proof]);
    const after = await pub.getBalance({ address: o.address });
    const gas = rcpt.gasUsed * rcpt.effectiveGasPrice;
    check(`${o.address.slice(0, 8)}: balance rose by exactly the leaf amount`, after - before + gas === amount, `${amount} wei`);
    let second = null;
    try {
      await pub.simulateContract({ account: o, address: rewards, abi: sparecycleRewardsAbi, functionName: "claim", args: [0n, amount, p.proof] });
    } catch (e) {
      second = revertName(e);
    }
    check(`${o.address.slice(0, 8)}: second claim reverts AlreadyClaimed`, second === "AlreadyClaimed", String(second));
  }
  const e0b = await read("getEpoch", [0n]);
  check("claimed == reserved", e0b.claimed === e0b.reserved);

  step("13. rate limit");
  const fourth = await api("POST", "/jobs", { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "one more", maxTokens: 16 } });
  check("4th job accepted (JOB_RATE_LIMIT=4)", fourth.status === 201);
  const fifth = await api("POST", "/jobs", { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "one too many", maxTokens: 16 } });
  check("5th job in the hour -> 429 rate-limited", fifth.status === 429 && fifth.data.error === "rate-limited");
  await waitFor("4th job agreed", async () => (await api("GET", `/jobs/${fourth.data.id}`)).data.status === "agreed", { timeoutMs: 60_000 });
  check("4th job agreed in epoch 1", (await api("GET", `/jobs/${fourth.data.id}`)).data.epochId === 1);

  step("14. restart on the same DB with SCHEDULER_AUTOCLOSE=1");
  await write(admin, "fund", [], parseEther("0.1"));
  const pot1 = (await read("getEpoch", [1n])).pot;
  check("epoch 1 pot = 1 wei rollover + 0.1 ETH", pot1 === e0.pot - e0.reserved + parseEther("0.1"), `${pot1}`);
  killTree(nextProc);
  await waitFor("next stopped", async () => !(await portBusy(NEXT_PORT)), { timeoutMs: 30_000 });
  nextProc = await startNext("next-restart", { SCHEDULER_AUTOCLOSE: "1" });
  const afterRestart = (await api("GET", "/epochs")).data.epochs;
  check("state survived the restart (epoch 0 posted, epoch 1 open)", afterRestart.find((e) => e.id === 0)?.status === "posted" && afterRestart.find((e) => e.id === 1)?.status === "open");
  check("jobs survived the restart", (await api("GET", "/jobs?limit=20")).data.jobs.filter((j) => j.status === "agreed").length === 5); // 3 + 1 free from the rate-limit step + 1 paid
  await pub.request({ method: "evm_increaseTime", params: [EPOCH_LENGTH * 2] });
  await pub.request({ method: "evm_mine", params: [] });
  await waitFor("autoclose to post epoch 1", async () => (await api("GET", "/epochs")).data.epochs.find((e) => e.id === 1)?.status === "posted", {
    timeoutMs: 90_000,
    intervalMs: 2000,
  });
  const e1s = await read("getEpoch", [1n]);
  const tree1 = (await api("GET", "/epochs/1/tree")).data;
  check("autoclose posted epoch 1 on-chain", e1s.settled && e1s.merkleRoot.toLowerCase() === tree1.root.toLowerCase() && e1s.reserved.toString() === tree1.reserved);
  check("epoch 1: reserved <= pot, two leaves", e1s.reserved <= e1s.pot && tree1.leaves.length === 2, `${e1s.reserved} of ${e1s.pot}`);
  check("epoch 2 got the epoch 1 rollover", (await read("getEpoch", [2n])).pot === e1s.pot - e1s.reserved);

  step("15. an epoch with no agreed jobs posts root 0 / reserved 0");
  await pub.request({ method: "evm_increaseTime", params: [EPOCH_LENGTH * 2] });
  await pub.request({ method: "evm_mine", params: [] });
  await waitFor("autoclose to post epoch 2", async () => (await api("GET", "/epochs")).data.epochs.find((e) => e.id === 2)?.status === "posted", {
    timeoutMs: 90_000,
    intervalMs: 2000,
  });
  const e2s = await read("getEpoch", [2n]);
  check("epoch 2: root 0x00…00, reserved 0, settled", e2s.settled && /^0x0{64}$/.test(e2s.merkleRoot) && e2s.reserved === 0n);
  check("epoch 3 got the whole epoch 2 pot", (await read("getEpoch", [3n])).pot === e2s.pot, `${e2s.pot} wei`);
  const p2 = await api("GET", `/epochs/2/proof?account=${ownerA.address}`);
  check("proof in an empty epoch -> 404 not-in-root", p2.status === 404 && p2.data.error === "not-in-root");

  step("16. node logs");
  for (const n of nodes) {
    const text = readFileSync(join(RUN_DIR, `${n.name}.log`), "utf8");
    check(`${n.name}: no rejected requests (replay / signature / dev-runner)`, !/replayed-request|bad-signature|stale-request|bad-receipt|dev-runner-not-accepted|failed:/.test(text));
    check(`${n.name}: log shows the dev-runner banner`, text.includes("DEV RUNNER") && text.includes("NEVER paid"));
  }
}

let failed = null;
try {
  await main();
} catch (e) {
  failed = e;
  log(`ERROR in step "${currentStep}": ${e?.stack ?? e}`);
}
cleanup();
const passed = results.filter((r) => r.ok).length;
console.log("\n================ Sparecycle e2e (local, no GPU, no real funds) ================");
console.log(`checks passed: ${passed}/${results.length}`);
if (failed) console.log(`stopped at: ${currentStep}`);
console.log(`logs and scratch DB: ${RUN_DIR}`);
console.log(failed ? "RESULT: FAIL" : "RESULT: PASS");
process.exitCode = failed ? 1 : 0;
