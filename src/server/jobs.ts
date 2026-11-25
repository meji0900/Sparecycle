// Job submission (MVP: SD 1.5 + Qwen2.5-1.5B only), per-IP rate limit, public job views.
// Prompts are stored privately and never returned by any API; the public views carry `promptHash`.
import {
  needs,
  parseJobRequest,
  promptHashOf,
  sha256Hex,
  SpecError,
  workUnits,
  type JobSpec,
  type JobStatus,
} from "@/lib/protocol";
import type { Hex } from "viem";
import { ANONYMOUS, newReadSecret, secretMatches, type Viewer } from "./auth";
import { getDb, nowSec, randomHex, tx } from "./db";
import { POLICY, serverEnv } from "./env";
import { AUTH_REQUIRED, ApiError } from "./http";
import { ipSalt, limitBucket, takeHourly } from "./limits";
import { poolNudge } from "./gpu-pool";
import { jobPriceWei } from "@/lib/job-payment";
import { heldFor, priceWeiPerUnit, teamWallets, verifyPayment, type Payment } from "./payments";

type JobRow = {
  id: string;
  kind: "image" | "text";
  model: string;
  spec: string;
  prompt_hash: string;
  work_units: number;
  status: JobStatus;
  dev: number;
  created_at: number;
  settled_at: number | null;
  epoch_id: number | null;
  output_type: string | null;
  note: string | null;
  epoch_status: string | null;
  epoch_reserved: string | null;
  payer: string | null;
  price_wei: string | null;
  charge_status: string | null;
  read_secret_hash: string | null;
};

/** Paid jobs per payer wallet per hour (queue protection; payment itself is the anti-abuse for paid jobs). */
const PAID_JOBS_PER_HOUR = 120;

/** Marks jobs that never reached a verdict within the TTL as expired (unpaid) and cancels their tasks. */
export function expireStaleJobs() {
  const cutoff = nowSec() - POLICY.jobTtlSeconds;
  tx((db) => {
    const stale = db
      .prepare("SELECT id FROM jobs WHERE status IN ('queued','running','checking') AND created_at < ?")
      .all(cutoff) as { id: string }[];
    if (!stale.length) return;
    const now = nowSec();
    const upJob = db.prepare("UPDATE jobs SET status = 'expired', settled_at = ?, note = 'no verdict within the job TTL' WHERE id = ?");
    const upTasks = db.prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id = ? AND status IN ('open','leased')");
    // An expired job may hold one node's result: drop that copy of the output too (hash and fingerprint stay).
    const dropOutputs = db.prepare("UPDATE results SET output = NULL WHERE job_id = ?");
    for (const { id } of stale) {
      upJob.run(now, id);
      upTasks.run(id);
      dropOutputs.run(id);
    }
  });
}

/**
 * POST /api/v1/jobs. A free job is the request itself (JOB_RATE_LIMIT per IP per hour). A paid job is
 * { request, payment }: the payer's signature over the request at the quoted price, checked against their
 * balance in the payments contract (see ./payments).
 * Every job gets a read secret (`readSecret`, returned only here): with OUTPUT_AUTH=enforce the output is served to
 * `Authorization: Bearer <readSecret>` or to a session of the paying wallet (see ./auth).
 */
