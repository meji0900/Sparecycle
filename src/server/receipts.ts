// The payer's job receipt (feature brief #8, option B: GET /api/v1/jobs/:id/receipt). It exists from the moment the
// verdict is set (submitResult in ./results): `provisional` until the charge that commits the job's leaf to a jobs root
// is confirmed on-chain, then `sealed` with the leaf, its Merkle proof, the jobs root (the listHash of the Charged
// event) and the charge transaction. Both nodes' EIP-712 receipts (results.signature) come with it, so the payer holds
// signed statements from the two nodes as well. The leaf's random salt is given here and nowhere else: without it the
// published leaves cannot be matched to jobs. Format, leaf and checks: src/lib/job-receipt.ts.
//
// Who can read it: exactly who can read the invoice (./invoices): a session of the wallet that paid, the job's read
// secret, or the API key that submitted the job; always enforced, whatever OUTPUT_AUTH says. A free trial job has no
// receipt: its read-secret holder gets a "free trial, no charge" stub.
import { getAddress, type Hex } from "viem";
import { targetChain } from "@/lib/chain";
import {
  jobLeafOf,
  JOBS_HASH_RULE,
  LEAF_CHARGE_STATUS,
  LEAF_VERDICT,
  RECEIPT_FORMAT,
  RECEIPT_VERSION,
  ZERO_HASH,
  type JobReceipt,
  type LeafChargeStatus,
  type LeafVerdict,
  type ReceiptNode,
  type ReceiptPending,
} from "@/lib/job-receipt";
import { buildTree, getProof } from "@/lib/merkle";
import type { JobStatus } from "@/lib/protocol";
import type { Viewer } from "./auth";
import { getDb } from "./db";
import { AUTH_REQUIRED, ApiError } from "./http";
import { chargeStatusOf } from "./invoices";
import { accessOf, expireStaleJobs, hasCredentials, isJobId, paymentKind, X402_CHARGE_STATUS } from "./jobs";
import { paymentsAddress } from "./payments";
import { x402Receipt } from "./x402";

type Row = {
  id: string;
  status: JobStatus;
  payer: string | null;
  price_wei: string | null;
  charge_status: string | null;
  charged_epoch: number | null;
  output_hash: string | null;
  read_secret_hash: string | null;
  api_key_id: string | null;
  settled_at: number | null;
  receipt_epoch: number | null;
};

type LeafRow = {
  payer: string;
  price_wei: string;
  verdict: LeafVerdict;
  charge_status: LeafChargeStatus;
  output_hash: string | null;
  salt: Hex;
  leaf: Hex;
};

export type FreeReceiptStub = { jobId: string; payment: "free"; receipt: false; note: string };

const isHex32 = (v: string | null): v is Hex => !!v && /^0x[0-9a-fA-F]{64}$/.test(v);

/** The two signed results of the job's final round (earlier re-check rounds stay in the DB for audit, not in receipts). */
function nodesOf(jobId: string): ReceiptNode[] {
  const rows = getDb()
    .prepare(
      `SELECT r.node_key, r.output_hash, r.gpu_ms, r.epoch, r.signature FROM results r JOIN jobs j ON j.id = r.job_id
       WHERE r.job_id = ? AND r.round = j.round ORDER BY r.received_at, r.task_id`,
    )
    .all(jobId) as { node_key: string; output_hash: string; gpu_ms: number; epoch: number; signature: string }[];
  return rows.map((r) => ({
    node: getAddress(r.node_key),
    outputHash: r.output_hash.toLowerCase() as Hex,
    gpuMs: r.gpu_ms,
    epoch: r.epoch,
    signature: r.signature.toLowerCase() as Hex,
  }));
}

