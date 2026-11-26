// GET /api/v1/staking (docs/node-staking.md): the public figures of SparecycleNodeStake for the node page, the token
// page and anyone else: total staked, total slashed (burned), the minimum per node, how many owner wallets stake, and
// the contract's fixed rules. Reads only, never a write.
//
// The views are read at one block through ./chain-io (tokenChain). How many owners stake has no view: the owners come
// from the contract's Staked events (scanned once from the deploy block, then only the new blocks), and each one's
// getAccount() is read at the same block. Answers are cached in memory for CACHE_MS (a failed read for FAILURE_CACHE_MS),
// so a busy page costs the RPC one read per half minute. A read that fails is an error, never a zero: the views fail the
// whole answer (503 chain-read-failed); the owner count alone fails to `owners: null` with `ownersError`.
import { getAddress, isAddress, type Address } from "viem";
import { ADDR } from "@/lib/addresses";
import { explorerAddress, targetChain } from "@/lib/chain";
import { config } from "@/lib/config";
import { NODE_STAKE_DEPLOY_BLOCK, SPARE_DECIMALS } from "@/lib/staking";
import { describeChainError, tokenChain } from "./chain-io";
import { ApiError } from "./http";

/** Successful answers are reused for this long. */
export const CACHE_MS = 30_000;
/** A failed read is not retried for this long (one RPC hiccup must not turn every page view into a retry). */
export const FAILURE_CACHE_MS = 10_000;

/**
 * The stake contract this deployment reads: TOKEN_NODE_STAKE_ADDRESS when set (testnet, the local end-to-end test),
 * else the live contract (ADDR.nodeStake) on mainnet, else null (not deployed on this network). Read per call.
 */
export function stakeContract(): Address | null {
  const raw = process.env.TOKEN_NODE_STAKE_ADDRESS?.trim();
  if (raw && isAddress(raw, { strict: false })) return getAddress(raw);
  return config.network === "mainnet" ? getAddress(ADDR.nodeStake) : null;
}

/** First block to scan for Staked events: TOKEN_NODE_STAKE_START_BLOCK, else the live contract's deploy block, else 0. */
export function stakeStartBlock(contract: Address): bigint {
  const raw = process.env.TOKEN_NODE_STAKE_START_BLOCK?.trim();
  if (raw && /^\d{1,12}$/.test(raw)) return BigInt(raw);
  return contract.toLowerCase() === ADDR.nodeStake.toLowerCase() ? NODE_STAKE_DEPLOY_BLOCK : 0n;
}

export type StakingJson = {
  contract: Address;
  chainId: number;
  /** The contract on the block explorer; null when this network has none configured. */
  explorerUrl: string | null;
  /** The staked token (SPARE) as the contract reports it. */
  token: Address;
  decimals: number;
  /** Block every figure below was read at, and when (unix seconds). */
  block: string;
  readAt: number;
  /** totalStaked(): every owner's active stake plus cooldown bucket, in SPARE base units. */
  totalStakedWei: string;
  /** totalSlashed(): every executed slash, all of it burned. */
  totalSlashedWei: string;
  /** minStakePerNode(): the minimum per active node in force now. */
  minStakePerNodeWei: string;
  /** proposalCount(): slash proposals ever made (open or closed). */
  proposals: number;
  /**
   * Owner wallets with SPARE in the contract: `staking` hold any (active or in the cooldown), `active` hold active stake,
   * `cooling` have SPARE in the cooldown (a wallet can be in both). Null when the event scan failed (see ownersError).
   */
  owners: { staking: number; active: number; cooling: number; fromBlock: string } | null;
  ownersError: string | null;
  rules: {
    epochLengthSeconds: number;
    cooldownEpochs: number;
    appealWindowEpochs: number;
    decisionWindowEpochs: number;
    slashBps: number;
    proposalGraceEpochs: number;
    stallFactor: number;
  };
  notes: string[];
};

const NOTES = [
  "Staking is voluntary and pays nothing. With a minimum of 0 per node, running a node needs no token.",
  "A slash is proposed by the scheduler only after repeated faults proven against two other owners' results, can be appealed, is decided by the treasury Safe, takes at most slashBps of a stake per proposal and is burned. Not trustless.",
  "Internal review only, not externally audited.",
];

type Scan = { contract: Address; from: bigint; next: bigint; owners: Address[] };
type State = { scan: Scan | null; cache: { at: number; ok: StakingJson } | { at: number; err: ApiError } | null; inflight: Promise<StakingJson> | null };
const g = globalThis as typeof globalThis & { __sparecycleStaking?: State };
const state = (): State => (g.__sparecycleStaking ??= { scan: null, cache: null, inflight: null });

