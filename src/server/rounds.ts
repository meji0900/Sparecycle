// Re-check rounds (feature brief #9, decisions D16 / D17): before a paid or team job is given up uncharged, it runs
// again on a different pair of nodes, at most MAX_ROUNDS pairs in all.
//
//   - Mismatch: when a round's two results do not match (submitResult in ./results), the job goes back to `queued` in
//     the next round with two new tasks. The round's tasks and results stay for audit; only the final round's verdict
//     counts, and only its two results are paid (agreedJobsOf in ./epochs, node stats in ./nodes).
//   - Not picked up: a round whose first lease is ROUND_MAX_SECONDS (PICKUP_TIMEOUT + one task lease = 2400 s) old
//     without a verdict is abandoned and the next round starts. A round that was never leased (no compatible pair
//     online) waits in the queue as before and uses up nothing. The 10-minute lease requeue inside a round stays.
//   - Exclusion: a new round never goes to a node whose node key, owner wallet or GPU UUID held a lease or sent a
//     result in an earlier round of the same job (tryLease in ./nodes). Every other assignment rule still applies.
//   - Limits: a new round starts only when round + 1 < MAX_ROUNDS and at least ROUND_MAX_SECONDS of the job TTL are
//     left, so every round fits inside jobTtlSeconds (9.4: the TTL is never extended and expireStaleJobs stays the hard
//     stop). Free trial jobs get one round (D17); a `rejected` verdict is never retried; an abandoned round that cannot
//     be followed by another simply keeps running until it gets a verdict or the job expires.
//   - Each round that ends without agreement is logged per node in job_rounds (disagreed | abandoned), as input for the
//     GPU challenge / suspension logic later. Nothing changes a node's eligibility from it yet.
// The hold on a paid job's price stays in place through every round; nothing is charged until a final `agreed`.
import type { DatabaseSync } from "node:sqlite";
import { MAX_ROUNDS, maxRoundsFor, PICKUP_TIMEOUT_SECONDS } from "@/lib/rounds";
import { randomHex } from "./db";
import { POLICY } from "./env";

export { MAX_ROUNDS, PICKUP_TIMEOUT_SECONDS };

/** The longest an active round can take: PICKUP_TIMEOUT + one task lease (1800 + 600 = 2400 s). */
export const ROUND_MAX_SECONDS = PICKUP_TIMEOUT_SECONDS + POLICY.taskLeaseSeconds;

export type RoundJob = { id: string; payer: string | null; round: number; created_at: number };
export type RoundOutcome = "disagreed" | "abandoned";

/**
 * May this job start another round at `now`? Only a paid or team job (D17) with rounds left, and only while a full
 * round (ROUND_MAX_SECONDS) still fits before created_at + jobTtlSeconds.
 */
export function canStartNextRound(job: RoundJob, now: number): boolean {
  return job.round + 1 < maxRoundsFor(job.payer) && job.created_at + POLICY.jobTtlSeconds - now >= ROUND_MAX_SECONDS;
}

/** Inserts the two open tasks of `round` (slots 2 x round and 2 x round + 1). */
export function insertRoundTasks(db: DatabaseSync, jobId: string, round: number) {
  const ins = db.prepare("INSERT INTO tasks (id, job_id, slot, status, round) VALUES (?, ?, ?, 'open', ?)");
  ins.run(randomHex(16), jobId, 2 * round, round);
  ins.run(randomHex(16), jobId, 2 * round + 1, round);
}

/**
 * SQL (for a NOT EXISTS) matching any lease or result of an earlier round of job `job` (current round `round`) whose
 * node key, owner wallet or GPU UUID equals the given node's. Arguments are SQL expressions or named parameters.
 */
