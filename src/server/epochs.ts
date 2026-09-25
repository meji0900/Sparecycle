// Epoch clock, epoch close and root posting.
//
// Clock: when NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS is set, epoch ids and start times follow the contract
// (currentEpoch / getEpoch / epochLength). Otherwise a scheduler-local clock runs with NEXT_PUBLIC_EPOCH_LENGTH
// (default 21600 s) and nothing is posted on-chain. One DB file serves one clock: switching from the local clock
// to a contract (or to another contract) needs a fresh DB_PATH, and the scheduler refuses to mix them.
//
// Close: read the pot (getEpoch(id).pot + unaccounted()), allocate it pro rata by work units over the epoch's
// agreed jobs (payouts.ts), build the Merkle tree, persist the leaves, then post closeEpochAndPostRoot when
// SCHEDULER_SIGNER_KEY is set. A failed post leaves the epoch `closed-unposted` with the error; the next close
// call (or the autoclose timer) retries the same root before closing anything else.
import { type Address, type Hex } from "viem";
import { targetChain } from "@/lib/chain";
import { buildEpochTree, ZERO_ROOT } from "@/lib/merkle";
import { getDb, getMeta, nowSec, setMeta, tx } from "./db";
import { POLICY, serverEnv } from "./env";
import { ApiError } from "./http";
import { allocate, type AgreedJob } from "./payouts";
import { chargeOpenEpoch, paymentsAddress } from "./payments";
import {
  describeChainError,
  postRoot,
  readCanClose,
  readCurrentEpoch,
  readEpoch,
  readEpochLength,
  readPotAtClose,
  rewardAddress,
  schedulerAccount,
} from "./chain-io";

export type EpochStatus = "open" | "closed-unposted" | "posted";
export type ClockMode = "contract" | "scheduler-local";

export type EpochRow = {
  id: number;
  clock: ClockMode;
  status: EpochStatus;
  started_at: number;
  length: number;
  provisional: number;
  ended_at: number | null;
  closed_at: number | null;
  root: string | null;
  reserved: string | null;
  pot_at_close: string | null;
  leaves: number;
  total_units: number;
  agreed_jobs: number;
  posted_tx: string | null;
  pending_tx: string | null;
  post_error: string | null;
};

export const LOCAL_CLOCK_NOTE = "scheduler-local epoch, contract not configured";

export const clockMode = (): ClockMode => (rewardAddress() ? "contract" : "scheduler-local");

const clockKey = () => {
  const a = rewardAddress();
  return a ? `contract:${targetChain.id}:${a.toLowerCase()}` : "scheduler-local";
};

/** Refuses to run on a DB that was written under a different clock (local vs contract, or another contract). */
export function assertClock() {
  const want = clockKey();
  const have = getMeta("clock");
  if (have === null) {
    setMeta("clock", want);
    return;
  }
  if (have !== want) {
    throw new ApiError(
      503,
      "db-clock-mismatch",
      "This scheduler database was created for a different epoch clock (local vs contract, or another contract). Use a fresh DB_PATH.",
    );
  }
}

const g = globalThis as typeof globalThis & { __sparecycleEpochSync?: number; __sparecycleCloseLock?: Promise<unknown> };

export function getEpochRow(id: number): EpochRow | null {
  return (getDb().prepare("SELECT * FROM epochs WHERE id = ?").get(id) as EpochRow | undefined) ?? null;
}

