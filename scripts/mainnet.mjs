#!/usr/bin/env node
// Sparecycle mainnet runner (Robinhood Chain, 4663). Every step that sends a transaction simulates first, shows
// the result, and broadcasts only after you type a confirmation word. Mainnet transactions are signed by Foundry
// from an encrypted keystore: the private key is typed once into `cast wallet import`'s hidden prompt and is never
// read, printed or stored by this script. Decisions live in contracts/mainnet.json.
//
//   node scripts/mainnet.mjs status              read-only: wallet, keys, decisions, deployment, token
//   node scripts/mainnet.mjs init                create the scheduler + sweep hot wallets (.keys/mainnet-ops.json)
//   node scripts/mainnet.mjs import              store the mainnet wallet's key in an encrypted Foundry keystore
//   node scripts/mainnet.mjs rehearse [--placeholders]
//                                                dry run from the real wallet on live mainnet state: deploy, launch,
//                                                a test buy, the Pons sweep, fees into the pot. Nothing is sent.
//   node scripts/mainnet.mjs deploy              deploy SparecycleRewards (owner = the wallet)
//   node scripts/mainnet.mjs fund <scheduler|sweep> [eth]   send gas money from the wallet (default 0.0003 ETH)
//   node scripts/mainnet.mjs deploy-payments     deploy SparecycleJobPayments (paid jobs) with the treasury Safe
//   node scripts/mainnet.mjs deploy-stake [--dry-run]   deploy SparecycleNodeStake (SPARE staking, slashes judged by
//                                                the treasury Safe; minimum stake 0). Internal review only, no audit.
//   node scripts/mainnet.mjs deploy-x402 [--dry-run]    deploy SparecycleX402Escrow (x402 pay-per-job in USDG, owner and
//                                                forwardTo the treasury Safe; caps 1 / 100 / 10 USDG). Internal review only.
//   node scripts/mainnet.mjs deploy-v2 [--dry-run]      deploy the V2 payment stack in one run: Uniswap v4 SPARE adapter,
//                                                SparecycleBurner, SparecycleJobPaymentsV2, SparecycleHolderPool (split
//                                                350/0/150, SPARE at 0% discount, slippage 4%). Internal review only.
//   node scripts/mainnet.mjs transfer-owner <safe>  step 1 of moving the reward contract owner to a Safe
//                                                (the Safe then executes acceptOwnership(); docs/ops/multisig-runbook.md)
//   node scripts/mainnet.mjs launch              launch the token on Pons with the reward contract as fee recipient
//                                                (refuses while the logo / website links do not load)
//   node scripts/mainnet.mjs verify [payments|stake|x402|v2]   publish a contract's source (Sourcify, shown on Blockscout)
//   node scripts/mainnet.mjs env                 the site / Railway settings for what is deployed
//   node scripts/mainnet.mjs secret <scheduler|sweep>   the hot key, only into a pipe (railway ... --stdin)
//
// RPC: MAINNET_RPC_URL, else the public RPC. Where an ISP's DNS filter hides the RPC host (seen in Indonesia), the
// host is resolved over DNS-over-HTTPS and reached through a relay on 127.0.0.1 for the duration of the command.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createPublicClient, encodeAbiParameters, formatEther, getAddress, http as viemHttp, isAddress, parseAbi, parseAbiParameters, parseEther, zeroAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = join(ROOT, "contracts");
const CONFIG_FILE = join(CONTRACTS, "mainnet.json");
const OPS_FILE = join(ROOT, ".keys", "mainnet-ops.json");
const DEPLOYMENTS = join(ROOT, "src", "contracts", "deployments.json");
const LAUNCH_RUN = join(CONTRACTS, "broadcast", "Launch.s.sol", "4663", "run-latest.json");
const KEYSTORES = join(homedir(), ".foundry", "keystores");
const CHAIN_ID = 4663;
const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";
const EXPLORER = "https://robinhoodchain.blockscout.com";
const PONS = { factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e", feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e" };
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
// Env the forge scripts read; cleared before each run so nothing stale from the shell leaks in.
const SCRIPT_ENV = ["TREASURY", "SPARE_TOKEN", "SPARE_HAS_BURN", "MIN_STAKE_PER_NODE",
  "X402_ASSET", "X402_ASSET_NAME", "X402_ASSET_VERSION", "X402_FORWARD_TO", "X402_SETTLE_WINDOW", "X402_MAX_PER_JOB",
  "X402_MAX_TOTAL_HELD", "X402_MAX_PER_PAYER_PER_EPOCH",
  "V4_POOL_MANAGER", "V4_POOL_FEE", "V4_TICK_SPACING", "V4_HOOKS", "MAX_ETH_PER_BURN", "SPARE_PAY_CAP_ETH",
  "ADMIN", "SCHEDULER", "EPOCH_LENGTH", "PAYOUT_TOKEN", "FEE_ESCROW", "DEPLOY_MOCK_ESCROW", "REWARD_CONTRACT",
  "TOKEN_NAME", "TOKEN_SYMBOL", "TOKEN_LOGO", "TOKEN_DESCRIPTION", "TOKEN_TWITTER", "TOKEN_TELEGRAM", "TOKEN_DISCORD",
  "TOKEN_WEBSITE", "TOKEN_FARCASTER", "CREATOR_TAX_BPS", "PAIR_ASSET", "LAUNCH_CONFIG_ID", "LAUNCH_SALT",
];

const rewardAbi = parseAbi([
  "function owner() view returns (address)",
  "function scheduler() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function payoutToken() view returns (address)",
  "function epochLength() view returns (uint64)",
  "function currentEpoch() view returns (uint64)",
]);
const factoryAbi = parseAbi([
  "function canLaunch(address) view returns (bool)",
  "function launchEnabled() view returns (bool)",
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
]);

const fail = (msg) => {
  console.error(`\n${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------- RPC (direct, or relayed past a DNS filter) ----
async function chainIdOf(url) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(10_000),
    });
    return Number((await r.json()).result);
  } catch {
    return null;
  }
}

async function resolveOverHttps(host) {
  for (const url of [`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, `https://dns.google/resolve?name=${host}&type=A`]) {
    try {
      const r = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8_000) });
      const ips = ((await r.json()).Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
      if (ips.length) return ips;
    } catch {
      /* try the next resolver */
    }
  }
  return [];
}

const relays = [];
/** Local HTTP relay to `target` (https), connecting to `ips` with normal TLS verification of the real host name. */
async function startRelay(target, ips) {
  const u = new URL(target);
  const lookup = (_host, opts, cb) => (opts?.all ? cb(null, ips.map((address) => ({ address, family: 4 }))) : cb(null, ips[0], 4));
  const agent = new https.Agent({ keepAlive: true, lookup });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c)).on("end", () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: u.host };
      delete headers.connection;
      const base = u.pathname.replace(/\/$/, "");
      const up = https.request({ hostname: u.hostname, port: 443, path: base + (req.url ?? "/"), method: req.method, headers, agent }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      });
      up.on("error", (e) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: `relay: ${e.message}` } }));
      });
      up.end(body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  relays.push({ server, agent });
  return `http://127.0.0.1:${server.address().port}`;
}

let rpcCache = null;
async function rpc() {
  if (rpcCache) return rpcCache;
  const target = process.env.MAINNET_RPC_URL?.trim() || PUBLIC_RPC;
  if ((await chainIdOf(target)) === CHAIN_ID) return (rpcCache = { url: target, via: "direct" });
  const host = new URL(target).hostname;
  const ips = await resolveOverHttps(host);
  if (!ips.length) fail(`Cannot reach ${target} (and DNS-over-HTTPS gave no address). Check the connection or set MAINNET_RPC_URL.`);
  const url = await startRelay(target, ips);
  if ((await chainIdOf(url)) !== CHAIN_ID) fail(`${target} via ${ips[0]} did not answer as chain ${CHAIN_ID}. Set MAINNET_RPC_URL to another RPC.`);
  return (rpcCache = { url, via: `relay 127.0.0.1 -> ${host} (${ips[0]}); your DNS hides this host` });
}

async function client() {
  return createPublicClient({ transport: viemHttp((await rpc()).url, { retryCount: 2, timeout: 20_000 }) });
}

function closeRelays() {
  for (const { server, agent } of relays) {
    server.close();
    agent.destroy();
  }
}

// ---------------------------------------------------------------- config, keys, state ----
function config() {
  const c = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  if (!isAddress(c.wallet ?? "")) fail(`contracts/mainnet.json: "wallet" is not an address`);
  c.wallet = getAddress(c.wallet);
  c.launchConfigId ??= 0;
  c.token ??= {};
  return c;
}

