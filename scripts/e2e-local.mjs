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
//     distinct node keys and fake GPU UUIDs; the scheduler runs GPU_ALLOWLIST_MODE=enforce and CHALLENGE_MODE=enforce,
//     so both nodes must first pass a GPU challenge (dev-runner reference) before they get jobs
//  5b. GPU gate round with signed requests from this script: a challenge-capable node fails -> cooldown, fails again
//     -> suspended, is re-issued by the admin endpoint and passes; an old 0.2.0-style node never gets a challenge; a
//     software rasterizer is refused (403 gpu-not-supported); an untested family registers as untested
//  6. submit 2 image + 1 text jobs, wait until both nodes agree; a paid job and a team test job, and their receipts:
//     provisional at the verdict with both node signatures
//  7. warp anvil past the epoch end, POST /api/v1/epochs/close (posts the root on-chain)
//  7b. the charge commits the jobs root (hashRule v2-jobs-merkle) as the Charged event's listHash; the public charge
//     list shows per-customer totals (= CustomerCharged) and salted leaves, no job ids or salts; both receipts are sealed and verify
//     against the Charged event read from anvil (src/lib/job-receipt.ts, the browser's check); a tampered one fails
//  8. each owner fetches its proof and claims; balances must rise by exactly the leaf amount; a second claim
//     must revert AlreadyClaimed; reserved <= pot; the rollover lands in epoch 1
//  9. rate limit; restart the scheduler on the same DB with SCHEDULER_AUTOCLOSE=1 and OUTPUT_AUTH=enforce and let the
//     timer close a funded epoch and then an empty one (root 0x00…00, reserved 0)
// 9b. re-check on a new pair (feature brief #9): the two honest nodes stop and six dev runners started with
//     SPARECYCLE_DEV_CORRUPT=1 (wrong job outputs on purpose, correct GPU challenges) take over. A paid image job runs
//     three mismatching rounds, each on node keys, owners and GPUs new to the job, and ends disagreed, not charged; a
//     free job's mismatch ends disagreed with no re-check. A paid text job mismatches on two corrupting nodes, waits in
//     round 1 (they are excluded) with the price still held, then agrees on the honest pair once it restarts; that
//     epoch's payout tree holds only the honest pair's owners and the charge list only that job
// 10. private outputs (OUTPUT_AUTH=enforce, nodes stopped): the 401/403/404/409/200 route matrix with read secrets and
//     wallet sign-in (EOA and an ERC-1271 smart wallet), the retired /output URL (410), and no /api/v1/jobs/* response
//     ever carrying a `public` cache directive
// 11. PASS / FAIL summary; every process started here is stopped, even on failure
//
// With E2E_X402=1 (E2E_X402=1 npm run e2e:local) the run also covers x402 pay-per-job (src/server/x402.ts; INTERNAL
// REVIEW ONLY build): a mock EIP-3009 token and SparecycleX402Escrow on anvil, the scheduler with X402_ENABLED=1; 9c: 402
// -> signed TransferWithAuthorization -> escrow funded on-chain -> job agreed -> forwarded (95% to forwardTo, 5% to the
// treasury); after the close of epoch 0 the x402 tree and the payer's receipt against the escrow events; 16b: an x402
// job no pair agrees on is refunded in full. Without E2E_X402 none of this runs and the default run is unchanged.
//
// The anvil keys below are the well-known public anvil/hardhat dev keys. They are for this local test only and
// must never be used anywhere else.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { createSiweMessage } from "viem/siwe";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANVIL_PORT = 8548;
const NEXT_PORT = 3210;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const SITE = `http://127.0.0.1:${NEXT_PORT}`;
const API = `${SITE}/api/v1`;
const ADMIN_TOKEN = "test";
const EPOCH_LENGTH = 30;
const CHALLENGE_COOLDOWN_S = 20; // CHALLENGE_COOLDOWN_HOURS for this test, in seconds (longer than one 8 s long poll)
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
/** E2E_X402=1: also run the x402 pay-per-job path (see the header). */
const X402 = process.env.E2E_X402 === "1";
const X402_PRICE_PER_UNIT = 10n; // mock-token units per work unit in this test

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
  for (const dir of [APP_DIR, join(RUN_DIR, "forge-out"), join(RUN_DIR, "forge-cache"), join(RUN_DIR, "sweep-mocks"), join(RUN_DIR, "auth-mocks")]) {
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

// Cache-Control of every /api/v1/jobs* response this test saw: none may carry a `public` directive.
const jobsCacheHeaders = [];

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (path.startsWith("/jobs")) jobsCacheHeaders.push({ method, path, status: res.status, cc: res.headers.get("cache-control") ?? "" });
  const type = res.headers.get("content-type") ?? "";
  const data = method === "HEAD" ? Buffer.alloc(0) : type.includes("application/json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, type, data, headers: res.headers };
}

const isPrivate = (r) => r.headers.get("cache-control") === "private, no-store" && /Authorization/.test(r.headers.get("vary") ?? "") && /Cookie/.test(r.headers.get("vary") ?? "");

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
    if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|SPARECYCLE_|X402_)/.test(k)) continue;
    if (["DB_PATH", "PAYOUT_CAP_PER_UNIT", "JOB_RATE_LIMIT", "LAUNCHER_WALLET", "EPOCH_POST_GAS_COST", "NODE_OPTIONS", "OUTPUT_AUTH", "OUTPUT_RATE_LIMIT", "AUTH_DOMAIN"].includes(k)) continue;
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

