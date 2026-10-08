#!/usr/bin/env node
// Read-only pre-launch report for the brief's "Appendix B: verify before launch".
// It only performs eth_chainId / eth_call / eth_getCode against a public RPC. It has no signer, builds no
// transaction and never sends one. Exit 1 if any line is FAIL.
//
// RPC: NEXT_PUBLIC_RPC_URL, else https://rpc.mainnet.chain.robinhood.com
// Inputs (env, plain or NEXT_PUBLIC_ form; .env.local / .env are loaded if present):
//   LAUNCHER_WALLET            wallet that will call launchToken
//   LAUNCH_CONFIG_ID           default 0                      (NEXT_PUBLIC_LAUNCH_CONFIG_ID)
//   PAIR_ASSET                 ETH | USDG                     (NEXT_PUBLIC_PAIR_ASSET)
//   CREATOR_TAX_BPS            intended creator tax           (NEXT_PUBLIC_CREATOR_TAX_BPS)
//   REWARD_CONTRACT_ADDRESS    deployed reward contract       (NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS)
//   OWNER_ADDRESS              expected reward-contract owner (NEXT_PUBLIC_OWNER_ADDRESS; else MULTISIG_ADDRESS)
//   MULTISIG_ADDRESS           fallback fee recipient / multisig owner (NEXT_PUBLIC_MULTISIG_ADDRESS)
//   NODE_PAYOUT_ASSET          ETH | USDG                     (NEXT_PUBLIC_NODE_PAYOUT_ASSET)
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, formatUnits, getAddress, http, isAddress, parseAbi, zeroAddress } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const f of [".env.local", ".env"]) {
  const p = join(root, f);
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      /* unreadable env file: ignore, env vars still apply */
    }
  }
}

const PONS = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  memeHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
};
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const EXPECTED_CHAIN_ID = 4663;
// Facts recorded in the brief on 20 Nov 2026 (only used to flag drift; live values always win).
const BRIEF = { launchFee: 500000000000000n, supply: 10n ** 27n, graduationThreshold: 42n * 10n ** 17n };

const env = (name) => {
  const v = process.env[name] ?? process.env[`NEXT_PUBLIC_${name}`];
  return v && v.trim() !== "" ? v.trim() : null;
};
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2, timeout: 15_000 }) });

const factoryAbi = parseAbi([
  "struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }",
  "function launchEnabled() view returns (bool)",
  "function canLaunch(address account) view returns (bool)",
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function launchConfigCount() view returns (uint256)",
  "function getLaunchConfig(uint256 id) view returns (LaunchConfig)",
  "function approvedPairTokens(address pairToken) view returns (bool)",
  "function pairTokenEconomics(address pairToken) view returns (uint256 phantomQuote, uint256 graduationThreshold, uint8 decimals)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
]);
const rewardAbi = parseAbi([
  "function owner() view returns (address)",
  "function scheduler() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function payoutToken() view returns (address)",
  "function epochLength() view returns (uint64)",
  "function claimsPaused() view returns (bool)",
]);
const hookAbi = parseAbi(["function feeSweepOperator() view returns (address)"]);

const lines = [];
const out = (level, msg) => {
  lines.push(level);
  console.log(`${level.padEnd(4)}  ${msg}`);
};
const pass = (m) => out("PASS", m);
const warn = (m) => out("WARN", m);
const fail = (m) => out("FAIL", m);
const info = (m) => out("INFO", m);
const f = (functionName, args = []) => client.readContract({ address: PONS.factory, abi: factoryAbi, functionName, args });
async function tryRead(label, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    fail(`${label}: call failed (${e.shortMessage ?? e.message})`);
    return { ok: false };
  }
}
const hasCode = async (a) => {
  const code = await client.getCode({ address: a });
  return Boolean(code && code !== "0x");
};