/** Decisions that must be made before `deploy` (asset, epoch) and before `launch` (all). Never guessed. */
function missing(c, forLaunch) {
  const m = [];
  if (!["ETH", "USDG"].includes(c.asset)) m.push(`"asset": "ETH" or "USDG" (the pair asset; fees and node payouts are in it)`);
  if (!Number.isInteger(c.epochLengthSeconds) || c.epochLengthSeconds < 60) m.push(`"epochLengthSeconds": whole seconds, e.g. 21600 (6 h)`);
  if (forLaunch) {
    if (!Number.isInteger(c.creatorTaxBps) || c.creatorTaxBps < 0) m.push(`"creatorTaxBps": 0..maxCreatorTaxBps (1000 today); fixed at launch`);
    if (!c.token.name) m.push(`"token.name"`);
    if (!c.token.symbol) m.push(`"token.symbol"`);
  }
  return m;
}

function ops() {
  if (!existsSync(OPS_FILE)) return null;
  const k = JSON.parse(readFileSync(OPS_FILE, "utf8"));
  return { scheduler: privateKeyToAccount(k.scheduler).address, sweep: privateKeyToAccount(k.sweep).address };
}

function deployedReward() {
  if (!existsSync(DEPLOYMENTS)) return null;
  const a = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"))[String(CHAIN_ID)]?.SparecycleRewards;
  return a ? getAddress(a) : null;
}

function deployedPayments() {
  if (!existsSync(DEPLOYMENTS)) return null;
  const a = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"))[String(CHAIN_ID)]?.SparecycleJobPayments;
  return a ? getAddress(a) : null;
}

function deployedX402() {
  if (!existsSync(DEPLOYMENTS)) return null;
  const a = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"))[String(CHAIN_ID)]?.SparecycleX402Escrow;
  return a ? getAddress(a) : null;
}

// x402 launch settings (decided 26 Nov 2026): USDG (6 decimals), caps 1 USDG per job, 100 USDG held in total,
// 10 USDG per payer per reward epoch; the pot's 95% goes to the treasury Safe, which converts it to ETH.
const X402 = {
  asset: USDG,
  assetName: "Global Dollar",
  assetVersion: "1",
  maxPerJob: 1_000_000n,
  maxTotalHeld: 100_000_000n,
  maxPerPayerPerEpoch: 10_000_000n,
  settleWindow: 43_200n,
};

function deployedStake() {
  if (!existsSync(DEPLOYMENTS)) return null;
  const a = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"))[String(CHAIN_ID)]?.SparecycleNodeStake;
  return a ? getAddress(a) : null;
}

/** SPARE from the site's single address source (src/lib/addresses.ts, ADDR.spareToken). */
function spareToken() {
  const m = /spareToken:\s*"(0x[0-9a-fA-F]{40})"/.exec(readFileSync(join(ROOT, "src", "lib", "addresses.ts"), "utf8"));
  if (!m) fail("No spareToken in src/lib/addresses.ts.");
  return getAddress(m[1]);
}

/** The SPARE/ETH Uniswap v4 pool key and PoolManager from the site's address sources (UNISWAP_V4_DEFAULTS, PONS.memeHook). */
function v4Pool() {
  const a = readFileSync(join(ROOT, "src", "lib", "addresses.ts"), "utf8");
  const p = readFileSync(join(ROOT, "src", "lib", "pons.ts"), "utf8");
  const pm = /poolManager:\s*"(0x[0-9a-fA-F]{40})"/.exec(a);
  const key = /spareEthPoolKey:\s*\{[^}]*fee:\s*(\d+),\s*tickSpacing:\s*(\d+),\s*hooks:\s*PONS\.memeHook/.exec(a);
  const hook = /memeHook:\s*"(0x[0-9a-fA-F]{40})"/.exec(p);
  if (!pm || !key || !hook) fail("Could not read the SPARE/ETH v4 pool key from src/lib/addresses.ts and src/lib/pons.ts.");
  return { poolManager: getAddress(pm[1]), fee: Number(key[1]), tickSpacing: Number(key[2]), hooks: getAddress(hook[1]) };
}

// V2 contract names in src/contracts/deployments.json, in deploy order.
const V2_NAMES = ["UniswapV4SpareAdapter", "SparecycleBurner", "SparecycleJobPaymentsV2", "SparecycleHolderPool"];

function deployedV2() {
  if (!existsSync(DEPLOYMENTS)) return null;
  const d = JSON.parse(readFileSync(DEPLOYMENTS, "utf8"))[String(CHAIN_ID)] ?? {};
  return d.SparecycleJobPaymentsV2 ? Object.fromEntries(V2_NAMES.map((n) => [n, d[n] ? getAddress(d[n]) : null])) : null;
}

// V2 launch settings (owner decisions of 26-27 Nov 2026; the split, discount and slippage are the contracts' defaults).
// SPARE-paid jobs: at most 0.02 ETH of them per epoch (a small share of the pool's ETH side, so one epoch's SPARE sale
// stays well inside the 4% slippage with the pool hook's 2.90% cut). The burner's share is 0, so its cap is not used
// until the Safe changes the split; it must be > 0. The Safe can change both later.
const V2 = { spareCapEthPerEpoch: parseEther("0.02"), maxEthPerBurn: parseEther("0.05") };

function launched() {
  if (!existsSync(LAUNCH_RUN)) return null;
  const run = JSON.parse(readFileSync(LAUNCH_RUN, "utf8"));
  const token = run.returns?.token?.value;
  const curve = run.returns?.curve?.value;
  // forge writes this file before sending, with the simulated return values: only a successful receipt counts.
  const receipt = run.receipts?.find((r) => r.status === "0x1" || r.status === 1 || r.status === true);
  return token && curve && receipt ? { token: getAddress(token), curve: getAddress(curve), tx: receipt.transactionHash } : null;
}

const keystoreExists = (name) => existsSync(join(KEYSTORES, name));

function deployEnv(c, scheduler) {
  return {
    ADMIN: c.wallet,
    SCHEDULER: scheduler,
    EPOCH_LENGTH: String(c.epochLengthSeconds),
    PAYOUT_TOKEN: c.asset === "USDG" ? USDG : zeroAddress,
    FEE_ESCROW: PONS.feeEscrow,
    DEPLOY_MOCK_ESCROW: "0",
  };
}

function launchEnv(c, reward) {
  const t = c.token;
  const env = {
    TOKEN_NAME: t.name,
    TOKEN_SYMBOL: t.symbol,
    CREATOR_TAX_BPS: String(c.creatorTaxBps),
    PAIR_ASSET: c.asset,
    LAUNCH_CONFIG_ID: String(c.launchConfigId),
    TOKEN_LOGO: t.logo,
    TOKEN_DESCRIPTION: t.description,
    TOKEN_WEBSITE: t.website,
    TOKEN_TWITTER: t.twitter,
    TOKEN_TELEGRAM: t.telegram,
    TOKEN_DISCORD: t.discord,
    TOKEN_FARCASTER: t.farcaster,
  };
  if (reward) env.REWARD_CONTRACT = reward;
  return env;
}

// ---------------------------------------------------------------- foundry ----
function toolEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of SCRIPT_ENV) delete env[k];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && String(v) !== "") env[k] = String(v);
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${join(homedir(), ".foundry", "bin")}${delimiter}${env[pathKey] ?? ""}`;
  return env;
}

function run(cmd, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: CONTRACTS, env: toolEnv(extraEnv), stdio: "inherit" });
    p.on("error", (e) => {
      console.error(`could not run ${cmd}: ${e.message} (install Foundry: https://getfoundry.sh)`);
      resolve(1);
    });
    p.on("close", (code) => resolve(code ?? 1));
  });
}

function needTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    fail("This step signs a mainnet transaction and asks for the keystore password: run it yourself in a terminal (VS Code terminal / PowerShell).");
}

async function confirm(word, question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`\n${question}\nType ${word} to send it, anything else to stop: `)).trim();
  rl.close();
  return a.toUpperCase() === word.toUpperCase(); // the word must be typed; its case does not matter
}

function needKeystore(c) {
  if (!keystoreExists(c.keystore))
    fail(`No Foundry keystore "${c.keystore}" yet. Run: node scripts/mainnet.mjs import\n(or put the name of an existing keystore that holds ${c.wallet} in contracts/mainnet.json "keystore")`);
}

const eth = (wei) => `${Number(formatEther(wei)).toFixed(6)} ETH`;

