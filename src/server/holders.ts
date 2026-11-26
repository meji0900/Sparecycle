// Holder weights and the HolderPool root, credit mode (brief §6.1–6.2, docs/token-features.md), behind TOKEN_HOLDERS
// (default off). Nothing here sends a transaction: the postRoot call and the Safe funding transaction are PREPARED,
// unsigned. NVDA mode is not built (gates G1–G3, §6.6).
//
// Weight (no point-in-time snapshot). For epoch E = [startedAt, endedAt) the weight of an address is its time-weighted
// average SPARE balance:  sum(balance x seconds held) / epoch length,  replayed from SPARE Transfer logs read through
// ./chain-io (block timestamps), so SPARE bought one block before the end and sold right after weighs only the seconds it
// was held. "Balance" is the wallet balance plus the SPARE the address staked in SparecycleNodeStake (N15): a transfer to
// the stake contract moves wallet -> staked for the sender, one from it moves staked -> wallet for the receiver, and one
// from it to a burn sink (an executed slash) takes the stake of the Slashed event's owner in the same transaction.
//
// Eligible (N11, N14): not in HOLDER_EXCLUSIONS (src/lib/addresses.ts: PoolManager, Pons curve / escrow / vault / hook /
// locker, team, launch, treasury Safe, stake / burner / pool contracts, zero, dead), no contract code unless in
// HOLDER_CONTRACT_ALLOWLIST (an EIP-7702 delegated EOA is an EOA), and an average >= HOLDER_MIN_SPARE_WEI.
// Share: holder share of the epoch's charge (N1: Charged.toTreasury x 150 / 500), split pro rata by weight, floored, so
// the sum never exceeds totalEth. Mode: the last ModeSet with effectiveEpoch <= E (setMode in epoch N counts from N+1),
// default credits (N18); a mode that is not supported yet (NVDA) is put in the root as credits.
// Leaf: keccak256(abi.encodePacked(uint64 epochId, address holder, uint8 mode, uint256 amount)), sorted-pair tree
// (src/lib/merkle.ts, OpenZeppelin MerkleProof).
//
// The ledger (token_holder_ledger, cursor meta token_holder_block) replays every SPARE transfer from SPARE_START_BLOCK,
// because a holder's balance at an epoch start needs the full history. While SPARE_START_BLOCK is not recorded, roots are
// stored `incomplete`.
import { encodeFunctionData, encodePacked, getAddress, keccak256, type Address, type Hex } from "viem";
import { ADDR, BURN_SINKS, HOLDER_CONTRACT_ALLOWLIST, HOLDER_EXCLUSIONS, SPARE_START_BLOCK, TOKEN_CONTRACTS } from "@/lib/addresses";
import { targetChain } from "@/lib/chain";
import { buildTree, ZERO_ROOT } from "@/lib/merkle";
import { holderPoolAbi } from "@/lib/token-contracts";
import { DEFAULT_HOLDER_MODE, HOLDER_MIN_SPARE_WEI, holderShareOf, STAKED_COUNTS_AS_HELD, SUPPORTED_HOLDER_MODES, type HolderMode } from "@/lib/token-rules";
import { tokenChain, type SpareTransfer } from "./chain-io";
import { getDb, getMeta, nowSec, setMeta, tx } from "./db";
import { epochTreasuryAmount, safeTxHashOf, safeTxJson, type SafeTx } from "./burns";

const lower = (a: string) => a.toLowerCase();
const SINKS = new Set([lower(BURN_SINKS.zero), lower(BURN_SINKS.dead)]);
const MINT_FROM = lower(BURN_SINKS.zero);

export type Holding = { wallet: bigint; staked: bigint };
export type Ledger = Map<string, Holding>;
/** A SPARE transfer with its block time; `slashedOwner` = the owner of the Slashed event in the same transaction. */
export type TimedTransfer = SpareTransfer & { time: number; slashedOwner?: Address | null };

const entry = (l: Ledger, a: string): Holding => {
  let e = l.get(a);
  if (!e) {
    e = { wallet: 0n, staked: 0n };
    l.set(a, e);
  }
  return e;
};
const minus = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/** The addresses whose held amount a transfer changes. */
function touched(t: TimedTransfer, stake: string | null): string[] {
  const out = [lower(t.from), lower(t.to)];
  if (t.slashedOwner) out.push(lower(t.slashedOwner));
  return out.filter((a) => a !== stake);
}