/** Forget the cache and the event scan (tests). */
export function resetStakingCache() {
  g.__sparecycleStaking = { scan: null, cache: null, inflight: null };
}

const short = (e: unknown) => describeChainError(e).split("\n")[0].slice(0, 160);

/** Owners seen in Staked events up to `head`: the stored scan plus the blocks after it. Stored only when the scan worked. */
async function stakers(contract: Address, head: bigint): Promise<{ owners: Address[]; from: bigint }> {
  const s = state();
  const start = stakeStartBlock(contract);
  let scan = s.scan && s.scan.contract === contract && s.scan.from === start ? s.scan : { contract, from: start, next: start, owners: [] as Address[] };
  if (scan.next <= head) {
    const found = await tokenChain.nodeStakeStakers(contract, scan.next, head);
    scan = { ...scan, next: head + 1n, owners: [...new Set([...scan.owners, ...found])] };
    s.scan = scan;
  }
  return { owners: scan.owners, from: scan.from };
}

async function read(contract: Address): Promise<StakingJson> {
  let head: bigint;
  let totals: Awaited<ReturnType<typeof tokenChain.nodeStakeTotals>>;
  try {
    head = await tokenChain.headBlock();
    totals = await tokenChain.nodeStakeTotals(contract, head);
  } catch (e) {
    console.error(`[sparecycle] staking: could not read SparecycleNodeStake (${short(e)})`);
    throw new ApiError(503, "chain-read-failed", "Could not read the stake contract right now. Nothing is shown rather than a guess; try again in a minute.");
  }
  let owners: StakingJson["owners"] = null;
  let ownersError: string | null = null;
  try {
    const seen = await stakers(contract, head);
    const accounts = await tokenChain.nodeStakeAccounts(contract, seen.owners, head);
    owners = {
      staking: accounts.filter((a) => a.staked + a.unstaking > 0n).length,
      active: accounts.filter((a) => a.staked > 0n).length,
      cooling: accounts.filter((a) => a.unstaking > 0n).length,
      fromBlock: seen.from.toString(),
    };
  } catch (e) {
    console.error(`[sparecycle] staking: could not count staking owners (${short(e)})`);
    ownersError = "Could not read the contract's Staked events right now, so the number of staking owners is not shown.";
  }
  const r = totals.rules;
  return {
    contract,
    chainId: targetChain.id,
    explorerUrl: explorerAddress(contract),
    token: totals.token,
    decimals: SPARE_DECIMALS,
    block: head.toString(),
    readAt: Math.floor(Date.now() / 1000),
    totalStakedWei: totals.totalStaked.toString(),
    totalSlashedWei: totals.totalSlashed.toString(),
    minStakePerNodeWei: totals.minStakePerNode.toString(),
    proposals: Number(totals.proposalCount),
    owners,
    ownersError,
    rules: {
      epochLengthSeconds: Number(r.epochLength),
      cooldownEpochs: Number(r.cooldownEpochs),
      appealWindowEpochs: Number(r.appealWindowEpochs),
      decisionWindowEpochs: Number(r.decisionWindowEpochs),
      slashBps: r.slashBps,
      proposalGraceEpochs: Number(r.proposalGraceEpochs),
      stallFactor: Number(r.stallFactor),
    },
    notes: NOTES,
  };
}

/** The staking figures (cached). Throws ApiError 503 staking-not-deployed / chain-read-failed. `now` is for tests. */
export async function stakingJson(now: number = Date.now()): Promise<StakingJson> {
  const contract = stakeContract();
  if (!contract) throw new ApiError(503, "staking-not-deployed", "SparecycleNodeStake is not deployed on this network.");
  const s = state();
  const c = s.cache;
  if (c && "ok" in c && c.ok.contract === contract && now - c.at < CACHE_MS) return c.ok;
  if (c && "err" in c && now - c.at < FAILURE_CACHE_MS) throw c.err;
  if (s.inflight) return s.inflight;
  const run = read(contract).then(
    (ok) => {
      s.cache = { at: now, ok };
      return ok;
    },
    (e: unknown) => {
      const err = e instanceof ApiError ? e : new ApiError(503, "chain-read-failed", "Could not read the stake contract right now.");
      s.cache = { at: now, err };
      throw err;
    },
  );
  s.inflight = run.finally(() => {
    s.inflight = null;
  });
  return s.inflight;
}