export function openEpochRow(): EpochRow | null {
  return (getDb().prepare("SELECT * FROM epochs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as EpochRow | undefined) ?? null;
}

export function listEpochRows(limit = 200): EpochRow[] {
  return getDb().prepare("SELECT * FROM epochs ORDER BY id DESC LIMIT ?").all(limit) as EpochRow[];
}

export function lastClosedEpochRow(): EpochRow | null {
  return (
    (getDb().prepare("SELECT * FROM epochs WHERE status != 'open' ORDER BY id DESC LIMIT 1").get() as EpochRow | undefined) ?? null
  );
}

/** Mirrors the contract's epoch state into the DB and reconciles posts that happened while we weren't looking. */
async function syncFromChain(): Promise<void> {
  const cur = await readCurrentEpoch();
  const [curEpoch, length] = await Promise.all([readEpoch(cur), readEpochLength()]);
  const curId = Number(cur);

  // Closed epochs the chain has moved past: settled on-chain => posted (e.g. after a crash mid-wait, or a manual post).
  const unposted = getDb()
    .prepare("SELECT * FROM epochs WHERE status = 'closed-unposted' AND clock = 'contract' AND id < ?")
    .all(curId) as EpochRow[];
  for (const row of unposted) {
    const e = await readEpoch(BigInt(row.id));
    if (!e.settled) continue;
    if (e.merkleRoot.toLowerCase() === (row.root ?? "").toLowerCase() && e.reserved.toString() === row.reserved) {
      getDb()
        .prepare(
          "UPDATE epochs SET status = 'posted', posted_tx = COALESCE(posted_tx, pending_tx), pending_tx = NULL, post_error = NULL, ended_at = ? WHERE id = ?",
        )
        .run(Number(e.endedAt), row.id);
      console.log(`[sparecycle] epoch ${row.id}: root found on-chain, marked posted`);
    } else {
      getDb()
        .prepare("UPDATE epochs SET post_error = ? WHERE id = ?")
        .run("settled on-chain with a different root/reserved than this scheduler's tree", row.id);
      console.error(`[sparecycle] epoch ${row.id}: on-chain root differs from the scheduler tree`);
    }
  }

  tx((db) => {
    const row = getEpochRow(curId);
    if (!row) {
      // Any epoch still open below the chain's current one was closed outside this scheduler.
      db.prepare(
        "UPDATE epochs SET status = 'closed-unposted', closed_at = ?, post_error = 'closed on-chain outside this scheduler' WHERE status = 'open' AND id < ?",
      ).run(nowSec(), curId);
      db.prepare("INSERT INTO epochs (id, clock, status, started_at, length, provisional) VALUES (?, 'contract', 'open', ?, ?, 0)").run(
        curId,
        Number(curEpoch.startedAt),
        Number(length),
      );
    } else if (row.status === "open") {
      db.prepare("UPDATE epochs SET started_at = ?, length = ?, provisional = 0 WHERE id = ?").run(
        Number(curEpoch.startedAt),
        Number(length),
        curId,
      );
    }
  });
  g.__sparecycleEpochSync = Date.now();
}

/** The open epoch (creating / syncing it as needed). Jobs reaching a verdict now belong to it. */
export async function ensureEpoch(force = false): Promise<EpochRow> {
  assertClock();
  if (clockMode() === "scheduler-local") {
    const open = openEpochRow();
    if (open) return open;
    const max = getDb().prepare("SELECT MAX(id) AS m FROM epochs").get() as { m: number | null };
    const id = max.m === null ? 0 : max.m + 1;
    getDb()
      .prepare("INSERT INTO epochs (id, clock, status, started_at, length, provisional) VALUES (?, 'scheduler-local', 'open', ?, ?, 0)")
      .run(id, nowSec(), serverEnv.localEpochLength());
    return openEpochRow()!;
  }
  const open = openEpochRow();
  const fresh = g.__sparecycleEpochSync !== undefined && Date.now() - g.__sparecycleEpochSync < POLICY.chainSyncMs;
  if (!force && open && fresh) return open;
  try {
    await syncFromChain();
  } catch (e) {
    if (open && !force) return open; // RPC hiccup: keep working on the epoch we know
    throw new ApiError(503, "chain-unavailable", `could not read the reward contract: ${describeChainError(e)}`);
  }
  const row = openEpochRow();
  if (!row) throw new ApiError(503, "epoch-unknown", "no open epoch");
  return row;
}

/** Open epoch without touching the chain (for result processing, which must not depend on the RPC). */
export function currentEpochIdLocal(): number {
  const open = openEpochRow();
  if (!open) throw new ApiError(503, "epoch-unknown", "no open epoch yet");
  return open.id;
}

// ---- Close --------------------------------------------------------------------------------------------
export type CloseSummary = {
  action: "closed" | "retried-post";
  epoch: {
    id: number;
    status: EpochStatus;
    root: string | null;
    reserved: string;
    potAtClose: string | null;
    leaves: number;
    agreedJobs: number;
    postedTx: string | null;
    postError: string | null;
  };
  next: { id: number } | null;
  note: string | null;
};

function summary(action: CloseSummary["action"], id: number, note: string | null): CloseSummary {
  const row = getEpochRow(id)!;
  const next = getEpochRow(id + 1);
  return {
    action,
    epoch: {
      id: row.id,
      status: row.status,
      root: row.root,
      reserved: row.reserved ?? "0",
      potAtClose: row.pot_at_close,
      leaves: row.leaves,
      agreedJobs: row.agreed_jobs,
      postedTx: row.posted_tx,
      postError: row.post_error,
    },
    next: next ? { id: next.id } : null,
    note,
  };
}

/** Agreed, payable jobs of an epoch with the owners of their two agreeing results. */
function agreedJobsOf(epochId: number): AgreedJob[] {
  const allowDev = serverEnv.allowDevRunner();
  const rows = getDb()
    .prepare(
      `SELECT j.id AS id, j.work_units AS units, j.dev AS dev, GROUP_CONCAT(r.owner) AS owners, COUNT(r.task_id) AS n
       FROM jobs j JOIN results r ON r.job_id = j.id
       WHERE j.status = 'agreed' AND j.epoch_id = ?
       GROUP BY j.id`,
    )
    .all(epochId) as { id: string; units: number; dev: number; owners: string; n: number }[];
  const out: AgreedJob[] = [];
  for (const r of rows) {
    if (r.n !== 2) continue;
    if (r.dev && !allowDev) continue;
    const [a, b] = r.owners.split(",") as Address[];
    if (a.toLowerCase() === b.toLowerCase()) continue;
    out.push({ units: r.units, owners: [a, b] });
  }
  return out;
}

async function postEpoch(row: EpochRow): Promise<void> {
  const id = row.id;
  const root = (row.root ?? ZERO_ROOT) as Hex;
  const reserved = BigInt(row.reserved ?? "0");
  try {
    const pot = await readPotAtClose(BigInt(id));
    if (reserved > pot) throw new Error(`reserved ${reserved} exceeds the on-chain pot ${pot}; refusing to post`);
    const res = await postRoot(BigInt(id), root, reserved, (hash) => {
      getDb().prepare("UPDATE epochs SET pending_tx = ? WHERE id = ?").run(hash, id);
    });
    if (!res.success) {
      getDb().prepare("UPDATE epochs SET post_error = ? WHERE id = ?").run(`transaction ${res.hash} reverted`, id);
      console.error(`[sparecycle] epoch ${id}: root post reverted (${res.hash})`);
      return;
    }
    tx((db) => {
      db.prepare(
        "UPDATE epochs SET status = 'posted', posted_tx = ?, pending_tx = NULL, post_error = NULL, ended_at = ? WHERE id = ?",
      ).run(res.hash, Number(res.endedAt ?? BigInt(nowSec())), id);
    });
    console.log(`[sparecycle] epoch ${id}: root ${root} posted, reserved ${reserved} (tx ${res.hash})`);
    g.__sparecycleEpochSync = undefined;
    await ensureEpoch(true).catch(() => undefined); // pick up the next epoch's on-chain start time
  } catch (e) {
    const msg = describeChainError(e);
    getDb().prepare("UPDATE epochs SET post_error = ? WHERE id = ?").run(msg.slice(0, 500), id);
    console.error(`[sparecycle] epoch ${id}: root not posted: ${msg}`);
  }
}

/** Chain reads during a close: RPC failures become 503 chain-unavailable (nothing is written before them). */
async function chainRead<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new ApiError(503, "chain-unavailable", `${what}: ${describeChainError(e)}`);
  }
}