// ---------------------------------------------------------------- commands ----
async function status() {
  const c = config();
  const r = await rpc();
  const pc = await client();
  console.log(`RPC        ${r.via === "direct" ? r.url : r.via}`);
  const [bal, nonce, gas, can, enabled, fee, maxTax] = await Promise.all([
    pc.getBalance({ address: c.wallet }),
    pc.getTransactionCount({ address: c.wallet }),
    pc.getGasPrice(),
    pc.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "canLaunch", args: [c.wallet] }),
    pc.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "launchEnabled" }),
    pc.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "launchFee" }),
    pc.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "maxCreatorTaxBps" }),
  ]);
  console.log(`\nWallet     ${c.wallet}  (owner of the reward contract, launcher)`);
  console.log(`  balance  ${eth(bal)}   nonce ${nonce}   gas price ${(Number(gas) / 1e9).toFixed(4)} gwei`);
  console.log(`  Pons     canLaunch ${can}   launches ${enabled ? "enabled" : "DISABLED"}   launch fee ${eth(fee)}   max creator tax ${maxTax} bps`);
  console.log(`  keystore "${c.keystore}" ${keystoreExists(c.keystore) ? "present" : "missing (node scripts/mainnet.mjs import)"}`);
  const o = ops();
  if (!o) console.log(`\nHot wallets  not created yet (node scripts/mainnet.mjs init)`);
  else {
    const [bs, bw] = await Promise.all([pc.getBalance({ address: o.scheduler }), pc.getBalance({ address: o.sweep })]);
    console.log(`\nScheduler  ${o.scheduler}  ${eth(bs)}  (posts each epoch's Merkle root; key on the server)`);
    console.log(`Sweep bot  ${o.sweep}  ${eth(bw)}  (moves Pons fees into the pot; key on the server)`);
  }
  const forDeploy = missing(c, false);
  const forLaunch = missing(c, true);
  console.log(`\nDecisions (contracts/mainnet.json): ${forLaunch.length ? "" : "all set"}`);
  for (const m of forLaunch) console.log(`  missing  ${m}`);
  if (!forLaunch.length) console.log(`  asset ${c.asset}, creator tax ${c.creatorTaxBps} bps, ${c.token.name} (${c.token.symbol}), epoch ${c.epochLengthSeconds} s`);

  const reward = deployedReward();
  if (!reward) console.log(`\nReward contract  not deployed${forDeploy.length ? "" : "  (next: rehearse, then deploy)"}`);
  else {
    const read = (functionName) => pc.readContract({ address: reward, abi: rewardAbi, functionName });
    const [owner, sched, escrow, payout, len, epoch, pbal] = await Promise.all([
      read("owner"), read("scheduler"), read("feeEscrow"), read("payoutToken"), read("epochLength"), read("currentEpoch"), pc.getBalance({ address: reward }),
    ]);
    console.log(`\nReward contract  ${reward}  ${EXPLORER}/address/${reward}`);
    console.log(`  owner ${owner}${owner === c.wallet ? " (the wallet)" : ""}   scheduler ${sched}`);
    console.log(`  escrow ${escrow === PONS.feeEscrow ? "Pons v2" : escrow}   payout ${payout === zeroAddress ? "ETH" : payout}   epoch ${epoch} of ${len} s   balance ${eth(pbal)}`);
  }
  const l = launched();
  if (!l) console.log(`\nToken  not launched`);
  else {
    const lt = await pc.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "getLaunchedToken", args: [l.token] });
    console.log(`\nToken  ${l.token}  curve ${l.curve}`);
    console.log(`  fee recipient ${lt.creatorFeeRecipient}${reward && lt.creatorFeeRecipient === reward ? " (the reward contract)" : ""}   buyback ${lt.buybackEnabled ? "ON" : "off"}   phase ${lt.phase}`);
  }
}

async function init() {
  if (!existsSync(OPS_FILE)) {
    mkdirSync(dirname(OPS_FILE), { recursive: true });
    writeFileSync(OPS_FILE, JSON.stringify({ scheduler: generatePrivateKey(), sweep: generatePrivateKey() }, null, 2) + "\n", { mode: 0o600 });
    console.log(`created ${OPS_FILE} (gitignored; keys are never printed)`);
  }
  const o = ops();
  console.log(`scheduler  ${o.scheduler}\nsweep bot  ${o.sweep}`);
  console.log(`Both hold only gas money. The server signs with them: node scripts/mainnet.mjs secret scheduler | railway variable set SCHEDULER_SIGNER_KEY --stdin --service web`);
}

async function importKey() {
  needTerminal();
  const c = config();
  if (keystoreExists(c.keystore)) fail(`Keystore "${c.keystore}" already exists. Nothing to do.`);
  console.log(`Foundry asks for the private key of ${c.wallet} (hidden while you type), then a password that encrypts it.`);
  console.log(`Afterwards check that the "Address" Foundry prints is ${c.wallet}.\n`);
  process.exitCode = await run("cast", ["wallet", "import", c.keystore, "--interactive"]);
}

async function rehearse(placeholders) {
  let c = config();
  const gaps = missing(c, true);
  if (gaps.length && !placeholders) fail(`Decide first (contracts/mainnet.json):\n  ${gaps.join("\n  ")}\nor run: node scripts/mainnet.mjs rehearse --placeholders`);
  if (gaps.length) {
    c = { ...c, asset: c.asset ?? "ETH", creatorTaxBps: c.creatorTaxBps ?? 0, epochLengthSeconds: c.epochLengthSeconds ?? 21600 };
    c.token = { ...c.token, name: c.token.name ?? "Sparecycle Rehearsal", symbol: c.token.symbol ?? "SCRHSL" };
    console.log(`placeholders for undecided values: asset ${c.asset}, creator tax ${c.creatorTaxBps} bps, ${c.token.name} (${c.token.symbol})`);
  }
  const scheduler = ops()?.scheduler ?? "0x000000000000000000000000000000000000dEaD";
  const r = await rpc();
  console.log(`RPC ${r.via === "direct" ? r.url : r.via}\nDry run from ${c.wallet} on live mainnet state. Nothing is signed or sent.\n`);
  const code = await run("forge", ["script", "script/Rehearse.s.sol:Rehearse", "--rpc-url", r.url, "--sender", c.wallet], {
    ...deployEnv(c, scheduler),
    ...launchEnv(c, null),
  });
  if (code !== 0) fail("Rehearsal failed (see above). Nothing was sent.");
  console.log(`\nRehearsal passed: deploy + launch would succeed from ${c.wallet} right now, and a test buy's fees reached the pot.`);
}

async function deploy(again) {
  const c = config();
  const gaps = missing(c, false);
  if (gaps.length) fail(`Decide first (contracts/mainnet.json):\n  ${gaps.join("\n  ")}`);
  const o = ops();
  if (!o) fail("Create the scheduler wallet first: node scripts/mainnet.mjs init");
  if (deployedReward() && !again) fail(`Already deployed: ${deployedReward()}. (--again deploys another one)`);
  needTerminal();
  needKeystore(c);
  const r = await rpc();
  const env = deployEnv(c, o.scheduler);
  const args = ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", r.url, "--sender", c.wallet];
  console.log(`Simulating the deploy from ${c.wallet} (nothing sent yet)\n`);
  if ((await run("forge", args, env)) !== 0) fail("Simulation failed. Nothing was sent.");
  const ok = await confirm(
    "DEPLOY",
    `Deploy SparecycleRewards on Robinhood Chain mainnet: owner ${c.wallet}, scheduler ${o.scheduler}, payout ${c.asset}, epoch ${c.epochLengthSeconds} s. The payout asset and epoch length can never change.`,
  );
  if (!ok) fail("Stopped. Nothing was sent.");
  if ((await run("forge", [...args, "--account", c.keystore, "--broadcast"], env)) !== 0) fail("Broadcast failed (see above).");
  if ((await run(process.execPath, [join(ROOT, "scripts", "sync-deployments.mjs"), "Deploy.s.sol", "--chain", String(CHAIN_ID)])) !== 0)
    fail("Deployed, but writing src/contracts/deployments.json failed; run node scripts/sync-deployments.mjs Deploy.s.sol --chain 4663");
  const reward = deployedReward();
  const pc = await client();
  const [owner, sched, escrow] = await Promise.all(["owner", "scheduler", "feeEscrow"].map((functionName) => pc.readContract({ address: reward, abi: rewardAbi, functionName })));
  const good = owner === c.wallet && sched === o.scheduler && escrow === PONS.feeEscrow;
  console.log(`\nSparecycleRewards ${reward}\n${EXPLORER}/address/${reward}\nread back: owner ${owner}, scheduler ${sched}, escrow ${escrow}  ${good ? "OK" : "MISMATCH"}`);
  console.log(`Next: node scripts/mainnet.mjs verify, then fund scheduler, then launch.`);
}