export function earlierRoundSql(job: string, round: string, node: { key: string; owner: string; gpu: string }): string {
  const match = (x: string) =>
    `${x}.job_id = ${job} AND ${x}.round < ${round} AND (${x}.node_key = ${node.key} OR lower(${x}.owner) = lower(${node.owner}) OR ${x}.gpu_uuid = ${node.gpu})`;
  return `SELECT 1 FROM job_leases xl WHERE ${match("xl")} UNION ALL SELECT 1 FROM results xr WHERE ${match("xr")}`;
}

/**
 * Logs the nodes of a round that ended without agreement: for `disagreed` the two nodes whose results did not match,
 * for `abandoned` every node that held a lease in the round (finished or not).
 */
function logRound(db: DatabaseSync, jobId: string, round: number, outcome: RoundOutcome, now: number) {
  const fromResults = "SELECT job_id, round, node_key, owner, gpu_uuid, ?, ? FROM results WHERE job_id = ? AND round = ?";
  const fromLeases = "SELECT job_id, round, node_key, owner, gpu_uuid, ?, ? FROM job_leases WHERE job_id = ? AND round = ?";
  const insert = "INSERT OR IGNORE INTO job_rounds (job_id, round, node_key, owner, gpu_uuid, outcome, at)";
  if (outcome === "disagreed") db.prepare(`${insert} ${fromResults}`).run(outcome, now, jobId, round);
  else db.prepare(`${insert} ${fromResults} UNION ALL ${fromLeases}`).run(outcome, now, jobId, round, outcome, now, jobId, round);
}

/** Logs a disagreeing round per node (every one: also a final round, and a free job's single round). */
export const logDisagreedRound = (db: DatabaseSync, jobId: string, round: number, now: number) => logRound(db, jobId, round, "disagreed", now);

/**
 * Ends the job's current round and queues the next one (the caller checked canStartNextRound): open and leased tasks of
 * the round are cancelled, the per-node output copies of the round are dropped (hashes and fingerprints stay), two new
 * tasks are inserted and the job goes back to `queued` with no round start yet. Returns the new round.
 */
export function startNextRound(db: DatabaseSync, job: RoundJob, outcome: RoundOutcome, now: number): number {
  const next = job.round + 1;
  const max = maxRoundsFor(job.payer);
  if (outcome === "abandoned") logRound(db, job.id, job.round, "abandoned", now);
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id = ? AND round = ? AND status IN ('open','leased')").run(job.id, job.round);
  db.prepare("UPDATE results SET output = NULL WHERE job_id = ? AND round = ?").run(job.id, job.round);
  insertRoundTasks(db, job.id, next);
  const why =
    outcome === "disagreed"
      ? `the results of pair ${job.round + 1} did not match`
      : `pair ${job.round + 1} gave no verdict within ${Math.round(ROUND_MAX_SECONDS / 60)} minutes of its first lease`;
  db.prepare("UPDATE jobs SET status = 'queued', round = ?, round_started_at = NULL, note = ? WHERE id = ?").run(
    next,
    `${why}; re-checking on another pair (round ${next + 1} of ${max})`,
    job.id,
  );
  console.log(`[sparecycle] job ${job.id.slice(0, 10)}: round ${job.round} ${outcome}, round ${next} queued on another pair`);
  return next;
}

/**
 * Abandons every round that has had a first lease for ROUND_MAX_SECONDS without a verdict, when the job may start
 * another round; the next round then goes to nodes that took no part in this one. Runs inside expireStaleJobs.
 */
export function abandonStuckRounds(db: DatabaseSync, now: number): number {
  const stuck = db
    .prepare(
      `SELECT id, payer, round, created_at FROM jobs
       WHERE status IN ('queued','running','checking') AND round_started_at IS NOT NULL AND round_started_at <= ?
         AND payer IS NOT NULL AND round < ?`,
    )
    .all(now - ROUND_MAX_SECONDS, MAX_ROUNDS - 1) as RoundJob[];
  let n = 0;
  for (const job of stuck) {
    if (!canStartNextRound(job, now)) continue; // nothing to move to: the round keeps running until a verdict or the TTL
    startNextRound(db, job, "abandoned", now);
    n++;
  }
  return n;
}