async function closeEpochUnlocked(): Promise<CloseSummary> {
  const mode = clockMode();
  const open = await ensureEpoch(true);

  if (mode === "contract") {
    const chainCur = Number(await chainRead("currentEpoch()", readCurrentEpoch));
    const waiting = getDb()
      .prepare("SELECT * FROM epochs WHERE status = 'closed-unposted' AND clock = 'contract' AND id = ?")
      .get(chainCur) as EpochRow | undefined;
    if (waiting) {
      if (!schedulerAccount()) {
        throw new ApiError(
          409,
          "previous-epoch-unposted",
          `epoch ${waiting.id} is closed but its root is not posted and SCHEDULER_SIGNER_KEY is not set`,
        );
      }
      await postEpoch(waiting);
      return summary("retried-post", waiting.id, null);
    }
    if (open.id !== chainCur) {
      throw new ApiError(409, "epoch-out-of-sync", `scheduler epoch ${open.id} != on-chain epoch ${chainCur}`);
    }
    if (!(await chainRead("canClose()", () => readCanClose(BigInt(open.id))))) {
      throw new ApiError(409, "epoch-not-over", `epoch ${open.id} can't close yet (on-chain end not reached)`);
    }
  } else if (nowSec() < open.started_at + open.length) {
    throw new ApiError(409, "epoch-not-over", `epoch ${open.id} ends at ${open.started_at + open.length}`);
  }

  // Paid jobs: charge what is due into this epoch's pot first, so the pot read below includes it. A failed charge
  // never blocks the close; the jobs stay pending and are charged at the next close.
  if (mode === "contract" && paymentsAddress()) {
    console.log(`[sparecycle] epoch ${open.id} job payments: ${await chargeOpenEpoch(open.id)}`);
  }

  // Pot: what the contract will hold for this epoch at close. Without a contract there is no pot (0).
  const pot = mode === "contract" ? await chainRead("pot", () => readPotAtClose(BigInt(open.id))) : 0n;
  const capPerUnit = serverEnv.payoutCapPerUnit();

  tx((db) => {
    const still = getEpochRow(open.id);
    if (!still || still.status !== "open") throw new ApiError(409, "already-closed", `epoch ${open.id} is already closed`);
    const jobs = agreedJobsOf(open.id);
    const paidTest = serverEnv.paidTestOwners();
    const exclude = new Set([...serverEnv.projectOwners()].filter((o) => !paidTest.has(o)));
    const alloc = allocate({ pot, capPerUnit, jobs, exclude });
    const { tree, leaves } = buildEpochTree(BigInt(open.id), alloc.entries);
    if (alloc.reserved > pot) throw new Error("allocation exceeds pot"); // never post more than the pot
    const now = nowSec();
    db.prepare(
      `UPDATE epochs SET status = 'closed-unposted', ended_at = ?, closed_at = ?, root = ?, reserved = ?, pot_at_close = ?,
         leaves = ?, total_units = ?, agreed_jobs = ?, post_error = ? WHERE id = ?`,
    ).run(
      mode === "contract" ? now : open.started_at + open.length,
      now,
      tree.root,
      alloc.reserved.toString(),
      mode === "contract" ? pot.toString() : null,
      leaves.length,
      alloc.totalUnits,
      jobs.length,
      mode === "contract" ? (schedulerAccount() ? null : "SCHEDULER_SIGNER_KEY not set: root not posted") : null,
      open.id,
    );
    const ins = db.prepare("INSERT INTO payouts (epoch_id, account, amount, leaf, weight) VALUES (?, ?, ?, ?, ?)");
    for (const l of leaves) {
      const w = alloc.entries.find((e) => e.account === l.account)!.weight;
      ins.run(open.id, l.account, l.amount.toString(), l.leaf, w);
    }
    db.prepare("INSERT INTO epochs (id, clock, status, started_at, length, provisional) VALUES (?, ?, 'open', ?, ?, ?)").run(
      open.id + 1,
      mode,
      now,
      mode === "contract" ? open.length : serverEnv.localEpochLength(),
      mode === "contract" ? 1 : 0,
    );
  });
  const closed = getEpochRow(open.id)!;
  console.log(
    `[sparecycle] epoch ${open.id} closed: ${closed.agreed_jobs} agreed jobs, ${closed.leaves} leaves, reserved ${closed.reserved}` +
      (mode === "contract" ? ` of pot ${closed.pot_at_close}` : ` (${LOCAL_CLOCK_NOTE})`),
  );

  if (mode === "contract" && schedulerAccount()) await postEpoch(closed);
  const note =
    mode === "contract"
      ? schedulerAccount()
        ? null
        : "SCHEDULER_SIGNER_KEY not set: the tree is published but the root is not posted"
      : `${LOCAL_CLOCK_NOTE}: the tree is published, nothing is posted on-chain and there is no pot`;
  return summary("closed", open.id, note);
}