export async function submitJob(
  body: unknown,
  ip: string,
): Promise<{ id: Hex; status: "queued"; priceWei: string | null; readSecret: string }> {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const paidRequest = "payment" in b;
  const rawRequest = paidRequest ? b.request : body;
  let req;
  try {
    req = parseJobRequest(rawRequest);
  } catch (e) {
    if (e instanceof SpecError) throw new ApiError(400, "invalid-job", e.message, { field: e.field });
    throw e;
  }
  let payment: (Payment & { balance: bigint; withdrawAmount: bigint }) | null = null;
  if (paidRequest) payment = await verifyPayment(rawRequest, b.payment, jobPriceWei(req, priceWeiPerUnit()));
  const limit = payment ? PAID_JOBS_PER_HOUR : serverEnv.jobRateLimit();
  const bucket = payment ? sha256Hex(`${ipSalt()}|payer|${payment.payer.toLowerCase()}`) : sha256Hex(`${ipSalt()}|${ip}`);
  const now = nowSec();
  const window = Math.floor(now / 3600) * 3600;

  const queued = tx((db) => {
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").run(window - 3600);
    const used = (db.prepare("SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?").get(bucket, window) as
      | { count: number }
      | undefined)?.count ?? 0;
    if (used >= limit) {
      throw new ApiError(429, "rate-limited", `at most ${limit} ${payment ? "paid jobs per hour per wallet" : "free jobs per hour from one address"}`, {
        retryAfter: window + 3600 - now,
      });
    }
    const open = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','checking')").get() as { n: number }).n;
    if (open >= POLICY.maxOpenJobs) {
      throw new ApiError(503, "queue-full", "the job queue is full; try again later");
    }
    if (payment) {
      // Re-checked inside the transaction so two concurrent submissions can't overspend the balance.
      const locked = heldFor(payment.payer) + payment.withdrawAmount + payment.priceWei;
      if (locked > payment.balance) {
        throw new ApiError(402, "insufficient-balance", "available balance is below the price of this job", {
          available: (payment.balance > locked - payment.priceWei ? payment.balance - (locked - payment.priceWei) : 0n).toString(),
          priceWei: payment.priceWei.toString(),
        });
      }
    }
    const id = randomHex(32);
    const read = newReadSecret();
    let spec: JobSpec;
    if (req.kind === "image") {
      const seed = req.params.seed ?? globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
      spec = { kind: "image", params: { ...req.params, seed } };
    } else {
      spec = req;
    }
    db.prepare(
      `INSERT INTO jobs (id, kind, model, spec, prompt_hash, work_units, status, ip_hash, created_at, payer, price_wei, payment_sig, charge_status,
         read_secret_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      spec.kind,
      needs(spec).model,
      JSON.stringify(spec),
      promptHashOf(id, spec.params.prompt),
      workUnits(spec),
      bucket,
      now,
      payment?.payer ?? null,
      payment?.priceWei.toString() ?? null,
      payment?.signature ?? null,
      payment ? "pending" : null,
      read.hash,
    );
    const ins = db.prepare("INSERT INTO tasks (id, job_id, slot, status) VALUES (?, ?, ?, 'open')");
    ins.run(randomHex(16), id, 0);
    ins.run(randomHex(16), id, 1);
    db.prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1`,
    ).run(bucket, window);
    return { id, status: "queued" as const, priceWei: payment?.priceWei.toString() ?? null, readSecret: read.secret };
  });
  poolNudge(); // bootstrap GPU pool: start it if no two owners online can take this job
  return queued;
}

const SELECT_JOB = `SELECT j.id, j.kind, j.model, j.spec, j.prompt_hash, j.work_units, j.status, j.dev, j.created_at, j.settled_at,
  j.epoch_id, j.output_type, j.note, e.status AS epoch_status, e.reserved AS epoch_reserved, j.payer, j.price_wei, j.charge_status,
  j.read_secret_hash
  FROM jobs j LEFT JOIN epochs e ON e.id = j.epoch_id`;

function flags(r: JobRow) {
  const eligible = r.status === "agreed" && (!r.dev || serverEnv.allowDevRunner());
  const paid = eligible && r.epoch_status === "posted" && BigInt(r.epoch_reserved ?? "0") > 0n;
  return { eligible, paid };
}

function publicJob(r: JobRow) {
  return {
    id: r.id,
    model: r.model,
    kind: r.kind,
    status: r.status,
    createdAt: r.created_at,
    settledAt: r.settled_at,
    promptHash: r.prompt_hash,
    workUnits: r.work_units,
    epochId: r.epoch_id,
    ...flags(r),
    // Who paid: "free" (trial, shares the pot like any job), "paid" (a customer's balance) or "team" (the team's own test job).
    payment: !r.payer ? "free" : teamWallets().has(r.payer.toLowerCase()) ? "team" : "paid",
    priceWei: r.price_wei,
    chargeStatus: r.charge_status,
  };
}

/** GET /api/v1/jobs */
export function listJobs(limit: number) {
  expireStaleJobs();
  const rows = getDb().prepare(`${SELECT_JOB} ORDER BY j.created_at DESC, j.id LIMIT ?`).all(limit) as JobRow[];
  return { jobs: rows.map(publicJob) };
}

const isJobId = (id: string) => /^0x[0-9a-f]{64}$/.test(id);

function getJobRow(id: string): JobRow {
  if (!isJobId(id)) throw new ApiError(400, "invalid-job-id", "job id must be 0x + 64 lowercase hex characters");
  const row = getDb().prepare(`${SELECT_JOB} WHERE j.id = ?`).get(id) as JobRow | undefined;
  if (!row) throw new ApiError(404, "unknown-job", "no job with this id");
  return row;
}

