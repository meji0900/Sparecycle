#!/usr/bin/env node
// Testnet rehearsal of moving SparecycleRewards' owner to a Safe (docs/ops/multisig-runbook.md, brief Update 1 §1.5 A).
// Robinhood Chain TESTNET only (46630). Real testnet transactions; nothing touches mainnet.
//
//   node scripts/multisig-rehearsal.mjs [--epoch 120]
//
// What it does, in order, and checks after every step:
//   1. deploys a fresh SparecycleRewards (+ MockPonsFeeEscrow) with ADMIN = the testnet deployer and SCHEDULER = a
//      DIFFERENT key (owner-a), like mainnet; and a SparecycleJobPayments whose treasury is the rehearsal Safe
//   2. creates a Safe 1.5.0 (the same SafeL2 singleton + proxy factory as the mainnet treasury) with two "laptop" owners,
//      threshold 2
//   3. signer fix: addOwnerWithThreshold(independent, 2), then swapOwner(laptop2 -> hardware)  => 2-of-3
//   4. transferOwnership(safe) from the EOA; pendingOwner == safe, owner unchanged
//   5. acceptOwnership() as a Safe transaction; owner == safe
//   6. old EOA setScheduler / pauseClaims revert (OwnableUnauthorizedAccount); the Safe rotates the scheduler and back,
//      pauses and unpauses claims
//   7. the scheduler charges a customer deposit (95% pot / 5% Safe) and closes the epoch after it ends
//   8. writes every tx hash to docs/ops/multisig-rehearsal.md
//
// Keys: the Foundry keystores in .keys/ (evm-testnet, owner-a, owner-b), decrypted in-process as in e2e-testnet.mjs.
// The Safe signers are throwaway keys generated in memory for this run and discarded at exit (the rehearsal Safe is
// abandoned afterwards). No private key is printed or written.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  concat,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  getAddress,
  http as viemHttp,
  keccak256,
  parseAbi,
  parseEther,
  toHex,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHAIN_ID = 46630;
const TARGET_RPC = process.env.TESTNET_RPC_URL?.trim() || "https://rpc.testnet.chain.robinhood.com";
const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
const KEYS_DIR = join(ROOT, ".keys");
const OUT_DOC = join(ROOT, "docs", "ops", "multisig-rehearsal.md");
// Safe 1.5.0, the same addresses as the mainnet treasury Safe (present on 46630, checked below).
const SAFE_SINGLETON = "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e";
const SAFE_FACTORY = "0x14F2982D601c9458F93bd70B218933A6f8165e7b";
const SENTINEL = "0x0000000000000000000000000000000000000001";
const argv = process.argv.slice(2);
const EPOCH = Number(argv.includes("--epoch") ? argv[argv.indexOf("--epoch") + 1] : 120);
const FOUNDRY_BIN = process.env.FOUNDRY_BIN ?? join(homedir(), ".foundry", "bin");
const exe = (n) => join(FOUNDRY_BIN, process.platform === "win32" ? `${n}.exe` : n);

