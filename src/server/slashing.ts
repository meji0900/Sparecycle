// Evidence-based fault attribution and slash proposals (brief §3, docs/token-features.md), behind TOKEN_SLASHING
// (default off). Nothing here sends a transaction: a proposal is a prepared, UNSIGNED proposeSlash call plus a public
// evidence bundle. The scheduler and the Safe judge; this is not trustless, and the docs say so.
//
// Fault (attribution rule, brief §3, Default, not yet confirmed by Fabio). A fault is attributed to node N for job J only
// when ALL of these hold:
//   - J reached `agreed` in a re-check round (jobs.round > 0): its final round's two results matched each other, under
//     the live thresholds of ./verify (IMAGE_MAX_BITS, TEXT_MIN_SIMILARITY);
//   - N sent a signed result (results.signature, the node's EIP-712 receipt) in an EARLIER round of J;
//   - that result matches NEITHER of the two agreeing results;
//   - the agreeing results come from two other nodes of two other owner wallets, neither of them N's owner.
// So one mismatch never attributes anything by itself: a mismatch with no later agreement (a job that ends `disagreed`,
// a free job, an abandoned round, a node that never answered) attributes nothing, and the node of an earlier round whose
// result matches the agreed one is not at fault.
//
// Proposal: when a node has at least FAULTS_PER_PROPOSAL (F = 3, N5) faults not yet used by a proposal, all with verdict
// epochs inside the last FAULT_WINDOW_EPOCHS (W = 8, N6) epochs, exactly one proposal is created from those faults and
// they are marked used, so the same faults never make a second one. Its evidence bundle is public at
// GET /api/v1/slashing/:id: job ids, the node's signed result and the two agreeing signed results (output hashes and
// signatures), the comparison against the thresholds; no prompt, no output and no text fingerprint (text fingerprints
// are the output text). evidenceHash = keccak256(utf8(evidenceJson)) over the exact stored string. The amount is
// stakedOf(owner) x SLASH_BPS (N4) when SparecycleNodeStake is live, else the proposal stays `incomplete`.
// Faults are counted per node key (a GPU or driver at fault), and the stake taken is its owner's. The appeal window,
// the freeze and the burn of the slashed SPARE are the contract's (N7, N9).
import { encodeFunctionData, getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { targetChain } from "@/lib/chain";
import { NOT_LIVE_YET, TOKEN_CONTRACTS } from "@/lib/addresses";
import { receiptDomain } from "@/lib/protocol";
import { nodeStakeAbi } from "@/lib/token-contracts";
import { APPEAL_WINDOW_EPOCHS, FAULT_WINDOW_EPOCHS, FAULTS_PER_PROPOSAL, SLASH_BPS, SLASHED_SPARE_GOES_TO } from "@/lib/token-rules";
import { NotLiveError, tokenChain } from "./chain-io";
import { getDb, nowSec, tx } from "./db";
import { ApiError } from "./http";
import { fingerprintsMatch, hammingHex, IMAGE_MAX_BITS, TEXT_MIN_SIMILARITY, textSimilarity } from "./verify";

export const FAULT_RULE =
  "A fault is attributed to a node for a job only when its signed result disagrees with the agreed result of a later " +
  "re-check round, and that agreed result comes from two other nodes of two other owner wallets, neither of them the " +
  "node's owner. A single mismatch never creates a proposal.";

type ResultRow = {
  task_id: string;
  node_key: string;
  owner: string;
  round: number;
  output_hash: string;
  fingerprint: string;
  gpu_ms: number;
  epoch: number;
  signature: string;
};
type JobRow = { id: string; kind: "image" | "text"; model: string; round: number; epoch_id: number | null };

const RESULT_COLS = "task_id, node_key, owner, round, output_hash, fingerprint, gpu_ms, epoch, signature";

/** The faults one agreed job attributes (pure over its results). Exported for tests. */
export function faultsOfJob(job: JobRow, results: ResultRow[]): ResultRow[] {
  if (job.round < 1) return [];
  const final = results.filter((r) => r.round === job.round);
  if (final.length !== 2) return [];
  const [a, b] = final;
  const agreeingOwners = new Set([a.owner.toLowerCase(), b.owner.toLowerCase()]);
  if (agreeingOwners.size !== 2 || a.node_key === b.node_key) return [];
  if (!fingerprintsMatch(job.kind, a.fingerprint, b.fingerprint)) return []; // never happens for an agreed job; a guard
  return results.filter(
    (r) =>
      r.round < job.round &&
      !agreeingOwners.has(r.owner.toLowerCase()) &&
      !fingerprintsMatch(job.kind, r.fingerprint, a.fingerprint) &&
      !fingerprintsMatch(job.kind, r.fingerprint, b.fingerprint),
  );
}

/**
 * Records the faults of every agreed re-checked job whose verdict fell in `epochId` (idempotent). Returns how many new
 * faults were recorded.
 */
export function attributeFaults(epochId: number): number {
  const db = getDb();
  const jobs = db
    .prepare("SELECT id, kind, model, round, epoch_id FROM jobs WHERE status = 'agreed' AND round > 0 AND epoch_id = ?")
    .all(epochId) as JobRow[];
  let added = 0;
  const now = nowSec();
  tx(() => {
    const ins = db.prepare(
      "INSERT OR IGNORE INTO token_slash_faults (job_id, node_key, owner, task_id, round, epoch_id, proposal_id, at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
    );
    for (const j of jobs) {
      const results = db.prepare(`SELECT ${RESULT_COLS} FROM results WHERE job_id = ? ORDER BY round, received_at, task_id`).all(j.id) as ResultRow[];
      for (const f of faultsOfJob(j, results)) {
        added += Number(ins.run(j.id, f.node_key, getAddress(f.owner), f.task_id, f.round, epochId, now).changes);
      }
    }
  });
  return added;
}

// ---- Evidence --------------------------------------------------------------------------------------------------

type SignedResult = { node: Address; owner: Address; round: number; outputHash: Hex; gpuMs: number; epoch: number; signature: Hex; imageDhash?: string };

const signed = (kind: "image" | "text", r: ResultRow): SignedResult => ({
  node: getAddress(r.node_key),
  owner: getAddress(r.owner),
  round: r.round,
  outputHash: r.output_hash.toLowerCase() as Hex,
  gpuMs: r.gpu_ms,
  epoch: r.epoch,
  signature: r.signature.toLowerCase() as Hex,
  // A 64-bit perceptual hash of an image says nearly nothing about the picture and lets anyone recompute the distance.
  // Text fingerprints are the output text itself, so they are never published.
  ...(kind === "image" ? { imageDhash: r.fingerprint } : {}),
});

function comparison(kind: "image" | "text", n: ResultRow, other: ResultRow) {
  return kind === "image"
    ? { with: getAddress(other.node_key), metric: "image-dhash-bits", value: hammingHex(n.fingerprint, other.fingerprint), threshold: IMAGE_MAX_BITS, matches: false }
    : {
        with: getAddress(other.node_key),
        metric: "text-similarity",
        value: Math.round(textSimilarity(n.fingerprint, other.fingerprint) * 10_000) / 10_000,
        threshold: TEXT_MIN_SIMILARITY,
        matches: false,
      };
}

type FaultRow = { job_id: string; node_key: string; owner: string; task_id: string; round: number; epoch_id: number };

/** The public evidence bundle of a proposal (deterministic key order: its JSON is what evidenceHash covers). */
export function evidenceBundle(owner: Address, node: Address, window: { fromEpoch: number; toEpoch: number }, faults: FaultRow[]) {
  const db = getDb();
  return {
    kind: "sparecycle-slash-evidence",
    version: 1,
    chainId: targetChain.id,
    owner,
    node,
    window: { fromEpoch: window.fromEpoch, toEpoch: window.toEpoch, epochs: FAULT_WINDOW_EPOCHS },
    rule: {
      fault: FAULT_RULE,
      faultsPerProposal: FAULTS_PER_PROPOSAL,
      windowEpochs: FAULT_WINDOW_EPOCHS,
      slashBps: SLASH_BPS,
      appealEpochs: APPEAL_WINDOW_EPOCHS,
      slashedSpare: SLASHED_SPARE_GOES_TO,
      defaults: "Default, not yet confirmed by Fabio",
    },
    thresholds: { imageMaxBits: IMAGE_MAX_BITS, textMinSimilarity: TEXT_MIN_SIMILARITY },
    receipts: {
      scheme: "EIP-712",
      domain: receiptDomain(targetChain.id),
      type: "Receipt(bytes32 jobId,address node,bytes32 outputHash,uint64 gpuMs,uint64 epoch)",
    },
    faults: faults.map((f) => {
      const job = db.prepare("SELECT id, kind, model, round, epoch_id FROM jobs WHERE id = ?").get(f.job_id) as JobRow;
      const rows = db.prepare(`SELECT ${RESULT_COLS} FROM results WHERE job_id = ? ORDER BY round, received_at, task_id`).all(f.job_id) as ResultRow[];
      const mine = rows.find((r) => r.task_id === f.task_id)!;
      const agreeing = rows.filter((r) => r.round === job.round);
      return {
        jobId: job.id,
        kind: job.kind,
        model: job.model,
        verdictEpoch: job.epoch_id,
        result: signed(job.kind, mine),
        agreeing: agreeing.map((r) => signed(job.kind, r)),
        comparison: agreeing.map((r) => comparison(job.kind, mine, r)),
      };
    }),
  };
}

export const evidenceHashOf = (evidenceJson: string): Hex => keccak256(toBytes(evidenceJson));

// ---- Proposals --------------------------------------------------------------------------------------------------

type ProposalRow = {
  id: number;
  owner: string;
  node_key: string;
  from_epoch: number;
  to_epoch: number;
  faults: number;
  evidence_json: string;
  evidence_hash: Hex;
  stake_wei: string | null;
  amount_wei: string | null;
  call_json: string | null;
  status: "prepared" | "incomplete";
  created_at: number;
};

/** The unsigned proposeSlash call (scheduler key), or null and the reason when it cannot be prepared. */
async function prepareCall(owner: Address, evidenceHash: Hex): Promise<{ stake: bigint | null; amount: bigint | null; call: object | null }> {
  try {
    const stake = await tokenChain.stakedOf(owner);
    const amount = (stake * BigInt(SLASH_BPS)) / 10_000n;
    return {
      stake,
      amount,
      call: {
        unsigned: true,
        from: "scheduler key (never sent by this code)",
        to: TOKEN_CONTRACTS.nodeStake,
        function: "proposeSlash(address owner, uint256 amount, bytes32 evidenceHash)",
        args: { owner, amount: amount.toString(), evidenceHash },
        data: encodeFunctionData({ abi: nodeStakeAbi, functionName: "proposeSlash", args: [owner, amount, evidenceHash] }),
      },
    };
  } catch (e) {
    if (!(e instanceof NotLiveError)) console.error(`[sparecycle] slashing: stake read for ${owner} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { stake: null, amount: null, call: null };
  }
}

/**
 * Creates the proposals that are due at the close of `epochId`: for each node with at least F unused faults whose
 * verdict epochs lie in [epochId - W + 1, epochId], exactly one proposal from all those faults. Returns the new ids.
 */
export async function proposeDueSlashes(epochId: number): Promise<number[]> {
  const db = getDb();
  const from = epochId - FAULT_WINDOW_EPOCHS + 1;
  const due = db
    .prepare(
      `SELECT node_key, COUNT(*) AS n FROM token_slash_faults WHERE proposal_id IS NULL AND epoch_id BETWEEN ? AND ?
       GROUP BY node_key HAVING COUNT(*) >= ? ORDER BY node_key`,
    )
    .all(from, epochId, FAULTS_PER_PROPOSAL) as { node_key: string; n: number }[];
  const ids: number[] = [];
  for (const d of due) {
    const faults = db
      .prepare(
        "SELECT job_id, node_key, owner, task_id, round, epoch_id FROM token_slash_faults WHERE proposal_id IS NULL AND node_key = ? AND epoch_id BETWEEN ? AND ? ORDER BY epoch_id, job_id",
      )
      .all(d.node_key, from, epochId) as FaultRow[];
    const owner = getAddress(faults[faults.length - 1].owner);
    const node = getAddress(d.node_key);
    const evidenceJson = JSON.stringify(evidenceBundle(owner, node, { fromEpoch: from, toEpoch: epochId }, faults));
    const evidenceHash = evidenceHashOf(evidenceJson);
    const { stake, amount, call } = await prepareCall(owner, evidenceHash);
    const id = tx(() => {
      // Re-check inside the transaction: a concurrent close must not use the same faults twice.
      const free = db
        .prepare(`SELECT COUNT(*) AS n FROM token_slash_faults WHERE proposal_id IS NULL AND node_key = ? AND job_id IN (${faults.map(() => "?").join(",")})`)
        .get(d.node_key, ...faults.map((f) => f.job_id)) as { n: number };
      if (free.n !== faults.length) return null;
      const res = db
        .prepare(
          `INSERT INTO token_slash_proposals (owner, node_key, from_epoch, to_epoch, faults, evidence_json, evidence_hash, stake_wei, amount_wei,
             call_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(owner, node, from, epochId, faults.length, evidenceJson, evidenceHash, stake?.toString() ?? null, amount?.toString() ?? null,
          call ? JSON.stringify(call) : null, call ? "prepared" : "incomplete", nowSec());
      const pid = Number(res.lastInsertRowid);
      const mark = db.prepare("UPDATE token_slash_faults SET proposal_id = ? WHERE job_id = ? AND node_key = ?");
      for (const f of faults) mark.run(pid, f.job_id, f.node_key);
      return pid;
    });
    if (id !== null) {
      ids.push(id);
      console.log(`[sparecycle] slashing: proposal ${id} prepared for node ${node} (owner ${owner}), ${faults.length} faults, evidence ${evidenceHash}; NOT sent`);
    }
  }
  return ids;
}

// ---- Public read model (GET /api/v1/slashing, GET /api/v1/slashing/:id) -------------------------------------------

const summary = (r: ProposalRow) => ({
  id: r.id,
  owner: getAddress(r.owner),
  node: getAddress(r.node_key),
  window: { fromEpoch: r.from_epoch, toEpoch: r.to_epoch },
  faults: r.faults,
  evidenceHash: r.evidence_hash,
  /** prepared = the unsigned proposeSlash call exists; incomplete = SparecycleNodeStake is not live, so no amount. */
  status: r.status,
  sent: false,
  stakeWei: r.stake_wei,
  amountWei: r.amount_wei,
  amount: r.amount_wei ?? NOT_LIVE_YET,
  createdAt: r.created_at,
  evidenceUrl: `/api/v1/slashing/${r.id}`,
});

/** 404 exactly like an unknown /api/v1 path while TOKEN_SLASHING is off. */
const off = () => new ApiError(404, "not-found", "no such scheduler endpoint");

export function slashingListJson(enabled: boolean) {
  if (!enabled) throw off();
  const rows = getDb().prepare("SELECT * FROM token_slash_proposals ORDER BY id DESC LIMIT 200").all() as ProposalRow[];
  return {
    rule: { fault: FAULT_RULE, faultsPerProposal: FAULTS_PER_PROPOSAL, windowEpochs: FAULT_WINDOW_EPOCHS, slashBps: SLASH_BPS, defaults: "Default, not yet confirmed by Fabio" },
    note: "Prepared proposals: none is sent by the scheduler. The scheduler and the treasury Safe judge; this is not trustless.",
    proposals: rows.map(summary),
  };
}

export function slashingDetailJson(enabled: boolean, rawId: string) {
  if (!enabled) throw off();
  if (!/^\d{1,12}$/.test(rawId)) throw new ApiError(400, "invalid-proposal-id", "proposal id must be a positive integer");
  const row = getDb().prepare("SELECT * FROM token_slash_proposals WHERE id = ?").get(Number(rawId)) as ProposalRow | undefined;
  if (!row) throw new ApiError(404, "unknown-proposal", "no slash proposal with this id");
  return {
    ...summary(row),
    hashRule: "evidenceHash = keccak256(utf8(evidenceJson))",
    evidenceJson: row.evidence_json,
    evidence: JSON.parse(row.evidence_json) as unknown,
    call: row.call_json ? (JSON.parse(row.call_json) as unknown) : null,
  };
}