/** Why a settled job's receipt is not sealed yet (see ReceiptPending in src/lib/job-receipt.ts). */
function pendingOf(r: Row, chargeStatus: JobReceipt["chargeStatus"]): ReceiptPending {
  const db = getDb();
  const sending = db
    .prepare(
      `SELECT cl.epoch_id AS id FROM charge_leaves cl JOIN charges c ON c.epoch_id = cl.epoch_id
       WHERE cl.job_id = ? AND c.status = 'sending' ORDER BY cl.epoch_id DESC LIMIT 1`,
    )
    .get(r.id) as { id: number } | undefined;
  if (sending) return { reason: "charge-unconfirmed", epochId: sending.id };
  if (chargeStatus === "charged") return { reason: "charged-before-receipts", epochId: r.charged_epoch };
  if (chargeStatus === "released" || chargeStatus === "unpaid") {
    // Final and in no confirmed jobs root yet. When the latest epoch close since the verdict confirmed no charge, there
    // is no Charged event to anchor it (D15). (A job that settled while that close was charging just missed its root:
    // it waits for the next charge.)
    const closed = db
      .prepare(
        `SELECT e.id AS id, (SELECT c.status FROM charges c WHERE c.epoch_id = e.id) AS charge FROM epochs e
         WHERE e.status != 'open' AND e.closed_at IS NOT NULL AND e.closed_at >= ? ORDER BY e.id DESC LIMIT 1`,
      )
      .get(r.settled_at ?? 0) as { id: number; charge: string | null } | undefined;
    if (closed && closed.charge !== "done") return { reason: "no-anchor", epochId: closed.id };
  }
  const open = db.prepare("SELECT id FROM epochs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  return { reason: "waiting-for-charge", epochId: open?.id ?? null };
}

/** The sealed part: the stored leaf, its proof against the stored jobs root, the charge transaction. */
function sealed(r: Row): Pick<JobReceipt, "payer" | "priceWei" | "verdict" | "chargeStatus" | "outputHash" | "epochId" | "chargeTx" | "anchor"> | null {
  const epochId = r.receipt_epoch;
  if (epochId === null) return null;
  const db = getDb();
  const charge = db.prepare("SELECT list_hash, tx, status, hash_rule FROM charges WHERE epoch_id = ?").get(epochId) as
    | { list_hash: Hex; tx: Hex | null; status: string; hash_rule: string }
    | undefined;
  const leafRow = db
    .prepare("SELECT payer, price_wei, verdict, charge_status, output_hash, salt, leaf FROM charge_leaves WHERE epoch_id = ? AND job_id = ?")
    .get(epochId, r.id) as LeafRow | undefined;
  if (!charge || charge.status !== "done" || charge.hash_rule !== JOBS_HASH_RULE || !isHex32(charge.tx) || !leafRow || !isHex32(leafRow.salt)) {
    console.error(`[sparecycle] job ${r.id}: receipt epoch ${epochId} has no confirmed v2 charge with its leaf`);
    throw new ApiError(500, "receipt-unavailable", "the scheduler's records for this receipt are incomplete");
  }
  const tree = buildTree((db.prepare("SELECT leaf FROM charge_leaves WHERE epoch_id = ?").all(epochId) as { leaf: Hex }[]).map((l) => l.leaf));
  const payer = getAddress(leafRow.payer);
  const outputHash = isHex32(leafRow.output_hash) ? (leafRow.output_hash.toLowerCase() as Hex) : null;
  const salt = leafRow.salt.toLowerCase() as Hex;
  const leaf = jobLeafOf(epochId, {
    jobId: r.id as Hex,
    payer,
    priceWei: BigInt(leafRow.price_wei),
    verdict: leafRow.verdict,
    chargeStatus: leafRow.charge_status,
    outputHash,
    salt,
  });
  if (leaf !== leafRow.leaf.toLowerCase() || tree.root !== charge.list_hash.toLowerCase()) {
    console.error(`[sparecycle] job ${r.id}: stored leaf or jobs root of epoch ${epochId} does not recompute`);
    throw new ApiError(500, "receipt-unavailable", "the scheduler's records for this receipt are incomplete");
  }
  return {
    payer,
    priceWei: leafRow.price_wei,
    verdict: leafRow.verdict,
    chargeStatus: leafRow.charge_status,
    outputHash,
    epochId,
    chargeTx: charge.tx.toLowerCase() as Hex,
    anchor: {
      hashRule: JOBS_HASH_RULE,
      leafInputs: {
        epochId,
        jobId: r.id as Hex,
        payer,
        priceWei: leafRow.price_wei,
        verdict: LEAF_VERDICT[leafRow.verdict],
        chargeStatus: LEAF_CHARGE_STATUS[leafRow.charge_status],
        outputHash: outputHash ?? ZERO_HASH,
        salt,
      },
      leaf,
      proof: getProof(tree, leaf),
      listHash: tree.root,
    },
  };
}

/**
 * GET /api/v1/jobs/:id/receipt. Malformed id -> 400; no credentials -> 401 auth-required (an empty body); unknown
 * job -> 404; credentials that can't read this job -> 403; no verdict yet -> 409 no-verdict.
 */
/** The receipt of a job paid with x402 into the escrow (./x402): escrow events and the epoch's x402 tree. */
export type X402Receipt = NonNullable<ReturnType<typeof x402Receipt>>;

export function jobReceipt(id: string, viewer: Viewer): JobReceipt | FreeReceiptStub | X402Receipt {
  if (!isJobId(id)) throw new ApiError(400, "invalid-job-id", "job id must be 0x + 64 lowercase hex characters");
  if (!hasCredentials(viewer)) {
    throw new ApiError(401, AUTH_REQUIRED, "sign in with the paying wallet or send the job's read secret (Authorization: Bearer)");
  }
  expireStaleJobs();
  const r = getDb()
    .prepare(
      `SELECT id, status, payer, price_wei, charge_status, charged_epoch, output_hash, read_secret_hash, api_key_id, settled_at, receipt_epoch
       FROM jobs WHERE id = ?`,
    )
    .get(id) as Row | undefined;
  if (!r) throw new ApiError(404, "unknown-job", "no job with this id");
  if (!accessOf(r, viewer)) throw new ApiError(403, "forbidden", "only the wallet that paid for this job or its read secret can read its receipt");
  if (r.charge_status === X402_CHARGE_STATUS) {
    const x = x402Receipt(r.id);
    if (x) return x;
  }
  if (paymentKind(r.payer) === "free" || r.price_wei === null || !/^\d+$/.test(r.price_wei)) {
    return { jobId: r.id, payment: "free", receipt: false, note: "free trial, no charge: no receipt" };
  }
  if (!(r.status in LEAF_VERDICT)) {
    throw new ApiError(409, "no-verdict", `the job is ${r.status}; its receipt appears as soon as the two results are compared`);
  }
  const contract = paymentsAddress();
  if (!contract) throw new ApiError(503, "payments-off", "paid jobs are not enabled on this scheduler");

  const seal = sealed(r);
  const verdict = seal?.verdict ?? (r.status as LeafVerdict);
  const chargeStatus = seal?.chargeStatus ?? chargeStatusOf(r.status, r.charge_status);
  // Field order = the order of the saved file.
  return {
    format: RECEIPT_FORMAT,
    version: RECEIPT_VERSION,
    state: seal ? "sealed" : "provisional",
    chainId: targetChain.id,
    paymentsContract: contract,
    jobId: r.id as Hex,
    payer: seal?.payer ?? getAddress(r.payer!),
    priceWei: seal?.priceWei ?? r.price_wei,
    verdict,
    chargeStatus,
    outputHash: seal ? seal.outputHash : verdict === "agreed" && isHex32(r.output_hash) ? (r.output_hash.toLowerCase() as Hex) : null,
    nodes: nodesOf(r.id),
    epochId: seal?.epochId ?? null,
    chargeTx: seal?.chargeTx ?? null,
    anchor: seal?.anchor ?? null,
    pending: seal ? null : pendingOf(r, chargeStatus),
  };
}