const paymentsAbi = parseAbi([
  "function rewards() view returns (address)",
  "function treasury() view returns (address)",
  "function TREASURY_BPS() view returns (uint16)",
]);
const safeAbi = parseAbi(["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"]);

/** Deploys SparecycleJobPayments on the live reward contract, with the treasury Safe from contracts/mainnet.json. */
async function deployPayments(again) {
  const c = config();
  const reward = deployedReward();
  if (!reward) fail("Deploy the reward contract first: node scripts/mainnet.mjs deploy");
  const safe = c.treasury?.safe;
  if (!safe || !isAddress(safe)) fail('Set "treasury": { "safe": "0x…" } in contracts/mainnet.json (the Safe multisig).');
  if (deployedPayments() && !again) fail(`Already deployed: ${deployedPayments()}. (--again deploys another one)`);
  needTerminal();
  needKeystore(c);
  const r = await rpc();
  const pc = await client();
  const [code, owners, threshold] = await Promise.all([
    pc.getCode({ address: safe }),
    pc.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }).catch(() => null),
    pc.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }).catch(() => null),
  ]);
  if (!code || code === "0x" || !owners || threshold === null) fail(`${safe} is not a Safe on Robinhood Chain (no code or no getOwners()).`);
  console.log(`Treasury Safe ${safe}: ${threshold} of ${owners.length} (${owners.join(", ")})`);
  if (threshold < 2n) fail("The treasury Safe needs a threshold of at least 2.");
  const env = { REWARD_CONTRACT: reward, TREASURY: safe };
  const args = ["script", "script/DeployPayments.s.sol:DeployPayments", "--rpc-url", r.url, "--sender", c.wallet];
  console.log(`Simulating the payments deploy from ${c.wallet} (nothing sent yet)\n`);
  if ((await run("forge", args, env)) !== 0) fail("Simulation failed. Nothing was sent.");
  const ok = await confirm(
    "PAYMENTS",
    `Deploy SparecycleJobPayments: rewards ${reward}, treasury Safe ${safe} (5% of every charge, fixed). No owner, no admin functions; the reward contract's scheduler is the only charger.`,
  );
  if (!ok) fail("Stopped. Nothing was sent.");
  if ((await run("forge", [...args, "--account", c.keystore, "--broadcast"], env)) !== 0) fail("Broadcast failed (see above).");
  const runFile = join(CONTRACTS, "broadcast", "DeployPayments.s.sol", String(CHAIN_ID), "run-latest.json");
  const out = JSON.parse(readFileSync(runFile, "utf8"));
  const receipt = out.receipts?.find((x) => x.status === "0x1" || x.status === 1);
  const address = receipt?.contractAddress ? getAddress(receipt.contractAddress) : null;
  if (!address) fail("Sent, but no successful receipt with a contract address in the broadcast output; check Blockscout.");
  const all = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {};
  all[String(CHAIN_ID)] = { ...(all[String(CHAIN_ID)] ?? {}), SparecycleJobPayments: address };
  writeFileSync(DEPLOYMENTS, JSON.stringify(all, null, 2) + "\n");
  const [rw, tr, bps] = await Promise.all(["rewards", "treasury", "TREASURY_BPS"].map((functionName) => pc.readContract({ address, abi: paymentsAbi, functionName })));
  const good = rw === reward && tr === getAddress(safe) && bps === 500;
  console.log(`\nSparecycleJobPayments ${address}\n${EXPLORER}/address/${address}\ntx ${receipt.transactionHash}\nread back: rewards ${rw}, treasury ${tr}, treasury share ${bps} bps  ${good ? "OK" : "MISMATCH"}`);
  console.log("Next: node scripts/mainnet.mjs verify payments, then node scripts/mainnet.mjs env (Railway variables).");
}

const stakeAbi = parseAbi([
  "function token() view returns (address)",
  "function rewards() view returns (address)",
  "function safe() view returns (address)",
  "function burnWithBurnFunction() view returns (bool)",
  "function minStakePerNode() view returns (uint256)",
  "function slashBps() view returns (uint16)",
]);

/**
 * Deploys SparecycleNodeStake next to the live reward contract: SPARE (from src/lib/addresses.ts) is staked per owner
 * wallet, the reward contract's scheduler proposes slashes, the treasury Safe judges them. Minimum stake 0, so no node
 * needs a stake until the Safe raises it. Internal review only, not externally audited. --dry-run simulates only and
 * needs no keystore.
 */
async function deployStake(again, dryRun) {
  const c = config();
  const reward = deployedReward();
  if (!reward) fail("No reward contract deployed.");
  const safe = c.treasury?.safe;
  if (!safe || !isAddress(safe)) fail('Set "treasury": { "safe": "0x…" } in contracts/mainnet.json (the Safe multisig).');
  if (deployedStake() && !again) fail(`Already deployed: ${deployedStake()}. (--again deploys another one)`);
  const spare = spareToken();
  if (!dryRun) {
    needTerminal();
    needKeystore(c);
  }
  const r = await rpc();
  const pc = await client();
  const [safeCode, threshold, spareCode, scheduler] = await Promise.all([
    pc.getCode({ address: safe }),
    pc.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }).catch(() => null),
    pc.getCode({ address: spare }),
    pc.readContract({ address: reward, abi: rewardAbi, functionName: "scheduler" }),
  ]);
  if (!safeCode || safeCode === "0x" || threshold === null) fail(`${safe} is not a Safe on Robinhood Chain.`);
  if (threshold < 2n) fail("The treasury Safe needs a threshold of at least 2.");
  if (!spareCode || spareCode === "0x") fail(`SPARE ${spare} has no code on Robinhood Chain.`);
  // burn(uint256) = 0x42966c68 in SPARE's runtime code (a fork test burned SPARE and saw totalSupply fall).
  const hasBurn = spareCode.toLowerCase().includes("42966c68");
  console.log(`SPARE ${spare}: burn(uint256) ${hasBurn ? "found: slashed SPARE is burned" : "not found: slashed SPARE goes to 0x…dEaD"}`);
  console.log(`Reward contract ${reward} (scheduler ${scheduler}); treasury Safe ${safe}, threshold ${threshold}`);
  const env = { SPARE_TOKEN: spare, REWARD_CONTRACT: reward, TREASURY: safe, SPARE_HAS_BURN: String(hasBurn), MIN_STAKE_PER_NODE: "0" };
  const args = ["script", "script/DeployNodeStake.s.sol:DeployNodeStake", "--rpc-url", r.url, "--sender", c.wallet];
  console.log(`Simulating the NodeStake deploy from ${c.wallet} (nothing sent yet)\n`);
  if ((await run("forge", args, env)) !== 0) fail("Simulation failed. Nothing was sent.");
  if (dryRun) {
    console.log("\nDry run only: nothing was sent.");
    return;
  }
  const ok = await confirm(
    "STAKE",
    `Deploy SparecycleNodeStake: SPARE ${spare}, rewards ${reward}, treasury Safe ${safe}. Minimum stake 0; a slash is at most 10% of a stake per proposal and is burned; appeal window 4 epochs; unstake cooldown 16 epochs. Internal review only, not externally audited.`,
  );
  if (!ok) fail("Stopped. Nothing was sent.");
  if ((await run("forge", [...args, "--account", c.keystore, "--broadcast"], env)) !== 0) fail("Broadcast failed (see above).");
  const runFile = join(CONTRACTS, "broadcast", "DeployNodeStake.s.sol", String(CHAIN_ID), "run-latest.json");
  const out = JSON.parse(readFileSync(runFile, "utf8"));
  const receipt = out.receipts?.find((x) => x.status === "0x1" || x.status === 1);
  const address = receipt?.contractAddress ? getAddress(receipt.contractAddress) : null;
  if (!address) fail("Sent, but no successful receipt with a contract address in the broadcast output; check Blockscout.");
  const all = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {};
  all[String(CHAIN_ID)] = { ...(all[String(CHAIN_ID)] ?? {}), SparecycleNodeStake: address };
  writeFileSync(DEPLOYMENTS, JSON.stringify(all, null, 2) + "\n");
  const read = (functionName) => pc.readContract({ address, abi: stakeAbi, functionName });
  const [tk, rw, sf, burn, min, bps] = await Promise.all(["token", "rewards", "safe", "burnWithBurnFunction", "minStakePerNode", "slashBps"].map(read));
  const good = tk === spare && rw === reward && sf === getAddress(safe) && burn === hasBurn && min === 0n && bps === 1000;
  console.log(`\nSparecycleNodeStake ${address}\n${EXPLORER}/address/${address}\ntx ${receipt.transactionHash}`);
  console.log(`read back: token ${tk}, rewards ${rw}, safe ${sf}, burn ${burn}, min stake ${min}, slash cap ${bps} bps  ${good ? "OK" : "MISMATCH"}`);
  console.log("Next: node scripts/mainnet.mjs verify stake, then set TOKEN_NODE_STAKE_ADDRESS on Railway.");
}

