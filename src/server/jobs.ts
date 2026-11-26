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
import type { DatabaseSync } from "node:sqlite";
import type { Address, Hex } from "viem";
import { assertKeyCanSpend, holdKeySpend, KEY_JOBS_GET_READ_SECRET, KEY_READS_WALLET_JOBS, releaseKeyHolds } from "./apikeys";
import { ANONYMOUS, newReadSecret, secretMatches, type KeyViewer, type Viewer } from "./auth";
import { getDb, nowSec, randomHex, tx } from "./db";
import { POLICY, serverEnv } from "./env";
import { AUTH_REQUIRED, ApiError } from "./http";
import { ipSalt, limitBucket, takeHourly } from "./limits";
import { poolNudge, poolStartInfo } from "./gpu-pool";
import { assertPairReachable } from "./capacity";
import { abandonStuckRounds, insertRoundTasks } from "./rounds";
import { maxRoundsFor } from "@/lib/rounds";
import { isLowBalance, jobPriceWei } from "@/lib/job-payment";
import { heldFor, paymentsAddress, priceWeiPerUnit, readAccount, teamWallets, verifyPayment, type Payment } from "./payments";

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
  /** Internal only (key-paid job views and invoices); never in publicJob (D7). */
  price_wei: string | null;
  charge_status: string | null;
  read_secret_hash: string | null;
  api_key_id: string | null;
  /** Re-check round (0 = the first pair; see ./rounds). */
  round: number;
};

/** Paid jobs per payer wallet per hour (queue protection; payment itself is the anti-abuse for paid jobs). */
export const PAID_JOBS_PER_HOUR = 120;
/** Job status / result reads per API key per hour (OpenAI-compatible polls and MCP tools). */
export const KEY_READS_PER_HOUR = 3_600;
/** jobs.charge_status of a job paid with x402 into the escrow (src/server/x402.ts): never charged from a balance. */
export const X402_CHARGE_STATUS = "x402";

/**
 * Marks jobs that never reached a verdict within the TTL as expired (unpaid) and cancels their tasks (the hard stop,
 * whatever round a job is in), then abandons re-check rounds that got no verdict in time (./rounds).
 */
export function expireStaleJobs() {
  const now = nowSec();
  const cutoff = now - POLICY.jobTtlSeconds;
  tx((db) => {
    const stale = db
      .prepare("SELECT id FROM jobs WHERE status IN ('queued','running','checking') AND created_at < ?")
      .all(cutoff) as { id: string }[];
    if (stale.length) expire(db, stale, now);
    abandonStuckRounds(db, now);
  });
}

function expire(db: DatabaseSync, stale: { id: string }[], now: number) {
  const upJob = db.prepare("UPDATE jobs SET status = 'expired', settled_at = ?, note = 'no verdict within the job TTL' WHERE id = ?");
  const upTasks = db.prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id = ? AND status IN ('open','leased')");
  // An expired job may hold one node's result: drop that copy of the output too (hash and fingerprint stay).
  const dropOutputs = db.prepare("UPDATE results SET output = NULL WHERE job_id = ?");
  for (const { id } of stale) {
    upJob.run(now, id);
    upTasks.run(id);
    dropOutputs.run(id);
  }
  releaseKeyHolds(); // an expired key-paid job gives its price back to the key's daily counter
}

export type SubmitOptions = {
  /** Pay with this API key (`Authorization: Bearer sck_…`) instead of a per-job payment block (see ./apikeys). */
  key?: KeyViewer | null;
  /** Runs inside the insert transaction with the new job id (e.g. to record an Idempotency-Key with the job). */
  onInsert?: (db: DatabaseSync, jobId: Hex) => void;
  /**
   * Paid with x402: the escrow already holds the payment (src/server/x402.ts). The job gets this reserved id, payer =
   * the x402 payer, no price in wei and charge_status 'x402'; the payer's per-hour limit applies like a paid job's.
   */
  x402?: { payer: Address; jobId: Hex } | null;
};

type Payer = { payer: Address; priceWei: bigint; balance: bigint; withdrawAmount: bigint; signature: Hex | null };

