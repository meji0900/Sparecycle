// Sends the holder-pool roots that ./holders prepared (docs/token-features.md), behind TOKEN_HOLDERS (default off) and only
// with SparecycleHolderPool and SparecycleJobPaymentsV2 both set. The only token-feature transaction this scheduler sends:
// postRoot(epochId, root, totalEth) from the scheduler key, through chain-io's holderPoolSender (sendAsScheduler, so its
// nonce never collides with the reward root post, the charge or the x402 calls).
//
// Never posts an epoch twice:
//  - roots go out in epoch order (the pool accepts strictly increasing ids only); `posted` is final;
//  - before every send the pool's getRoot(epoch) is read: already posted with this root and total -> marked posted with its
//    RootPosted transaction, nothing sent; posted with another root -> `conflict` (for the operator), nothing sent;
//  - a `sent` row waits for its transaction; only after SENT_TIMEOUT_S with no receipt AND no root on-chain is it treated as
//    dropped and sent again (the contract would refuse a second post of the same epoch anyway);
//  - an epoch the pool no longer accepts (below nextPostableEpoch: a later epoch was posted, or it predates the pool) is
//    `unpostable`; one not closed on-chain yet waits.
// Retries: an RPC or transport failure stops the run without counting and is retried by the timer (HOLDER_TICK_MS) and at
// the next close. A contract revert counts an attempt; after MAX_POST_ATTEMPTS the row is `failed` and later epochs go
// on (that epoch can then never be posted; its funding stays in the pool).
import type { Hex } from "viem";
import { chainErrorName, describeChainError, holderPoolSender, rootPostingConfigured, tokenChain } from "./chain-io";
import { getDb, nowSec } from "./db";
import { serverEnv } from "./env";
import { defaultHolderInfra, holderPostingLive, prepareHolderRoots, type HolderInfra } from "./holders";

export const MAX_POST_ATTEMPTS = 3;
export const SENT_TIMEOUT_S = 15 * 60;
/** How often the timer retries preparing and posting (an epoch is six hours; a failed post is retried within minutes). */
export const HOLDER_TICK_MS = 5 * 60_000;

export type HolderRootRow = {
  epoch_id: number;
  status: string;
  root: string | null;
  total_eth_wei: string;
  leaves: number;
  from_block: number | null;
  pending_tx: string | null;
  sent_at: number | null;
  posted_tx: string | null;
  post_attempts: number;
};

const msg = (e: unknown) => describeChainError(e).split("\n")[0].slice(0, 300);

function setRow(epochId: number, fields: Record<string, string | number | null>) {
  const keys = Object.keys(fields);
  getDb()
    .prepare(`UPDATE token_holder_roots SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE epoch_id = ?`)
    .run(...keys.map((k) => fields[k]), epochId);
}

const rowOf = (epochId: number) => getDb().prepare("SELECT * FROM token_holder_roots WHERE epoch_id = ?").get(epochId) as HolderRootRow;

function markPosted(epochId: number, tx: string | null, claimableUntil: bigint | null) {
  setRow(epochId, {
    status: "posted",
    posted_tx: tx,
    posted_at: nowSec(),
    pending_tx: null,
    post_error: null,
    claimable_until: claimableUntil === null ? null : Number(claimableUntil),
  });
}

/** A contract revert: count it; after MAX_POST_ATTEMPTS the row is `failed` and the run moves on. */
function revertAttempt(row: HolderRootRow, error: string): { stop: boolean; line: string } {
  const attempts = row.post_attempts + 1;
  const failed = attempts >= MAX_POST_ATTEMPTS;
  setRow(row.epoch_id, { status: failed ? "failed" : "ready", pending_tx: null, post_error: error, post_attempts: attempts });
  return {
    stop: !failed,
    line: `epoch ${row.epoch_id}: postRoot refused (${error}), attempt ${attempts} of ${MAX_POST_ATTEMPTS}${failed ? ": marked failed" : ""}`,
  };
}

