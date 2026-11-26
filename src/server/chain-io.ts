// On-chain I/O of the scheduler: reads of the reward contract and the one write it makes,
// closeEpochAndPostRoot. The signer key comes only from SCHEDULER_SIGNER_KEY and is never logged.
// Token features (`tokenChain`, at the end of the file): reads only, never a write.
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "@/lib/config";
import { publicClient, targetChain } from "@/lib/chain";
import { sparecycleRewardsAbi, type EpochStruct } from "@/contracts/sparecycleRewards";
import { jobPaymentsAbi } from "@/contracts/jobPayments";
import { ADDR, BURN_SINKS, TOKEN_CONTRACTS, UNISWAP_V4 } from "@/lib/addresses";
import { burnerAbi, holderPoolAbi, nodeStakeAbi, safeAbi, spareTokenAbi, v4PoolManagerAbi, v4StateViewAbi } from "@/lib/token-contracts";
import { serverEnv } from "./env";

export const rewardAddress = (): Address | null => config.rewardContract;

function need(): Address {
  const a = rewardAddress();
  if (!a) throw new Error("reward contract not configured");
  return a;
}

export async function readCurrentEpoch(): Promise<bigint> {
  return publicClient.readContract({ address: need(), abi: sparecycleRewardsAbi, functionName: "currentEpoch" });
}

export async function readEpoch(id: bigint): Promise<EpochStruct> {
  return (await publicClient.readContract({
    address: need(),
    abi: sparecycleRewardsAbi,
    functionName: "getEpoch",
    args: [id],
  })) as EpochStruct;
}

export async function readEpochLength(): Promise<bigint> {
  return publicClient.readContract({ address: need(), abi: sparecycleRewardsAbi, functionName: "epochLength" });
}

/** What the epoch will hold at close: its pot plus anything not yet credited (closeEpochAndPostRoot syncs first). */
export async function readPotAtClose(id: bigint): Promise<bigint> {
  const [epoch, unaccounted] = await Promise.all([
    readEpoch(id),
    publicClient.readContract({ address: need(), abi: sparecycleRewardsAbi, functionName: "unaccounted" }),
  ]);
  return epoch.pot + unaccounted;
}

export async function readCanClose(id: bigint): Promise<boolean> {
  return publicClient.readContract({ address: need(), abi: sparecycleRewardsAbi, functionName: "canClose", args: [id] });
}

export async function readScheduler(): Promise<Address> {
  return publicClient.readContract({ address: need(), abi: sparecycleRewardsAbi, functionName: "scheduler" });
}

/** The root-posting account, or null when SCHEDULER_SIGNER_KEY is not set. */
export function schedulerAccount() {
  const key = serverEnv.signerKey();
  return key ? privateKeyToAccount(key) : null;
}

export const rootPostingConfigured = () => rewardAddress() !== null && schedulerAccount() !== null;

/** Short, secret-free error text (decoded revert name when there is one). */
export function describeChainError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) return `reverted: ${revert.data.errorName}`;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Sends closeEpochAndPostRoot(epochId, root, reserved) from the scheduler key, after a simulation.
 * `onSent` is called with the tx hash before waiting, so a crash mid-wait still leaves a trace in the DB.
 */
export async function postRoot(
  epochId: bigint,
  root: Hex,
  reserved: bigint,
  onSent: (hash: Hex) => void,
): Promise<{ hash: Hex; success: boolean; endedAt: bigint | null }> {
  const account = schedulerAccount();
  if (!account) throw new Error("SCHEDULER_SIGNER_KEY not set");
  const address = need();
  const onChainScheduler = await readScheduler();
  if (onChainScheduler.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`signer ${account.address} is not the contract's scheduler (${onChainScheduler})`);
  }
  const { request } = await publicClient.simulateContract({
    account,
    address,
    abi: sparecycleRewardsAbi,
    functionName: "closeEpochAndPostRoot",
    args: [epochId, root, reserved],
  });
  const wallet = createWalletClient({ account, chain: targetChain, transport: http(targetChain.rpcUrls.default.http[0]) });
  const hash = await wallet.writeContract(request);
  onSent(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") return { hash, success: false, endedAt: null };
  const settled = await readEpoch(epochId);
  return { hash, success: true, endedAt: settled.endedAt };
}

