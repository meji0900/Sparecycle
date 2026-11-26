// Job receipts (feature brief #8, option B, decision D14): a Merkle tree over the paid jobs that reached a final state
// since the last charge, committed on-chain as the `listHash` of SparecycleJobPayments' Charged(epochId, listHash, …)
// event. The epoch payout root (src/lib/merkle.ts, leafOf) commits one leaf per node-owner payout: jobs and payers are
// not in it, so a payer's job is checked against this jobs root instead. No contract change: charge() accepts any
// bytes32 as listHash.
//
// leaf  = keccak256(abi.encode(uint64 epochId, bytes32 jobId, address payer, uint256 priceWei, uint8 verdict,
//                              uint8 chargeStatus, bytes32 outputHash))
//         epochId    = the epoch whose charge() committed the tree (the Charged event's epochId)
//         verdict    = LEAF_VERDICT, chargeStatus = LEAF_CHARGE_STATUS (0 is never used)
//         outputHash = sha256 of the kept output when the two results agreed, else 0x00…00
//         224 bytes in, so a leaf can never collide with a 64-byte inner node.
// inner = sorted-pair keccak256 (src/lib/merkle.ts hashPair); leaves sorted ascending, an odd node is promoted.
//
// Pure (viem only) and browser-safe: the scheduler builds trees and receipts with it (src/server/payments.ts,
// src/server/receipts.ts), and the dapp's Verify panel, the unit tests and scripts/e2e-local.mjs check them with it.
import { encodeAbiParameters, getAddress, isAddress, keccak256, parseEventLogs, type Address, type Hex } from "viem";
import { jobPaymentsAbi } from "@/contracts/jobPayments";
import { buildTree, hashPair, type MerkleTree } from "./merkle";
import { recoverReceiptSigner } from "./protocol";

/** `hashRule` of a charge whose listHash is a jobs Merkle root. Earlier charges hashed the JSON list ("v1"). */
export const JOBS_HASH_RULE = "v2-jobs-merkle" as const;
export const RECEIPT_FORMAT = "sparecycle-job-receipt" as const;
export const RECEIPT_VERSION = 1 as const;

/** The uint8 verdict of a jobs-tree leaf. One definition for the scheduler, the browser and the tests. */
export const LEAF_VERDICT = { agreed: 1, disagreed: 2, expired: 3, rejected: 4 } as const;
/** The uint8 charge status of a jobs-tree leaf (a leaf is only written once the charge status is final). */
export const LEAF_CHARGE_STATUS = { charged: 1, released: 2, unpaid: 3 } as const;

export type LeafVerdict = keyof typeof LEAF_VERDICT;
export type LeafChargeStatus = keyof typeof LEAF_CHARGE_STATUS;

export const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

/** The leaf rule as one line (served with v2 charge lists, shown in the docs). */
export const JOBS_LEAF_RULE =
  "keccak256(abi.encode(uint64 epochId, bytes32 jobId, address payer, uint256 priceWei, uint8 verdict, uint8 chargeStatus, bytes32 outputHash)); sorted-pair keccak256 tree as the payout tree (src/lib/merkle.ts)";