const x402Abi = parseAbi([
  "function owner() view returns (address)",
  "function rewards() view returns (address)",
  "function asset() view returns (address)",
  "function treasury() view returns (address)",
  "function forwardTo() view returns (address)",
  "function settleWindow() view returns (uint64)",
  "function potPaysInAsset() view returns (bool)",
  "function maxPerJob() view returns (uint256)",
  "function maxTotalHeld() view returns (uint256)",
  "function maxPerPayerPerEpoch() view returns (uint256)",
]);

/**
 * Deploys SparecycleX402Escrow (x402 option X1): per-job USDG escrow funded by the payer's EIP-3009 authorization,
 * forwarded on agreement (95% to forwardTo = the Safe for conversion, 5% to the treasury Safe) or refunded. Owner =
 * the treasury Safe (the reward contract's owner). Internal review only, not externally audited. --dry-run simulates.
 */
async function deployX402(again, dryRun) {
  const c = config();
  const reward = deployedReward();
  if (!reward) fail("No reward contract deployed.");
  const safe = c.treasury?.safe;
  if (!safe || !isAddress(safe)) fail('Set "treasury": { "safe": "0x…" } in contracts/mainnet.json (the Safe multisig).');
  if (deployedX402() && !again) fail(`Already deployed: ${deployedX402()}. (--again deploys another one)`);
  if (!dryRun) {
    needTerminal();
    needKeystore(c);
  }
  const r = await rpc();
  const pc = await client();
  const [threshold, owner] = await Promise.all([
    pc.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }).catch(() => null),
    pc.readContract({ address: reward, abi: rewardAbi, functionName: "owner" }),
  ]);
  if (threshold === null || threshold < 2n) fail(`${safe} is not a Safe with a threshold of at least 2.`);
  if (getAddress(owner) !== getAddress(safe)) fail(`The reward contract's owner is ${owner}, not the treasury Safe: the escrow owner must be the Safe.`);
  const usdg = (n) => `${Number(n) / 1e6} USDG`;
  console.log(`Asset USDG ${X402.asset} ("${X402.assetName}" v${X402.assetVersion}); owner, treasury and forwardTo: the Safe ${safe}`);
  console.log(`Caps: ${usdg(X402.maxPerJob)} per job, ${usdg(X402.maxTotalHeld)} held in total, ${usdg(X402.maxPerPayerPerEpoch)} per payer per epoch; settle window ${X402.settleWindow} s`);
  const env = {
    REWARD_CONTRACT: reward,
    X402_ASSET: X402.asset,
    X402_ASSET_NAME: X402.assetName,
    X402_ASSET_VERSION: X402.assetVersion,
    X402_FORWARD_TO: safe,
    TREASURY: safe,
    X402_SETTLE_WINDOW: String(X402.settleWindow),
    X402_MAX_PER_JOB: String(X402.maxPerJob),
    X402_MAX_TOTAL_HELD: String(X402.maxTotalHeld),
    X402_MAX_PER_PAYER_PER_EPOCH: String(X402.maxPerPayerPerEpoch),
  };
  const args = ["script", "script/DeployX402Escrow.s.sol:DeployX402Escrow", "--rpc-url", r.url, "--sender", c.wallet];
  console.log(`Simulating the x402 escrow deploy from ${c.wallet} (nothing sent yet)\n`);
  if ((await run("forge", args, env)) !== 0) fail("Simulation failed. Nothing was sent.");
  if (dryRun) {
    console.log("\nDry run only: nothing was sent.");
    return;
  }
  const ok = await confirm(
    "X402",
    `Deploy SparecycleX402Escrow: USDG escrow per job, funded by the payer's signed authorization; on agreement 95% to the Safe for conversion and 5% to the treasury Safe, otherwise refunded; anyone can refund after ${X402.settleWindow} s. Caps ${usdg(X402.maxPerJob)} / ${usdg(X402.maxTotalHeld)} / ${usdg(X402.maxPerPayerPerEpoch)}. Owner: the Safe. Internal review only, not externally audited.`,
  );
  if (!ok) fail("Stopped. Nothing was sent.");
  if ((await run("forge", [...args, "--account", c.keystore, "--broadcast"], env)) !== 0) fail("Broadcast failed (see above).");
  const runFile = join(CONTRACTS, "broadcast", "DeployX402Escrow.s.sol", String(CHAIN_ID), "run-latest.json");
  const out = JSON.parse(readFileSync(runFile, "utf8"));
  const receipt = out.receipts?.find((x) => x.status === "0x1" || x.status === 1);
  const address = receipt?.contractAddress ? getAddress(receipt.contractAddress) : null;
  if (!address) fail("Sent, but no successful receipt with a contract address in the broadcast output; check Blockscout.");
  const all = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {};
  all[String(CHAIN_ID)] = { ...(all[String(CHAIN_ID)] ?? {}), SparecycleX402Escrow: address };
  writeFileSync(DEPLOYMENTS, JSON.stringify(all, null, 2) + "\n");
  const read = (functionName) => pc.readContract({ address, abi: x402Abi, functionName });
  const names = ["owner", "rewards", "asset", "treasury", "forwardTo", "settleWindow", "potPaysInAsset", "maxPerJob", "maxTotalHeld", "maxPerPayerPerEpoch"];
  const v = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await read(n)])));
  const S = getAddress(safe);
  const good = v.owner === S && v.rewards === reward && v.asset === getAddress(X402.asset) && v.treasury === S && v.forwardTo === S &&
    v.settleWindow === X402.settleWindow && v.potPaysInAsset === false && v.maxPerJob === X402.maxPerJob &&
    v.maxTotalHeld === X402.maxTotalHeld && v.maxPerPayerPerEpoch === X402.maxPerPayerPerEpoch;
  console.log(`\nSparecycleX402Escrow ${address}\n${EXPLORER}/address/${address}\ntx ${receipt.transactionHash}`);
  console.log(`read back: owner ${v.owner}, asset ${v.asset}, forwardTo ${v.forwardTo}, caps ${usdg(v.maxPerJob)} / ${usdg(v.maxTotalHeld)} / ${usdg(v.maxPerPayerPerEpoch)}, pot pays in asset ${v.potPaysInAsset}  ${good ? "OK" : "MISMATCH"}`);
  console.log("Next: node scripts/mainnet.mjs verify x402, then set the X402_* variables on Railway.");
}

const v2Abi = parseAbi([
  "function treasury() view returns (address)",
  "function rewards() view returns (address)",
  "function burner() view returns (address)",
  "function holderPool() view returns (address)",
  "function spare() view returns (address)",
  "function swapAdapter() view returns (address)",
  "function currentSplit() view returns (uint16, uint16, uint16)",
  "function SPARE_DISCOUNT_BPS() view returns (uint16)",
  "function maxSwapSlippageBps() view returns (uint16)",
  "function spareCapEthPerEpoch() view returns (uint256)",
  "function referenceSparePrice() view returns (uint256)",
]);
const holderPoolAbi = parseAbi(["function payments() view returns (address)"]);

/**
 * Deploys the V2 payment stack (docs/contracts-v2.md) in one forge run from the wallet: the Uniswap v4 SPARE adapter,
 * SparecycleBurner, SparecycleJobPaymentsV2 and SparecycleHolderPool, wired to each other through predicted addresses,
 * on the live SparecycleRewards with the treasury Safe as owner of every setting. Internal review only, not externally
 * audited. --dry-run simulates on live mainnet state and sends nothing.
 */
