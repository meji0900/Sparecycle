// Stake gate (brief §3 "Scheduler changes", docs/token-features.md), behind TOKEN_STAKE_GATE (default off). Used by
// ./nodes (leases) and ./rounds (the registered-pair check of a new round).
//
// With the flag ON, an owner wallet's nodes get job leases only while
//     stakedOf(owner) >= minStakePerNode() x activeNodes(owner)
// read from SparecycleNodeStake through ./chain-io (tokenChain). activeNodes = the owner's nodes that are online right
// now (polled within POLICY.onlineWindowSeconds or holding a live lease), at least 1: the node asking. Reads are cached
// per epoch in token_stake_reads: a sufficient stake is not read again within the epoch (stake can only fall through a
// slash or an unstake, both behind multi-epoch delays in the contract); an insufficient one is read again at the next
// poll, so a top-up restores leases from the next poll. If a read fails, the owner's last stored read is used (any
// epoch); with none, the gate fails closed (no lease). With SparecycleNodeStake not deployed (null in
// src/lib/addresses.ts) every read fails, so turning the flag on before the contract exists stops all leasing.
//
// The "compatible peer" checks (first task of a round in tryLease, the next-round pair in ./rounds) count only owners
// whose last read passed, so a job is never half-leased to a gated pair. With the flag OFF none of this runs: no read,
// no SQL change, leasing exactly as before (src/server/stake-gate.test.ts checks it).
import type { Address } from "viem";
import { getDb, getMeta, nowSec, setMeta } from "./db";
import { POLICY, serverEnv } from "./env";
import { NotLiveError, tokenChain } from "./chain-io";

type StakeRead = { owner: string; epoch_id: number; staked_wei: string; min_per_node_wei: string; active_nodes: number; ok: number; read_at: number };

/** The owner's nodes that are online now (polled within the online window or holding a live lease); at least 1. */
export function activeNodeCount(owner: Address): number {
  const now = nowSec();
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM nodes n WHERE lower(n.owner) = lower(?) AND (n.last_seen >= ? OR EXISTS (
         SELECT 1 FROM tasks t WHERE t.node_key = n.node_key AND t.status = 'leased' AND t.lease_expires >= ?))`,
    )
    .get(owner, now - POLICY.onlineWindowSeconds, now) as { n: number };
  return Math.max(1, row.n);
}

const meets = (staked: bigint, minPerNode: bigint, active: number) => staked >= minPerNode * BigInt(active);

function store(owner: string, epochId: number, staked: bigint, min: bigint, active: number, ok: boolean) {
  getDb()
    .prepare(
      `INSERT INTO token_stake_reads (owner, epoch_id, staked_wei, min_per_node_wei, active_nodes, ok, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner) DO UPDATE SET epoch_id = excluded.epoch_id, staked_wei = excluded.staked_wei,
         min_per_node_wei = excluded.min_per_node_wei, active_nodes = excluded.active_nodes, ok = excluded.ok, read_at = excluded.read_at`,
    )
    .run(owner, epochId, staked.toString(), min.toString(), active, ok ? 1 : 0, nowSec());
}

const loggedNotLive = new Set<number>();

/** minStakePerNode changes only by the Safe with a delay of at least one epoch: one read per epoch (meta token_stake_min). */
async function minStakeForEpoch(epochId: number): Promise<bigint> {
  const cached = getMeta("token_stake_min");
  const [e, v] = cached ? cached.split(":") : [];
  if (e !== undefined && Number(e) === epochId && /^\d+$/.test(v ?? "")) return BigInt(v);
  const min = await tokenChain.minStakePerNode();
  setMeta("token_stake_min", `${epochId}:${min}`);
  return min;
}

/**
 * Does this owner meet the stake for its active nodes in `epochId`? Only called with TOKEN_STAKE_GATE on. Never throws:
 * a failed read falls back to the last stored read, else false (fail closed).
 */
export async function ownerMeetsStake(owner: Address, epochId: number): Promise<boolean> {
  const key = owner.toLowerCase();
  const active = activeNodeCount(owner);
  const prev = getDb().prepare("SELECT * FROM token_stake_reads WHERE owner = ?").get(key) as StakeRead | undefined;
  const sameEpoch = prev?.epoch_id === epochId;
  if (prev && sameEpoch && meets(BigInt(prev.staked_wei), BigInt(prev.min_per_node_wei), active)) {
    if (prev.active_nodes !== active || prev.ok !== 1) store(key, epochId, BigInt(prev.staked_wei), BigInt(prev.min_per_node_wei), active, true);
    return true;
  }
  try {
    const min = await minStakeForEpoch(epochId);
    const staked = await tokenChain.stakedOf(owner);
    const ok = meets(staked, min, active);
    store(key, epochId, staked, min, active, ok);
    return ok;
  } catch (e) {
    if (e instanceof NotLiveError) {
      if (!loggedNotLive.has(epochId)) {
        loggedNotLive.add(epochId);
        console.error(`[sparecycle] stake gate: TOKEN_STAKE_GATE is on but ${e.message}; no node gets a lease`);
      }
    } else {
      console.error(`[sparecycle] stake gate: stake read for ${owner} failed (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
    }
    if (!prev) return false;
    const ok = meets(BigInt(prev.staked_wei), BigInt(prev.min_per_node_wei), active);
    if (ok !== (prev.ok === 1)) getDb().prepare("UPDATE token_stake_reads SET ok = ?, active_nodes = ? WHERE owner = ?").run(ok ? 1 : 0, active, key);
    return ok;
  }
}

/**
 * SQL to append to a peer / pair query: the node (table alias `alias`) belongs to an owner whose last stake read passed.
 * An EMPTY string while TOKEN_STAKE_GATE is off, so the query is exactly the one used before the gate existed.
 */
export function stakePeerSql(alias: string): string {
  if (!serverEnv.tokenStakeGate()) return "";
  return ` AND EXISTS (SELECT 1 FROM token_stake_reads sr WHERE sr.owner = lower(${alias}.owner) AND sr.ok = 1)`;
}
