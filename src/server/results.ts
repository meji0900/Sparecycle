// Node results: check the lease, recompute the output hash from the submitted PNG / text, verify the node's
// EIP-712 receipt, fingerprint the output, and decide the job once both results of its current round are in:
//   agreed    -> one output is kept for the submitter; the job is payable in the epoch open right now
//   disagreed -> unpaid; a paid or team job with a round left (./rounds) goes back to the queue for another pair instead
//   rejected  -> a node's SD 1.5 safety checker flagged the image (unpaid, no output, never retried)
import { getAddress, type Address, type Hex } from "viem";
import { targetChain } from "@/lib/chain";
import { recoverReceiptSigner, sha256Hex, type JobSpec } from "@/lib/protocol";
import { getDb, nowSec, tx } from "./db";
import { POLICY, serverEnv } from "./env";
import { ApiError } from "./http";
import { currentEpochIdLocal } from "./epochs";
import { decodePng, fingerprintsMatch, imageFingerprint, textFingerprint } from "./verify";
import { canStartNextRound, logDisagreedRound, startNextRound } from "./rounds";

type TaskRow = {
  id: string;
  job_id: string;
  slot: number;
  status: string;
  node_key: string | null;
  owner: string | null;
  gpu_uuid: string | null;
  epoch: number | null;
  backend: string | null;
  round: number;
};

const TEXT_TYPE = "text/plain; charset=utf-8";

function bad(message: string, field?: string): never {
  throw new ApiError(400, "invalid-result", message, field ? { field } : undefined);
}