async function deployV2(again, dryRun) {
  const c = config();
  const reward = deployedReward();
  if (!reward) fail("No reward contract deployed.");
  const safe = c.treasury?.safe;
  if (!safe || !isAddress(safe)) fail('Set "treasury": { "safe": "0x…" } in contracts/mainnet.json (the Safe multisig).');
  if (deployedV2() && !again) fail(`Already deployed: SparecycleJobPaymentsV2 ${deployedV2().SparecycleJobPaymentsV2}. (--again deploys another set)`);
  const spare = spareToken();
  const pool = v4Pool();
  if (!dryRun) {
    needTerminal();
    needKeystore(c);
  }
  const r = await rpc();
  const pc = await client();
  const [threshold, owner, scheduler, payout, spareCode, bal] = await Promise.all([
    pc.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }).catch(() => null),
    pc.readContract({ address: reward, abi: rewardAbi, functionName: "owner" }),
    pc.readContract({ address: reward, abi: rewardAbi, functionName: "scheduler" }),
    pc.readContract({ address: reward, abi: rewardAbi, functionName: "payoutToken" }),
    pc.getCode({ address: spare }),
    pc.getBalance({ address: c.wallet }),
  ]);
  if (threshold === null || threshold < 2n) fail(`${safe} is not a Safe with a threshold of at least 2.`);
  if (getAddress(owner) !== getAddress(safe)) fail(`The reward contract's owner is ${owner}, not the treasury Safe.`);
  if (payout !== zeroAddress) fail("The reward contract does not pay out in ETH; V2 needs an ETH pot.");
  // burn(uint256) = 0x42966c68 in SPARE's runtime code (as for NodeStake).
  const hasBurn = Boolean(spareCode && spareCode.toLowerCase().includes("42966c68"));
  console.log(`Reward contract ${reward} (scheduler ${scheduler}); treasury Safe ${safe}, threshold ${threshold}`);
  console.log(`SPARE ${spare}, burn(uint256) ${hasBurn ? "found" : "not found (burns go to 0x…dEaD)"}`);
  console.log(`SPARE/ETH v4 pool: PoolManager ${pool.poolManager}, fee ${pool.fee}, tickSpacing ${pool.tickSpacing}, hooks ${pool.hooks}`);
  console.log(`Split 350 treasury / 0 burner / 150 holder pool; SPARE discount 0%; slippage 4%; SPARE-paid jobs at most ${eth(V2.spareCapEthPerEpoch)} per epoch; burner cap ${eth(V2.maxEthPerBurn)}`);
  console.log(`Wallet ${c.wallet}: ${eth(bal)}`);
  const env = {
    REWARD_CONTRACT: reward,
    TREASURY: safe,
    SPARE_TOKEN: spare,
    SPARE_HAS_BURN: String(hasBurn),
    V4_POOL_MANAGER: pool.poolManager,
    V4_POOL_FEE: String(pool.fee),
    V4_TICK_SPACING: String(pool.tickSpacing),
    V4_HOOKS: pool.hooks,
    MAX_ETH_PER_BURN: String(V2.maxEthPerBurn),
    SPARE_PAY_CAP_ETH: String(V2.spareCapEthPerEpoch),
  };
  const args = ["script", "script/DeployV2.s.sol:DeployV2", "--rpc-url", r.url, "--sender", c.wallet];
  console.log(`Simulating the V2 deploy from ${c.wallet} (nothing sent yet)\n`);
  if ((await run("forge", args, env)) !== 0) fail("Simulation failed. Nothing was sent.");
  if (dryRun) {
    console.log("\nDry run only: nothing was sent.");
    return;
  }
  const ok = await confirm(
    "V2",
    `Deploy 4 contracts in a row from ${c.wallet} (send nothing else from this wallet until it is done): the Uniswap v4 SPARE adapter, SparecycleBurner, SparecycleJobPaymentsV2 and SparecycleHolderPool, owned by the treasury Safe. Split 350 / 0 / 150, SPARE at 0% discount, slippage 4%; SPARE payments stay closed until the Safe sets a reference price. Internal review only, not externally audited.`,
  );
  if (!ok) fail("Stopped. Nothing was sent.");
  if ((await run("forge", [...args, "--account", c.keystore, "--broadcast", "--slow"], env)) !== 0) fail("Broadcast failed (see above). Check Blockscout before running it again.");
  const runFile = join(CONTRACTS, "broadcast", "DeployV2.s.sol", String(CHAIN_ID), "run-latest.json");
  const out = JSON.parse(readFileSync(runFile, "utf8"));
  const found = {};
  for (const t of out.transactions ?? []) {
    if (!V2_NAMES.includes(t.contractName) || !t.contractAddress) continue;
    const rc = out.receipts?.find((x) => x.transactionHash === t.hash);
    if (rc && (rc.status === "0x1" || rc.status === 1)) found[t.contractName] = { address: getAddress(t.contractAddress), tx: t.hash };
  }
  const missingNames = V2_NAMES.filter((n) => !found[n]);
  if (missingNames.length) fail(`Sent, but no successful receipt for ${missingNames.join(", ")} in ${runFile}; check Blockscout.`);
  const all = existsSync(DEPLOYMENTS) ? JSON.parse(readFileSync(DEPLOYMENTS, "utf8")) : {};
  all[String(CHAIN_ID)] = { ...(all[String(CHAIN_ID)] ?? {}), ...Object.fromEntries(V2_NAMES.map((n) => [n, found[n].address])) };
  writeFileSync(DEPLOYMENTS, JSON.stringify(all, null, 2) + "\n");
  const v2 = found.SparecycleJobPaymentsV2.address;
  const read = (functionName) => pc.readContract({ address: v2, abi: v2Abi, functionName });
  const [tr, rw, bu, hp, sp, ad, split, disc, slip, cap, ref] = await Promise.all(
    ["treasury", "rewards", "burner", "holderPool", "spare", "swapAdapter", "currentSplit", "SPARE_DISCOUNT_BPS", "maxSwapSlippageBps", "spareCapEthPerEpoch", "referenceSparePrice"].map(read),
  );
  const poolPays = await pc.readContract({ address: found.SparecycleHolderPool.address, abi: holderPoolAbi, functionName: "payments" });
  const good = tr === getAddress(safe) && rw === reward && bu === found.SparecycleBurner.address && hp === found.SparecycleHolderPool.address &&
    sp === spare && ad === found.UniswapV4SpareAdapter.address && split.join("/") === "350/0/150" && disc === 0 && slip === 400 &&
    cap === V2.spareCapEthPerEpoch && ref === 0n && poolPays === v2;
  console.log("");
  for (const n of V2_NAMES) console.log(`${n.padEnd(24)} ${found[n].address}  ${EXPLORER}/tx/${found[n].tx}`);
  console.log(`read back: treasury ${tr}, split ${split.join("/")}, SPARE discount ${disc} bps, slippage ${slip} bps, SPARE cap ${eth(cap)}, reference price ${ref} (not set yet)  ${good ? "OK" : "MISMATCH"}`);
  console.log("Next: node scripts/mainnet.mjs verify v2, then node scripts/mainnet.mjs env for the Railway settings.");
}

/**
 * Step 1 of 2 of moving the reward contract's owner to a Safe: transferOwnership(safe) from the wallet. The Safe must
 * then execute acceptOwnership() (data 0x79ba5097); until it does, the wallet stays owner. See docs/ops/multisig-runbook.md.
 */
async function transferOwner(safeArg) {
  const c = config();
  const reward = deployedReward();
  if (!reward) fail("No reward contract deployed.");
  if (!safeArg || !isAddress(safeArg)) fail("usage: node scripts/mainnet.mjs transfer-owner <safe address>");
  const safe = getAddress(safeArg);
  needTerminal();
  needKeystore(c);
  const r = await rpc();
  const pc = await client();
  const ownableAbi = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)"]);
  const [owner, pending, code, owners, threshold] = await Promise.all([
    pc.readContract({ address: reward, abi: ownableAbi, functionName: "owner" }),
    pc.readContract({ address: reward, abi: ownableAbi, functionName: "pendingOwner" }),
    pc.getCode({ address: safe }),
    pc.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }).catch(() => null),
    pc.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }).catch(() => null),
  ]);
  if (getAddress(owner) !== getAddress(c.wallet)) fail(`The reward contract's owner is ${owner}, not ${c.wallet}: nothing to do from this wallet.`);
  if (!code || code === "0x" || !owners || threshold === null) fail(`${safe} is not a deployed Safe on Robinhood Chain.`);
  if (threshold < 2n) fail(`The Safe's threshold is ${threshold}; it must be at least 2.`);
  console.log(`Reward contract ${reward}\n  owner         ${owner}\n  pendingOwner  ${pending}`);
  console.log(`New owner (Safe) ${safe}: ${threshold} of ${owners.length}\n  ${owners.join("\n  ")}`);
  const env = { REWARD_CONTRACT: reward, SAFE: safe, EXPECTED_CHAIN_ID: String(CHAIN_ID) };
  const args = ["script", "script/TransferOwnership.s.sol:TransferOwnership", "--rpc-url", r.url, "--sender", c.wallet];
  console.log(`\nSimulating transferOwnership from ${c.wallet} (nothing sent yet)\n`);
  if ((await run("forge", args, env)) !== 0) fail("Simulation failed. Nothing was sent.");
  const ok = await confirm(
    "OWNER",
    `transferOwnership(${safe}) on the reward contract. The wallet stays owner until the Safe executes acceptOwnership(); before that you can still point it elsewhere by running this again.`,
  );
  if (!ok) fail("Stopped. Nothing was sent.");
  if ((await run("forge", [...args, "--account", c.keystore, "--broadcast"], env)) !== 0) fail("Broadcast failed (see above).");
  const after = await pc.readContract({ address: reward, abi: ownableAbi, functionName: "pendingOwner" });
  console.log(`\npendingOwner ${after} ${getAddress(after) === safe ? "OK" : "MISMATCH"}`);
  console.log(`Next, from the Safe: a transaction to ${reward}, value 0, data 0x79ba5097 (acceptOwnership()).`);
  console.log(`Check: ${EXPLORER}/address/${reward}?tab=read_contract (owner = the Safe, pendingOwner = 0x0).`);
}