const LEAF_TYPES = [
  { type: "uint64" },
  { type: "bytes32" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint8" },
  { type: "uint8" },
  { type: "bytes32" },
] as const;

export type JobLeafEntry = {
  jobId: Hex;
  payer: Address;
  priceWei: bigint;
  verdict: LeafVerdict;
  chargeStatus: LeafChargeStatus;
  /** null (or omitted) = 0x00…00. Only an agreed job has one. */
  outputHash: Hex | null;
};

/** The leaf of one job in the jobs tree of epoch `epochId`. */
export function jobLeafOf(epochId: bigint | number, e: JobLeafEntry): Hex {
  return keccak256(
    encodeAbiParameters(LEAF_TYPES, [
      BigInt(epochId),
      e.jobId,
      e.payer,
      e.priceWei,
      LEAF_VERDICT[e.verdict],
      LEAF_CHARGE_STATUS[e.chargeStatus],
      e.outputHash ?? ZERO_HASH,
    ]),
  );
}

/** The jobs tree of one charge (at least one entry; job ids are unique, so leaves are too). */
export function buildJobsTree(epochId: bigint | number, entries: readonly JobLeafEntry[]): { tree: MerkleTree; leaves: (JobLeafEntry & { leaf: Hex })[] } {
  const leaves = entries.map((e) => ({ ...e, leaf: jobLeafOf(epochId, e) }));
  return { tree: buildTree(leaves.map((l) => l.leaf)), leaves };
}

const codeName = <T extends Record<string, number>>(codes: T, code: number): keyof T | null =>
  (Object.keys(codes) as (keyof T)[]).find((k) => codes[k] === code) ?? null;

// ---- The receipt -------------------------------------------------------------------------------------------------

/** One node's EIP-712 receipt (src/lib/protocol.ts RECEIPT_TYPES) over this job. */
export type ReceiptNode = { node: Address; outputHash: Hex; gpuMs: number; epoch: number; signature: Hex };

/** The leaf as committed: the encoded values (verdict and charge status as their uint8 codes). */
export type ReceiptLeafInputs = {
  epochId: number;
  jobId: Hex;
  payer: Address;
  priceWei: string;
  verdict: number;
  chargeStatus: number;
  outputHash: Hex;
};

export type ReceiptAnchor = {
  hashRule: typeof JOBS_HASH_RULE;
  leafInputs: ReceiptLeafInputs;
  leaf: Hex;
  /** Sibling hashes from the leaf up to the root. */
  proof: Hex[];
  /** The jobs root: the listHash of the Charged event of `epochId`. */
  listHash: Hex;
};

/**
 * Why a receipt is still provisional:
 *   waiting-for-charge  the job's line goes into the jobs root of the next epoch close that charges a job
 *   charge-unconfirmed  the charge transaction that holds it was sent and is not confirmed yet
 *   no-anchor           the epoch close after its verdict charged nothing: no Charged event, so no on-chain anchor for
 *                       that epoch (D15); it goes into the next jobs root, if a later epoch charges a job
 *   charged-before-receipts  charged in a "v1" charge (before jobs roots existed): that epoch's published per-job
 *                       list holds it, and the list's keccak256 is the Charged event's listHash; there is no proof
 */
export type ReceiptPending = {
  reason: "waiting-for-charge" | "charge-unconfirmed" | "no-anchor" | "charged-before-receipts";
  epochId: number | null;
};

/**
 * A paid (or team) job's receipt: GET /api/v1/jobs/{id}/receipt, and the file a payer saves. Every field is checked by
 * verifyReceipt (constants, the node signatures, the leaf and its proof, the Charged event), so a changed field fails.
 */
export type JobReceipt = {
  format: typeof RECEIPT_FORMAT;
  version: typeof RECEIPT_VERSION;
  /** provisional until the charge transaction that commits the job's leaf is confirmed, then sealed. */
  state: "provisional" | "sealed";
  chainId: number;
  paymentsContract: Address;
  jobId: Hex;
  payer: Address;
  priceWei: string;
  verdict: LeafVerdict;
  /** "pending" only while provisional (an agreed job not charged yet). */
  chargeStatus: "pending" | LeafChargeStatus;
  /** sha256 of the kept output of an agreed job, else null. */
  outputHash: Hex | null;
  /** The EIP-712 receipts of the nodes that answered (two for a compared job; fewer when it expired). */
  nodes: ReceiptNode[];
  /** The epoch whose charge committed the leaf (sealed), else null. */
  epochId: number | null;
  chargeTx: Hex | null;
  anchor: ReceiptAnchor | null;
  pending: ReceiptPending | null;
};

const RECEIPT_KEYS = [
  "format",
  "version",
  "state",
  "chainId",
  "paymentsContract",
  "jobId",
  "payer",
  "priceWei",
  "verdict",
  "chargeStatus",
  "outputHash",
  "nodes",
  "epochId",
  "chargeTx",
  "anchor",
  "pending",
] as const;
const NODE_KEYS = ["node", "outputHash", "gpuMs", "epoch", "signature"] as const;
const ANCHOR_KEYS = ["hashRule", "leafInputs", "leaf", "proof", "listHash"] as const;
const LEAF_INPUT_KEYS = ["epochId", "jobId", "payer", "priceWei", "verdict", "chargeStatus", "outputHash"] as const;
const PENDING_KEYS = ["reason", "epochId"] as const;
const PENDING_REASONS = ["waiting-for-charge", "charge-unconfirmed", "no-anchor", "charged-before-receipts"] as const;

export class ReceiptFormatError extends Error {}

const fail = (message: string): never => {
  throw new ReceiptFormatError(message);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isHash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const isSig = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{130}$/.test(v);
const isWei = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,77})$/.test(v);
const isUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function exactKeys(o: Record<string, unknown>, keys: readonly string[], what: string) {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) fail(`${what} has fields a version 1 receipt does not have: ${extra.join(", ")}`);
  const missing = keys.filter((k) => !(k in o));
  if (missing.length) fail(`${what} is missing: ${missing.join(", ")}`);
}

