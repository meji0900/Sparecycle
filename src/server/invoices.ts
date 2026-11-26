// The private per-job invoice (feature brief #4, GET /api/v1/jobs/:id/invoice): what a paid job costs, the protocol
// cut, whether the two results matched, what happened to the charge, the output fingerprint (its sha256, never the
// file), the epochs and the on-chain transactions. None of this is in the public job views (D7).
//
// Who can read it: a session of the wallet that paid (for a team job that is the team wallet that paid), or the
// holder of the job's read secret (`Authorization: Bearer`, returned once by POST /api/v1/jobs). Always enforced,
// whatever OUTPUT_AUTH says. A free trial job has no invoice: its read-secret holder gets a "free trial, no charge"
// stub instead.
import { explorerTx } from "@/lib/chain";
import { protocolCutWei, TREASURY_BPS } from "@/lib/job-payment";
import type { JobStatus } from "@/lib/protocol";
import { maxRoundsFor } from "@/lib/rounds";
import type { Viewer } from "./auth";
import { getDb, nowSec } from "./db";
import { AUTH_REQUIRED, ApiError } from "./http";
import { accessOf, expireStaleJobs, hasCredentials, isJobId, paymentKind } from "./jobs";

export type ChargeStatus = "pending" | "charged" | "released" | "unpaid";
export type Verdict = "agreed" | "disagreed" | "expired" | "rejected";

/** How the per-job protocol cut is labelled wherever it is shown. */
export const PROTOCOL_CUT_NOTE =
  "5% share of this job's price, rounded; the contract takes 5% of each epoch's charged total (charged per epoch batch, rounded down), so the amount on-chain can differ by rounding dust";

type Row = {
  id: string;
  kind: "image" | "text";
  model: string;
  status: JobStatus;
  created_at: number;
  settled_at: number | null;
  epoch_id: number | null;
  note: string | null;
  payer: string | null;
  price_wei: string | null;
  charge_status: string | null;
  charged_epoch: number | null;
  output_hash: string | null;
  read_secret_hash: string | null;
  epoch_status: string | null;
  epoch_posted_tx: string | null;
  charge_tx: string | null;
  round: number;
};

const SELECT = `SELECT j.id, j.kind, j.model, j.status, j.created_at, j.settled_at, j.epoch_id, j.note, j.payer, j.price_wei,
  j.charge_status, j.charged_epoch, j.output_hash, j.read_secret_hash, j.round, e.status AS epoch_status, e.posted_tx AS epoch_posted_tx,
  c.tx AS charge_tx
  FROM jobs j
  LEFT JOIN epochs e ON e.id = j.epoch_id
  LEFT JOIN charges c ON c.epoch_id = j.charged_epoch AND c.status = 'done'
  WHERE j.id = ?`;

const VERDICTS: readonly JobStatus[] = ["agreed", "disagreed", "expired", "rejected"];
const verdictOf = (s: JobStatus): Verdict | null => (VERDICTS.includes(s) ? (s as Verdict) : null);

/**
 * The charge status a payer should see. A job that settled without agreement is never charged and holds nothing
 * (see heldFor in ./payments); the stored status flips from 'pending' to 'released' at the next epoch close
 * (chargeOpenEpoch), so it is shown as released from the verdict on.
 */
export function chargeStatusOf(status: JobStatus, stored: string | null): ChargeStatus {
  if (stored === "charged" || stored === "released" || stored === "unpaid") return stored;
  if (status === "disagreed" || status === "expired" || status === "rejected") return "released";
  return "pending";
}

const txLink = (hash: string | null) => (hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? { hash, url: explorerTx(hash) } : null);

/**
 * GET /api/v1/jobs/:id/invoice. Malformed id -> 400; no credentials -> 401 auth-required (an empty body);
 * unknown job -> 404; credentials that can't read this job -> 403.
 */
export function jobInvoice(id: string, viewer: Viewer) {
  if (!isJobId(id)) throw new ApiError(400, "invalid-job-id", "job id must be 0x + 64 lowercase hex characters");
  if (!hasCredentials(viewer)) {
    throw new ApiError(401, AUTH_REQUIRED, "sign in with the paying wallet or send the job's read secret (Authorization: Bearer)");
  }
  expireStaleJobs();
  const r = getDb().prepare(SELECT).get(id) as Row | undefined;
  if (!r) throw new ApiError(404, "unknown-job", "no job with this id");
  if (!accessOf(r, viewer)) throw new ApiError(403, "forbidden", "only the wallet that paid for this job or its read secret can read its invoice");

  const base = {
    version: 1 as const,
    jobId: r.id,
    model: r.model,
    kind: r.kind,
    status: r.status,
    verdict: verdictOf(r.status),
    createdAt: r.created_at,
    settledAt: r.settled_at,
    generatedAt: nowSec(),
    /**
     * Re-check round (./rounds): 0 = the first pair. While a paid job is checked again on another pair after a mismatch
     * (or a pair that never finished) this is 1 or 2 and the price stays held; the verdict, charge and output hash are
     * those of the final round only.
     */
    round: r.round,
    maxRounds: maxRoundsFor(r.payer),
  };
  const payment = paymentKind(r.payer);
  if (payment === "free" || r.price_wei === null || !/^\d+$/.test(r.price_wei)) {
    return { ...base, payment: "free" as const, invoice: false as const, note: "free trial, no charge" };
  }

  const price = BigInt(r.price_wei);
  const cut = protocolCutWei(price);
  const chargeStatus = chargeStatusOf(r.status, r.charge_status);
  return {
    ...base,
    payment,
    invoice: true as const,
    payer: r.payer,
    /** The price the payer signed for, wei. */
    priceWei: price.toString(),
    /** What was taken from the balance for this job: the price once charged, 0 when not charged, null while open. */
    chargedWei: chargeStatus === "charged" ? price.toString() : chargeStatus === "pending" ? null : "0",
    protocolCutBps: Number(TREASURY_BPS),
    protocolCutWei: cut.toString(),
    protocolCutNote: PROTOCOL_CUT_NOTE,
    toPotWei: (price - cut).toString(),
    toPotNote:
      "the rest goes into the open epoch's node reward pot, which is split by work units across all matched jobs of that epoch, not paid to the nodes of this job in particular",
    chargeStatus,
    /** Why the scheduler settled the job this way (e.g. "the two results do not match"), when it says. */
    reason: r.note,
    /** The epoch open when the verdict was reached: the epoch whose payout root covers this job's work. */
    epochId: r.epoch_id,
    epochStatus: r.epoch_status,
    /** The epoch whose close charged this job (null until charged). */
    chargedEpoch: r.charged_epoch,
    /** sha256 of the output served at /api/v1/jobs/:id/result (the copy kept from one of the two matching results). */
    outputHash: r.status === "agreed" ? r.output_hash : null,
    links: {
      chargeTx: chargeStatus === "charged" ? txLink(r.charge_tx) : null,
      epochRootTx: r.epoch_status === "posted" ? txLink(r.epoch_posted_tx) : null,
    },
  };
}