async function fund(which, amount) {
  if (!["scheduler", "sweep"].includes(which)) fail("usage: node scripts/mainnet.mjs fund <scheduler|sweep> [eth]");
  const c = config();
  const o = ops();
  if (!o) fail("Create the hot wallets first: node scripts/mainnet.mjs init");
  const value = parseEther(amount ?? "0.0003");
  if (value <= 0n || value > parseEther("0.01")) fail("Amount must be above 0 and at most 0.01 ETH (gas money only).");
  needTerminal();
  needKeystore(c);
  const r = await rpc();
  const to = o[which];
  if (!(await confirm("SEND", `Send ${formatEther(value)} ETH from ${c.wallet} to the ${which} wallet ${to}.`))) fail("Stopped. Nothing was sent.");
  process.exitCode = await run("cast", ["send", to, "--value", value.toString(), "--rpc-url", r.url, "--account", c.keystore]);
}

/** The logo and website are written into the token forever: refuse to launch while they do not load. */
async function linkProblems(c) {
  const out = [];
  const check = async (label, url, wantImage) => {
    if (!url) return;
    try {
      const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
      const type = r.headers.get("content-type") ?? "";
      if (!r.ok) out.push(`${label} ${url}: HTTP ${r.status}`);
      else if (wantImage && !type.startsWith("image/")) out.push(`${label} ${url}: not an image (${type || "no content-type"})`);
    } catch (e) {
      out.push(`${label} ${url}: ${e?.cause?.code ?? e?.message ?? e}`);
    }
  };
  await check("logo", c.token.logo, true);
  await check("website", c.token.website, false);
  return out;
}

async function launch(again) {
  const c = config();
  const gaps = missing(c, true);
  if (gaps.length) fail(`Decide first (contracts/mainnet.json):\n  ${gaps.join("\n  ")}`);
  const reward = deployedReward();
  if (!reward) fail("Deploy the reward contract first: node scripts/mainnet.mjs deploy");
  if (launched() && !again) fail(`Already launched: ${launched().token}. (--again launches another token)`);
  const links = process.argv.includes("--skip-link-check") ? [] : await linkProblems(c);
  if (links.length)
    fail(
      `The token links do not load yet (they are stored in the token permanently):\n  ${links.join("\n  ")}\n` +
        "Put the site live on that domain first, or fix contracts/mainnet.json. (--skip-link-check overrides)",
    );
  needTerminal();
  needKeystore(c);
  const r = await rpc();
  const env = launchEnv(c, reward);
  const args = ["script", "script/Launch.s.sol:Launch", "--rpc-url", r.url, "--sender", c.wallet];
  console.log(`Simulating the launch from ${c.wallet} (nothing sent yet)\n`);
  if ((await run("forge", args, env)) !== 0) fail("Simulation failed. Nothing was sent.");
  const ok = await confirm(
    c.token.symbol,
    `Launch ${c.token.name} (${c.token.symbol}) on Pons: pair ${c.asset}, creator tax ${c.creatorTaxBps} bps (can never be raised), fee recipient = reward contract ${reward} (permanent), buybacks off, no initial buy.`,
  );
  if (!ok) fail("Stopped. Nothing was sent.");
  if ((await run("forge", [...args, "--account", c.keystore, "--broadcast"], env)) !== 0) fail("Broadcast failed (see above).");
  const l = launched();
  if (!l) fail("Sent, but the token address was not found in the broadcast output; check the transaction on Blockscout.");
  console.log(`\nToken ${l.token}\nCurve ${l.curve}\n${EXPLORER}/address/${l.token}\nNext: node scripts/mainnet.mjs env`);
}

/**
 * Publishes the source through Sourcify (Blockscout imports Sourcify matches). Blockscout's own API sits behind a
 * Cloudflare browser challenge since 22 Nov 2026, so forge cannot reach it. Constructor arguments come from the
 * deploy broadcast; no RPC needed.
 */
async function verify(which) {
  if (which === "payments") return verifyPayments();
  if (which === "stake") return verifyStake();
  if (which === "x402") return verifyX402();
  if (which === "v2") return verifyV2();
  const reward = deployedReward();
  if (!reward) fail("Nothing deployed yet.");
  const runFile = join(CONTRACTS, "broadcast", "Deploy.s.sol", String(CHAIN_ID), "run-latest.json");
  const tx = existsSync(runFile) ? JSON.parse(readFileSync(runFile, "utf8")).transactions?.find((t) => t.contractName === "SparecycleRewards") : null;
  if (!tx?.arguments) fail(`No deploy broadcast with constructor arguments in ${runFile}.`);
  const [admin, scheduler, payout, escrow, epoch] = tx.arguments;
  const args = encodeAbiParameters(parseAbiParameters("address, address, address, address, uint64"), [admin, scheduler, payout, escrow, BigInt(epoch)]);
  process.exitCode = await run("forge", [
    "verify-contract", reward, "src/SparecycleRewards.sol:SparecycleRewards",
    "--chain", String(CHAIN_ID), "--verifier", "sourcify", "--constructor-args", args, "--watch",
  ]);
  if (!process.exitCode) console.log(`Source: https://repo.sourcify.dev/${CHAIN_ID}/${reward}  (Blockscout shows it at ${EXPLORER}/address/${reward})`);
}

async function verifyPayments() {
  const address = deployedPayments();
  if (!address) fail("SparecycleJobPayments is not deployed yet.");
  const runFile = join(CONTRACTS, "broadcast", "DeployPayments.s.sol", String(CHAIN_ID), "run-latest.json");
  const tx = JSON.parse(readFileSync(runFile, "utf8")).transactions?.find((t) => t.contractName === "SparecycleJobPayments");
  if (!tx?.arguments) fail(`No constructor arguments in ${runFile}.`);
  const args = encodeAbiParameters(parseAbiParameters("address, address"), [tx.arguments[0], tx.arguments[1]]);
  process.exitCode = await run("forge", [
    "verify-contract", address, "src/SparecycleJobPayments.sol:SparecycleJobPayments",
    "--chain", String(CHAIN_ID), "--verifier", "sourcify", "--constructor-args", args, "--watch",
  ]);
}

async function verifyStake() {
  const address = deployedStake();
  if (!address) fail("SparecycleNodeStake is not deployed yet.");
  const runFile = join(CONTRACTS, "broadcast", "DeployNodeStake.s.sol", String(CHAIN_ID), "run-latest.json");
  const tx = JSON.parse(readFileSync(runFile, "utf8")).transactions?.find((t) => t.contractName === "SparecycleNodeStake");
  if (!tx?.arguments) fail(`No constructor arguments in ${runFile}.`);
  const [token, rewards, safe, burn, minStake, cfg] = tx.arguments;
  const nums = String(cfg).replace(/[()\s]/g, "").split(",").map((x) => BigInt(x));
  const args = encodeAbiParameters(
    parseAbiParameters("address, address, address, bool, uint256, (uint16, uint64, uint64, uint64, uint64, uint64)"),
    [token, rewards, safe, String(burn) === "true", BigInt(minStake), [Number(nums[0]), nums[1], nums[2], nums[3], nums[4], nums[5]]],
  );
  process.exitCode = await run("forge", [
    "verify-contract", address, "src/SparecycleNodeStake.sol:SparecycleNodeStake",
    "--chain", String(CHAIN_ID), "--verifier", "sourcify", "--constructor-args", args, "--watch",
  ]);
}