/** Applies one transfer to the ledger (wallet / staked, N15). Exported for tests. */
export function applyTransfer(l: Ledger, t: TimedTransfer, stake: string | null) {
  const from = lower(t.from);
  const to = lower(t.to);
  const v = t.value;
  if (stake && from === stake && to === stake) return;
  if (stake && from === stake) {
    // Out of the stake contract: an unstake back to `to`, or an executed slash burned to a sink.
    const owner = SINKS.has(to) ? (t.slashedOwner ? lower(t.slashedOwner) : null) : to;
    if (owner) entry(l, owner).staked = minus(entry(l, owner).staked, v);
    entry(l, to).wallet += v; // to a sink: the sink "holds" what was burned (sinks are always excluded)
    return;
  }
  if (from !== MINT_FROM) entry(l, from).wallet = minus(entry(l, from).wallet, v);
  if (stake && to === stake) {
    entry(l, from).staked += v;
    return;
  }
  entry(l, to).wallet += v;
}

const heldBy = (h: Holding | undefined, countStaked: boolean) => (h ? h.wallet + (countStaked ? h.staked : 0n) : 0n);

/**
 * Time-weighted average holding per address over [start, end): sum(held x seconds) / (end - start), floored. `opening`
 * is the ledger at `start`; `transfers` are the epoch's transfers in chain order with start <= time < end. Pure.
 */
export function timeWeightedAverages(o: {
  start: number;
  end: number;
  opening: Ledger;
  transfers: TimedTransfer[];
  stake: Address | null;
  countStaked?: boolean;
}): { averages: Map<string, bigint>; closing: Ledger } {
  const countStaked = o.countStaked ?? STAKED_COUNTS_AS_HELD;
  const stake = o.stake ? lower(o.stake) : null;
  const length = BigInt(o.end - o.start);
  if (length <= 0n) throw new Error("epoch length must be positive");
  const l: Ledger = new Map([...o.opening].map(([a, h]) => [a, { ...h }]));
  const acc = new Map<string, bigint>();
  const since = new Map<string, number>();
  const flush = (a: string, t: number) => {
    const from = since.get(a) ?? o.start;
    acc.set(a, (acc.get(a) ?? 0n) + heldBy(l.get(a), countStaked) * BigInt(t - from));
    since.set(a, t);
  };
  for (const t of o.transfers) {
    if (t.time < o.start || t.time >= o.end) throw new Error(`transfer at ${t.time} is outside the epoch [${o.start}, ${o.end})`);
    for (const a of touched(t, stake)) flush(a, t.time);
    applyTransfer(l, t, stake);
  }
  for (const a of l.keys()) if (a !== stake) flush(a, o.end);
  const averages = new Map<string, bigint>();
  for (const [a, v] of acc) if (v > 0n) averages.set(a, v / length);
  return { averages, closing: l };
}

export type Eligibility = {
  eligible: Map<Address, bigint>;
  excluded: string[];
  contracts: string[];
  belowMin: string[];
};

/** Applies the exclusion list, the contract rule (N14) and the minimum (N11). `contracts` = addresses found to hold code. */
export function eligibleWeights(
  averages: Map<string, bigint>,
  o: { excluded: Set<string>; allowlist: Set<string>; contracts: Set<string>; min: bigint },
): Eligibility {
  const out: Eligibility = { eligible: new Map(), excluded: [], contracts: [], belowMin: [] };
  for (const [a, avg] of [...averages].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (o.excluded.has(a)) out.excluded.push(a);
    else if (o.contracts.has(a) && !o.allowlist.has(a)) out.contracts.push(a);
    else if (avg < o.min) out.belowMin.push(a);
    else out.eligible.set(getAddress(a), avg);
  }
  return out;
}

/** Pro-rata shares of `total`, floored (sum <= total); zero amounts are dropped. Pure. */
export function allocateHolderShares(total: bigint, weights: Map<Address, bigint>): { holder: Address; weight: bigint; amount: bigint }[] {
  const sum = [...weights.values()].reduce((s, w) => s + w, 0n);
  if (sum === 0n || total === 0n) return [];
  return [...weights]
    .map(([holder, weight]) => ({ holder, weight, amount: (total * weight) / sum }))
    .filter((e) => e.amount > 0n)
    .sort((a, b) => (lower(a.holder) < lower(b.holder) ? -1 : 1));
}

export type ModeChange = { mode: number; effectiveEpoch: number; block: number; logIndex: number };