/** Closes the open epoch (serialized per process). Throws ApiError 409 when it can't close yet. */
export function closeEpoch(): Promise<CloseSummary> {
  const run = (g.__sparecycleCloseLock ?? Promise.resolve()).catch(() => undefined).then(() => closeEpochUnlocked());
  g.__sparecycleCloseLock = run;
  return run;
}

/** Autoclose tick: closes (or retries a post) when the chain / clock allows it; never throws. */
export async function autocloseTick(): Promise<void> {
  try {
    const mode = clockMode();
    const open = await ensureEpoch(true);
    let due: boolean;
    if (mode === "contract") {
      const chainCur = Number(await readCurrentEpoch());
      const waiting = getEpochRow(chainCur);
      due =
        (waiting?.status === "closed-unposted" && schedulerAccount() !== null) ||
        (open.id === chainCur && (await readCanClose(BigInt(open.id))));
    } else {
      due = nowSec() >= open.started_at + open.length;
    }
    if (!due) return;
    const s = await closeEpoch();
    console.log(`[sparecycle] autoclose: epoch ${s.epoch.id} ${s.action} -> ${s.epoch.status}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return;
    console.error(`[sparecycle] autoclose: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Public JSON of an epoch row (bigints as decimal strings, timestamps in unix seconds). */
export function epochJson(row: EpochRow) {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.status === "open" ? null : row.ended_at,
    root: row.status === "open" ? null : row.root,
    reserved: row.reserved ?? "0",
    potAtClose: row.pot_at_close,
    leaves: row.leaves,
    postedTx: row.posted_tx,
    status: row.status,
    clock: row.clock,
    agreedJobs: row.agreed_jobs,
    postError: row.post_error,
  };
}