/**
 * POST /api/v1/jobs. A free job is the request itself (JOB_RATE_LIMIT per IP per hour). A paid job is
 * { request, payment }: the payer's signature over the request at the quoted price, checked against their
 * balance in the payments contract (see ./payments). A job paid with an API key (`opts.key`) is the request itself:
 * no per-job signature, the same available-balance checks, the key's UTC-day cap, `payer` = the key's wallet.
 * Every job except key-paid ones gets a read secret (`readSecret`, returned only here): with OUTPUT_AUTH=enforce the
 * output is served to `Authorization: Bearer <readSecret>` or to a session of the paying wallet (see ./auth). A
 * key-paid job is read with its key (A4).
 * A paid job's answer (wallet- or key-paid) also carries `available` (wei the payer can still spend on new jobs, this
 * job's price already held) and `lowBalance` (fewer than LOW_CREDIT_JOBS jobs at this price left), like the dapp's
 * low-credit banner.
 * Capacity guard (./capacity, N24): when no pair of machines with different owners can take the model, neither online nor
 * through the GPU pool, every kind of job (free, wallet-paid, key-paid) is refused with 503 no-node-pair before anything is
 * held, counted against a limit or queued.
 */
export async function submitJob(
  body: unknown,
  ip: string,
  opts: SubmitOptions = {},
): Promise<{ id: Hex; status: "queued"; priceWei: string | null; readSecret?: string; available?: string; lowBalance?: boolean }> {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const key = opts.key ?? null;
  const x402 = opts.x402 ?? null;
  if (x402 && (key || "payment" in b)) {
    throw new ApiError(400, "invalid-job", "an x402 job is sent without a payment block or API key", { field: "payment" });
  }
  if (key && "payment" in b) {
    throw new ApiError(400, "invalid-job", "a job paid with an API key is sent without a payment block", { field: "payment" });
  }
  const paidRequest = !key && "payment" in b;
  const rawRequest = paidRequest ? b.request : body;
  let req;
  try {
    req = parseJobRequest(rawRequest);
  } catch (e) {
    if (e instanceof SpecError) throw new ApiError(400, "invalid-job", e.message, { field: e.field });
    throw e;
  }
  // Before the payment check and the transaction: a refused job holds nothing and uses up no rate limit or key cap.
  assertPairReachable(needs(req).model, poolStartInfo());
  let paid: Payer | null = null;
  if (paidRequest) {
    const p: Payment & { balance: bigint; withdrawAmount: bigint } = await verifyPayment(rawRequest, b.payment, jobPriceWei(req, priceWeiPerUnit()));
    paid = { payer: p.payer, priceWei: p.priceWei, balance: p.balance, withdrawAmount: p.withdrawAmount, signature: p.signature };
  } else if (key) {
    if (!paymentsAddress()) throw new ApiError(503, "payments-off", "paid jobs are not enabled on this scheduler");
    const price = jobPriceWei(req, priceWeiPerUnit());
    assertKeyCanSpend(key, price); // cheap: status and daily cap before the chain read
    const acct = await readAccount(key.owner);
    if (acct.available < price) {
      throw new ApiError(402, "insufficient-balance", `available balance ${acct.available} wei is below the price ${price} wei`, {
        available: acct.available.toString(),
        priceWei: price.toString(),
      });
    }
    paid = { payer: key.owner, priceWei: price, balance: acct.balance, withdrawAmount: acct.withdrawAmount, signature: null };
  }
  const { limit, bucket } = queueBucket(paid?.payer ?? x402?.payer ?? null, ip);
  const now = nowSec();
  const window = Math.floor(now / 3600) * 3600;

  const queued = tx((db) => {
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").run(window - 3600);
    const used = (db.prepare("SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?").get(bucket, window) as
      | { count: number }
      | undefined)?.count ?? 0;
    if (used >= limit) {
      throw new ApiError(429, "rate-limited", `at most ${limit} ${paid || x402 ? "paid jobs per hour per wallet" : "free jobs per hour from one address"}`, {
        retryAfter: window + 3600 - now,
      });
    }
    const open = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','checking')").get() as { n: number }).n;
    if (open >= POLICY.maxOpenJobs) {
      throw new ApiError(503, "queue-full", "the job queue is full; try again later");
    }
    let availableAfter: bigint | null = null;
    if (paid) {
      // Re-checked inside the transaction so two concurrent submissions can't overspend the balance.
      const locked = heldFor(paid.payer) + paid.withdrawAmount + paid.priceWei;
      if (locked > paid.balance) {
        throw new ApiError(402, "insufficient-balance", "available balance is below the price of this job", {
          available: (paid.balance > locked - paid.priceWei ? paid.balance - (locked - paid.priceWei) : 0n).toString(),
          priceWei: paid.priceWei.toString(),
        });
      }
      availableAfter = paid.balance - locked;
    }
    // A key's daily cap, re-checked here (status too) and counted in the same transaction as the job.
    if (key && paid) holdKeySpend(key.keyId, paid.priceWei, now);
    const id = x402?.jobId ?? randomHex(32);
    const read = key && !KEY_JOBS_GET_READ_SECRET ? null : newReadSecret();
    let spec: JobSpec;
    if (req.kind === "image") {
      const seed = req.params.seed ?? globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
      spec = { kind: "image", params: { ...req.params, seed } };
    } else {
      spec = req;
    }
    db.prepare(
      `INSERT INTO jobs (id, kind, model, spec, prompt_hash, work_units, status, ip_hash, created_at, payer, price_wei, payment_sig, charge_status,
         read_secret_hash, api_key_id, api_key_held)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      spec.kind,
      needs(spec).model,
      JSON.stringify(spec),
      promptHashOf(id, spec.params.prompt),
      workUnits(spec),
      bucket,
      now,
      paid?.payer ?? x402?.payer ?? null,
      paid?.priceWei.toString() ?? null,
      paid?.signature ?? null,
      paid ? "pending" : x402 ? X402_CHARGE_STATUS : null,
      read?.hash ?? null,
      key?.keyId ?? null,
      key ? 1 : 0,
    );
    insertRoundTasks(db, id, 0);
    db.prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1`,
    ).run(bucket, window);
    opts.onInsert?.(db, id);
    return {
      id,
      status: "queued" as const,
      priceWei: paid?.priceWei.toString() ?? null,
      ...(read ? { readSecret: read.secret } : {}),
      ...(paid && availableAfter !== null
        ? { available: availableAfter.toString(), lowBalance: isLowBalance(availableAfter, paid.priceWei) }
        : {}),
    };
  });
  poolNudge(); // bootstrap GPU pool: start it if no two owners online can take this job
  return queued;
}