/** One root: decides from the chain, sends at most one postRoot. `stop` = do not go on to later epochs this run. */
async function postOne(row: HolderRootRow, pool: `0x${string}`): Promise<{ stop: boolean; line: string }> {
  const id = BigInt(row.epoch_id);
  const root = row.root as Hex;
  const total = BigInt(row.total_eth_wei);
  let sentOk = false;

  // 1. A transaction already sent for this row: its receipt decides before anything else.
  if (row.status === "sent" && row.pending_tx) {
    const st = await holderPoolSender.receiptStatus(row.pending_tx as Hex, 20_000);
    if (st === null && nowSec() - (row.sent_at ?? 0) < SENT_TIMEOUT_S) {
      return { stop: true, line: `epoch ${row.epoch_id}: postRoot ${row.pending_tx} not mined yet` };
    }
    if (st === "reverted") return revertAttempt(row, `transaction ${row.pending_tx} reverted`);
    sentOk = st === "success";
    // success, or no receipt after SENT_TIMEOUT_S (dropped): the on-chain root below decides.
  }

  // 2. The chain first: never send for an epoch that already has a root.
  const info = await tokenChain.holderRoot(id);
  if (info.posted) {
    if (info.root.toLowerCase() === root.toLowerCase() && info.total === total) {
      const tx = sentOk ? row.pending_tx : ((await tokenChain.holderRootPostedTx(id, BigInt(row.from_block ?? 0)).catch(() => null)) ?? row.pending_tx);
      markPosted(row.epoch_id, tx, info.claimableUntilEpoch);
      return { stop: false, line: `epoch ${row.epoch_id}: root on-chain${tx ? ` (tx ${tx})` : ""}, marked posted` };
    }
    setRow(row.epoch_id, {
      status: "conflict",
      pending_tx: null,
      note: `the pool holds another root for this epoch (${info.root}, total ${info.total} wei)`,
    });
    return { stop: false, line: `epoch ${row.epoch_id}: CONFLICT, the pool holds root ${info.root} (total ${info.total}); not sent` };
  }
  if (sentOk) {
    // A successful postRoot always leaves the root posted; reaching here means the read lags. Try again later.
    return { stop: true, line: `epoch ${row.epoch_id}: postRoot ${row.pending_tx} succeeded but getRoot does not show it yet` };
  }
  const nextPostable = await tokenChain.holderNextPostable();
  if (id < nextPostable) {
    setRow(row.epoch_id, { status: "unpostable", pending_tx: null, note: `the pool accepts epochs from ${nextPostable} on (ids are strictly increasing)` });
    return { stop: false, line: `epoch ${row.epoch_id}: unpostable (the pool accepts epochs from ${nextPostable} on)` };
  }
  const open = await tokenChain.currentEpoch();
  if (id >= open) return { stop: true, line: `epoch ${row.epoch_id}: not closed on-chain yet` };

  // 3. Send (simulated first; a decoded revert throws before anything is sent).
  try {
    const res = await holderPoolSender.postRoot(pool, id, root, total, (hash) => {
      setRow(row.epoch_id, { status: "sent", pending_tx: hash, sent_at: nowSec(), post_error: null });
    });
    if (!res.success) return revertAttempt(rowOf(row.epoch_id), `transaction ${res.hash} reverted`);
    const after = await tokenChain.holderRoot(id).catch(() => null);
    markPosted(row.epoch_id, res.hash, after?.posted ? after.claimableUntilEpoch : null);
    return { stop: false, line: `epoch ${row.epoch_id}: root ${root} posted, totalEth ${total} wei (tx ${res.hash})` };
  } catch (e) {
    const now = rowOf(row.epoch_id);
    if (now.status === "sent") {
      // Sent, then the receipt wait failed: the next run reads its receipt. Never send again here.
      setRow(row.epoch_id, { post_error: msg(e) });
      return { stop: true, line: `epoch ${row.epoch_id}: postRoot ${now.pending_tx} sent, receipt not confirmed (${msg(e)})` };
    }
    const name = chainErrorName(e);
    if (name === "EpochNotPostable") {
      setRow(row.epoch_id, { status: "unpostable", note: "the pool refused the epoch id (EpochNotPostable)" });
      return { stop: false, line: `epoch ${row.epoch_id}: unpostable (EpochNotPostable)` };
    }
    if (name === "EpochNotClosed") return { stop: true, line: `epoch ${row.epoch_id}: not closed on-chain yet (EpochNotClosed)` };
    if (name && name !== "NotScheduler") return revertAttempt(now, `reverted: ${name}`);
    // RPC / transport failure, or a key that is not the scheduler (configuration): retried later, never counted.
    setRow(row.epoch_id, { post_error: msg(e) });
    return { stop: true, line: `epoch ${row.epoch_id}: not sent (${msg(e)}); retried later` };
  }
}

/** Posts every `ready` (or `sent`) root in epoch order. A summary line; never throws. */
export async function postHolderRoots(infra: HolderInfra = defaultHolderInfra()): Promise<string> {
  if (!holderPostingLive(infra) || !infra.holderPool) return "holder roots: posting not live (SparecycleHolderPool and SparecycleJobPaymentsV2 must both be set)";
  if (!rootPostingConfigured()) return "holder roots: SCHEDULER_SIGNER_KEY or the reward contract not set, nothing sent";
  const rows = getDb().prepare("SELECT * FROM token_holder_roots WHERE status IN ('ready', 'sent') ORDER BY epoch_id").all() as HolderRootRow[];
  if (!rows.length) return "holder roots: nothing to post";
  const lines: string[] = [];
  for (const row of rows) {
    try {
      const r = await postOne(row, infra.holderPool);
      lines.push(r.line);
      if (r.stop) break;
    } catch (e) {
      lines.push(`epoch ${row.epoch_id}: chain read failed (${msg(e)}); retried later`);
      break;
    }
  }
  return `holder roots: ${lines.join(" | ")}`;
}

const g = globalThis as typeof globalThis & { __sparecycleHolderWork?: Promise<unknown>; __sparecycleHolderTimer?: ReturnType<typeof setInterval> };

/**
 * Prepares the closed epochs' roots (./holders), then posts the ready ones. Serialized per process (the close and the
 * timer both come through here). A summary line; never throws.
 */
export function runHolderWork(infra?: HolderInfra): Promise<string> {
  const run = (g.__sparecycleHolderWork ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const lines = [await prepareHolderRoots(infra)];
      if (holderPostingLive(infra ?? defaultHolderInfra())) lines.push(await postHolderRoots(infra));
      return lines.join(" || ");
    })
    .catch((e) => `holders: failed (${msg(e)})`);
  g.__sparecycleHolderWork = run;
  return run;
}

/** With TOKEN_HOLDERS on and posting live: retries preparing and posting every HOLDER_TICK_MS (a failed post, a late close). */
export function startHolderTimer() {
  if (!serverEnv.tokenHolders() || !holderPostingLive() || g.__sparecycleHolderTimer) return;
  g.__sparecycleHolderTimer = setInterval(() => {
    runHolderWork().then((line) => {
      const idle = line.split(" || ").every((l) => /nothing to (prepare|post)$/.test(l));
      if (!idle) console.log(`[sparecycle] token: ${line}`);
    });
  }, HOLDER_TICK_MS);
  g.__sparecycleHolderTimer.unref?.();
  console.log(`[sparecycle] holder root timer on (every ${HOLDER_TICK_MS / 60_000} min)`);
}