/** POST /api/v1/tasks/:taskId/result */
export async function submitResult(nodeKey: Address, taskId: string, body: unknown) {
  if (!/^0x[0-9a-f]{32}$/.test(taskId)) throw new ApiError(400, "invalid-task-id", "task id must be 0x + 32 lowercase hex characters");
  if (typeof body !== "object" || body === null) bad("expected a JSON object");
  const b = body as Record<string, unknown>;

  const db = getDb();
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRow | undefined;
  if (!task) throw new ApiError(404, "unknown-task", "no task with this id");
  if (task.status !== "leased" || task.node_key !== nodeKey) {
    throw new ApiError(409, "not-your-task", "this task is not leased to this node (lease expired and reassigned, or already done)");
  }
  const job = db.prepare("SELECT id, kind, spec, status FROM jobs WHERE id = ?").get(task.job_id) as
    | { id: string; kind: "image" | "text"; spec: string; status: string }
    | undefined;
  if (!job || !["running", "checking"].includes(job.status)) {
    throw new ApiError(409, "job-closed", `job is ${job?.status ?? "missing"}; result not needed`);
  }
  const spec = JSON.parse(job.spec) as JobSpec;

  const dev = b.dev === true;
  if (dev && !serverEnv.allowDevRunner()) {
    throw new ApiError(403, "dev-runner-not-accepted", "dev-runner results are accepted only by a local test scheduler");
  }
  const nsfw = b.nsfw === true;
  if (typeof b.outputHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.outputHash)) bad("outputHash must be a 32-byte hex hash", "outputHash");
  if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) bad("signature must be a 65-byte hex signature", "signature");
  const gpuMs = b.gpuMs;
  if (typeof gpuMs !== "number" || !Number.isFinite(gpuMs) || gpuMs < 0 || gpuMs > 86_400_000) bad("gpuMs must be a number of ms", "gpuMs");
  const epoch = b.epoch;
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch !== task.epoch) {
    bad(`epoch must be the epoch handed out with the task (${task.epoch})`, "epoch");
  }
  const runner = typeof b.runner === "string" ? b.runner.slice(0, 32) : null;

  // Output: recompute the hash and the fingerprint from what the node actually sent.
  let output: Uint8Array;
  let outputType: string;
  let fingerprint: string;
  if (spec.kind === "image") {
    if (typeof b.png !== "string" || b.png.length === 0) bad("image results need png (base64)", "png");
    output = Buffer.from(b.png, "base64");
    const img = decodePng(output, spec.params.width, spec.params.height);
    if (!img) bad(`png must be a valid ${spec.params.width}x${spec.params.height} PNG`, "png");
    fingerprint = imageFingerprint(img);
    outputType = "image/png";
  } else {
    if (typeof b.text !== "string") bad("text results need text", "text");
    if (b.text.length > POLICY.maxTextOutputChars) bad(`text is longer than ${POLICY.maxTextOutputChars} characters`, "text");
    output = Buffer.from(b.text, "utf8");
    fingerprint = textFingerprint(b.text);
    outputType = TEXT_TYPE;
  }
  const outputHash = sha256Hex(output);
  if (outputHash.toLowerCase() !== (b.outputHash as string).toLowerCase()) {
    throw new ApiError(400, "output-hash-mismatch", "outputHash is not the sha256 of the submitted output");
  }

  const signer = await recoverReceiptSigner(
    targetChain.id,
    { jobId: job.id as Hex, node: nodeKey, outputHash, gpuMs: BigInt(Math.round(gpuMs)), epoch: BigInt(epoch) },
    b.signature as Hex,
  );
  if (!signer || getAddress(signer) !== nodeKey) {
    throw new ApiError(401, "bad-receipt-signature", "receipt is not signed by this node key (EIP-712, domain Sparecycle v1)");
  }

  const settled = tx((db) => {
    // Re-check inside the transaction (the signature check above was async).
    const t = db.prepare("SELECT status, node_key FROM tasks WHERE id = ?").get(taskId) as { status: string; node_key: string };
    if (t.status !== "leased" || t.node_key !== nodeKey) throw new ApiError(409, "not-your-task", "this task is no longer leased to this node");
    const j = db.prepare("SELECT status, round, payer, created_at, model FROM jobs WHERE id = ?").get(job.id) as {
      status: string;
      round: number;
      payer: string | null;
      created_at: number;
      model: string;
    };
    if (!["running", "checking"].includes(j.status)) throw new ApiError(409, "job-closed", `job is ${j.status}; result not needed`);
    // Never happens (a round's tasks are done or cancelled before the next round starts); kept as a guard.
    if (j.round !== task.round) throw new ApiError(409, "job-closed", "this task belongs to an earlier round of the job; result not needed");
    const round = j.round;
    const now = nowSec();
    db.prepare(
      `INSERT INTO results (task_id, job_id, node_key, owner, gpu_uuid, output_hash, fingerprint, gpu_ms, epoch, signature, nsfw, dev,
         runner, output, output_type, received_at, backend, round) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      job.id,
      nodeKey,
      task.owner!,
      task.gpu_uuid!,
      outputHash,
      fingerprint,
      Math.round(gpuMs),
      epoch,
      (b.signature as string).toLowerCase(),
      nsfw ? 1 : 0,
      dev ? 1 : 0,
      runner,
      output,
      outputType,
      now,
      task.backend ?? "cuda",
      round,
    );
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);

    // Only the current round's two results are compared (earlier rounds' results stay for audit).
    const results = db
      .prepare(
        `SELECT task_id, node_key, owner, gpu_uuid, fingerprint, nsfw, dev, backend, output, output_type FROM results
         WHERE job_id = ? AND round = ? ORDER BY received_at, task_id`,
      )
      .all(job.id, round) as {
      task_id: string;
      node_key: string;
      owner: string;
      gpu_uuid: string;
      fingerprint: string;
      nsfw: number;
      dev: number;
      backend: string | null;
      output: Uint8Array | null;
      output_type: string;
    }[];
    if (results.length < 2) {
      db.prepare("UPDATE jobs SET status = 'checking' WHERE id = ?").run(job.id);
      return { status: "checking" as const, round };
    }
    const [r0, r1] = results;
    const distinct =
      r0.node_key !== r1.node_key && r0.owner.toLowerCase() !== r1.owner.toLowerCase() && r0.gpu_uuid !== r1.gpu_uuid;
    const sameBackend = (r0.backend ?? "cuda") === (r1.backend ?? "cuda") && r0.dev === r1.dev;
    const epochId = currentEpochIdLocal();
    const anyDev = r0.dev || r1.dev ? 1 : 0;
    let verdict: "agreed" | "disagreed" | "rejected";
    let note: string | null = null;
    if (r0.nsfw || r1.nsfw) {
      verdict = "rejected";
      note = "safety checker flagged the image";
    } else if (!distinct) {
      verdict = "disagreed";
      note = "results not from two distinct nodes";
    } else if (!sameBackend) {
      verdict = "disagreed"; // never happens: assignment pairs like-for-like backends
      note = "results from different backends";
    } else if (fingerprintsMatch(spec.kind, r0.fingerprint, r1.fingerprint)) {
      verdict = "agreed";
    } else {
      verdict = "disagreed";
      note = "the two results do not match";
    }
    if (verdict === "disagreed") {
      logDisagreedRound(db, job.id, round, now);
      // A paid or team job with a round left that still fits in its TTL, and a registered pair that could take it:
      // another pair checks it (./rounds). Otherwise the mismatch is final now, as before re-checks.
      const rj = { id: job.id, payer: j.payer, round, created_at: j.created_at, model: j.model };
      if (canStartNextRound(db, rj, now)) {
        return { status: "queued" as const, verdict, round: startNextRound(db, rj, "disagreed", now) };
      }
      if (round > 0) note = `${note} (checked on ${round + 1} pairs; none matched)`;
    }
    // The kept output and its sha256 (the "output fingerprint" on the payer's invoice): equal to the sha256 of the
    // bytes GET /api/v1/jobs/:id/result serves.
    const agreed = verdict === "agreed";
    db.prepare(
      "UPDATE jobs SET status = ?, settled_at = ?, epoch_id = ?, dev = ?, note = ?, output = ?, output_type = ?, output_hash = ? WHERE id = ?",
    ).run(
      verdict,
      now,
      epochId,
      anyDev,
      note,
      agreed ? r0.output : null,
      agreed ? r0.output_type : null,
      agreed && r0.output ? sha256Hex(r0.output) : null,
      job.id,
    );
    if (verdict === "agreed") {
      db.prepare("UPDATE nodes SET agreed_jobs = agreed_jobs + 1 WHERE node_key IN (?, ?)").run(r0.node_key, r1.node_key);
    }
    // Keep hashes and fingerprints for audit; drop the per-node copies of the output (every round's).
    db.prepare("UPDATE results SET output = NULL WHERE job_id = ?").run(job.id);
    return { status: verdict, round };
  });
  // `status` is the job's status after this result; when a mismatch sent the job to another pair it is "queued", with
  // `verdict: "disagreed"` for this round and `round` = the new round.
  return { ok: true, jobId: job.id, ...settled };
}