const address = (v: unknown, what: string): Address => (typeof v === "string" && isAddress(v) ? getAddress(v) : fail(`${what} must be an address`));
const hash = (v: unknown, what: string): Hex => (isHash(v) ? (v.toLowerCase() as Hex) : fail(`${what} must be a 32-byte hex hash`));

/**
 * Reads a receipt strictly: exactly the version 1 fields, each of the right type. Hex values come back lowercase
 * and addresses checksummed (an address with a wrong checksum is refused). Throws ReceiptFormatError.
 */
export function parseReceipt(raw: unknown): JobReceipt {
  if (!isObj(raw)) fail("a receipt is a JSON object");
  const o = raw as Record<string, unknown>;
  if (o.format !== RECEIPT_FORMAT) fail(`not a Sparecycle job receipt (format must be "${RECEIPT_FORMAT}")`);
  if (o.version !== RECEIPT_VERSION) fail(`unknown receipt version ${String(o.version)}; this page reads version ${RECEIPT_VERSION}`);
  exactKeys(o, RECEIPT_KEYS, "the receipt");
  if (o.state !== "provisional" && o.state !== "sealed") fail('state must be "provisional" or "sealed"');
  if (!isUint(o.chainId)) fail("chainId must be a whole number");
  if (typeof o.verdict !== "string" || !(o.verdict in LEAF_VERDICT)) fail("verdict must be agreed, disagreed, expired or rejected");
  if (typeof o.chargeStatus !== "string" || !(o.chargeStatus === "pending" || o.chargeStatus in LEAF_CHARGE_STATUS)) {
    fail("chargeStatus must be pending, charged, released or unpaid");
  }
  if (!isWei(o.priceWei)) fail("priceWei must be a whole number of wei, as a string");
  if (o.outputHash !== null && !isHash(o.outputHash)) fail("outputHash must be a 32-byte hex hash or null");
  if (!Array.isArray(o.nodes) || o.nodes.length > 2) fail("nodes must be a list of at most two node receipts");
  const nodes = (o.nodes as unknown[]).map((n, i): ReceiptNode => {
    if (!isObj(n)) fail(`nodes[${i}] must be an object`);
    const x = n as Record<string, unknown>;
    exactKeys(x, NODE_KEYS, `nodes[${i}]`);
    if (!isUint(x.gpuMs) || !isUint(x.epoch)) fail(`nodes[${i}]: gpuMs and epoch must be whole numbers`);
    if (!isSig(x.signature)) fail(`nodes[${i}].signature must be a 65-byte hex signature`);
    return {
      node: address(x.node, `nodes[${i}].node`),
      outputHash: hash(x.outputHash, `nodes[${i}].outputHash`),
      gpuMs: x.gpuMs as number,
      epoch: x.epoch as number,
      signature: (x.signature as string).toLowerCase() as Hex,
    };
  });
  if (o.epochId !== null && !isUint(o.epochId)) fail("epochId must be a whole number or null");
  if (o.chargeTx !== null && !isHash(o.chargeTx)) fail("chargeTx must be a transaction hash or null");

  let anchor: ReceiptAnchor | null = null;
  if (o.anchor !== null) {
    if (!isObj(o.anchor)) fail("anchor must be an object or null");
    const a = o.anchor as Record<string, unknown>;
    exactKeys(a, ANCHOR_KEYS, "anchor");
    if (a.hashRule !== JOBS_HASH_RULE) fail(`anchor.hashRule must be "${JOBS_HASH_RULE}"`);
    if (!isObj(a.leafInputs)) fail("anchor.leafInputs must be an object");
    const li = a.leafInputs as Record<string, unknown>;
    exactKeys(li, LEAF_INPUT_KEYS, "anchor.leafInputs");
    if (!isUint(li.epochId) || !isUint(li.verdict) || !isUint(li.chargeStatus)) fail("anchor.leafInputs: epochId, verdict and chargeStatus must be whole numbers");
    if (!isWei(li.priceWei)) fail("anchor.leafInputs.priceWei must be a whole number of wei, as a string");
    if (!Array.isArray(a.proof) || !a.proof.every(isHash)) fail("anchor.proof must be a list of 32-byte hex hashes");
    anchor = {
      hashRule: JOBS_HASH_RULE,
      leafInputs: {
        epochId: li.epochId as number,
        jobId: hash(li.jobId, "anchor.leafInputs.jobId"),
        payer: address(li.payer, "anchor.leafInputs.payer"),
        priceWei: li.priceWei as string,
        verdict: li.verdict as number,
        chargeStatus: li.chargeStatus as number,
        outputHash: hash(li.outputHash, "anchor.leafInputs.outputHash"),
      },
      leaf: hash(a.leaf, "anchor.leaf"),
      proof: (a.proof as string[]).map((p) => p.toLowerCase() as Hex),
      listHash: hash(a.listHash, "anchor.listHash"),
    };
  }
  let pending: ReceiptPending | null = null;
  if (o.pending !== null) {
    if (!isObj(o.pending)) fail("pending must be an object or null");
    const p = o.pending as Record<string, unknown>;
    exactKeys(p, PENDING_KEYS, "pending");
    if (!PENDING_REASONS.includes(p.reason as (typeof PENDING_REASONS)[number])) fail(`pending.reason must be one of ${PENDING_REASONS.join(", ")}`);
    if (p.epochId !== null && !isUint(p.epochId)) fail("pending.epochId must be a whole number or null");
    pending = { reason: p.reason as ReceiptPending["reason"], epochId: p.epochId as number | null };
  }
  return {
    format: RECEIPT_FORMAT,
    version: RECEIPT_VERSION,
    state: o.state as JobReceipt["state"],
    chainId: o.chainId as number,
    paymentsContract: address(o.paymentsContract, "paymentsContract"),
    jobId: hash(o.jobId, "jobId"),
    payer: address(o.payer, "payer"),
    priceWei: o.priceWei as string,
    verdict: o.verdict as LeafVerdict,
    chargeStatus: o.chargeStatus as JobReceipt["chargeStatus"],
    outputHash: o.outputHash === null ? null : hash(o.outputHash, "outputHash"),
    nodes,
    epochId: o.epochId as number | null,
    chargeTx: o.chargeTx === null ? null : hash(o.chargeTx, "chargeTx"),
    anchor,
    pending,
  };
}