// ---- Token features (docs/token-features.md): READS ONLY ---------------------------------------------------------
// Everything the burn plan, the holder weights, the slashing, the stake gate and the holder page read from the chain
// goes through `tokenChain`, so tests can replace one method at a time and the integrator has one place to align with
// the real contracts (interfaces: src/lib/token-contracts.ts). Nothing here signs or sends a transaction. A contract
// that is not deployed (null in src/lib/addresses.ts) throws NotLiveError, which callers turn into NOT_LIVE_YET or an
// incomplete plan.

/** A token-feature contract or setting that is not deployed / not recorded yet (null in src/lib/addresses.ts). */
export class NotLiveError extends Error {
  constructor(what: string) {
    super(`${what} is not live yet`);
    this.name = "NotLiveError";
  }
}

const live = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new NotLiveError(what);
  return v;
};

/** Log queries are split into spans of at most this many blocks (public RPCs cap a query at 10M blocks). */
const MAX_LOG_SPAN = 2_000_000n;
const MIN_LOG_SPAN = 1_000n;

/** getLogs over [from, to] in chunks; a chunk that fails (too many results) is split in half, down to MIN_LOG_SPAN. */
async function logsInChunks<T>(from: bigint, to: bigint, fetch: (from: bigint, to: bigint) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  let start = from;
  let span = MAX_LOG_SPAN;
  while (start <= to) {
    const end = start + span - 1n < to ? start + span - 1n : to;
    try {
      out.push(...(await fetch(start, end)));
      start = end + 1n;
    } catch (e) {
      if (span <= MIN_LOG_SPAN) throw e;
      span /= 2n;
    }
  }
  return out;
}

export type SpareTransfer = { block: bigint; logIndex: number; txHash: Hex; from: Address; to: Address; value: bigint };
export type ChargedEvent = { epochId: bigint; total: bigint; toPot: bigint; toTreasury: bigint; block: bigint; txHash: Hex };
export type PoolRead = { sqrtPriceX96: bigint; liquidity: bigint; lpFee: number; block: bigint };
export type SafeExecution = { safeTxHash: Hex; txHash: Hex; block: bigint };
export type ModeSetEvent = { holder: Address; mode: number; effectiveEpoch: bigint; block: bigint; logIndex: number };
export type SlashedEvent = { owner: Address; amount: bigint; proposalId: bigint; evidenceHash: Hex; block: bigint; txHash: Hex };
export type BurnedEvent = { epochId: bigint; ethIn: bigint; spareBurned: bigint; block: bigint; txHash: Hex };
/** What a burn transaction shows on-chain: who it was sent to, the treasury Safe's execution in it, the v4 swap's ETH leg. */
export type BurnTxContext = {
  to: Address | null;
  input: Hex;
  /** The SafeTx hash of the treasury Safe's ExecutionSuccess in the transaction (null = not a treasury Safe execution). */
  safeExecution: Hex | null;
  /** |amount0| of the SPARE/ETH pool's Swap event in the transaction (currency0 is native ETH); null = no such swap. */
  ethIn: bigint | null;
  time: number;
};

const blockTimes = new Map<bigint, number>();
/** Burn transaction contexts: immutable once mined, so cached (the holder page re-reads its rows each epoch). */
const burnContexts = new Map<string, BurnTxContext>();
const EXECUTION_SUCCESS_TOPIC = keccak256(toBytes("ExecutionSuccess(bytes32,uint256)"));
/** Safe 1.3 logs ExecutionSuccess with txHash in data, later versions index it: read both layouts. */
const safeTxHashOfLog = (l: { topics: readonly Hex[]; data: Hex }): Hex => (l.topics[1] ?? (`0x${l.data.slice(2, 66)}` as Hex)) as Hex;