/** The mode a holder's leaf carries in `epochId`: the last ModeSet with effectiveEpoch <= epochId, default credits (N18). */
export function modeForEpoch(history: ModeChange[], epochId: number, supported: readonly number[] = SUPPORTED_HOLDER_MODES): HolderMode {
  const last = history
    .filter((h) => h.effectiveEpoch <= epochId)
    .sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block - b.block))
    .pop();
  if (!last || !supported.includes(last.mode)) return DEFAULT_HOLDER_MODE;
  return last.mode as HolderMode;
}

/** keccak256(abi.encodePacked(uint64 epochId, address holder, uint8 mode, uint256 amount)). */
export const holderLeafOf = (epochId: bigint, holder: Address, mode: number, amount: bigint): Hex =>
  keccak256(encodePacked(["uint64", "address", "uint8", "uint256"], [epochId, holder, mode, amount]));

export function buildHolderTree<T extends { holder: Address; mode: number; amount: bigint }>(epochId: number, entries: T[]) {
  const leaves = entries.map((e) => ({ ...e, leaf: holderLeafOf(BigInt(epochId), e.holder, e.mode, e.amount) }));
  return { tree: leaves.length ? buildTree(leaves.map((l) => l.leaf)) : { root: ZERO_ROOT, layers: [[]] }, leaves };
}

// ---- The runner ------------------------------------------------------------------------------------------------

export type HolderInfra = {
  startBlock: bigint | null;
  holderPool: Address | null;
  nodeStake: Address | null;
  safe: Address;
  chainId: number;
  excluded: (Address | null)[];
  allowlist: Address[];
  min: bigint;
};

export const defaultHolderInfra = (): HolderInfra => ({
  startBlock: SPARE_START_BLOCK,
  holderPool: TOKEN_CONTRACTS.holderPool,
  nodeStake: TOKEN_CONTRACTS.nodeStake,
  safe: ADDR.treasurySafe,
  chainId: targetChain.id,
  excluded: HOLDER_EXCLUSIONS.map((e) => e.address),
  allowlist: HOLDER_CONTRACT_ALLOWLIST,
  min: HOLDER_MIN_SPARE_WEI,
});

type EpochRow = { id: number; started_at: number; ended_at: number | null; length: number };
const CURSOR = "token_holder_block";

function loadLedger(): Ledger {
  const rows = getDb().prepare("SELECT address, wallet_wei, staked_wei FROM token_holder_ledger").all() as { address: string; wallet_wei: string; staked_wei: string }[];
  return new Map(rows.map((r) => [r.address, { wallet: BigInt(r.wallet_wei), staked: BigInt(r.staked_wei) }]));
}

/**
 * Transfers in [from, to] with the slashed owner of a stake -> sink transfer (Slashed in the same tx), and block times when
 * `withTimes` (only the epoch's own transfers need them: the catch-up before its start does not, which keeps the first run
 * from reading one block per historical transfer).
 */
async function timedTransfers(from: bigint, to: bigint, infra: HolderInfra, withTimes: boolean): Promise<TimedTransfer[]> {
  if (to < from) return [];
  const raw = await tokenChain.spareTransfers(from, to);
  const slashedByTx = new Map<string, Address>();
  const stake = infra.nodeStake ? lower(infra.nodeStake) : null;
  if (stake && raw.some((t) => lower(t.from) === stake && SINKS.has(lower(t.to)))) {
    for (const s of await tokenChain.slashedEvents(from, to)) slashedByTx.set(lower(s.txHash), s.owner);
  }
  const out: TimedTransfer[] = [];
  for (const t of raw) {
    out.push({ ...t, time: withTimes ? await tokenChain.blockTime(t.block) : 0, slashedOwner: slashedByTx.get(lower(t.txHash)) ?? null });
  }
  return out;
}