// ---- Verification ------------------------------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "skip";
export type ReceiptCheck = { id: string; label: string; status: CheckStatus; detail: string };

export type ReceiptOutcome =
  /** Every check passed, including the Charged event read from the chain. */
  | "verified"
  /** A check failed: the receipt was changed, or it does not match the chain. */
  | "failed"
  /** Not anchored yet: nothing on-chain to compare with. The node signatures were checked. */
  | "provisional"
  /** D15: the epoch it settled in had no charge, so there is no on-chain anchor for that epoch (yet). */
  | "no-anchor"
  /** The RPC could not be reached or did not answer; nothing on-chain was checked. */
  | "unreachable";

export type ReceiptVerification = {
  outcome: ReceiptOutcome;
  checks: ReceiptCheck[];
  receipt: JobReceipt | null;
  /** The leaf computed here from the leaf inputs, and the root the proof leads to (sealed receipts). */
  computedLeaf: Hex | null;
  computedRoot: Hex | null;
  /** What the chain said, when it was read. */
  onchain: { listHash: Hex | null; customerCharged: string | null; blockNumber: string | null } | null;
  /** The RPC error, for "unreachable". */
  error: string | null;
};

type LogLike = { address: Address; topics: readonly Hex[] | [] | [Hex, ...Hex[]]; data: Hex };
/** The two reads the check needs. A viem PublicClient fits; tests pass a stub. */
export type ReceiptChainClient = {
  getChainId: () => Promise<number>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ status: "success" | "reverted"; blockNumber: bigint; logs: readonly LogLike[] }>;
};