// A minimal ERC-1271 smart wallet for the sign-in test: valid when the owner EOA signed the hash. Local anvil only.
const AUTH_MOCKS_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract Mock1271Wallet {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (sig.length != 65) return 0xffffffff;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
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
        [
          "build",
          "--out",
          forgeOut,
          "--cache-path",
          join(RUN_DIR, "forge-cache"),
          "src/SparecycleRewards.sol",
          "src/SparecycleJobPayments.sol",
          "test/mocks/MockPonsFeeEscrow.sol",
          ...(X402 ? ["src/SparecycleX402Escrow.sol", "test/mocks/MockEIP3009.sol"] : []),
        ],
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
  // x402 (E2E_X402=1): a mock EIP-3009 token named like USDG and the escrow on the reward contract (12 h settle window).
  const x402ForwardTo = privateKeyToAccount(generatePrivateKey()).address; // stands in for the Safe-controlled converter
  let x402Token = null;
  let x402Escrow = null;
  if (X402) {
    x402Token = await deploy(artifact(forgeOut, "MockEIP3009.sol", "MockEIP3009Token"), ["Global Dollar", "1", 6]);
    x402Escrow = await deploy(artifact(forgeOut, "SparecycleX402Escrow.sol", "SparecycleX402Escrow"), [
      admin.address,
      rewards,
      x402Token,
      treasury,
      x402ForwardTo,
      43_200n,
      [10_000_000n, 1_000_000_000n, 100_000_000n],
    ]);
    check("x402: mock EIP-3009 token and SparecycleX402Escrow deployed", Boolean(x402Token && x402Escrow), `${x402Token} ${x402Escrow}`);
  }
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
  let expectedPot = parseEther("1.25") + 1n; // + 95% of the paid and team jobs, added after the close

  step("7. scheduler (next dev) from an isolated app copy");
  mkdirSync(APP_DIR, { recursive: true });
  for (const f of ["src", "public", "bench", "next.config.ts", "tsconfig.json", "package.json", "postcss.config.mjs"]) {
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
        GPU_ALLOWLIST_MODE: "enforce",
        CHALLENGE_MODE: "enforce",
        CHALLENGE_COOLDOWN_HOURS: String(CHALLENGE_COOLDOWN_S / 3600),
        JOB_RATE_LIMIT: "4",
        DB_PATH: dbPath,
        ...(X402
          ? {
              X402_ENABLED: "1",
              X402_ESCROW_ADDRESS: x402Escrow,
              X402_ASSET_ADDRESS: x402Token,
              X402_ASSET_NAME: "Global Dollar",
              X402_ASSET_VERSION: "1",
              X402_PRICE_PER_UNIT: X402_PRICE_PER_UNIT.toString(),
            }
          : {}),
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

  step("8b. GPU gate: allowlist + challenge round");
  const proto = await srcImport("lib/protocol.ts");
  const { devText } = await import(pathToFileURL(join(ROOT, "node-client", "src", "dev-runner.ts")).href);
  /** A signed node request, as the node client sends it. */
  const nodeCall = async (account, path, body = {}) => {
    const text = JSON.stringify({ ...body, nonce: proto.requestNonce() });
    const headers = await proto.signRequest(account, "POST", new URL(API + path).pathname, text);
    const res = await fetch(API + path, { method: "POST", headers, body: text, signal: AbortSignal.timeout(60_000) });
    return { status: res.status, data: res.status === 204 ? null : await res.json().catch(() => null) };
  };
  const registerManual = async (account, owner, extra) =>
    nodeCall(account, "/nodes/register", {
      gpuUuid: `E2E-GPU-${account.address.slice(2, 8)}`,
      vramMb: 8192,
      caps: ["text:qwen2.5-1.5b"],
      owner: owner.address,
      ownerSig: await owner.signMessage({ message: proto.linkMessage(account.address, owner.address) }),
      backend: "cuda",
      ...extra,
    });
  const answerChallenge = async (account, c, text, chainId) => {
    const outputHash = proto.sha256Hex(text);
    const signature = await proto.signChallengeResult(account, chainId, { challengeId: c.challengeId, node: account.address, outputHash, gpuMs: 5n });
    return nodeCall(account, `/challenges/${c.challengeId}/result`, { text, outputHash, gpuMs: 5, signature, dev: true, runner: "dev" });
  };
  const fresh = () => privateKeyToAccount(generatePrivateKey());
  const gate = (await api("GET", "/status")).data.gpuGate;
  check("status: GPU allowlist and challenge both enforce", gate?.allowlist === "enforce" && gate?.challenge === "enforce", JSON.stringify(gate));
  await waitFor("both dev nodes pass their first GPU challenge", async () => {
    const r = await api("GET", "/nodes");
    return r.data.nodes.filter((x) => x.dev && x.challengeState === "eligible").length === 2;
  }, { timeoutMs: 60_000 });
  const devNodes = (await api("GET", "/nodes")).data.nodes.filter((x) => x.dev);
  check("dev nodes: family dev-runner, gpuStatus eligible, challenge passed", devNodes.every((x) => x.gpuFamily === "dev-runner" && x.gpuStatus === "eligible"));

  // C: a challenge-capable node with a "faulty GPU": fail -> cooldown, fail -> suspended, admin re-issue, pass.
  const nodeC = fresh();
  const regC = await registerManual(nodeC, fresh(), { gpu: "dev-runner (no GPU, cuda)", dev: true, version: "sparecycle-node/0.3.0", features: [proto.CHALLENGE_FEATURE] });
  check("node C (0.3.0, challenge feature) registers pending-challenge", regC.status === 200 && regC.data.challenge?.state === "pending-challenge", JSON.stringify(regC.data?.challenge));
  const chainId = Number(regC.data.chainId);
  const c1 = await nodeCall(nodeC, "/nodes/poll");
  check("node C: the poll hands out a challenge (not a job)", c1.status === 200 && c1.data.type === "challenge" && /^0x[0-9a-f]{64}$/.test(c1.data.challengeId) && !c1.data.jobId, c1.data?.caseId);
  const f1 = await answerChallenge(nodeC, c1.data, "a wrong answer from a broken GPU", chainId);
  const failedAt = Date.now();
  check("node C: wrong answer -> not passed, cooldown", f1.status === 200 && f1.data.passed === false && f1.data.state === "cooldown", JSON.stringify(f1.data));
  const coolPoll = await nodeCall(nodeC, "/nodes/poll"); // a full long poll (8 s) inside the cooldown
  check("node C: no challenge and no job during the cooldown (204)", coolPoll.status === 204);
  await sleep(Math.max(0, failedAt + CHALLENGE_COOLDOWN_S * 1000 + 1500 - Date.now()));
  const c2 = await nodeCall(nodeC, "/nodes/poll");
  check("node C: re-challenged after the cooldown", c2.status === 200 && c2.data.type === "challenge" && c2.data.challengeId !== c1.data.challengeId);
  const f2 = await answerChallenge(nodeC, c2.data, "still wrong", chainId);
  check("node C: second consecutive fail -> suspended", f2.status === 200 && f2.data.passed === false && f2.data.state === "suspended", JSON.stringify(f2.data));
  await sleep(CHALLENGE_COOLDOWN_S * 1000 + 1500);
  check("node C: suspended -> nothing at all, even after the cooldown time (204)", (await nodeCall(nodeC, "/nodes/poll")).status === 204);
  const noAuth = await api("POST", "/admin/challenges", { nodeKey: nodeC.address, action: "reissue" });
  check("challenge admin without the token -> 401", noAuth.status === 401 && noAuth.data.error === "unauthorized");
  const adminHdr = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const re = await api("POST", "/admin/challenges", { nodeKey: nodeC.address, action: "reissue", note: "e2e re-qualify" }, adminHdr);
  check("admin re-issue: suspended -> pending-challenge", re.status === 200 && re.data.before.state === "suspended" && re.data.after.state === "pending-challenge", JSON.stringify(re.data));
  const c3 = await nodeCall(nodeC, "/nodes/poll");
  check("node C: re-issued challenge handed out", c3.status === 200 && c3.data.type === "challenge");
  const p3 = await answerChallenge(nodeC, c3.data, devText(c3.data.spec.params).text, chainId);
  check("node C: correct answer -> passed, eligible", p3.status === 200 && p3.data.passed === true && p3.data.state === "eligible", JSON.stringify(p3.data));
  const report = await api("GET", `/admin/challenges?nodeKey=${nodeC.address}`, undefined, adminHdr);
  check(
    "admin report: 3 challenges (failed, failed, passed), one audit row, job-eligible",
    report.status === 200 &&
      report.data.challenges.map((c) => c.status).join(",") === "passed,failed,failed" &&
      report.data.log.length === 1 &&
      report.data.log[0].action === "reissue" &&
      report.data.jobEligible === true,
    JSON.stringify({ c: report.data.challenges?.map((c) => c.status), log: report.data.log?.length }),
  );
  const jobsNow = (await api("GET", "/jobs?limit=50")).data.jobs;
  check("challenges never show up as jobs", jobsNow.length === 0 && [c1, c2, c3].every((c) => !JSON.stringify(jobsNow).includes(c.data.challengeId)));

  // D: an old 0.2.0-style registration (no device, no features): accepted as before, never challenged.
  const nodeD = fresh();
  const regD = await registerManual(nodeD, fresh(), { gpu: "dev-runner (no GPU, cuda)", dev: true, version: "sparecycle-node/0.2.0" });
  check("node D (0.2.0 body) registers unchanged, no challenge state", regD.status === 200 && regD.data.challenge?.feature === false && regD.data.challenge?.state === null);
  check("node D: never gets a challenge (204)", (await nodeCall(nodeD, "/nodes/poll")).status === 204);

  // E: a software rasterizer is refused; F: an untested family registers but is marked untested.
  const regE = await registerManual(fresh(), fresh(), {
    gpu: "llvmpipe (LLVM 15.0.7, 256 bits) (Vulkan)",
    backend: "vulkan",
    version: "sparecycle-node/0.3.0",
    device: { vendor: "software", vulkan: { deviceType: "PHYSICAL_DEVICE_TYPE_CPU", deviceName: "llvmpipe (LLVM 15.0.7, 256 bits)" } },
  });
  check("software rasterizer -> 403 gpu-not-supported with the support link", regE.status === 403 && regE.data.error === "gpu-not-supported" && /^https:\/\//.test(regE.data.supported ?? ""), JSON.stringify(regE.data));
  const nodeF = fresh();
  const regF = await registerManual(nodeF, fresh(), { gpu: "NVIDIA GeForce RTX 2080", version: "sparecycle-node/0.2.0" });
  check("RTX 2080 (Turing, not benched) registers as untested", regF.status === 200 && regF.data.gpu?.status === "untested" && regF.data.gpu?.family === "nvidia-rtx20-turing", JSON.stringify(regF.data?.gpu));
  const listed = (await api("GET", "/nodes")).data.nodes;
  check(
    "node list shows family / gpuStatus / challengeState",
    listed.find((x) => x.nodeKey === nodeC.address)?.challengeState === "eligible" && listed.find((x) => x.nodeKey === nodeF.address)?.gpuStatus === "untested",
  );

  step("9. submit 2 image + 1 text jobs and wait for agreement");
  const specs = [
    { kind: "image", params: { model: "sd15", prompt: "a lighthouse at dusk, oil painting", width: 256, height: 256, steps: 10 } },
    { kind: "image", params: { model: "sd15", prompt: "a red bicycle", negative: "blurry", width: 320, height: 256, steps: 12, guidance: 6.5, seed: 42 } },
    { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "Explain an epoch in one sentence.", system: "Be brief.", maxTokens: 64 } },
  ];
  const jobIds = [];
  const secrets = {}; // job id -> read secret (never printed)
  for (const s of specs) {
    const r = await api("POST", "/jobs", s);
    check(`POST /jobs ${s.kind}`, r.status === 201 && r.data.status === "queued", r.data.id ?? JSON.stringify(r.data));
    jobIds.push(r.data.id);
    secrets[r.data.id] = r.data.readSecret;
  }
  check("every job gets a read secret", jobIds.every((id) => /^[A-Za-z0-9_-]{43}$/.test(secrets[id] ?? "")));
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
  const bearer = (id) => ({ authorization: `Bearer ${secrets[id]}` });
  const img = await api("GET", `/jobs/${jobIds[0]}/result`, undefined, bearer(jobIds[0]));
  check("image result is a PNG, private, no-store", img.status === 200 && img.type === "image/png" && img.data.subarray(1, 4).toString() === "PNG" && isPrivate(img));
  const txt = await api("GET", `/jobs/${jobIds[2]}/result`, undefined, bearer(jobIds[2]));
  check("text result served", txt.status === 200 && txt.type.startsWith("text/plain") && txt.data.toString().length > 0);
  const oldOff = await api("GET", `/jobs/${jobIds[0]}/output`);
  check("OUTPUT_AUTH=off: old /output still serves, never public/immutable again", oldOff.status === 200 && isPrivate(oldOff) && !/public|immutable/.test(oldOff.headers.get("cache-control")));
  const anonOff = await api("GET", `/jobs/${jobIds[0]}/result`);
  check("OUTPUT_AUTH=off: /result serves without credentials", anonOff.status === 200 && isPrivate(anonOff));
  const detail = await api("GET", `/jobs/${jobIds[1]}`);
  check("job detail: seed kept, result url, outputAvailable, no prompt, private", detail.data.params.seed === 42 && detail.data.output?.endsWith("/result") && detail.data.outputAvailable === true && !JSON.stringify(detail.data).includes("bicycle") && isPrivate(detail));

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
  check("paid job accepted with the quoted price", paid.status === 201 && paid.data.priceWei === paidPrice.toString(), paid.data.id ?? paid.data.error);
  check(
    "paid submit answers available (after the hold) and lowBalance",
    paid.data.available === (parseEther("0.01") - paidPrice).toString() && paid.data.lowBalance === false,
    `${paid.data.available} ${paid.data.lowBalance}`,
  );
  secrets[paid.data.id] = paid.data.readSecret;
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
  check("job list marks it paid, without price or charge status (D7)", paidRow.payment === "paid" && !("priceWei" in paidRow) && !("chargeStatus" in paidRow), JSON.stringify(paidRow));
  const invoiceOf = (id) => api("GET", `/jobs/${id}/invoice`, undefined, { authorization: `Bearer ${secrets[id]}` });
  const inv0 = await invoiceOf(paid.data.id);
  check(
    "invoice (read secret): price, 5% cut, held, output hash; private",
    inv0.status === 200 && isPrivate(inv0) && inv0.data.priceWei === paidPrice.toString() && inv0.data.protocolCutWei === ((paidPrice * 500n) / 10_000n).toString() &&
      inv0.data.chargeStatus === "pending" && inv0.data.verdict === "agreed" && /^0x[0-9a-f]{64}$/.test(inv0.data.outputHash ?? ""),
    JSON.stringify(inv0.data),
  );
  const paidBytes = await api("GET", `/jobs/${paid.data.id}/result`, undefined, { authorization: `Bearer ${secrets[paid.data.id]}` });
  check("invoice output hash = sha256 of the downloaded output", paidBytes.status === 200 && inv0.data.outputHash === `0x${createHash("sha256").update(paidBytes.data).digest("hex")}`);
  check("invoice without credentials -> 401", (await api("GET", `/jobs/${paid.data.id}/invoice`)).status === 401);
  check("free jobs are marked free", (await api("GET", "/jobs?limit=20")).data.jobs.filter((j) => jobIds.includes(j.id)).every((j) => j.payment === "free"));

  // A team test job (TEAM_JOB_WALLETS = the sweeper key in this test): charged like any paid job, in the same jobs root.
  {
    const hash = await wallet(sweeper).writeContract({ address: payments, abi: jobPaymentsAbi, functionName: "deposit", value: parseEther("0.001") });
    await pub.waitForTransactionReceipt({ hash });
  }
  const teamReq = { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "A team test job for the receipt check.", system: "Be brief.", maxTokens: 16 } };
  const teamPrice = jobPriceWei(teamReq, PRICE_WEI_PER_UNIT);
  const teamJob = await api("POST", "/jobs", { request: teamReq, payment: await signPayment(sweeper, teamReq, teamPrice) });
  check("team test job accepted", teamJob.status === 201 && teamJob.data.priceWei === teamPrice.toString(), teamJob.data.error ?? "");
  secrets[teamJob.data.id] = teamJob.data.readSecret;
  await waitFor("team job agreed", async () => (await api("GET", "/jobs/" + teamJob.data.id)).data.status === "agreed", { timeoutMs: 120_000, intervalMs: 1000 });
  check("team job shown as team-funded", (await api("GET", "/jobs/" + teamJob.data.id)).data.payment === "team");

  // Job receipts (feature brief #8): provisional from the verdict on, with both nodes' EIP-712 receipts.
  const { verifyReceipt } = await srcImport("lib/job-receipt.ts");
  const receiptOf = (id) => api("GET", `/jobs/${id}/receipt`, undefined, { authorization: `Bearer ${secrets[id]}` });
  const verifyOpts = { client: pub, chainId: 31337, paymentsContract: payments };
  const rc0 = await receiptOf(paid.data.id);
  check(
    "receipt (read secret): provisional at the verdict, both node signatures, private",
    rc0.status === 200 && isPrivate(rc0) && rc0.data.state === "provisional" && rc0.data.chargeStatus === "pending" && rc0.data.nodes?.length === 2 &&
      rc0.data.pending?.reason === "waiting-for-charge" && rc0.data.outputHash === inv0.data.outputHash,
    JSON.stringify(rc0.data),
  );
  const rcAnon = await api("GET", `/jobs/${paid.data.id}/receipt`);
  check("receipt without credentials -> 401, private", rcAnon.status === 401 && isPrivate(rcAnon));
  const vc0 = await verifyReceipt(rc0.data, verifyOpts);
  check(
    "provisional receipt: node signatures valid, nothing on-chain to check yet",
    vc0.outcome === "provisional" && vc0.checks.find((c) => c.id === "signatures")?.status === "pass",
    JSON.stringify(vc0.checks),
  );
  const treasuryBefore = await pub.getBalance({ address: treasury });

  // ---- x402 pay-per-job (E2E_X402=1 only) ----
  const xl = X402 ? await srcImport("lib/x402.ts") : null;
  const { x402EscrowAbi } = X402 ? await srcImport("contracts/x402Escrow.ts") : {};
  const tokenAbi = [
    { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  ];
  const tokenBalance = (who) => pub.readContract({ address: x402Token, abi: tokenAbi, functionName: "balanceOf", args: [who] });
  const escrowOf = async (id) => {
    const [payer, deadline, state, amount] = await pub.readContract({ address: x402Escrow, abi: x402EscrowAbi, functionName: "escrows", args: [id] });
    return { payer, deadline, state: ["none", "held", "forwarded", "refunded"][state], amount };
  };
  /** 402 for `body`, then a TransferWithAuthorization signed by `who` and the paid retry. */
  const payX402 = async (who, path, body) => {
    const first = await api("POST", path, body);
    const header = first.headers.get("payment-required");
    const pr = header ? xl.decodeX402Header(header) : null;
    const r = pr?.accepts?.[0];
    if (first.status !== 402 || !r) return { first, pr, res: null };
    const authorization = {
      from: who.address,
      to: r.payTo,
      value: r.amount,
      validAfter: "0",
      validBefore: String(Math.floor(Date.now() / 1000) + r.maxTimeoutSeconds),
      nonce: generatePrivateKey(), // 32 random bytes
    };
    const signature = await who.signTypedData({
      domain: xl.assetDomain(r, 31337),
      types: xl.TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: xl.authorizationMessage(authorization),
    });
    const paymentHeader = xl.encodeX402Header({ x402Version: 2, accepted: r, payload: { signature, authorization } });
    const res = await api("POST", path, body, { "payment-signature": paymentHeader });
    return { first, pr, r, res, paymentHeader };
  };
  let x402Job = null;
  if (X402) {
    step("9c. x402 pay-per-job (E2E_X402=1): 402 -> signed EIP-3009 payment -> escrow -> agreed -> forwarded");
    {
      const hash = await wallet(admin).writeContract({ address: x402Token, abi: tokenAbi, functionName: "mint", args: [customer.address, 1_000_000_000n] });
      await pub.waitForTransactionReceipt({ hash });
    }
    const chatBody = { model: "qwen2.5-1.5b", messages: [{ role: "user", content: "An x402 paid hello" }], max_tokens: 16 };
    const keyless = await api("POST", "/chat/completions", chatBody, { authorization: "Bearer not-a-key" });
    check("x402: any Authorization header keeps the key path (401, no PAYMENT-REQUIRED)", keyless.status === 401 && !keyless.headers.get("payment-required"));
    const paidX = await payX402(customer, "/chat/completions", chatBody);
    const r = paidX.r;
    check(
      "x402: no API key -> 402 x402_payment_required, PAYMENT-REQUIRED v2 exact on eip155:31337, payTo = the escrow, private",
      paidX.first.status === 402 && paidX.first.data.error?.code === "x402_payment_required" && paidX.pr?.x402Version === 2 && r?.scheme === "exact" &&
        r.network === "eip155:31337" && r.payTo.toLowerCase() === x402Escrow.toLowerCase() && r.asset.toLowerCase() === x402Token.toLowerCase() &&
        r.extra?.name === "Global Dollar" && isPrivate(paidX.first),
      JSON.stringify(r),
    );
    const settle = paidX.res.headers.get("payment-response") ? xl.decodeX402Header(paidX.res.headers.get("payment-response")) : null;
    check(
      "x402: the signed payment -> 202 with PAYMENT-RESPONSE (success, funding tx) and a read secret",
      paidX.res.status === 202 && settle?.success === true && /^0x[0-9a-f]{64}$/.test(settle.transaction ?? "") && /^[A-Za-z0-9_-]{43}$/.test(paidX.res.data.sparecycle?.read_secret ?? ""),
      JSON.stringify(paidX.res.data.error ?? settle),
    );
    const fundRcpt = await pub.getTransactionReceipt({ hash: settle.transaction });
    const funded = (await import("viem")).parseEventLogs({ abi: x402EscrowAbi, logs: fundRcpt.logs }).find((e) => e.eventName === "Funded");
    const amount = BigInt(r.amount);
    check(
      "x402: the escrow was funded on-chain by the scheduler key before the job was queued (Funded: payer, exact amount)",
      fundRcpt.status === "success" && fundRcpt.from.toLowerCase() === scheduler.address.toLowerCase() && funded?.args.payer.toLowerCase() === customer.address.toLowerCase() &&
        funded.args.amount === amount && (await tokenBalance(x402Escrow)) === amount,
    );
    const jobId = paidX.res.data.sparecycle.job_id;
    x402Job = { jobId, secret: paidX.res.data.sparecycle.read_secret, escrowId: funded.args.escrowId, amount, pollId: paidX.res.data.id };
    check("x402: the escrow is held on-chain under the salted escrow id (not the job id)", (await escrowOf(x402Job.escrowId)).state === "held" && x402Job.escrowId !== jobId);
    const replay = await api("POST", "/chat/completions", chatBody, { "payment-signature": paidX.paymentHeader });
    check("x402: the same payment again -> 409 payment_used, no job id", replay.status === 409 && replay.data.error?.code === "payment_used" && !JSON.stringify(replay.data).includes(jobId.slice(2)));
    await waitFor("x402 job agreed", async () => (await api("GET", `/jobs/${jobId}`)).data.status === "agreed", { timeoutMs: 120_000, intervalMs: 1000 });
    await waitFor("x402 escrow forwarded by the settle timer", async () => (await escrowOf(x402Job.escrowId)).state === "forwarded", { timeoutMs: 90_000, intervalMs: 1000 });
    const toTreasuryX = (amount * 500n) / 10_000n;
    check(
      "x402: forwarded once: 95% to forwardTo (conversion), 5% to the treasury, nothing left in the escrow",
      (await tokenBalance(x402ForwardTo)) === amount - toTreasuryX && (await tokenBalance(treasury)) === toTreasuryX && (await tokenBalance(x402Escrow)) === 0n,
    );
    const pollX = await api("GET", `/chat/completions/${x402Job.pollId}`, undefined, { authorization: `Bearer ${x402Job.secret}` });
    check(
      "x402: the read secret polls the answer; sparecycle.x402 shows forwarded",
      pollX.status === 200 && pollX.data.choices?.[0]?.message?.content?.length > 0 && pollX.data.sparecycle?.x402?.status === "forwarded" && isPrivate(pollX),
      JSON.stringify(pollX.data.sparecycle?.x402),
    );
    check("x402: a wrong secret -> 403", (await api("GET", `/chat/completions/${x402Job.pollId}`, undefined, { authorization: "Bearer wrong" })).status === 403);
  }

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
  if (X402) {
    const ch0 = (await api("GET", "/epochs/0/charges")).data;
    const rc = (await api("GET", `/jobs/${x402Job.jobId}/receipt`, undefined, { authorization: `Bearer ${x402Job.secret}` })).data;
    const { verifyProof } = await srcImport("lib/merkle.ts");
    const li = rc.anchor?.leafInputs;
    const leaf =
      li &&
      xl.x402LeafOf(0, {
        jobId: li.jobId,
        escrowId: li.escrowId,
        payer: li.payer,
        asset: li.asset,
        amount: BigInt(li.amount),
        verdict: "agreed",
        outcome: "forwarded",
        outputHash: li.outputHash,
        salt: li.salt,
      });
    check(
      "x402: the close sealed epoch 0's x402 tree; the payer's receipt rebuilds its leaf and proves it against the published root",
      ch0.x402?.root && rc.format === "sparecycle-x402-receipt" && rc.state === "sealed" && leaf === rc.anchor.leaf && verifyProof(rc.anchor.proof, ch0.x402.root, leaf),
      JSON.stringify({ root: ch0.x402?.root, state: rc.state }),
    );
    const viemMod = await import("viem");
    const evs = (await pub.getContractEvents({ address: x402Escrow, abi: x402EscrowAbi, fromBlock: 0n })).filter((e) => e.args.escrowId === rc.escrowId);
    check(
      "x402: the receipt's escrowSalt ties the job to the on-chain Funded and Forwarded events (escrowId = keccak256(jobId, salt))",
      xl.escrowIdOf(rc.jobId, rc.escrowSalt) === rc.escrowId && evs.map((e) => e.eventName).join() === "Funded,Forwarded" && viemMod.isHex(rc.fundTx),
    );
    check("x402: no job id, payer or salt in the public x402 tree", ![x402Job.jobId, rc.escrowSalt, li.salt].some((v) => JSON.stringify(ch0.x402).includes(v.slice(2))));
  }

  step("11. on-chain settlement checks");
  const e0 = await read("getEpoch", [0n]);
  const e1 = await read("getEpoch", [1n]);
  const tree = (await api("GET", "/epochs/0/tree")).data;
  check("epoch 0 settled on-chain", e0.settled === true && (await read("currentEpoch")) === 1n);
  const chargedTotal = paidPrice + teamPrice;
  const toTreasury = (chargedTotal * 500n) / 10_000n; // 5% of the epoch's charged batch, rounded down
  expectedPot += chargedTotal - toTreasury;
  check("pot = 1 ETH fund + 0.25 ETH escrow + 1 wei unaccounted + 95% of the paid and team jobs", e0.pot === expectedPot, String(e0.pot));
  const charges = (await api("GET", "/epochs/0/charges")).data;
  check(
    "charge published, done, hashRule v2-jobs-merkle, two leaves, no per-job list",
    charges.status === "done" && charges.hashRule === "v2-jobs-merkle" && charges.leaves?.length === 2 && !("jobs" in charges),
    JSON.stringify(charges),
  );
  const chargeRcpt = await pub.getTransactionReceipt({ hash: charges.tx });
  check("charge sent from the scheduler key", chargeRcpt.status === "success" && chargeRcpt.from.toLowerCase() === scheduler.address.toLowerCase());
  const viem = await import("viem");
  const chargeEvents = viem.parseEventLogs({ abi: jobPaymentsAbi, logs: chargeRcpt.logs.filter((l) => l.address.toLowerCase() === payments.toLowerCase()) });
  const chargedEv = chargeEvents.find((e) => e.eventName === "Charged");
  check("Charged(epoch 0) carries the published jobs root as listHash", chargedEv?.args.epochId === 0n && chargedEv.args.listHash === charges.listHash, charges.listHash);
  check("merkle.ts rebuilds the jobs root from the published leaves", buildTree(charges.leaves).root === charges.listHash);
  const onchainTotals = Object.fromEntries(chargeEvents.filter((e) => e.eventName === "CustomerCharged").map((e) => [e.args.customer.toLowerCase(), e.args.amount.toString()]));
  check(
    "per-customer totals == the CustomerCharged events (customer and team wallet)",
    charges.customers.length === 2 && charges.customers.every((c) => onchainTotals[c.customer.toLowerCase()] === c.amountWei) &&
      onchainTotals[customer.address.toLowerCase()] === paidPrice.toString() && onchainTotals[sweeper.address.toLowerCase()] === teamPrice.toString(),
    JSON.stringify(charges.customers),
  );
  check("no job ids in the public charge list (D7)", ![paid.data.id, teamJob.data.id].some((id) => JSON.stringify(charges).includes(id.slice(2))));
  check("treasury got 5% of the batch", (await pub.getBalance({ address: treasury })) - treasuryBefore === toTreasury, toTreasury + " wei");

  // The receipts are sealed and verify against the Charged event read straight from the chain (here anvil, on the live
  // site the chain's public RPC), never through the scheduler API.
  const rc1 = await receiptOf(paid.data.id);
  check(
    "receipt sealed in epoch 0 with the charge tx and the jobs root",
    rc1.data.state === "sealed" && rc1.data.epochId === 0 && rc1.data.chargeTx === charges.tx.toLowerCase() && rc1.data.anchor?.listHash === charges.listHash &&
      rc1.data.chargeStatus === "charged",
    JSON.stringify(rc1.data),
  );
  const vc1 = await verifyReceipt(rc1.data, verifyOpts);
  check("the paid job's receipt verifies against the Charged event on the local chain", vc1.outcome === "verified", JSON.stringify(vc1.checks));
  const vcTeam = await verifyReceipt((await receiptOf(teamJob.data.id)).data, verifyOpts);
  check("the team job's receipt verifies too", vcTeam.outcome === "verified", JSON.stringify(vcTeam.checks));
  const saved = JSON.parse(JSON.stringify(rc1.data)); // what "Save receipt (JSON)" writes
  const tamperedPrice = await verifyReceipt({ ...saved, priceWei: (BigInt(saved.priceWei) - 1n).toString() }, verifyOpts);
  const tamperedEpoch = await verifyReceipt({ ...saved, epochId: 1, anchor: { ...saved.anchor, leafInputs: { ...saved.anchor.leafInputs, epochId: 1 } } }, verifyOpts);
  const tamperedSalt = await verifyReceipt({ ...saved, anchor: { ...saved.anchor, leafInputs: { ...saved.anchor.leafInputs, salt: `0x${"ab".repeat(32)}` } } }, verifyOpts);
  check("a tampered receipt (price, epoch, salt) does not verify", tamperedPrice.outcome === "failed" && tamperedEpoch.outcome === "failed" && tamperedSalt.outcome === "failed");
  const salt = saved.anchor.leafInputs.salt;
  check(
    "the leaf's salt is only in the payer's receipt, not in the public charge answer",
    /^0x[0-9a-f]{64}$/.test(salt) && !JSON.stringify((await api("GET", "/epochs/0/charges")).data).includes(salt.slice(2)),
  );
  const deadRpc = await verifyReceipt(saved, { ...verifyOpts, client: createPublicClient({ chain: foundry, transport: http("http://127.0.0.1:9", { retryCount: 0 }) }) });
  check("an unreachable RPC is reported as unreachable, never as verified", deadRpc.outcome === "unreachable");
  const acct2 = (await api("GET", "/payments/account?address=" + customer.address)).data;
  check("customer balance reduced by the price, nothing held", BigInt(acct2.balance) === parseEther("0.01") - paidPrice && acct2.held === "0", JSON.stringify(acct2));
  const inv1 = (await invoiceOf(paid.data.id)).data;
  check("invoice: charged in epoch 0, charge tx linked", inv1.chargeStatus === "charged" && inv1.chargedEpoch === 0 && inv1.links?.chargeTx?.hash === charges.tx, JSON.stringify(inv1));
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

  step("14. restart on the same DB with SCHEDULER_AUTOCLOSE=1 and OUTPUT_AUTH=enforce");
  await write(admin, "fund", [], parseEther("0.1"));
  const pot1 = (await read("getEpoch", [1n])).pot;
  check("epoch 1 pot = 1 wei rollover + 0.1 ETH", pot1 === e0.pot - e0.reserved + parseEther("0.1"), `${pot1}`);
  killTree(nextProc);
  await waitFor("next stopped", async () => !(await portBusy(NEXT_PORT)), { timeoutMs: 30_000 });
  nextProc = await startNext("next-restart", { SCHEDULER_AUTOCLOSE: "1", OUTPUT_AUTH: "enforce" });
  const afterRestart = (await api("GET", "/epochs")).data.epochs;
  check("state survived the restart (epoch 0 posted, epoch 1 open)", afterRestart.find((e) => e.id === 0)?.status === "posted" && afterRestart.find((e) => e.id === 1)?.status === "open");
  check("jobs survived the restart", (await api("GET", "/jobs?limit=20")).data.jobs.filter((j) => j.status === "agreed").length === 6 + (X402 ? 1 : 0)); // 3 + 1 free from the rate-limit step + 1 paid + 1 team (+ the x402 job)
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
    check(`${n.name}: log shows a passed GPU challenge`, /GPU challenge \S+ \((image|text)\) done in .* -> passed \(eligible\)/.test(text));
  }

  step("16b. re-check on a new pair (dev runners told to corrupt their outputs)");
  {
    const sqlite = await import("node:sqlite");
    /** Read-only query of the scheduler's scratch DB (node identities per round are not in any public view). */
    const q = (sql, ...args) => {
      const d = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        return d.prepare(sql).all(...args);
      } finally {
        d.close();
      }
    };
    const childNamed = (name) => children.find((c) => c.name === name)?.child;
    const keyOf = (keyFile) => privateKeyToAccount(JSON.parse(readFileSync(keyFile, "utf8")).privateKey).address;
    /** Starts a dev-runner node client (a fresh key unless `n.keyFile` exists); returns its node key. */
    const startDevNode = async (n, logName, extraEnv = {}) => {
      if (!n.keyFile) {
        n.keyFile = join(RUN_DIR, `${n.name}-key.json`);
        const init = spawnSync(process.execPath, [agent, "init", "--key-file", n.keyFile], { cwd: ROOT, encoding: "utf8" });
        if (init.status !== 0) throw new Error(`${n.name}: init failed`);
      }
      const nodeKey = keyOf(n.keyFile);
      const sig = await n.owner.signMessage({ message: proto.linkMessage(nodeKey, n.owner.address) });
      start(logName, process.execPath, [agent, "start", "--network", SITE, "--owner", n.owner.address, "--owner-sig", sig, "--dev-runner", "--key-file", n.keyFile], {
        env: cleanEnv({ SPARECYCLE_GPU_UUID: n.gpu, ...extraEnv }),
      });
      return nodeKey;
    };
    const final = (s) => ["agreed", "disagreed", "expired", "rejected"].includes(s);
    const job = async (id) => (await api("GET", `/jobs/${id}`)).data;
    const invoice = async (j) => (await api("GET", `/jobs/${j.id}/invoice`, undefined, { authorization: `Bearer ${j.readSecret}` })).data;
    /** Every result of a later round comes from a node key, owner wallet and GPU that no earlier round used. */
    const freshPerRound = (rows) =>
      rows.every((r) => rows.filter((e) => e.round < r.round).every((e) => e.node_key !== r.node_key && e.owner.toLowerCase() !== r.owner.toLowerCase() && e.gpu_uuid !== r.gpu_uuid));
    const balanceOf = (who) => pub.readContract({ address: payments, abi: jobPaymentsAbi, functionName: "balanceOf", args: [who] });
    // A stopped node's last long poll (up to 8 s) can still lease a task on the scheduler: let it run out first.
    const stopNodes = async (names) => {
      for (const name of names) killTree(childNamed(name));
      await sleep(10_000);
    };

    // The honest pair stops; six corrupting dev runners (six owners, six GPUs) take over.
    await stopNodes(["node-a", "node-b"]);
    const corrupt = Array.from({ length: 6 }, (_, i) => ({ name: `node-c${i + 1}`, owner: privateKeyToAccount(generatePrivateKey()), gpu: `E2E-GPU-C${i + 1}` }));
    for (const c of corrupt) c.key = await startDevNode(c, c.name, { SPARECYCLE_DEV_CORRUPT: "1" });
    await waitFor("six corrupting dev nodes online and past their GPU challenge", async () => {
      const listedNow = (await api("GET", "/nodes")).data.nodes;
      return corrupt.every((c) => listedNow.some((x) => x.nodeKey === c.key && x.online && x.challengeState === "eligible"));
    }, { timeoutMs: 120_000, intervalMs: 1000 });
    check("6 dev runners with SPARECYCLE_DEV_CORRUPT=1 registered and passed their GPU challenge (challenges are never corrupted)", true);
    check(
      "corrupting nodes log that they corrupt job outputs on purpose",
      corrupt.every((c) => readFileSync(join(RUN_DIR, `${c.name}.log`), "utf8").includes("SPARECYCLE_DEV_CORRUPT=1")),
    );

    // J1: a paid image job that no pair agrees on. J3: a free text job (another address: this one's free hour is used).
    const balBefore = await balanceOf(customer.address);
    const imgReq = { kind: "image", params: { model: "sd15", prompt: "a lighthouse no pair agrees on", width: 256, height: 256, steps: 10 } };
    const j1 = (await api("POST", "/jobs", { request: imgReq, payment: await signPayment(customer, imgReq, jobPriceWei(imgReq, PRICE_WEI_PER_UNIT)) })).data;
    const j3 = (await api("POST", "/jobs", { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "a free job its pair disagrees on", maxTokens: 16 } }, { "x-forwarded-for": "10.77.0.1" })).data;
    check("paid image job J1 and free text job J3 accepted", /^0x[0-9a-f]{64}$/.test(j1.id ?? "") && /^0x[0-9a-f]{64}$/.test(j3.id ?? ""), `${j1.error ?? ""} ${j3.error ?? ""}`);
    const seen = [];
    await waitFor("J1 through its rounds and J3 settled", async () => {
      const [a, b] = await Promise.all([job(j1.id), job(j3.id)]);
      const state = `${a.status}/round ${a.round}`;
      if (seen.at(-1) !== state) seen.push(state);
      return final(a.status) && final(b.status);
    }, { timeoutMs: 180_000, intervalMs: 250 });
    log(`J1 as the public API showed it: ${seen.join(" -> ")}`);
    const d1 = await job(j1.id);
    check("J1 (paid): 3 mismatching rounds end disagreed (round 2, maxRounds 3)", d1.status === "disagreed" && d1.round === 2 && d1.maxRounds === 3 && d1.payment === "paid", JSON.stringify({ status: d1.status, round: d1.round, note: d1.note }));
    const r1 = q("SELECT round, node_key, owner, gpu_uuid FROM results WHERE job_id = ? ORDER BY round, received_at", j1.id);
    check("J1: two results in each of rounds 0, 1 and 2, all from corrupting nodes", r1.map((r) => r.round).join(",") === "0,0,1,1,2,2" && r1.every((r) => corrupt.some((c) => c.key === r.node_key)));
    check(
      "J1: each new round ran on node keys, owners and GPUs that took no part in an earlier round (6 of each)",
      freshPerRound(r1) && ["node_key", "owner", "gpu_uuid"].every((k) => new Set(r1.map((r) => r[k].toLowerCase())).size === 6),
    );
    check("J1: each disagreeing round logged per node (6 rows)", q("SELECT COUNT(*) AS n FROM job_rounds WHERE job_id = ? AND outcome = 'disagreed'", j1.id)[0].n === 6);
    const pubText = JSON.stringify([d1, (await api("GET", "/jobs?limit=50")).data]).toLowerCase();
    check("public job views: round and maxRounds, no node keys or owners", corrupt.every((c) => !pubText.includes(c.key.slice(2).toLowerCase()) && !pubText.includes(c.owner.address.slice(2).toLowerCase())));
    const inv1 = await invoice(j1);
    check(
      "J1 invoice: disagreed, not charged (released, 0 wei), round 2 of 3",
      inv1.verdict === "disagreed" && inv1.chargeStatus === "released" && inv1.chargedWei === "0" && inv1.round === 2 && inv1.maxRounds === 3,
      JSON.stringify({ verdict: inv1.verdict, chargeStatus: inv1.chargeStatus, round: inv1.round, reason: inv1.reason }),
    );
    const d3 = await job(j3.id);
    check("J3 (free): its mismatch ends disagreed in round 0, no re-check (maxRounds 1)", d3.status === "disagreed" && d3.round === 0 && d3.maxRounds === 1 && d3.payment === "free", JSON.stringify({ status: d3.status, round: d3.round }));
    check("J3: only its first pair's two tasks and two results", q("SELECT COUNT(*) AS n FROM tasks WHERE job_id = ?", j3.id)[0].n === 2 && q("SELECT COUNT(*) AS n FROM results WHERE job_id = ?", j3.id)[0].n === 2);

    if (X402) {
      // J4 (x402): a paid text job that no pair agrees on -> disagreed after three rounds -> the escrow refunds in full.
      const before = await tokenBalance(customer.address);
      const j4 = await payX402(customer, "/chat/completions", { model: "qwen2.5-1.5b", messages: [{ role: "user", content: "an x402 job no pair agrees on" }], max_tokens: 16 });
      check("x402 J4 accepted and escrowed", j4.res?.status === 202, j4.res?.data?.sparecycle?.job_id ?? JSON.stringify(j4.res?.data?.error ?? j4.first.data?.error ?? ""));
      const j4Id = j4.res.data.sparecycle.job_id;
      await waitFor("x402 J4 through its rounds", async () => final((await job(j4Id)).status), { timeoutMs: 180_000, intervalMs: 500 });
      check("x402 J4 ends disagreed after re-check rounds", (await job(j4Id)).status === "disagreed");
      await waitFor("x402 J4 refunded by the settle timer", async () => (await tokenBalance(customer.address)) === before, { timeoutMs: 90_000, intervalMs: 1000 });
      const p4 = await api("GET", `/chat/completions/${j4.res.data.id}`, undefined, { authorization: `Bearer ${j4.res.data.sparecycle.read_secret}` });
      check(
        "x402 J4: refunded in full; the poll answers 422 not_charged and says the escrow refunded",
        p4.status === 422 && p4.data.error?.type === "not_charged" && /refunded/.test(p4.data.error?.message ?? "") && p4.data.sparecycle?.x402?.status === "refunded",
        JSON.stringify(p4.data),
      );
    }

    // J2: a paid text job. Round 0 on two corrupting nodes (the other four stop); round 1 waits until honest nodes return.
    await stopNodes(corrupt.slice(2).map((c) => c.name));
    const [c1, c2] = corrupt;
    const txtReq = { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "a paid job a second pair gets right", maxTokens: 32 } };
    const j2Price = jobPriceWei(proto.parseJobRequest(txtReq), PRICE_WEI_PER_UNIT); // the scheduler prices the parsed request
    const j2 = (await api("POST", "/jobs", { request: txtReq, payment: await signPayment(customer, txtReq, j2Price) })).data;
    check("paid text job J2 accepted", /^0x[0-9a-f]{64}$/.test(j2.id ?? ""), j2.error ?? "");
    await waitFor("J2's first pair (two corrupting nodes) mismatches and J2 goes back to the queue in round 1", async () => {
      const d = await job(j2.id);
      if (final(d.status)) throw new Error(`J2 settled: ${d.status}`);
      return d.round === 1;
    }, { timeoutMs: 60_000, intervalMs: 250 });
    await sleep(10_000); // longer than a long poll: c1 and c2 keep polling and must get nothing
    const w = await job(j2.id);
    const wRow = q("SELECT round_started_at FROM jobs WHERE id = ?", j2.id)[0];
    check(
      "J2 waits in round 1: its round-0 nodes keep polling but are excluded, so no lease and no round used up",
      w.status === "queued" && w.round === 1 && w.maxRounds === 3 && wRow.round_started_at === null,
      JSON.stringify({ status: w.status, round: w.round, note: w.note }),
    );
    const r2a = q("SELECT round, node_key FROM results WHERE job_id = ?", j2.id);
    check("J2 round 0 ran on the two corrupting nodes", r2a.length === 2 && r2a.every((r) => r.round === 0 && [c1.key, c2.key].includes(r.node_key)));
    const invW = await invoice(j2);
    check(
      "payer view while re-checking: price held, nothing charged, round 1 (shown as round 2 of 3)",
      invW.chargeStatus === "pending" && invW.verdict === null && invW.chargedWei === null && invW.round === 1 && invW.maxRounds === 3 && /re-checking on another pair \(round 2 of 3\)/.test(w.note ?? ""),
      JSON.stringify({ chargeStatus: invW.chargeStatus, round: invW.round, note: w.note }),
    );
    const acctW = (await api("GET", "/payments/account?address=" + customer.address)).data;
    check("the hold stays in place: held = J2's price", BigInt(acctW.held) === j2Price, JSON.stringify({ held: acctW.held, price: j2Price.toString() }));

    // The honest pair returns (same keys, owners and GPUs) and takes round 1.
    for (const n of nodes) await startDevNode(n, `${n.name}-recheck`);
    await waitFor("J2 agreed on the honest pair", async () => {
      const d = await job(j2.id);
      if (final(d.status) && d.status !== "agreed") throw new Error(`J2 ${d.status}`);
      return d.status === "agreed";
    }, { timeoutMs: 90_000, intervalMs: 500 });
    const d2 = await job(j2.id);
    const honest = nodes.map((n) => keyOf(n.keyFile));
    const r2 = q("SELECT round, node_key, owner, gpu_uuid FROM results WHERE job_id = ? ORDER BY round, received_at", j2.id);
    check("J2 agreed in round 1", d2.status === "agreed" && d2.round === 1, JSON.stringify({ status: d2.status, round: d2.round }));
    check(
      "J2 round 1 ran on the honest pair: other owners and GPUs than round 0",
      r2.length === 4 && freshPerRound(r2) && r2.filter((r) => r.round === 1).every((r) => honest.includes(r.node_key)),
    );
    const listedNow = (await api("GET", "/nodes")).data.nodes;
    check(
      "the corrupting nodes never count an agreed job (all time and this epoch)",
      corrupt.every((c) => {
        const x = listedNow.find((y) => y.nodeKey === c.key);
        return x && x.agreedJobs === 0 && x.epochAgreedJobs === 0;
      }),
    );

    // J2's epoch: the payout tree holds only the final pair's owners; the charge takes J2 and never J1.
    const E = d2.epochId;
    await pub.request({ method: "evm_increaseTime", params: [EPOCH_LENGTH * 2] });
    await pub.request({ method: "evm_mine", params: [] });
    await waitFor(`autoclose to post epoch ${E}`, async () => (await api("GET", "/epochs")).data.epochs.find((e) => e.id === E)?.status === "posted", {
      timeoutMs: 90_000,
      intervalMs: 2000,
    });
    const treeE = (await api("GET", `/epochs/${E}/tree`)).data;
    const accounts = treeE.leaves.map((l) => l.account.toLowerCase()).sort();
    check(
      `epoch ${E} payout: only the final pair's owners (A and B), equal halves of J2's units`,
      accounts.join() === [ownerA, ownerB].map((o) => o.address.toLowerCase()).sort().join() && treeE.leaves[0].amount === treeE.leaves[1].amount && BigInt(treeE.leaves[0].amount) > 0n,
      JSON.stringify(treeE.leaves),
    );
    const cProofs = await Promise.all([c1, c2].map((c) => api("GET", `/epochs/${E}/proof?account=${c.owner.address}`)));
    check("J2's round-0 owners are not in the payout root (404 not-in-root)", cProofs.every((r) => r.status === 404 && r.data.error === "not-in-root"));
    // Receipts and re-checks together: J2's receipt holds only round 1's pair and verifies against the v2 jobs root.
    const chargesE = (await api("GET", `/epochs/${E}/charges`)).data;
    const rcJ2 = (await api("GET", `/jobs/${j2.id}/receipt`, undefined, { authorization: `Bearer ${j2.readSecret}` })).data;
    const vJ2 = await verifyReceipt(rcJ2, verifyOpts);
    const honestLower = honest.map((h) => h.toLowerCase());
    check(
      `epoch ${E} charge is a v2 jobs root; J2's receipt is sealed, charged, verifies, and names only round 1's pair`,
      chargesE.status === "done" && chargesE.hashRule === "v2-jobs-merkle" && rcJ2.state === "sealed" && rcJ2.chargeStatus === "charged" &&
        vJ2.outcome === "verified" && rcJ2.nodes?.length === 2 && rcJ2.nodes.every((n) => honestLower.includes(n.node.toLowerCase())),
      JSON.stringify({ hashRule: chargesE.hashRule, state: rcJ2.state, outcome: vJ2.outcome, nodes: rcJ2.nodes?.map((n) => n.node) }),
    );
    let j1Charged = false;
    for (let e = 0; e <= E; e++) if ((await api("GET", `/epochs/${e}/charges`)).data.jobs?.some((x) => x.jobId === j1.id)) j1Charged = true;
    const j1Leaves = q("SELECT charge_status FROM charge_leaves WHERE job_id = ?", j1.id);
    check(
      "J1 (three mismatching rounds) is never charged: in no v1 list, no charged leaf, invoice released",
      !j1Charged && j1Leaves.every((l) => l.charge_status !== "charged") && (await invoice(j1)).chargeStatus === "released",
      JSON.stringify(j1Leaves),
    );
    const inv2 = await invoice(j2);
    check(`J2 invoice: matched on round 1, charged in epoch ${E}`, inv2.verdict === "agreed" && inv2.round === 1 && inv2.chargeStatus === "charged" && inv2.chargedEpoch === E, JSON.stringify({ verdict: inv2.verdict, chargeStatus: inv2.chargeStatus, chargedEpoch: inv2.chargedEpoch }));
    const balAfter = await balanceOf(customer.address);
    check("customer balance: only J2's price was taken, nothing for J1", balBefore - balAfter === j2Price, `${balBefore - balAfter} wei`);
  }

  step("17. private outputs (OUTPUT_AUTH=enforce; nodes stopped so a new job stays queued)");
  for (const n of children.filter((c) => c.name.startsWith("node-"))) killTree(n.child);
  check("status reports outputAuth = enforce", (await api("GET", "/status")).data.outputAuth === "enforce");
  const [freeImg, , freeTxt] = jobIds;
  const paidId = paid.data.id;
  const anon = await api("GET", `/jobs/${freeImg}/result`);
  check("anonymous -> 401, empty body, private, no-store", anon.status === 401 && anon.data.length === 0 && isPrivate(anon));
  const anonHead = await api("HEAD", `/jobs/${freeImg}/result`);
  check("anonymous HEAD -> 401, no-store", anonHead.status === 401 && isPrivate(anonHead));
  const oldGet = await api("GET", `/jobs/${freeImg}/output`);
  const oldHead = await api("HEAD", `/jobs/${freeImg}/output`);
  check("old /output -> 410, private, no-store (GET and HEAD, even with the secret)", oldGet.status === 410 && oldHead.status === 410 && isPrivate(oldGet) && isPrivate(oldHead) && (await api("GET", `/jobs/${freeImg}/output`, undefined, bearer(freeImg))).status === 410);
  const own = await api("GET", `/jobs/${freeImg}/result`, undefined, bearer(freeImg));
  check("free job, its read secret -> 200 PNG, private, no-store", own.status === 200 && own.type === "image/png" && isPrivate(own));
  const other = await api("GET", `/jobs/${freeImg}/result`, undefined, bearer(freeTxt));
  check("another job's secret -> 403", other.status === 403 && other.data.error === "forbidden" && isPrivate(other));
  const unknown = await api("GET", `/jobs/0x${"ab".repeat(32)}/result`, undefined, bearer(freeImg));
  check("unknown id -> 404", unknown.status === 404 && isPrivate(unknown));
  // A paid job (the free hourly limit is used up): with the nodes stopped it stays queued.
  const queuedReq = { ...paidReq, params: { ...paidReq.params, prompt: "a paid lighthouse that stays queued" } };
  const pending = await api("POST", "/jobs", { request: queuedReq, payment: await signPayment(customer, queuedReq, paidPrice) });
  check("a new paid job is accepted and stays queued", pending.status === 201 && pending.data.status === "queued", pending.data.error ?? "");
  const notYet = await api("GET", `/jobs/${pending.data.id}/result`, undefined, { authorization: `Bearer ${pending.data.readSecret}` });
  check("not agreed -> 409 no-output", notYet.status === 409 && notYet.data.error === "no-output" && isPrivate(notYet));
  const dAnon = await api("GET", `/jobs/${freeImg}`);
  const dOwn = await api("GET", `/jobs/${freeImg}`, undefined, bearer(freeImg));
  check("job detail: no output url for a stranger, the result url for the secret, outputAvailable for both", dAnon.data.output === null && dAnon.data.outputAvailable === true && dOwn.data.output?.endsWith(`/jobs/${freeImg}/result`) && isPrivate(dAnon));
  const nodeKeyFile = JSON.parse(readFileSync(nodes[0].keyFile, "utf8"));
  const { signRequest } = await srcImport("lib/protocol.ts");
  const nodeHeaders = await signRequest(privateKeyToAccount(nodeKeyFile.privateKey), "GET", `/api/v1/jobs/${freeImg}/result`, "");
  check("a node's signed request is not a credential -> 401", (await api("GET", `/jobs/${freeImg}/result`, undefined, nodeHeaders)).status === 401);

  // Wallet sign-in (EIP-4361) through the real routes; the session cookie is carried by hand.
  const signInAs = async (address, signer, { reuse } = {}) => {
    const n = reuse ? null : await api("GET", "/auth/nonce");
    const message =
      reuse?.message ??
      createSiweMessage({
        address,
        chainId: n.data.chainId,
        domain: new URL(SITE).host,
        uri: `${SITE}/playground`,
        nonce: n.data.nonce,
        version: "1",
        statement: n.data.statement,
        issuedAt: new Date(),
        expirationTime: new Date(n.data.expiresAt * 1000),
      });
    const signature = reuse?.signature ?? (await signer.signMessage({ message }));
    const r = await api("POST", "/auth/verify", { message, signature });
    const cookie = /^sc_session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1];
    return { r, message, signature, setCookie: r.headers.get("set-cookie") ?? "", headers: cookie ? { cookie: `sc_session=${cookie}` } : {} };
  };
  const payerIn = await signInAs(customer.address, customer);
  check("payer signs in: 200, HttpOnly SameSite=Strict cookie, private", payerIn.r.status === 200 && /HttpOnly/.test(payerIn.setCookie) && /SameSite=Strict/.test(payerIn.setCookie) && isPrivate(payerIn.r));
  const paidOwn = await api("GET", `/jobs/${paidId}/result`, undefined, payerIn.headers);
  check("payer session -> 200 PNG, private, no-store", paidOwn.status === 200 && paidOwn.type === "image/png" && isPrivate(paidOwn));
  check("paid job: its read secret also reads it", (await api("GET", `/jobs/${paidId}/result`, undefined, bearer(paidId))).status === 200);
  check("payer session can't read a free job -> 403", (await api("GET", `/jobs/${freeImg}/result`, undefined, payerIn.headers)).status === 403);
  const replayIn = await signInAs(customer.address, customer, { reuse: payerIn });
  check("nonce reuse -> 401 bad-nonce", replayIn.r.status === 401 && replayIn.r.data.error === "bad-nonce");
  const strangerIn = await signInAs(ownerA.address, ownerA);
  check("another wallet's session -> 403 on the paid job", strangerIn.r.status === 200 && (await api("GET", `/jobs/${paidId}/result`, undefined, strangerIn.headers)).status === 403);

  // ERC-1271: a contract wallet owned by ownerB signs in through the chain (anvil).
  const authDir = join(RUN_DIR, "auth-mocks");
  mkdirSync(join(authDir, "src"), { recursive: true });
  writeFileSync(join(authDir, "src", "AuthMocks.sol"), AUTH_MOCKS_SOL);
  const ab = spawnSync(FORGE, ["build", "--root", authDir], { cwd: authDir, encoding: "utf8" });
  check("ERC-1271 wallet mock compiled", ab.status === 0, (ab.stderr || "").trim().split("\n").slice(-1)[0]);
  const walletArt = artifact(join(authDir, "out"), "AuthMocks.sol", "Mock1271Wallet");
  const scw = await deploy(walletArt, [ownerB.address]);
  const scwIn = await signInAs(scw, ownerB);
  check("ERC-1271 smart wallet signs in (owner's signature checked on-chain)", scwIn.r.status === 200 && scwIn.r.data.address?.toLowerCase() === scw.toLowerCase(), scw);
  const scwForged = await signInAs(scw, ownerA);
  check("ERC-1271: a signature from a non-owner -> 401 bad-signature", scwForged.r.status === 401 && scwForged.r.data.error === "bad-signature");
  // Test-only: make the smart wallet the payer of the text job (a paid submit needs an EOA signature today).
  const { DatabaseSync } = await import("node:sqlite");
  const sdb = new DatabaseSync(dbPath);
  sdb.exec("PRAGMA busy_timeout = 5000");
  sdb.prepare("UPDATE jobs SET payer = ? WHERE id = ?").run(scw, freeTxt);
  sdb.close();
  const scwRead = await api("GET", `/jobs/${freeTxt}/result`, undefined, scwIn.headers);
  check("ERC-1271 wallet session reads the job it paid -> 200", scwRead.status === 200 && scwRead.type.startsWith("text/plain"));
  const out = await api("POST", "/auth/logout", undefined, payerIn.headers);
  check("logout clears the cookie; the old session -> 401", out.status === 200 && /Max-Age=0/.test(out.headers.get("set-cookie") ?? "") && (await api("GET", `/jobs/${paidId}/result`, undefined, payerIn.headers)).status === 401);

  const leaky = jobsCacheHeaders.filter((h) => /public|immutable/i.test(h.cc));
  check(`no /api/v1/jobs/* response carried a public cache directive (${jobsCacheHeaders.length} responses)`, leaky.length === 0, leaky.map((h) => `${h.method} ${h.path} ${h.cc}`).join(", "));
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