async function verifyX402() {
  const address = deployedX402();
  if (!address) fail("SparecycleX402Escrow is not deployed yet.");
  const runFile = join(CONTRACTS, "broadcast", "DeployX402Escrow.s.sol", String(CHAIN_ID), "run-latest.json");
  const tx = JSON.parse(readFileSync(runFile, "utf8")).transactions?.find((t) => t.contractName === "SparecycleX402Escrow");
  if (!tx?.arguments) fail(`No constructor arguments in ${runFile}.`);
  const [admin, rewards, asset, treasury, forwardTo, window, caps] = tx.arguments;
  const capList = String(caps).replace(/[[\]\s]/g, "").split(",").map((x) => BigInt(x));
  const args = encodeAbiParameters(parseAbiParameters("address, address, address, address, address, uint64, uint256[3]"), [
    admin, rewards, asset, treasury, forwardTo, BigInt(window), [capList[0], capList[1], capList[2]],
  ]);
  process.exitCode = await run("forge", [
    "verify-contract", address, "src/SparecycleX402Escrow.sol:SparecycleX402Escrow",
    "--chain", String(CHAIN_ID), "--verifier", "sourcify", "--constructor-args", args, "--watch",
  ]);
}

async function verifyV2() {
  const d = deployedV2();
  if (!d) fail("The V2 contracts are not deployed yet.");
  const runFile = join(CONTRACTS, "broadcast", "DeployV2.s.sol", String(CHAIN_ID), "run-latest.json");
  const txs = JSON.parse(readFileSync(runFile, "utf8")).transactions ?? [];
  const argsOf = (name) => {
    const t = txs.find((x) => x.contractName === name);
    if (!t?.arguments) fail(`No constructor arguments for ${name} in ${runFile}.`);
    return t.arguments;
  };
  const [pm, sp, fee, ts, hk] = argsOf("UniswapV4SpareAdapter");
  const [bRw, bTr, bSp, bAd, bPs, bUse, bMax] = argsOf("SparecycleBurner");
  const [vRw, vTr, vBu, vHp, vSp, vAd, vCap] = argsOf("SparecycleJobPaymentsV2");
  const [hRw, hPay, hTr] = argsOf("SparecycleHolderPool");
  const jobs = [
    ["UniswapV4SpareAdapter", "src/adapters/UniswapV4SpareAdapter.sol:UniswapV4SpareAdapter",
      encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [pm, sp, Number(fee), Number(ts), hk])],
    ["SparecycleBurner", "src/SparecycleBurner.sol:SparecycleBurner",
      encodeAbiParameters(parseAbiParameters("address, address, address, address, address, bool, uint256"), [bRw, bTr, bSp, bAd, bPs, String(bUse) === "true", BigInt(bMax)])],
    ["SparecycleJobPaymentsV2", "src/SparecycleJobPaymentsV2.sol:SparecycleJobPaymentsV2",
      encodeAbiParameters(parseAbiParameters("address, address, address, address, address, address, uint256"), [vRw, vTr, vBu, vHp, vSp, vAd, BigInt(vCap)])],
    ["SparecycleHolderPool", "src/SparecycleHolderPool.sol:SparecycleHolderPool",
      encodeAbiParameters(parseAbiParameters("address, address, address"), [hRw, hPay, hTr])],
  ];
  let code = 0;
  for (const [name, path, args] of jobs) {
    console.log(`\n${name} ${d[name]}`);
    code ||= await run("forge", ["verify-contract", d[name], path, "--chain", String(CHAIN_ID), "--verifier", "sourcify", "--constructor-args", args, "--watch"]);
  }
  process.exitCode = code;
}

function env() {
  const c = config();
  const o = ops();
  const reward = deployedReward();
  const l = launched();
  const lines = [
    "NEXT_PUBLIC_NETWORK=mainnet",
    `NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS=${reward ?? ""}`,
    `NEXT_PUBLIC_OWNER_ADDRESS=${c.wallet}`,
    `NEXT_PUBLIC_SCHEDULER_ADDRESS=${o?.scheduler ?? ""}`,
    `NEXT_PUBLIC_SWEEP_BOT_ADDRESS=${o?.sweep ?? ""}`,
    `NEXT_PUBLIC_EPOCH_LENGTH=${c.epochLengthSeconds ?? ""}`,
    `NEXT_PUBLIC_PAIR_ASSET=${c.asset ?? ""}`,
    `NEXT_PUBLIC_PAIR_TOKEN_ADDRESS=${c.asset === "USDG" ? USDG : c.asset === "ETH" ? zeroAddress : ""}`,
    `NEXT_PUBLIC_NODE_PAYOUT_ASSET=${c.asset ?? ""}`,
    `NEXT_PUBLIC_CREATOR_TAX_BPS=${c.creatorTaxBps ?? ""}`,
    `NEXT_PUBLIC_LAUNCH_CONFIG_ID=${c.launchConfigId}`,
    `NEXT_PUBLIC_TICKER=${c.token.symbol ?? ""}`,
    `NEXT_PUBLIC_TOKEN_ADDRESS=${l?.token ?? ""}`,
    `NEXT_PUBLIC_CURVE_ADDRESS=${l?.curve ?? ""}`,
    `LAUNCHER_WALLET=${c.wallet}`,
    "SCHEDULER_AUTOCLOSE=1",
    "SWEEP_AUTORUN_MINUTES=60",
    `NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS=${deployedPayments() ?? ""}`,
    `NEXT_PUBLIC_JOB_PRICE_WEI_PER_UNIT=${c.jobPriceWeiPerUnit ?? ""}`,
    `NEXT_PUBLIC_TREASURY_ADDRESS=${c.treasury?.safe ?? ""}`,
    `TOKEN_NODE_STAKE_ADDRESS=${deployedStake() ?? ""}`,
    ...(deployedV2()
      ? [
          `TOKEN_JOB_PAYMENTS_V2_ADDRESS=${deployedV2().SparecycleJobPaymentsV2}`,
          `TOKEN_HOLDER_POOL_ADDRESS=${deployedV2().SparecycleHolderPool ?? ""}`,
          `TOKEN_BURNER_ADDRESS=${deployedV2().SparecycleBurner ?? ""}`,
          "# switch on only after the Safe set the reference SPARE price: TOKEN_PAYMENTS_V2=on, TOKEN_HOLDERS=on, TOKEN_HOLDER_PAGE=on",
        ]
      : []),
    "NEXT_PUBLIC_EXPLORER_URL=https://robinhoodchain.blockscout.com",
  ];
  console.log(lines.join("\n"));
  console.log(`\n# secrets, straight from .keys into Railway (never shown):`);
  console.log(`# node scripts/mainnet.mjs secret scheduler | railway variable set SCHEDULER_SIGNER_KEY --stdin --service web`);
  console.log(`# node scripts/mainnet.mjs secret sweep     | railway variable set SWEEP_SIGNER_KEY --stdin --service web`);
}

function secret(which) {
  if (!["scheduler", "sweep"].includes(which)) fail("usage: node scripts/mainnet.mjs secret <scheduler|sweep> | railway variable set ... --stdin");
  if (process.stdout.isTTY) fail("Refusing to print a key to the screen. Pipe it: node scripts/mainnet.mjs secret scheduler | railway variable set SCHEDULER_SIGNER_KEY --stdin --service web");
  if (!existsSync(OPS_FILE)) fail("No hot wallets yet: node scripts/mainnet.mjs init");
  process.stdout.write(JSON.parse(readFileSync(OPS_FILE, "utf8"))[which]);
}

// ---------------------------------------------------------------- main ----
const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const positional = rest.filter((a) => !a.startsWith("--"));
try {
  switch (cmd) {
    case "status": await status(); break;
    case "init": await init(); break;
    case "import": await importKey(); break;
    case "rehearse": await rehearse(flag("--placeholders")); break;
    case "deploy": await deploy(flag("--again")); break;
    case "fund": await fund(positional[0], positional[1]); break;
    case "launch": await launch(flag("--again")); break;
    case "verify": await verify(positional[0]); break;
    case "deploy-payments": await deployPayments(flag("--again")); break;
    case "deploy-stake": await deployStake(flag("--again"), flag("--dry-run")); break;
    case "deploy-x402": await deployX402(flag("--again"), flag("--dry-run")); break;
    case "deploy-v2": await deployV2(flag("--again"), flag("--dry-run")); break;
    case "transfer-owner": await transferOwner(positional[0]); break;
    case "env": env(); break;
    case "secret": secret(positional[0]); break;
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 25).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
      process.exitCode = cmd ? 1 : 0;
  }
} finally {
  closeRelays();
}