export type VerifyOptions = {
  client: ReceiptChainClient;
  /** The chain and payments contract this site uses. A receipt naming another one fails. */
  chainId: number;
  paymentsContract: Address;
};

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const shortHex = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const errText = (e: unknown) => (e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e)).split("\n")[0].slice(0, 200);
const notFound = (e: unknown) => {
  for (let x = e as { name?: string; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
    if (x.name === "TransactionReceiptNotFoundError" || x.name === "TransactionNotFoundError") return true;
  }
  return false;
};

/**
 * Checks a receipt (a parsed object or the raw JSON value) in this order: format, chain and contract, state, the node
 * signatures, the leaf and its proof (all local), then, for a sealed receipt, the Charged event of the charge
 * transaction read through `client` (never the Sparecycle API). Never throws.
 */
export async function verifyReceipt(raw: unknown, opts: VerifyOptions): Promise<ReceiptVerification> {
  const checks: ReceiptCheck[] = [];
  const add = (id: string, label: string, ok: boolean | null, detail: string) => {
    checks.push({ id, label, status: ok === null ? "skip" : ok ? "pass" : "fail", detail });
    return ok !== false;
  };
  const done = (outcome: ReceiptOutcome, extra: Partial<ReceiptVerification> = {}): ReceiptVerification => ({
    outcome,
    checks,
    receipt: null,
    computedLeaf: null,
    computedRoot: null,
    onchain: null,
    error: null,
    ...extra,
  });

  let r: JobReceipt;
  try {
    r = parseReceipt(raw);
    add("format", "Receipt format", true, `Sparecycle job receipt, version ${RECEIPT_VERSION}`);
  } catch (e) {
    add("format", "Receipt format", false, e instanceof ReceiptFormatError ? e.message : "could not read the receipt");
    return done("failed");
  }

  let ok = true;
  ok = add("chain", "Chain", r.chainId === opts.chainId, r.chainId === opts.chainId ? `chain id ${r.chainId}` : `the receipt names chain ${r.chainId}; this site uses chain ${opts.chainId}`) && ok;
  ok =
    add(
      "contract",
      "Payments contract",
      same(r.paymentsContract, opts.paymentsContract),
      same(r.paymentsContract, opts.paymentsContract) ? r.paymentsContract : `the receipt names ${r.paymentsContract}; this site's payments contract is ${opts.paymentsContract}`,
    ) && ok;

  // State: sealed <=> a confirmed charge holds the leaf.
  const sealedShape = r.anchor !== null && r.epochId !== null && r.chargeTx !== null && r.pending === null && r.chargeStatus !== "pending";
  const provisionalShape = r.anchor === null && r.epochId === null && r.chargeTx === null && r.pending !== null;
  // Only an agreed job is charged, unpaid or still pending; only an agreed job has an output hash.
  const chargeFits = r.verdict === "agreed" ? r.chargeStatus !== "released" : r.chargeStatus === "released" && r.outputHash === null;
  const stateOk = (r.state === "sealed" ? sealedShape : provisionalShape) && chargeFits;
  ok =
    add(
      "state",
      "State",
      stateOk,
      stateOk
        ? r.state === "sealed"
          ? `sealed in epoch ${r.epochId}`
          : "provisional"
        : "the fields do not fit together (state, verdict, charge status, output hash, anchor)",
    ) && ok;

  // Node signatures (EIP-712, domain Sparecycle v1 on the receipt's chain): over this job id.
  let sigsOk = true;
  for (const n of r.nodes) {
    const signer = await recoverReceiptSigner(
      r.chainId,
      { jobId: r.jobId, node: n.node, outputHash: n.outputHash, gpuMs: BigInt(n.gpuMs), epoch: BigInt(n.epoch) },
      n.signature,
    );
    if (!same(signer, n.node)) sigsOk = false;
  }
  // A compared job has both results; an expired one may have fewer.
  const compared = r.verdict !== "expired";
  if (compared && r.nodes.length !== 2) sigsOk = false;
  if (r.verdict === "agreed" && r.outputHash !== null && !r.nodes.some((n) => same(n.outputHash, r.outputHash))) sigsOk = false;
  ok =
    add(
      "signatures",
      "Node signatures",
      sigsOk,
      sigsOk
        ? r.nodes.length
          ? `${r.nodes.length} valid EIP-712 receipt${r.nodes.length === 1 ? "" : "s"} for this job, from ${r.nodes.map((n) => shortHex(n.node)).join(" and ")}`
          : "no node answered before the job expired"
        : "a node signature does not match its node key, this job id or the output hash",
    ) && ok;

  if (!r.anchor) {
    add("leaf", "Jobs-tree leaf", null, "not in a jobs root yet");
    add("onchain", "Charged event", null, "nothing on-chain to compare with yet");
    if (!ok) return done("failed", { receipt: r });
    return done(r.pending?.reason === "no-anchor" ? "no-anchor" : "provisional", { receipt: r });
  }

  // The leaf: its inputs must be the receipt's own fields, and it must hash to the stated leaf.
  const a = r.anchor;
  const li = a.leafInputs;
  const verdictName = codeName(LEAF_VERDICT, li.verdict);
  const chargeName = codeName(LEAF_CHARGE_STATUS, li.chargeStatus);
  const inputsMatch =
    li.epochId === r.epochId &&
    same(li.jobId, r.jobId) &&
    same(li.payer, r.payer) &&
    li.priceWei === r.priceWei &&
    verdictName === r.verdict &&
    chargeName === r.chargeStatus &&
    same(li.outputHash, r.outputHash ?? ZERO_HASH);
  const computedLeaf =
    verdictName && chargeName
      ? jobLeafOf(li.epochId, { jobId: li.jobId, payer: li.payer, priceWei: BigInt(li.priceWei), verdict: verdictName, chargeStatus: chargeName, outputHash: li.outputHash })
      : null;
  const leafOk = inputsMatch && computedLeaf !== null && same(computedLeaf, a.leaf);
  ok =
    add(
      "leaf",
      "Jobs-tree leaf",
      leafOk,
      leafOk ? `computed here from the job, wallet, price, verdict, charge status and output hash: ${shortHex(computedLeaf!)}` : "the leaf does not match the receipt's fields",
    ) && ok;
  const computedRoot = computedLeaf ? a.proof.reduce<Hex>((h, p) => hashPair(h, p), computedLeaf) : null;
  const rootOk = computedRoot !== null && same(computedRoot, a.listHash);
  ok =
    add(
      "proof",
      "Merkle proof",
      rootOk,
      rootOk ? `${a.proof.length} step${a.proof.length === 1 ? " leads" : "s lead"} to the jobs root ${shortHex(a.listHash)}` : "the proof does not lead to the jobs root in the receipt",
    ) && ok;
  if (!ok) {
    add("onchain", "Charged event", null, "not read: the receipt already fails the checks above");
    return done("failed", { receipt: r, computedLeaf, computedRoot });
  }

  // On-chain: the charge transaction's Charged event must carry this epoch and this jobs root.
  let chainId: number;
  try {
    chainId = await opts.client.getChainId();
  } catch (e) {
    add("onchain", "Charged event", null, "the RPC could not be reached");
    return done("unreachable", { receipt: r, computedLeaf, computedRoot, error: errText(e) });
  }
  if (chainId !== r.chainId) {
    add("onchain", "Charged event", false, `this RPC serves chain ${chainId}, not chain ${r.chainId}`);
    return done("failed", { receipt: r, computedLeaf, computedRoot });
  }
  let tx: Awaited<ReturnType<ReceiptChainClient["getTransactionReceipt"]>>;
  try {
    tx = await opts.client.getTransactionReceipt({ hash: r.chargeTx! });
  } catch (e) {
    if (notFound(e)) {
      add("onchain", "Charged event", false, `the charge transaction ${shortHex(r.chargeTx!)} is not on this chain`);
      return done("failed", { receipt: r, computedLeaf, computedRoot });
    }
    add("onchain", "Charged event", null, "the RPC did not answer");
    return done("unreachable", { receipt: r, computedLeaf, computedRoot, error: errText(e) });
  }
  const logs = tx.logs.filter((l) => same(l.address, r.paymentsContract)) as Parameters<typeof parseEventLogs>[0]["logs"];
  const events = tx.status === "success" ? parseEventLogs({ abi: jobPaymentsAbi, eventName: ["Charged", "CustomerCharged"], logs, strict: true }) : [];
  let charged: { listHash: Hex } | undefined;
  let paid: { amount: bigint } | undefined;
  for (const ev of events) {
    if (Number(ev.args.epochId) !== r.epochId) continue;
    if (ev.eventName === "Charged") charged ??= { listHash: ev.args.listHash };
    else if (same(ev.args.customer, r.payer)) paid ??= { amount: ev.args.amount };
  }
  const onchain = { listHash: charged?.listHash ?? null, customerCharged: paid ? paid.amount.toString() : null, blockNumber: tx.blockNumber.toString() };
  const eventOk = !!charged && same(charged.listHash, a.listHash);
  ok =
    add(
      "onchain",
      "Charged event",
      eventOk,
      eventOk
        ? `transaction ${shortHex(r.chargeTx!)} (block ${tx.blockNumber}) emitted Charged(epoch ${r.epochId}) with this jobs root`
        : !charged
          ? `transaction ${shortHex(r.chargeTx!)} has no Charged event for epoch ${r.epochId} from the payments contract`
          : `the Charged event of epoch ${r.epochId} carries another root (${shortHex(charged.listHash)})`,
    ) && ok;
  if (r.chargeStatus === "charged") {
    const covers = !!paid && paid.amount >= BigInt(r.priceWei);
    ok =
      add(
        "customer",
        "Charge to the wallet",
        covers,
        covers
          ? `CustomerCharged(epoch ${r.epochId}, ${shortHex(r.payer)}) = ${paid!.amount} wei, this job's ${r.priceWei} wei included`
          : "the transaction has no CustomerCharged event for this wallet that covers the price",
      ) && ok;
  } else {
    add("customer", "Charge to the wallet", null, `not charged (${r.chargeStatus}): nothing taken for this job`);
  }
  return done(ok ? "verified" : "failed", { receipt: r, computedLeaf, computedRoot, onchain });
}