export const tokenChain = {
  async headBlock(): Promise<bigint> {
    return publicClient.getBlockNumber();
  },

  /** Block timestamp (unix seconds), cached in memory. */
  async blockTime(block: bigint): Promise<number> {
    const hit = blockTimes.get(block);
    if (hit !== undefined) return hit;
    const b = await publicClient.getBlock({ blockNumber: block });
    const t = Number(b.timestamp);
    if (blockTimes.size > 50_000) blockTimes.clear();
    blockTimes.set(block, t);
    return t;
  },

  /** The last block with a timestamp below `ts`, searched between `low` and the head (low - 1 when none). */
  async lastBlockBefore(ts: number, low: bigint): Promise<bigint> {
    let lo = low;
    let hi = await tokenChain.headBlock();
    if ((await tokenChain.blockTime(hi)) < ts) return hi;
    if ((await tokenChain.blockTime(lo)) >= ts) return lo - 1n;
    while (hi - lo > 1n) {
      const mid = (lo + hi) / 2n;
      if ((await tokenChain.blockTime(mid)) < ts) lo = mid;
      else hi = mid;
    }
    return lo;
  },

  /** SparecycleNodeStake.stakedOf(owner). */
  async stakedOf(owner: Address): Promise<bigint> {
    const address = live(TOKEN_CONTRACTS.nodeStake, "SparecycleNodeStake");
    return publicClient.readContract({ address, abi: nodeStakeAbi, functionName: "stakedOf", args: [owner] });
  },

  /** SparecycleNodeStake.minStakePerNode(). */
  async minStakePerNode(): Promise<bigint> {
    const address = live(TOKEN_CONTRACTS.nodeStake, "SparecycleNodeStake");
    return publicClient.readContract({ address, abi: nodeStakeAbi, functionName: "minStakePerNode" });
  },

  /** The Charged event in a charge transaction of the job payments contract (null = no such log in it). */
  async chargedEvent(txHash: Hex): Promise<ChargedEvent | null> {
    const payments = live(config.jobPayments, "SparecycleJobPayments");
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({ abi: jobPaymentsAbi, eventName: "Charged", logs: receipt.logs }).filter(
      (l) => l.address.toLowerCase() === payments.toLowerCase(),
    );
    if (!logs.length) return null;
    const a = logs[0].args;
    return { epochId: a.epochId, total: a.total, toPot: a.toPot, toTreasury: a.toTreasury, block: receipt.blockNumber, txHash };
  },

  /** The SPARE/ETH v4 pool's price and in-range liquidity (StateView), both read at one block. */
  async poolState(): Promise<PoolRead> {
    const address = live(UNISWAP_V4.stateView, "Uniswap v4 StateView");
    const block = await publicClient.getBlockNumber();
    const id = UNISWAP_V4.spareEthPoolId;
    const [slot0, liquidity] = await Promise.all([
      publicClient.readContract({ address, abi: v4StateViewAbi, functionName: "getSlot0", args: [id], blockNumber: block }),
      publicClient.readContract({ address, abi: v4StateViewAbi, functionName: "getLiquidity", args: [id], blockNumber: block }),
    ]);
    return { sqrtPriceX96: slot0[0], liquidity, lpFee: Number(slot0[3]), block };
  },

  /** The treasury Safe's nonce (the next SafeTx it executes). */
  async safeNonce(): Promise<bigint> {
    return publicClient.readContract({ address: ADDR.treasurySafe, abi: safeAbi, functionName: "nonce" });
  },

  /** ExecutionSuccess events of the treasury Safe since `fromBlock`. */
  async safeExecutions(fromBlock: bigint): Promise<SafeExecution[]> {
    const head = await publicClient.getBlockNumber();
    const logs = await logsInChunks(fromBlock, head, (from, to) => publicClient.getLogs({ address: ADDR.treasurySafe, fromBlock: from, toBlock: to }));
    return logs
      .filter((l) => l.topics[0] === EXECUTION_SUCCESS_TOPIC)
      .map((l) => ({ safeTxHash: safeTxHashOfLog(l), txHash: l.transactionHash as Hex, block: l.blockNumber as bigint }));
  },

  /** SPARE Transfer logs in [fromBlock, toBlock], in chain order. */
  async spareTransfers(fromBlock: bigint, toBlock: bigint): Promise<SpareTransfer[]> {
    const logs = await logsInChunks(fromBlock, toBlock, (from, to) =>
      publicClient.getLogs({ address: ADDR.spareToken, event: spareTokenAbi[0], fromBlock: from, toBlock: to }),
    );
    return logs.map((l) => ({
      block: l.blockNumber as bigint,
      logIndex: Number(l.logIndex),
      txHash: l.transactionHash as Hex,
      from: getAddress(l.args.from!),
      to: getAddress(l.args.to!),
      value: l.args.value!,
    }));
  },

  /** SPARE Transfer logs to the zero or the dead address since `fromBlock` (burn candidates), in chain order. */
  async spareBurnTransfers(fromBlock: bigint): Promise<SpareTransfer[]> {
    const head = await publicClient.getBlockNumber();
    const out: SpareTransfer[] = [];
    for (const sink of [BURN_SINKS.zero, BURN_SINKS.dead]) {
      const logs = await logsInChunks(fromBlock, head, (from, to) =>
        publicClient.getLogs({ address: ADDR.spareToken, event: spareTokenAbi[0], args: { to: sink }, fromBlock: from, toBlock: to }),
      );
      for (const l of logs) {
        out.push({
          block: l.blockNumber as bigint,
          logIndex: Number(l.logIndex),
          txHash: l.transactionHash as Hex,
          from: getAddress(l.args.from!),
          to: getAddress(l.args.to!),
          value: l.args.value!,
        });
      }
    }
    return out.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1));
  },

  /** A burn transaction's context: recipient, the treasury Safe's execution in it, and the v4 swap's ETH leg. */
  async burnTxContext(txHash: Hex): Promise<BurnTxContext> {
    const cached = burnContexts.get(txHash.toLowerCase());
    if (cached) return cached;
    const [tx, receipt] = await Promise.all([publicClient.getTransaction({ hash: txHash }), publicClient.getTransactionReceipt({ hash: txHash })]);
    const exec = receipt.logs.find((l) => l.address.toLowerCase() === ADDR.treasurySafe.toLowerCase() && l.topics[0] === EXECUTION_SUCCESS_TOPIC);
    const manager = UNISWAP_V4.poolManager;
    const swaps = manager
      ? parseEventLogs({ abi: v4PoolManagerAbi, eventName: "Swap", logs: receipt.logs }).filter(
          (l) => l.address.toLowerCase() === manager.toLowerCase() && l.args.id.toLowerCase() === UNISWAP_V4.spareEthPoolId.toLowerCase(),
        )
      : [];
    const amount0 = swaps.length ? swaps[0].args.amount0 : null;
    const ctx: BurnTxContext = {
      to: tx.to ? getAddress(tx.to) : null,
      input: tx.input,
      safeExecution: exec ? safeTxHashOfLog(exec) : null,
      ethIn: amount0 === null ? null : amount0 < 0n ? -amount0 : amount0,
      time: await tokenChain.blockTime(receipt.blockNumber),
    };
    if (burnContexts.size > 20_000) burnContexts.clear();
    burnContexts.set(txHash.toLowerCase(), ctx);
    return ctx;
  },

  /** SparecycleHolderPool ModeSet events in [fromBlock, toBlock]. */
  async modeSets(fromBlock: bigint, toBlock: bigint): Promise<ModeSetEvent[]> {
    const address = live(TOKEN_CONTRACTS.holderPool, "SparecycleHolderPool");
    const logs = await logsInChunks(fromBlock, toBlock, (from, to) => publicClient.getLogs({ address, event: holderPoolAbi[3], fromBlock: from, toBlock: to }));
    return logs.map((l) => ({
      holder: getAddress(l.args.holder!),
      mode: Number(l.args.mode!),
      effectiveEpoch: l.args.effectiveEpoch!,
      block: l.blockNumber as bigint,
      logIndex: Number(l.logIndex),
    }));
  },

  /** SparecycleNodeStake Slashed events in [fromBlock, toBlock] (default: to the head). */
  async slashedEvents(fromBlock: bigint, toBlock?: bigint): Promise<SlashedEvent[]> {
    const address = live(TOKEN_CONTRACTS.nodeStake, "SparecycleNodeStake");
    const head = toBlock ?? (await publicClient.getBlockNumber());
    const logs = await logsInChunks(fromBlock, head, (from, to) => publicClient.getLogs({ address, event: nodeStakeAbi[3], fromBlock: from, toBlock: to }));
    return logs.map((l) => ({
      owner: getAddress(l.args.owner!),
      amount: l.args.amount!,
      proposalId: l.args.proposalId!,
      evidenceHash: l.args.evidenceHash!,
      block: l.blockNumber as bigint,
      txHash: l.transactionHash as Hex,
    }));
  },

  /** SparecycleBurner Burned events since `fromBlock` (phase 2b). */
  async burnedEvents(fromBlock: bigint): Promise<BurnedEvent[]> {
    const address = live(TOKEN_CONTRACTS.burner, "SparecycleBurner");
    const head = await publicClient.getBlockNumber();
    const logs = await logsInChunks(fromBlock, head, (from, to) => publicClient.getLogs({ address, event: burnerAbi[0], fromBlock: from, toBlock: to }));
    return logs.map((l) => ({
      epochId: l.args.epochId!,
      ethIn: l.args.ethIn!,
      spareBurned: l.args.spareBurned!,
      block: l.blockNumber as bigint,
      txHash: l.transactionHash as Hex,
    }));
  },

  /** SparecycleNodeStake SlashProposed events since `fromBlock`. */
  async slashProposedEvents(fromBlock: bigint): Promise<(Omit<SlashedEvent, "proposalId"> & { proposalId: bigint })[]> {
    const address = live(TOKEN_CONTRACTS.nodeStake, "SparecycleNodeStake");
    const head = await publicClient.getBlockNumber();
    const logs = await logsInChunks(fromBlock, head, (from, to) => publicClient.getLogs({ address, event: nodeStakeAbi[4], fromBlock: from, toBlock: to }));
    return logs.map((l) => ({
      owner: getAddress(l.args.owner!),
      amount: l.args.amount!,
      proposalId: l.args.proposalId!,
      evidenceHash: l.args.evidenceHash!,
      block: l.blockNumber as bigint,
      txHash: l.transactionHash as Hex,
    }));
  },

  /** SparecycleHolderPool RootPosted and Claimed events since `fromBlock`. */
  async holderPoolEvents(fromBlock: bigint): Promise<{
    roots: { epochId: bigint; root: Hex; totalEth: bigint; block: bigint; txHash: Hex }[];
    claims: { epochId: bigint; holder: Address; mode: number; amount: bigint; block: bigint; txHash: Hex }[];
  }> {
    const address = live(TOKEN_CONTRACTS.holderPool, "SparecycleHolderPool");
    const head = await publicClient.getBlockNumber();
    const [roots, claims] = await Promise.all([
      logsInChunks(fromBlock, head, (from, to) => publicClient.getLogs({ address, event: holderPoolAbi[4], fromBlock: from, toBlock: to })),
      logsInChunks(fromBlock, head, (from, to) => publicClient.getLogs({ address, event: holderPoolAbi[5], fromBlock: from, toBlock: to })),
    ]);
    return {
      roots: roots.map((l) => ({ epochId: l.args.epochId!, root: l.args.root!, totalEth: l.args.totalEth!, block: l.blockNumber as bigint, txHash: l.transactionHash as Hex })),
      claims: claims.map((l) => ({
        epochId: l.args.epochId!,
        holder: getAddress(l.args.holder!),
        mode: Number(l.args.mode!),
        amount: l.args.amount!,
        block: l.blockNumber as bigint,
        txHash: l.transactionHash as Hex,
      })),
    };
  },

  /** TREASURY_BPS of the live SparecycleJobPayments (ADDR.payments): the treasury cut of every charge. */
  async treasuryBps(): Promise<number> {
    return Number(await publicClient.readContract({ address: ADDR.payments, abi: jobPaymentsAbi, functionName: "TREASURY_BPS" }));
  },

  /** SPARE balance of an address. */
  async spareBalanceOf(address: Address): Promise<bigint> {
    return publicClient.readContract({ address: ADDR.spareToken, abi: spareTokenAbi, functionName: "balanceOf", args: [address] });
  },

  /**
   * Does the address hold contract code? An EIP-7702 delegation (23 bytes: 0xef0100 + address) is an EOA that delegated
   * its execution, not a contract, so it is not excluded as a contract (N14).
   */
  async isContract(address: Address): Promise<boolean> {
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x") return false;
    return !(code.length === 2 + 46 && code.toLowerCase().startsWith("0xef0100"));
  },
};