/** Path of the gated output of a job. */
export const resultPath = (id: string) => `/api/v1/jobs/${id}/result`;

/**
 * May `viewer` read this job's output? "secret": the job's read secret; "payer": a session of the wallet that paid
 * (paid and team jobs; a free job has no payer). Jobs created before read secrets existed match no secret.
 */
function accessOf(job: { payer: string | null; read_secret_hash: string | null }, viewer: Viewer): "secret" | "payer" | null {
  if (secretMatches(viewer.secret, job.read_secret_hash)) return "secret";
  if (viewer.address && job.payer && viewer.address.toLowerCase() === job.payer.toLowerCase()) return "payer";
  return null;
}

const hasCredentials = (viewer: Viewer) => viewer.address !== null || viewer.secret !== null;

/**
 * GET /api/v1/jobs/:id — status, timestamps, non-private parameters, `outputAvailable`, and `output` (the gated
 * result URL) when agreed and, with OUTPUT_AUTH=enforce, only for a viewer who may read it.
 */
export function jobDetail(id: string, viewer: Viewer = ANONYMOUS, mode = serverEnv.outputAuth()) {
  expireStaleJobs();
  const r = getJobRow(id);
  const available = r.status === "agreed" && !!r.output_type;
  const spec = JSON.parse(r.spec) as JobSpec;
  const params =
    spec.kind === "image"
      ? { width: spec.params.width, height: spec.params.height, steps: spec.params.steps, guidance: spec.params.guidance, seed: spec.params.seed }
      : { maxTokens: spec.params.maxTokens };
  return {
    ...publicJob(r),
    params,
    note: r.note,
    output: available && (mode === "off" || accessOf(r, viewer) !== null) ? resultPath(r.id) : null,
    outputAvailable: available,
    outputType: r.status === "agreed" ? r.output_type : null,
  };
}

/**
 * GET /api/v1/jobs/:id/result (and the retired /output while OUTPUT_AUTH=off). With "enforce":
 *   no credentials -> 401 auth-required (empty body); unknown job -> 404; credentials that can't read this job
 *   -> 403; not agreed -> 409 no-output; else the output.
 * Reads are rate limited per viewer: per job for its read secret, per wallet for a payer session, else per IP.
 */
export function jobOutput(id: string, viewer: Viewer, opts: { ip: string; mode?: "off" | "enforce" }): { body: Uint8Array; type: string } {
  const mode = opts.mode ?? serverEnv.outputAuth();
  if (!isJobId(id)) throw new ApiError(400, "invalid-job-id", "job id must be 0x + 64 lowercase hex characters");
  const row = getDb().prepare("SELECT status, payer, read_secret_hash, output, output_type FROM jobs WHERE id = ?").get(id) as
    | { status: JobStatus; payer: string | null; read_secret_hash: string | null; output: Uint8Array | null; output_type: string | null }
    | undefined;
  const access = row ? accessOf(row, viewer) : null;
  const key = access === "secret" ? ["job", id] : access === "payer" && viewer.address ? ["wallet", viewer.address.toLowerCase()] : ["ip", opts.ip];
  takeHourly(limitBucket("output", ...key), serverEnv.outputRateLimit(), "output reads");
  if (mode === "enforce" && !hasCredentials(viewer)) {
    throw new ApiError(401, AUTH_REQUIRED, "send the job's read secret (Authorization: Bearer) or sign in with the paying wallet");
  }
  if (!row) throw new ApiError(404, "unknown-job", "no job with this id");
  if (mode === "enforce" && !access) throw new ApiError(403, "forbidden", "these credentials can't read this job's output");
  if (row.status !== "agreed") throw new ApiError(409, "no-output", `job is ${row.status}; output is served only for agreed jobs`);
  if (!row.output || !row.output_type) throw new ApiError(404, "no-output", "output not stored");
  return { body: row.output, type: row.output_type };
}

/** Counters for /status. */
export function jobCounts(epochId: number | null) {
  const db = getDb();
  const count = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  return {
    queued: count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'"),
    running: count("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('running','checking')"),
    agreedThisEpoch: epochId === null ? 0 : count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'agreed' AND epoch_id = ?", epochId),
    disagreedThisEpoch:
      epochId === null ? 0 : count("SELECT COUNT(*) AS n FROM jobs WHERE status = 'disagreed' AND epoch_id = ?", epochId),
  };
}