/** The hourly rate-limit bucket of a submission: per payer wallet for paid jobs, per IP for free ones. */
function queueBucket(payer: Address | null, ip: string) {
  return payer
    ? { limit: PAID_JOBS_PER_HOUR, bucket: sha256Hex(`${ipSalt()}|payer|${payer.toLowerCase()}`) }
    : { limit: serverEnv.jobRateLimit(), bucket: sha256Hex(`${ipSalt()}|${ip}`) };
}

/**
 * The checks submitJob makes inside its transaction, made read-only beforehand: the payer's paid jobs this hour and the
 * queue size. x402 runs it before it moves a payment into the escrow (src/server/x402.ts), so a payment is not taken
 * for a job that would be refused; submitJob checks again when it inserts.
 */
export function assertCanQueue(payer: Address) {
  const { limit, bucket } = queueBucket(payer, "");
  const now = nowSec();
  const window = Math.floor(now / 3600) * 3600;
  const db = getDb();
  const used = (db.prepare("SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?").get(bucket, window) as { count: number } | undefined)
    ?.count ?? 0;
  if (used >= limit) throw new ApiError(429, "rate-limited", `at most ${limit} paid jobs per hour per wallet`, { retryAfter: window + 3600 - now });
  const open = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','checking')").get() as { n: number }).n;
  if (open >= POLICY.maxOpenJobs) throw new ApiError(503, "queue-full", "the job queue is full; try again later");
}

const SELECT_JOB = `SELECT j.id, j.kind, j.model, j.spec, j.prompt_hash, j.work_units, j.status, j.dev, j.created_at, j.settled_at,
  j.epoch_id, j.output_type, j.note, e.status AS epoch_status, e.reserved AS epoch_reserved, j.payer, j.price_wei, j.charge_status,
  j.read_secret_hash, j.api_key_id, j.round
  FROM jobs j LEFT JOIN epochs e ON e.id = j.epoch_id`;

function flags(r: JobRow) {
  const eligible = r.status === "agreed" && (!r.dev || serverEnv.allowDevRunner());
  const paid = eligible && r.epoch_status === "posted" && BigInt(r.epoch_reserved ?? "0") > 0n;
  return { eligible, paid };
}

/**
 * The public view of a job (GET /api/v1/jobs and GET /api/v1/jobs/:id). No price, charge status, payer or output
 * hash (D7 in the feature brief): the payer reads those from the private invoice (./invoices).
 */
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
    payment: paymentKind(r.payer),
    // Re-check rounds (./rounds): 0 = the first pair; 1 or 2 = checking again on another pair after a mismatch or a pair
    // that never finished. maxRounds = 3 for paid and team jobs, 1 for free trial jobs. No node identities.
    round: r.round,
    maxRounds: maxRoundsFor(r.payer),
  };
}