// ---- secrets stay in memory; everything echoed is scrubbed ------------------------------------------------
const secrets = new Set();
const scrub = (s) => {
  let out = String(s);
  for (const k of secrets) out = out.split(k).join("[redacted]").split(k.slice(2)).join("[redacted]");
  return out;
};
const t0 = Date.now();
const log = (m) => console.log(scrub(`[rehearsal ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${m}`));
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) throw new Error(`check failed: ${name}`);
}
const txs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
function throwaway() {
  const key = generatePrivateKey();
  secrets.add(key);
  return privateKeyToAccount(key);
}
const artifact = (file, name) => {
  const j = JSON.parse(readFileSync(join(ROOT, "contracts", "out", file, `${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
};

// ---- RPC: direct, else a local relay over DNS-over-HTTPS (some ISPs hide the Robinhood RPC hosts) -------------
async function chainIdOf(url) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(10_000) });
    return Number((await r.json()).result);
  } catch {
    return null;
  }
}
let relay = null;
async function rpcUrl() {
  if ((await chainIdOf(TARGET_RPC)) === CHAIN_ID) return TARGET_RPC;
  const u = new URL(TARGET_RPC);
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${u.hostname}&type=A`, { headers: { accept: "application/dns-json" } });
  const ips = ((await r.json()).Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  if (!ips.length) throw new Error(`cannot reach ${TARGET_RPC}`);
  const agent = new https.Agent({ keepAlive: true, lookup: (_h, o, cb) => (o?.all ? cb(null, ips.map((address) => ({ address, family: 4 }))) : cb(null, ips[0], 4)) });
  relay = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c)).on("end", () => {
      const up = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method: "POST", headers: { "content-type": "application/json" }, agent }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, { "content-type": "application/json" });
        ur.pipe(res);
      });
      up.on("error", (e) => res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: e.message } })));
      up.end(Buffer.concat(chunks));
    });
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${relay.address().port}`;
  if ((await chainIdOf(url)) !== CHAIN_ID) throw new Error("relay did not answer as chain 46630");
  log(`RPC via local relay -> ${u.hostname} (${ips[0]})`);
  return url;
}

const safeAbi = parseAbi([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)",
  "event ExecutionFailure(bytes32 indexed txHash, uint256 payment)",
]);
const factoryAbi = parseAbi(["function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)"]);

async function main() {
  const url = await rpcUrl();
  const chain = defineChain({ id: CHAIN_ID, name: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: viemHttp(url, { retryCount: 4, timeout: 30_000 }) });
  check("RPC is Robinhood Chain testnet (46630)", (await pub.getChainId()) === CHAIN_ID);
  const [singletonCode, factoryCode] = await Promise.all([pub.getCode({ address: SAFE_SINGLETON }), pub.getCode({ address: SAFE_FACTORY })]);
  check("Safe 1.5.0 singleton and proxy factory exist on 46630", singletonCode?.length > 2 && factoryCode?.length > 2);

  const admin = privateKeyToAccount(decryptKey("evm-testnet")); // EOA owner before the move; also relays Safe txs
  const scheduler = privateKeyToAccount(decryptKey("owner-a")); // the hot key, different from the owner (as on mainnet)
  const customer = privateKeyToAccount(decryptKey("owner-b"));
  const wallet = (account) => createWalletClient({ account, chain, transport: viemHttp(url, { retryCount: 4, timeout: 30_000 }) });
  const send = async (label, account, req) => {
    const hash = await wallet(account).writeContract({ ...req, account, chain });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== "success") throw new Error(`${label} reverted (${hash})`);
    txs.push({ label, hash, from: account.address });
    log(`tx ${label}: ${EXPLORER}/tx/${hash}`);
    return rc;
  };
  const deploy = async (label, { abi, bytecode }, args) => {
    const hash = await wallet(admin).deployContract({ abi, bytecode, args, account: admin, chain });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (rc.status !== "success" || !rc.contractAddress) throw new Error(`${label} deploy failed (${hash})`);
    txs.push({ label, hash, from: admin.address });
    log(`tx ${label}: ${EXPLORER}/tx/${hash} -> ${rc.contractAddress}`);
    return getAddress(rc.contractAddress);
  };
  const reverts = async (label, account, req, errorName) => {
    try {
      await pub.simulateContract({ ...req, account: account.address });
      return check(label, false, "did not revert");
    } catch (e) {
      // custom errors carry their name; Safe reverts with Error("GS0xx"), so the reason is in the args
      const d = e?.walk?.((x) => x?.data?.errorName)?.data;
      const name = d ? `${d.errorName}${d.args?.length ? `(${d.args.join(", ")})` : ""}` : (e?.shortMessage ?? String(e));
      check(label, String(name).includes(errorName), name);
    }
  };

  const balances = await Promise.all([admin, scheduler, customer].map((a) => pub.getBalance({ address: a.address })));
  log(`balances: admin ${formatEther(balances[0])}, scheduler ${formatEther(balances[1])}, customer ${formatEther(balances[2])} ETH`);
  check("enough testnet ETH (admin >= 0.0015, scheduler >= 0.0003, customer >= 0.0012)", balances[0] >= parseEther("0.0015") && balances[1] >= parseEther("0.0003") && balances[2] >= parseEther("0.0012"));

  // 1. fresh contracts, owner != scheduler
  const rewardsArt = artifact("SparecycleRewards.sol", "SparecycleRewards");
  const payArt = artifact("SparecycleJobPayments.sol", "SparecycleJobPayments");
  const escrow = await deploy("deploy MockPonsFeeEscrow", artifact("MockPonsFeeEscrow.sol", "MockPonsFeeEscrow"), []);
  const rewards = await deploy("deploy SparecycleRewards (owner = EOA, scheduler = other key)", rewardsArt, [admin.address, scheduler.address, zeroAddress, escrow, BigInt(EPOCH)]);
  const R = { address: rewards, abi: rewardsArt.abi };
  const read = (fn, args = []) => pub.readContract({ ...R, functionName: fn, args });
  check("owner = EOA, scheduler = a different key", getAddress(await read("owner")) === admin.address && getAddress(await read("scheduler")) === scheduler.address);

  // 2. Safe with two "laptop" keys, threshold 2
  const laptop1 = throwaway(), laptop2 = throwaway(), independent = throwaway(), hardware = throwaway();
  const signerOf = new Map([laptop1, laptop2, independent, hardware].map((a) => [a.address.toLowerCase(), a]));
  const initializer = encodeFunctionData({ abi: safeAbi, functionName: "setup", args: [[laptop1.address, laptop2.address], 2n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress] });
  const salt = BigInt(keccak256(toHex(`sparecycle-rehearsal-${Date.now()}`)));
  const { result: predicted } = await pub.simulateContract({ address: SAFE_FACTORY, abi: factoryAbi, functionName: "createProxyWithNonce", args: [SAFE_SINGLETON, initializer, salt], account: admin.address });
  await send("create Safe 1.5.0 (2 laptop owners, threshold 2)", admin, { address: SAFE_FACTORY, abi: factoryAbi, functionName: "createProxyWithNonce", args: [SAFE_SINGLETON, initializer, salt] });
  const safe = getAddress(predicted);
  const S = { address: safe, abi: safeAbi };
  const safeRead = (fn, args = []) => pub.readContract({ ...S, functionName: fn, args });
  check("Safe deployed, VERSION 1.5.0, 2-of-2", (await safeRead("VERSION")) === "1.5.0" && (await safeRead("getThreshold")) === 2n && (await safeRead("getOwners")).length === 2, safe);

  /** One Safe transaction: hash from the Safe, signatures from `signers` (sorted by address), relayed by the admin EOA. */
  const safeTx = async (label, signers, to, data) => {
    const nonce = await safeRead("nonce");
    const hash = await safeRead("getTransactionHash", [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce]);
    const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    const sigs = concat(await Promise.all(sorted.map((s) => signerOf.get(s.address.toLowerCase()).sign({ hash }))));
    const rc = await send(`Safe tx: ${label}`, admin, { ...S, functionName: "execTransaction", args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, sigs] });
    const ok = rc.logs.some((l) => l.address.toLowerCase() === safe.toLowerCase() && l.topics[0] === keccak256(toHex("ExecutionSuccess(bytes32,uint256)")));
    check(`Safe executed: ${label}`, ok);
  };
  const onSafe = (fn, args) => encodeFunctionData({ abi: safeAbi, functionName: fn, args });
  const onRewards = (fn, args = []) => encodeFunctionData({ abi: rewardsArt.abi, functionName: fn, args });

  // 3. signer fix in place: + independent signer, laptop2 -> hardware
  await safeTx("addOwnerWithThreshold(independent, 2)", [laptop1, laptop2], safe, onSafe("addOwnerWithThreshold", [independent.address, 2n]));
  const owners1 = (await safeRead("getOwners")).map((a) => getAddress(a));
  const prev = owners1.indexOf(laptop2.address) === 0 ? SENTINEL : owners1[owners1.indexOf(laptop2.address) - 1];
  await safeTx("swapOwner(laptop2 -> hardware)", [laptop1, independent], safe, onSafe("swapOwner", [prev, laptop2.address, hardware.address]));
  const owners2 = (await safeRead("getOwners")).map((a) => getAddress(a));
  check(
    "Safe is 2-of-3: laptop1 + independent + hardware",
    (await safeRead("getThreshold")) === 2n && owners2.length === 3 && [laptop1, independent, hardware].every((a) => owners2.includes(a.address)) && !owners2.includes(laptop2.address),
  );
  {
    // laptop2 + laptop1 sign the real next Safe tx hash: the Safe must reject laptop2 (GS026 = not an owner)
    const nonce = await safeRead("nonce");
    const hash = await safeRead("getTransactionHash", [safe, 0n, "0x", 0, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce]);
    const sorted = [laptop2, laptop1].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    const sigs = concat(await Promise.all(sorted.map((s) => s.sign({ hash }))));
    await reverts("the removed laptop2 key can no longer sign (GS026)", admin, { ...S, functionName: "execTransaction", args: [safe, 0n, "0x", 0, 0n, 0n, 0n, zeroAddress, zeroAddress, sigs] }, "GS026");
  }

  // payments contract with the Safe as treasury, and a customer deposit
  const pay = await deploy("deploy SparecycleJobPayments (treasury = the Safe)", payArt, [rewards, safe]);
  const P = { address: pay, abi: payArt.abi };
  await send("customer deposit 0.001 ETH", customer, { ...P, functionName: "deposit", value: parseEther("0.001") });

  // 4. + 5. two-step ownership move
  await send("transferOwnership(safe) from the EOA", admin, { ...R, functionName: "transferOwnership", args: [safe] });
  check("pendingOwner = Safe, owner still the EOA", getAddress(await read("pendingOwner")) === safe && getAddress(await read("owner")) === admin.address);
  await safeTx("acceptOwnership() on the reward contract", [laptop1, hardware], rewards, onRewards("acceptOwnership"));
  check("owner = Safe, pendingOwner = 0", getAddress(await read("owner")) === safe && (await read("pendingOwner")) === zeroAddress);

  // 6. owner powers moved
  await reverts("old EOA setScheduler reverts", admin, { ...R, functionName: "setScheduler", args: [admin.address] }, "OwnableUnauthorizedAccount");
  await reverts("old EOA pauseClaims reverts", admin, { ...R, functionName: "pauseClaims" }, "OwnableUnauthorizedAccount");
  await safeTx("setScheduler(EOA) (rotation test)", [independent, hardware], rewards, onRewards("setScheduler", [admin.address]));
  check("scheduler rotated by the Safe", getAddress(await read("scheduler")) === admin.address);
  await safeTx("setScheduler(original scheduler) (rotate back)", [laptop1, independent], rewards, onRewards("setScheduler", [scheduler.address]));
  check("scheduler restored", getAddress(await read("scheduler")) === scheduler.address);
  await safeTx("pauseClaims()", [laptop1, hardware], rewards, onRewards("pauseClaims"));
  check("claims paused", (await read("claimsPaused")) === true);
  await safeTx("unpauseClaims()", [independent, hardware], rewards, onRewards("unpauseClaims"));
  check("claims unpaused", (await read("claimsPaused")) === false);

  // 7. scheduler unaffected: charge, then close the epoch once it has run its length
  const epochId = await read("currentEpoch");
  const potBefore = (await read("getEpoch", [epochId])).pot;
  const safeBefore = await pub.getBalance({ address: safe });
  const amount = parseEther("0.0004");
  await send("scheduler charge(customer, 0.0004 ETH)", scheduler, { ...P, functionName: "charge", args: [epochId, [customer.address], [amount], keccak256(toHex("rehearsal"))] });
  const potAfter = (await read("getEpoch", [epochId])).pot;
  check("charge: 95% to the open epoch's pot", potAfter - potBefore === (amount * 95n) / 100n, `${formatEther(potAfter - potBefore)} ETH`);
  check("charge: 5% to the Safe treasury", (await pub.getBalance({ address: safe })) - safeBefore === (amount * 5n) / 100n);
  const started = (await read("getEpoch", [epochId])).startedAt;
  for (;;) {
    const block = await pub.getBlock();
    if (block.timestamp >= started + BigInt(EPOCH)) break;
    const wait = Number(started + BigInt(EPOCH) - block.timestamp);
    log(`waiting ${wait}s for epoch ${epochId} to end`);
    await sleep(Math.min(Math.max(wait, 3), 30) * 1000);
  }
  await send(`scheduler closeEpochAndPostRoot(${epochId}, 0x0, 0)`, scheduler, { ...R, functionName: "closeEpochAndPostRoot", args: [epochId, `0x${"0".repeat(64)}`, 0n] });
  check("epoch settled by the scheduler after the move", (await read("getEpoch", [epochId])).settled === true && (await read("currentEpoch")) === epochId + 1n);

  // 8. the log
  const now = new Date().toISOString();
  const md = [
    "# Multisig rehearsal log (Robinhood Chain testnet, 46630)",
    "",
    `Generated by \`node scripts/multisig-rehearsal.mjs\` on ${now}. Brief Update 1, step 1.5 A. Testnet only: these are throwaway contracts and a throwaway Safe, not the mainnet ones.`,
    "",
    "| Role | Address |",
    "| --- | --- |",
    `| SparecycleRewards (fresh, epoch ${EPOCH} s) | [\`${rewards}\`](${EXPLORER}/address/${rewards}) |`,
    `| SparecycleJobPayments (treasury = Safe) | [\`${pay}\`](${EXPLORER}/address/${pay}) |`,
    `| Rehearsal Safe 1.5.0 | [\`${safe}\`](${EXPLORER}/address/${safe}) |`,
    `| EOA owner before the move | \`${admin.address}\` |`,
    `| Scheduler (hot key, different from the owner) | \`${scheduler.address}\` |`,
    `| Safe signers after the fix (2-of-3) | laptop1 \`${laptop1.address}\`, independent \`${independent.address}\`, hardware \`${hardware.address}\` (throwaway keys, discarded) |`,
    "",
    "## Transactions",
    "",
    "| # | Step | Tx |",
    "| --- | --- | --- |",
    ...txs.map((t, i) => `| ${i + 1} | ${t.label} | [\`${t.hash.slice(0, 10)}…\`](${EXPLORER}/tx/${t.hash}) |`),
    "",
    "## Checks",
    "",
    ...checks.map((c) => `- ${c.ok ? "[x]" : "[ ]"} ${c.name}${c.detail ? ` (${c.detail})` : ""}`),
    "",
    "Result: the owner moved to the Safe in two steps, the old EOA lost every owner power, the Safe could rotate the scheduler and pause/unpause claims, and the scheduler kept charging and closing epochs without any Safe signature.",
    "",
  ].join("\n");
  mkdirSync(dirname(OUT_DOC), { recursive: true });
  writeFileSync(OUT_DOC, md);
  log(`log written: ${OUT_DOC}`);
  const spent = (await Promise.all([admin, scheduler, customer].map((a) => pub.getBalance({ address: a.address })))).reduce((s, b, i) => s + balances[i] - b, 0n);
  log(`done: ${checks.length} checks passed, ${txs.length} transactions, ${formatEther(spent)} testnet ETH spent (incl. 0.001 deposit)`);
}

main()
  .catch((e) => {
    console.error(scrub(`rehearsal failed: ${e?.shortMessage ?? e?.message ?? e}`));
    process.exitCode = 1;
  })
  .finally(() => relay?.close());