const incompleteRow = (epochId: number, missing: string[], toTreasury: bigint | null, total: bigint) =>
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO token_holder_roots (epoch_id, status, missing, to_treasury_wei, total_eth_wei, root, leaves, total_weight, from_block, to_block,
         post_call, fund_safe_tx, created_at) VALUES (?, 'incomplete', ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?)`,
    )
    .run(epochId, JSON.stringify(missing), toTreasury?.toString() ?? null, total.toString(), nowSec());

/**
 * Computes one closed epoch's weights and root. Requires the ledger cursor to be before the epoch's start (epochs are
 * processed in order). Returns a summary line.
 */
export async function prepareHolderRoot(epoch: EpochRow, infra: HolderInfra = defaultHolderInfra()): Promise<string> {
  const end = epoch.ended_at ?? epoch.started_at + epoch.length;
  const charge = await epochTreasuryAmount(epoch.id);
  const toTreasury = charge?.toTreasury ?? null;
  const total = toTreasury === null ? 0n : holderShareOf(toTreasury);
  if (infra.startBlock === null) {
    incompleteRow(epoch.id, ["SPARE start block (src/lib/addresses.ts SPARE_START_BLOCK): balances need the full Transfer history"], toTreasury, total);
    return `epoch ${epoch.id}: incomplete (SPARE start block not recorded)`;
  }
  const cursorRaw = getMeta(CURSOR);
  const cursor = cursorRaw === null ? infra.startBlock - 1n : BigInt(cursorRaw);
  // Ledger up to the epoch start (transfers before startedAt), then the epoch's own transfers (startedAt <= t < end).
  const startBoundary = await tokenChain.lastBlockBefore(epoch.started_at, infra.startBlock);
  const endBoundary = await tokenChain.lastBlockBefore(end, infra.startBlock);
  if (startBoundary < cursor) return `epoch ${epoch.id}: skipped (the ledger is already past its start)`;
  const ledger = loadLedger();
  const stake = infra.nodeStake ? lower(infra.nodeStake) : null;
  for (const t of await timedTransfers(cursor + 1n, startBoundary, infra, false)) applyTransfer(ledger, t, stake);
  const inEpoch = await timedTransfers(startBoundary + 1n, endBoundary, infra, true);
  const { averages, closing } = timeWeightedAverages({ start: epoch.started_at, end, opening: ledger, transfers: inEpoch, stake: infra.nodeStake });

  // Modes: ModeSet events up to the epoch end (stored as history); none while the pool is not deployed.
  if (infra.holderPool) {
    const modeFrom = BigInt(getMeta("token_holder_mode_block") ?? (infra.startBlock - 1n).toString()) + 1n;
    const sets = await tokenChain.modeSets(modeFrom, endBoundary);
    tx((db) => {
      const ins = db.prepare("INSERT OR IGNORE INTO token_holder_modes (holder, mode, effective_epoch, block, log_index) VALUES (?, ?, ?, ?, ?)");
      for (const s of sets) ins.run(lower(s.holder), s.mode, Number(s.effectiveEpoch), Number(s.block), s.logIndex);
      setMeta("token_holder_mode_block", endBoundary.toString());
    });
  }

  const excluded = new Set(infra.excluded.filter((a): a is Address => a !== null).map(lower));
  for (const s of SINKS) excluded.add(s);
  if (stake) excluded.add(stake);
  const allowlist = new Set(infra.allowlist.map(lower));
  const contracts = new Set<string>();
  for (const [a, avg] of averages) {
    if (excluded.has(a) || allowlist.has(a) || avg < infra.min) continue;
    if (await tokenChain.isContract(getAddress(a))) contracts.add(a);
  }
  const el = eligibleWeights(averages, { excluded, allowlist, contracts, min: infra.min });
  const shares = allocateHolderShares(total, el.eligible);
  const modeRows = getDb().prepare("SELECT holder, mode, effective_epoch, block, log_index FROM token_holder_modes").all() as {
    holder: string;
    mode: number;
    effective_epoch: number;
    block: number;
    log_index: number;
  }[];
  const history = new Map<string, ModeChange[]>();
  for (const r of modeRows) {
    const h = history.get(r.holder) ?? [];
    h.push({ mode: r.mode, effectiveEpoch: r.effective_epoch, block: r.block, logIndex: r.log_index });
    history.set(r.holder, h);
  }
  const entries = shares.map((s) => ({ ...s, mode: modeForEpoch(history.get(lower(s.holder)) ?? [], epoch.id) }));
  const { tree, leaves } = buildHolderTree(epoch.id, entries);
  const totalWeight = [...el.eligible.values()].reduce((s, w) => s + w, 0n);

  const missing: string[] = [];
  if (!infra.holderPool) missing.push("SparecycleHolderPool (src/lib/addresses.ts TOKEN_CONTRACTS.holderPool): no postRoot call");
  if (toTreasury === null) missing.push("no confirmed charge in this epoch: nothing to distribute");
  const postCall =
    infra.holderPool && toTreasury !== null
      ? {
          unsigned: true,
          from: "scheduler key (never sent by this code)",
          to: infra.holderPool,
          function: "postRoot(uint64 epochId, bytes32 root, uint256 totalEth)",
          args: { epochId: epoch.id, root: tree.root, totalEth: total.toString() },
          data: encodeFunctionData({ abi: holderPoolAbi, functionName: "postRoot", args: [BigInt(epoch.id), tree.root, total] }),
        }
      : null;
  let fund: object | null = null;
  if (postCall && total > 0n) {
    // Until SparecycleJobPaymentsV2 sends the split itself, the holder share leaves the treasury Safe by a Safe transaction.
    try {
      const safeTx: SafeTx = {
        to: infra.holderPool!,
        value: total,
        data: "0x",
        operation: 0,
        safeTxGas: 0n,
        baseGas: 0n,
        gasPrice: 0n,
        gasToken: BURN_SINKS.zero,
        refundReceiver: BURN_SINKS.zero,
        nonce: await tokenChain.safeNonce(),
      };
      fund = { unsigned: true, note: "Prepared for the treasury Safe's signers. Not signed, not sent.", safe: infra.safe, safeTx: safeTxJson(safeTx), safeTxHash: safeTxHashOf(infra.chainId, infra.safe, safeTx) };
    } catch (e) {
      missing.push(`treasury Safe nonce read failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  const status = postCall ? "prepared" : toTreasury === null && infra.holderPool ? "nothing-due" : "incomplete";
  tx((db) => {
    db.prepare("DELETE FROM token_holder_ledger").run();
    const insL = db.prepare("INSERT INTO token_holder_ledger (address, wallet_wei, staked_wei) VALUES (?, ?, ?)");
    for (const [a, h] of closing) if (h.wallet > 0n || h.staked > 0n) insL.run(a, h.wallet.toString(), h.staked.toString());
    setMeta(CURSOR, endBoundary.toString());
    db.prepare(
      `INSERT OR REPLACE INTO token_holder_roots (epoch_id, status, missing, to_treasury_wei, total_eth_wei, root, leaves, total_weight, from_block, to_block,
         post_call, fund_safe_tx, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      epoch.id,
      status,
      missing.length ? JSON.stringify(missing) : null,
      toTreasury?.toString() ?? null,
      total.toString(),
      tree.root,
      leaves.length,
      totalWeight.toString(),
      Number(startBoundary + 1n),
      Number(endBoundary),
      postCall ? JSON.stringify(postCall) : null,
      fund ? JSON.stringify(fund) : null,
      nowSec(),
    );
    db.prepare("DELETE FROM token_holder_leaves WHERE epoch_id = ?").run(epoch.id);
    const insLeaf = db.prepare(
      "INSERT INTO token_holder_leaves (epoch_id, holder, mode, avg_balance_wei, amount_wei, leaf) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const l of leaves) insLeaf.run(epoch.id, l.holder, l.mode, l.weight.toString(), l.amount.toString(), l.leaf);
  });
  return (
    `epoch ${epoch.id}: ${status}, ${leaves.length} holders, total ${total} wei, root ${tree.root} ` +
    `(${el.excluded.length} excluded, ${el.contracts.length} contracts, ${el.belowMin.length} below the minimum; NOT posted)`
  );
}

/**
 * Prepares the roots of the closed epochs that have none yet, in order. On the first run only the latest closed epoch is
 * taken (earlier epochs are not distributed). Stops at the first failure; it is retried at the next close.
 */
export async function prepareHolderRoots(infra: HolderInfra = defaultHolderInfra()): Promise<string> {
  const db = getDb();
  const last = db.prepare("SELECT MAX(epoch_id) AS m FROM token_holder_roots").get() as { m: number | null };
  const closed = db
    .prepare("SELECT id, started_at, ended_at, length FROM epochs WHERE status != 'open' AND id > ? ORDER BY id")
    .all(last.m ?? -1) as EpochRow[];
  const todo = last.m === null ? closed.slice(-1) : closed;
  if (!todo.length) return "holders: nothing to prepare";
  const lines: string[] = [];
  for (const e of todo) {
    try {
      lines.push(await prepareHolderRoot(e, infra));
    } catch (err) {
      lines.push(`epoch ${e.id}: failed (${err instanceof Error ? err.message.split("\n")[0] : String(err)}); retried at the next close`);
      break;
    }
  }
  return `holders: ${lines.join(" | ")}`;
}