/** Who paid for a job: "free" (trial), "paid" (a customer's balance) or "team" (the team's own test job). */
export const paymentKind = (payer: string | null): "free" | "paid" | "team" =>
  !payer ? "free" : teamWallets().has(payer.toLowerCase()) ? "team" : "paid";

/** GET /api/v1/jobs */
export function listJobs(limit: number) {
  expireStaleJobs();
  const rows = getDb().prepare(`${SELECT_JOB} ORDER BY j.created_at DESC, j.id LIMIT ?`).all(limit) as JobRow[];
  return { jobs: rows.map(publicJob) };
}

export const isJobId = (id: string) => /^0x[0-9a-f]{64}$/.test(id);

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
 * (paid and team jobs; a free job has no payer); "key": the API key that submitted the job (A5: only that key, not the
 * wallet's other keys or jobs). Jobs created before read secrets existed match no secret.
 */
export function accessOf(
  job: { payer: string | null; read_secret_hash: string | null; api_key_id?: string | null },
  viewer: Viewer,
): "secret" | "payer" | "key" | null {
  if (secretMatches(viewer.secret, job.read_secret_hash)) return "secret";
  if (viewer.address && job.payer && viewer.address.toLowerCase() === job.payer.toLowerCase()) return "payer";
  if (viewer.key && job.api_key_id && job.api_key_id === viewer.key.keyId) return "key";
  if (KEY_READS_WALLET_JOBS && viewer.key && job.payer && viewer.key.owner.toLowerCase() === job.payer.toLowerCase()) return "key";
  return null;
}

export const hasCredentials = (viewer: Viewer) => viewer.address !== null || viewer.secret !== null || !!viewer.key;

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
  const row = getDb().prepare("SELECT status, payer, read_secret_hash, api_key_id, output, output_type FROM jobs WHERE id = ?").get(id) as
    | {
        status: JobStatus;
        payer: string | null;
        read_secret_hash: string | null;
        api_key_id: string | null;
        output: Uint8Array | null;
        output_type: string | null;
      }
    | undefined;
  const access = row ? accessOf(row, viewer) : null;
  const key =
    access === "secret"
      ? ["job", id]
      : access === "payer" && viewer.address
        ? ["wallet", viewer.address.toLowerCase()]
        : access === "key" && viewer.key
          ? ["key", viewer.key.keyId]
          : ["ip", opts.ip];
  takeHourly(limitBucket("output", ...key), serverEnv.outputRateLimit(), "output reads");
  if (mode === "enforce" && !hasCredentials(viewer)) {
    throw new ApiError(401, AUTH_REQUIRED, "send the job's read secret or API key (Authorization: Bearer) or sign in with the paying wallet");
  }
  if (!row) throw new ApiError(404, "unknown-job", "no job with this id");
  if (mode === "enforce" && !access) throw new ApiError(403, "forbidden", "these credentials can't read this job's output");
  if (row.status !== "agreed") throw new ApiError(409, "no-output", `job is ${row.status}; output is served only for agreed jobs`);
  if (!row.output || !row.output_type) throw new ApiError(404, "no-output", "output not stored");
  return { body: row.output, type: row.output_type };
}

/** A job as the API key that submitted it sees it (OpenAI-compatible routes, MCP tools). Never the prompt. */
export type KeyJob = {
  id: Hex;
  kind: "image" | "text";
  model: string;
  status: JobStatus;
  createdAt: number;
  settledAt: number | null;
  workUnits: number;
  priceWei: string | null;
  chargeStatus: string | null;
  note: string | null;
  width: number | null;
  height: number | null;
  /** Only with `withOutput` and only for an agreed job. */
  output: { body: Uint8Array; type: string } | null;
};

/**
 * A key's own job (A5): 400 bad id, 404 unknown, 403 when the key did not submit it (another key or wallet, a free
 * job). Always enforced, whatever OUTPUT_AUTH says. Reads count per key (KEY_READS_PER_HOUR); reading the output also
 * counts against OUTPUT_RATE_LIMIT, per key.
 */