async function main() {
  console.log(`Sparecycle pre-launch check (read-only) — RPC ${rpcUrl} — ${new Date().toISOString()}\n`);

  // 1. Chain
  const cid = await tryRead("eth_chainId", () => client.getChainId());
  if (!cid.ok) return;
  if (cid.value === EXPECTED_CHAIN_ID) pass(`chain id = ${cid.value} (Robinhood Chain mainnet)`);
  else fail(`chain id = ${cid.value}, expected ${EXPECTED_CHAIN_ID}`);

  for (const [name, a] of Object.entries(PONS)) {
    if (await hasCode(a)) pass(`Pons ${name} ${a} has code`);
    else fail(`Pons ${name} ${a} has NO code on this chain`);
  }

  // 2. Launch gate
  const enabled = await tryRead("launchEnabled()", () => f("launchEnabled"));
  if (enabled.ok) (enabled.value ? pass : fail)(`launchEnabled() = ${enabled.value}`);
  const launcher = env("LAUNCHER_WALLET");
  if (!launcher) warn("canLaunch: LAUNCHER_WALLET not set");
  else if (!isAddress(launcher)) fail(`canLaunch: LAUNCHER_WALLET is not an address (${launcher})`);
  else {
    const can = await tryRead("canLaunch()", () => f("canLaunch", [getAddress(launcher)]));
    if (can.ok) (can.value ? pass : fail)(`canLaunch(${getAddress(launcher)}) = ${can.value}`);
  }

  // 3. Fee
  const fee = await tryRead("launchFee()", () => f("launchFee"));
  if (fee.ok) {
    if (fee.value === BRIEF.launchFee) pass(`launchFee() = ${formatEther(fee.value)} ETH (send exactly this as msg.value)`);
    else warn(`launchFee() = ${formatEther(fee.value)} ETH — differs from the brief's 0.0005 ETH; send the live value`);
  }

  // 4. Launch config
  const idRaw = env("LAUNCH_CONFIG_ID") ?? "0";
  const id = /^\d+$/.test(idRaw) ? BigInt(idRaw) : null;
  if (id === null) fail(`LAUNCH_CONFIG_ID is not a number (${idRaw})`);
  else {
    if (!env("LAUNCH_CONFIG_ID")) info("LAUNCH_CONFIG_ID not set; checking config 0 (the docs' example, not a guarantee)");
    const count = await client.readContract({ address: PONS.factory, abi: factoryAbi, functionName: "launchConfigCount" }).catch(() => null);
    if (count !== null) (id < count ? pass : fail)(`launch config ${id} exists (launchConfigCount() = ${count})`);
    const cfg = await tryRead(`getLaunchConfig(${id})`, () => f("getLaunchConfig", [id]));
    if (cfg.ok) {
      const c = cfg.value;
      (c.enabled ? pass : fail)(
        `getLaunchConfig(${id}): supply=${c.supply} (${formatUnits(c.supply, 18)} tokens @18dp), curveFeeBps=${c.curveFeeBps}, ` +
          `graduationThreshold=${c.graduationThreshold} (${formatEther(c.graduationThreshold)} ETH for an ETH pair), ` +
          `phantomQuote=${c.phantomQuote}, poolFee=${c.poolFee}, tickSpacing=${c.tickSpacing}, enabled=${c.enabled}`,
      );
      if (c.supply !== BRIEF.supply) warn(`supply ${c.supply} differs from the brief's 1B (1e27)`);
      if (c.graduationThreshold !== BRIEF.graduationThreshold)
        warn(`graduationThreshold ${formatEther(c.graduationThreshold)} differs from the brief's 4.2 ETH`);
    }
  }

  // 5. Pair asset
  const pairAsset = (env("PAIR_ASSET") ?? "").toUpperCase() || null;
  const usdgOk = await tryRead("approvedPairTokens(USDG)", () => f("approvedPairTokens", [USDG]));
  if (usdgOk.ok) {
    const msg = `approvedPairTokens(USDG ${USDG}) = ${usdgOk.value}`;
    if (pairAsset === "USDG") (usdgOk.value ? pass : fail)(msg);
    else info(msg);
  }
  if (pairAsset === "USDG") {
    const econ = await tryRead("pairTokenEconomics(USDG)", () => f("pairTokenEconomics", [USDG]));
    if (econ.ok) {
      const [phantomQuote, threshold, decimals] = econ.value;
      pass(`pairTokenEconomics(USDG): phantomQuote=${phantomQuote}, graduationThreshold=${formatUnits(threshold, decimals)} USDG, decimals=${decimals}`);
    }
  }
  if (!pairAsset) warn("PAIR_ASSET not set (ETH | USDG); previewing the ETH pair");
  else if (pairAsset !== "ETH" && pairAsset !== "USDG") fail(`PAIR_ASSET must be ETH or USDG (got ${pairAsset})`);
  const pairToken = pairAsset === "USDG" ? USDG : zeroAddress;

  // 6. Economics pin
  if (id !== null) {
    const prev = await tryRead("previewLaunchEconomics()", () => f("previewLaunchEconomics", [id, pairToken]));
    if (prev.ok) {
      const zero = /^0x0+$/.test(prev.value);
      (zero ? fail : pass)(
        `previewLaunchEconomics(${id}, ${pairToken === zeroAddress ? "address(0) / ETH" : "USDG"}) = ${prev.value} ` +
          "→ pass as TokenParams.expectedEconomics in the same session as the launch",
      );
    }
  }

  // 7. Creator tax
  const maxTax = await tryRead("maxCreatorTaxBps()", () => f("maxCreatorTaxBps"));
  const taxRaw = env("CREATOR_TAX_BPS");
  if (maxTax.ok) {
    if (taxRaw === null) warn(`CREATOR_TAX_BPS not set (live maxCreatorTaxBps() = ${maxTax.value}); it cannot be raised after launch`);
    else if (!/^\d+$/.test(taxRaw)) fail(`CREATOR_TAX_BPS is not an integer (${taxRaw})`);
    else if (BigInt(taxRaw) > maxTax.value) fail(`CREATOR_TAX_BPS ${taxRaw} > live maxCreatorTaxBps() ${maxTax.value}`);
    else pass(`CREATOR_TAX_BPS ${taxRaw} <= live maxCreatorTaxBps() ${maxTax.value} (fixed at creation)`);
  }

  // 8. Reward contract (creatorFeeRecipient)
  const reward = env("REWARD_CONTRACT_ADDRESS");
  if (!reward) warn("REWARD_CONTRACT_ADDRESS not set — reward contract not deployed yet (or use the multisig fallback recipient)");
  else if (!isAddress(reward)) fail(`REWARD_CONTRACT_ADDRESS is not an address (${reward})`);
  else if (!(await hasCode(reward))) fail(`REWARD_CONTRACT_ADDRESS ${reward} has no code on chain ${cid.value}`);
  else {
    pass(`REWARD_CONTRACT_ADDRESS ${getAddress(reward)} has code`);
    const r = (functionName) => client.readContract({ address: reward, abi: rewardAbi, functionName });
    const vals = await tryRead("reward contract getters", () =>
      Promise.all(["owner", "scheduler", "feeEscrow", "payoutToken", "epochLength", "claimsPaused"].map(r)),
    );
    if (vals.ok) {
      const [owner, scheduler, escrow, token, len, paused] = vals.value;
      (escrow.toLowerCase() === PONS.feeEscrow.toLowerCase() ? pass : fail)(`reward.feeEscrow() = ${escrow}`);
      const payout = env("NODE_PAYOUT_ASSET")?.toUpperCase();
      const expectToken = payout === "USDG" ? USDG : payout === "ETH" ? zeroAddress : null;
      if (expectToken === null) info(`reward.payoutToken() = ${token}${token === zeroAddress ? " (ETH)" : ""}; NODE_PAYOUT_ASSET not set`);
      else (token.toLowerCase() === expectToken.toLowerCase() ? pass : fail)(`reward.payoutToken() = ${token} for NODE_PAYOUT_ASSET=${payout}`);
      if (pairAsset && expectToken !== null && pairToken.toLowerCase() !== expectToken.toLowerCase())
        warn("PAIR_ASSET != NODE_PAYOUT_ASSET: escrow fees arrive in the pair asset and would not be credited to the pot");
      const ms = env("OWNER_ADDRESS") ?? env("MULTISIG_ADDRESS");
      if (!ms) warn(`reward.owner() = ${owner}; OWNER_ADDRESS / MULTISIG_ADDRESS not set to compare`);
      else (owner.toLowerCase() === ms.toLowerCase() ? pass : fail)(`reward.owner() = ${owner} (expected owner ${ms})`);
      (scheduler.toLowerCase() !== owner.toLowerCase() ? pass : warn)(`reward.scheduler() = ${scheduler}`);
      info(`reward.epochLength() = ${len}s, claimsPaused() = ${paused}`);
    }
  }

  // 9. Sweep path (pre-graduation fees sit on the curve until swept)
  const op = await client.readContract({ address: PONS.memeHook, abi: hookAbi, functionName: "feeSweepOperator" }).catch(() => null);
  if (op && (await hasCode(op)))
    pass(`hook.feeSweepOperator() = ${op} (a fork test on 20 Nov 2026 swept a curve through its sweepCurve(curve) from a random EOA; re-run FORK_TESTS=1 before launch)`);
  else warn("hook.feeSweepOperator() unreadable or has no code — re-check how pre-graduation fees get swept");

  // 10. Manual items
  info("Launch params to set by hand: buybackEnabled=false, creatorFeeRecipient=reward contract (or multisig fallback), no extra snipe-tax exemptions, 3-argument launchToken");
  info("Recipient path: run `FORK_TESTS=1 forge test --match-path 'test/fork/*' -vv` in contracts/ right before launch");
  info("Pons v2 audits: check https://docs.ponsfamily.com/v2 for published reports (not verifiable on-chain)");
  info("EPOCH_POST_GAS_COST: see contracts/README.md gas table (gas units; multiply by the live L2 gas price + L1 data fee)");

  const fails = lines.filter((l) => l === "FAIL").length;
  const warns = lines.filter((l) => l === "WARN").length;
  console.log(`\n${fails} FAIL, ${warns} WARN, ${lines.filter((l) => l === "PASS").length} PASS. No transaction was sent.`);
  process.exitCode = fails ? 1 : 0;
}

main().catch((e) => {
  console.error(`prelaunch-check crashed: ${e.message}`);
  process.exit(1);
});