export function keyJob(id: string, key: KeyViewer, opts: { withOutput?: boolean } = {}): KeyJob {
  expireStaleJobs();
  if (!isJobId(id)) throw new ApiError(400, "invalid-job-id", "job id must be 0x + 64 lowercase hex characters");
  takeHourly(limitBucket("key-read", key.keyId), KEY_READS_PER_HOUR, "job reads per API key");
  const row = getDb().prepare(SELECT_VIEW).get(id) as ViewRow | undefined;
  if (!row) throw new ApiError(404, "unknown-job", "no job with this id");
  if (accessOf({ payer: row.payer, read_secret_hash: null, api_key_id: row.api_key_id }, { address: null, secret: null, key }) !== "key") {
    throw new ApiError(403, "forbidden", "this API key did not submit this job");
  }
  return viewOf(row, opts.withOutput ? ["key", key.keyId] : null);
}

/** Wrong read secrets per IP per hour on the x402 poll path (secretJob). */
export const WRONG_SECRETS_PER_IP_HOUR = 120;

/**
 * An x402 job read with its read secret on the OpenAI-compatible poll routes (src/server/openai.ts; x402 payers have
 * no API key): 400 bad id, 404 unknown, 403 when the job is not an x402 job or the secret is not its own. The secret is
 * checked first: a wrong one counts against the caller's IP (WRONG_SECRETS_PER_IP_HOUR), never against the job, so a
 * stranger who knows a public job id cannot use up its payer's reads. Right ones count per job (KEY_READS_PER_HOUR);
 * reading the output also counts against OUTPUT_RATE_LIMIT, per job.
 */
export function secretJob(id: string, secret: string, ip: string, opts: { withOutput?: boolean } = {}): KeyJob {
  if (!isJobId(id)) throw new ApiError(400, "invalid-job-id", "job id must be 0x + 64 lowercase hex characters");
  const row = getDb().prepare(SELECT_VIEW).get(id) as ViewRow | undefined;
  if (!row) throw new ApiError(404, "unknown-job", "no job with this id");
  if (row.charge_status !== X402_CHARGE_STATUS || !secretMatches(secret, row.read_secret_hash)) {
    takeHourly(limitBucket("secret-fail", ip), WRONG_SECRETS_PER_IP_HOUR, "wrong read secrets");
    throw new ApiError(403, "forbidden", "this read secret is not this job's");
  }
  takeHourly(limitBucket("secret-read", id), KEY_READS_PER_HOUR, "job reads per read secret");
  expireStaleJobs();
  const fresh = getDb().prepare(SELECT_VIEW).get(id) as ViewRow;
  return viewOf(fresh, opts.withOutput ? ["job", id] : null);
}

/** A job right after its payer paid for it (the x402 create answer). No access check: the caller checks first. */
export function jobView(id: string, opts: { withOutput?: boolean } = {}): KeyJob {
  const row = getDb().prepare(SELECT_VIEW).get(id) as ViewRow | undefined;
  if (!row) throw new ApiError(404, "unknown-job", "no job with this id");
  return viewOf(row, opts.withOutput ? ["job", id] : null);
}

const SELECT_VIEW = `SELECT id, kind, model, spec, status, created_at, settled_at, work_units, price_wei, charge_status, note, payer, api_key_id,
  output_type, read_secret_hash FROM jobs WHERE id = ?`;
type ViewRow = Omit<JobRow, "dev" | "prompt_hash" | "epoch_id" | "epoch_status" | "epoch_reserved" | "round">;

/** The KeyJob of a row; with `outputBucket` (an output rate-limit key) also the agreed output. */
function viewOf(row: ViewRow, outputBucket: string[] | null): KeyJob {
  const spec = JSON.parse(row.spec) as JobSpec;
  let output: KeyJob["output"] = null;
  if (outputBucket && row.status === "agreed" && row.output_type) {
    takeHourly(limitBucket("output", ...outputBucket), serverEnv.outputRateLimit(), "output reads");
    const o = getDb().prepare("SELECT output, output_type FROM jobs WHERE id = ?").get(row.id) as { output: Uint8Array | null; output_type: string };
    if (o.output) output = { body: o.output, type: o.output_type };
  }
  return {
    id: row.id as Hex,
    kind: row.kind,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
    settledAt: row.settled_at,
    workUnits: row.work_units,
    priceWei: row.price_wei,
    chargeStatus: row.charge_status,
    note: row.note,
    width: spec.kind === "image" ? spec.params.width : null,
    height: spec.kind === "image" ? spec.params.height : null,
    output,
  };
}

/** Status of a job without any check or counter (the `Prefer: wait` loop of ./openai, after a keyJob() check). */
export function jobStatusOf(id: string): JobStatus | null {
  return (getDb().prepare("SELECT status FROM jobs WHERE id = ?").get(id) as { status: JobStatus } | undefined)?.status ?? null;
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
