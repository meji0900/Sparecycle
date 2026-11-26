// Paid jobs on SparecycleJobPayments (non-custodial: balances live in the contract, never in a server wallet).
//
//   submit:  the customer signs jobPaymentMessage (EIP-191, no gas) for one job at the quoted price. The scheduler
//            accepts it when the signature is fresh and unused and the customer's available balance covers it:
//            available = contract balance - pending withdrawal - price of their unsettled and uncharged jobs.
//   verdict: agreed jobs become due; disagreed / expired / rejected jobs are released (never charged).
//   charge:  just before an epoch closes the scheduler key calls charge(epoch, customers, amounts, listHash) for all
//            due jobs: 95% lands in that epoch's reward pot, 5% in the treasury Safe.
//   listHash (hashRule "v2-jobs-merkle", feature brief #8 option B): the root of a Merkle tree over every paid / team
//            job that reached a final charge status and is not yet in a confirmed jobs root: the jobs charged now,
//            plus the jobs released (not charged) or left unpaid since the last confirmed charge, carried forward over
//            epochs that charged nothing. Leaf and codes: src/lib/job-receipt.ts. Each payer's job receipt carries a
//            proof against it (src/server/receipts.ts). /api/v1/epochs/{id}/charges serves each customer's total and
//            the leaves (no job ids, payers per job or prices: D7). Charges stored before this kept hashRule "v1"
//            (listHash = keccak256 of the JSON list of charged jobs) and are served exactly as stored.
//
// Crash safety: the list and the tree are stored (status 'sending') before the transaction and the hash right after it
// is sent; a retry first looks for that receipt or a Charged(epoch, listHash) log, so a job is never charged twice.
import { createWalletClient, getAddress, http, isAddress, recoverMessageAddress, type Address, type Hex } from "viem";
import { jobPaymentsAbi } from "@/contracts/jobPayments";
import { publicClient, targetChain } from "@/lib/chain";
import { config } from "@/lib/config";
import { JOB_PAYMENT_WINDOW_SECONDS, jobPaymentMessage, jobRequestHash } from "@/lib/job-payment";
import {
  buildJobsTree,
  JOBS_HASH_RULE,
  JOBS_LEAF_RULE,
  LEAF_CHARGE_STATUS,
  LEAF_VERDICT,
  type JobLeafEntry,
  type LeafChargeStatus,
  type LeafVerdict,
} from "@/lib/job-receipt";
import { buildTree } from "@/lib/merkle";
import { describeChainError, schedulerAccount } from "./chain-io";
import { getDb, nowSec, tx } from "./db";
import { ApiError } from "./http";

export const paymentsAddress = (): Address | null => config.jobPayments;
export const priceWeiPerUnit = (): bigint => config.jobPriceWeiPerUnit;

/** Wallets whose paid jobs are the team's own test jobs: shown publicly as "team-funded". */
export const teamWallets = (): Set<string> =>
  new Set(
    (process.env.TEAM_JOB_WALLETS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
  );

const UNSETTLED = "('queued','running','checking','agreed')";

/** Price of this payer's jobs that are not yet charged and may still be (unsettled or agreed). */
export function heldFor(payer: Address): bigint {
  const rows = getDb()
    .prepare(`SELECT price_wei FROM jobs WHERE payer = ? AND charge_status = 'pending' AND status IN ${UNSETTLED}`)
    .all(payer) as { price_wei: string }[];
  return rows.reduce((s, r) => s + BigInt(r.price_wei), 0n);
}

export async function readAccount(payer: Address) {
  const address = paymentsAddress();
  if (!address) throw new ApiError(503, "payments-off", "paid jobs are not enabled on this scheduler");
  const c = { address, abi: jobPaymentsAbi } as const;
  const [balance, spendLimit, request, canWithdraw] = await Promise.all([
    publicClient.readContract({ ...c, functionName: "balanceOf", args: [payer] }),
    publicClient.readContract({ ...c, functionName: "spendLimitPerEpoch", args: [payer] }),
    publicClient.readContract({ ...c, functionName: "withdrawRequestOf", args: [payer] }),
    publicClient.readContract({ ...c, functionName: "canWithdraw", args: [payer] }),
  ]);
  const [withdrawAmount, withdrawEpoch, withdrawRequestedAt] = request;
  const held = heldFor(payer);
  const locked = held + withdrawAmount;
  return {
    balance,
    spendLimit,
    withdrawAmount,
    withdrawEpoch,
    withdrawRequestedAt,
    canWithdraw,
    held,
    available: balance > locked ? balance - locked : 0n,
  };
}

/** GET /api/v1/payments/account?address= */
export async function accountJson(addressRaw: string | null) {
  if (!addressRaw || !isAddress(addressRaw)) throw new ApiError(400, "invalid-address", "address must be a wallet address");
  const payer = getAddress(addressRaw);
  const a = await readAccount(payer);
  return {
    address: payer,
    contract: paymentsAddress(),
    priceWeiPerUnit: priceWeiPerUnit().toString(),
    balance: a.balance.toString(),
    held: a.held.toString(),
    available: a.available.toString(),
    spendLimitPerEpoch: a.spendLimit.toString(),
    withdrawal:
      a.withdrawAmount > 0n
        ? { amount: a.withdrawAmount.toString(), epoch: Number(a.withdrawEpoch), requestedAt: Number(a.withdrawRequestedAt), ready: a.canWithdraw }
        : null,
  };
}

export type Payment = { payer: Address; signature: Hex; issued: number; priceWei: bigint };

/** Checks a paid job's payment block against its request and the customer's available balance. */
export async function verifyPayment(
  request: unknown,
  paymentRaw: unknown,
  price: bigint,
): Promise<Payment & { balance: bigint; withdrawAmount: bigint }> {
  const contract = paymentsAddress();
  if (!contract) throw new ApiError(503, "payments-off", "paid jobs are not enabled on this scheduler");
  const p = (paymentRaw ?? {}) as Record<string, unknown>;
  const payer = typeof p.payer === "string" && isAddress(p.payer) ? getAddress(p.payer) : null;
  const signature = typeof p.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(p.signature) ? (p.signature.toLowerCase() as Hex) : null;
  const issued = typeof p.issued === "number" && Number.isInteger(p.issued) ? p.issued : null;
  const priceWei = typeof p.priceWei === "string" && /^\d{1,30}$/.test(p.priceWei) ? BigInt(p.priceWei) : null;
  if (!payer || !signature || issued === null || priceWei === null) {
    throw new ApiError(400, "invalid-payment", "payment needs payer, signature, issued (unix seconds) and priceWei (string)");
  }
  const now = nowSec();
  if (issued > now + 60 || now - issued > JOB_PAYMENT_WINDOW_SECONDS) {
    throw new ApiError(400, "stale-payment", `payment signatures are valid for ${JOB_PAYMENT_WINDOW_SECONDS} s; sign again`);
  }
  if (priceWei !== price) {
    throw new ApiError(409, "price-changed", `this job costs ${price} wei; sign again at that price`, { priceWei: price.toString() });
  }
  const message = jobPaymentMessage({ chainId: targetChain.id, contract, requestHash: jobRequestHash(request), priceWei, issued });
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message, signature });
  } catch {
    throw new ApiError(401, "bad-payment-signature", "payment signature could not be recovered");
  }
  if (signer.toLowerCase() !== payer.toLowerCase()) throw new ApiError(401, "bad-payment-signature", "payment is not signed by the payer");
  const seen = getDb().prepare("SELECT 1 FROM jobs WHERE payment_sig = ?").get(signature);
  if (seen) throw new ApiError(409, "payment-used", "this payment signature already paid for a job");
  const acct = await readAccount(payer);
  if (acct.available < price) {
    throw new ApiError(402, "insufficient-balance", `available balance ${acct.available} wei is below the price ${price} wei`, {
      available: acct.available.toString(),
      priceWei: price.toString(),
    });
  }
  return { payer, signature, issued, priceWei, balance: acct.balance, withdrawAmount: acct.withdrawAmount };
}

// ---- Charging -----------------------------------------------------------------------------------------

type DueJob = { id: string; payer: Address; price_wei: string; api_key_id: string | null; output_hash: string | null };
type ChargeRow = {
  epoch_id: number;
  list_json: string;
  list_hash: Hex;
  total_wei: string;
  status: string;
  tx: Hex | null;
  error: string | null;
  hash_rule: string;
};
/**
 * One charged job. `apiKeyId` (the key that paid for it, null = a per-job wallet signature) is in every entry of lists
 * charged since API keys exist; older stored lists don't have the field and are served exactly as stored, so their
 * listHash still matches. For a v2 charge the list stays internal (it marks the jobs charged); the public answer is
 * per-customer totals and the jobs-tree leaves.
 */
type ListEntry = { jobId: string; payer: Address; priceWei: string; apiKeyId?: string | null };

/** The v1 rule, as v1 lists are served. */
const V1_HASH_RULE = "keccak256(utf8(JSON.stringify(jobs))) with jobs sorted by jobId";

const isHex32 = (v: string | null): v is Hex => !!v && /^0x[0-9a-fA-F]{64}$/.test(v);

function markCharged(epochId: number, list: ListEntry[], txHash: Hex) {
  tx((db) => {
    const up = db.prepare("UPDATE jobs SET charge_status = 'charged', charged_epoch = ? WHERE id = ? AND charge_status = 'pending'");
    for (const e of list) up.run(epochId, e.jobId);
    // Every job whose leaf this confirmed charge committed now has a sealed receipt (v1 charges have no leaves).
    db.prepare("UPDATE jobs SET receipt_epoch = ? WHERE receipt_epoch IS NULL AND id IN (SELECT job_id FROM charge_leaves WHERE epoch_id = ?)").run(
      epochId,
      epochId,
    );
    db.prepare("UPDATE charges SET status = 'done', tx = ?, error = NULL WHERE epoch_id = ?").run(txHash, epochId);
  });
}

/** Forgets an unsent or unconfirmed charge attempt and its jobs tree (`status` = the row status to delete). */
function dropCharge(epochId: number, status: "sending" | "failed") {
  tx((db) => {
    const gone = db.prepare("DELETE FROM charges WHERE epoch_id = ? AND status = ?").run(epochId, status);
    if (Number(gone.changes) > 0) db.prepare("DELETE FROM charge_leaves WHERE epoch_id = ?").run(epochId);
  });
}

/**
 * The jobs-tree entries of a charge: the jobs charged now, plus every paid / team job whose final charge status is
 * released or unpaid and that no confirmed jobs root holds yet (since the last charge; on the first v2 charge this
 * also takes such jobs settled before receipts existed).
 */
function jobsTreeEntries(list: ListEntry[], dueById: Map<string, DueJob>): JobLeafEntry[] {
  const entries: JobLeafEntry[] = list.map((e) => {
    const out = dueById.get(e.jobId)?.output_hash ?? null;
    return { jobId: e.jobId as Hex, payer: getAddress(e.payer), priceWei: BigInt(e.priceWei), verdict: "agreed", chargeStatus: "charged", outputHash: isHex32(out) ? out : null };
  });
  const rows = getDb()
    .prepare(
      `SELECT id, payer, price_wei, status, charge_status, output_hash FROM jobs
       WHERE payer IS NOT NULL AND receipt_epoch IS NULL AND charge_status IN ('released','unpaid') ORDER BY id`,
    )
    .all() as { id: string; payer: string; price_wei: string | null; status: string; charge_status: LeafChargeStatus; output_hash: string | null }[];
  for (const r of rows) {
    if (!(r.status in LEAF_VERDICT) || !(r.charge_status in LEAF_CHARGE_STATUS) || !isAddress(r.payer) || !/^\d{1,78}$/.test(r.price_wei ?? "")) {
      console.error(`[sparecycle] job ${r.id}: not put in a jobs tree (status ${r.status}, charge ${r.charge_status})`);
      continue;
    }
    const verdict = r.status as LeafVerdict;
    entries.push({
      jobId: r.id as Hex,
      payer: getAddress(r.payer),
      priceWei: BigInt(r.price_wei!),
      verdict,
      chargeStatus: r.charge_status,
      outputHash: verdict === "agreed" && isHex32(r.output_hash) ? r.output_hash : null,
    });
  }
  return entries;
}

/** Resolves a charge left 'sending' by an earlier attempt. Returns true when it is settled (done). */
async function resolveSending(row: ChargeRow, contract: Address): Promise<boolean> {
  const list = JSON.parse(row.list_json) as ListEntry[];
  if (row.tx) {
    const receipt = await publicClient.getTransactionReceipt({ hash: row.tx }).catch(() => null);
    if (receipt?.status === "success") {
      markCharged(row.epoch_id, list, row.tx);
      return true;
    }
    if (!receipt) {
      // Not mined (yet): wait for it rather than risk a second charge.
      const r = await publicClient.waitForTransactionReceipt({ hash: row.tx, timeout: 180_000 });
      if (r.status === "success") {
        markCharged(row.epoch_id, list, row.tx);
        return true;
      }
    }
  } else {
    // Crashed between storing the list and learning the hash: look for the event on-chain.
    // Public RPCs cap log queries at 10M blocks; Robinhood Chain makes ~9 blocks/s, so 9M blocks is ~11 days.
    const head = await publicClient.getBlockNumber();
    const logs = await publicClient.getContractEvents({
      address: contract,
      abi: jobPaymentsAbi,
      eventName: "Charged",
      args: { epochId: BigInt(row.epoch_id), listHash: row.list_hash },
      fromBlock: head > 9_000_000n ? head - 9_000_000n : 0n,
      toBlock: head,
    });
    if (logs.length) {
      markCharged(row.epoch_id, list, logs[0].transactionHash as Hex);
      return true;
    }
  }
  dropCharge(row.epoch_id, "sending");
  return false;
}

/**
 * Charges every due paid job into the open epoch `epochId` (call right before closing it). Never throws for an
 * on-chain failure: it returns a one-line summary, and due jobs stay pending for the next close.
 */
export async function chargeOpenEpoch(epochId: number): Promise<string> {
  const contract = paymentsAddress();
  const account = schedulerAccount();
  if (!contract) return "payments off";
  if (!account) return "SCHEDULER_SIGNER_KEY not set: no charge";
  const db = getDb();

  const prev = db.prepare("SELECT * FROM charges WHERE epoch_id = ?").get(epochId) as ChargeRow | undefined;
  if (prev?.status === "done") return `epoch ${epochId} already charged (${prev.tx})`;
  if (prev?.status === "sending") {
    try {
      if (await resolveSending(prev, contract)) return `epoch ${epochId} charge confirmed (${prev.tx ?? "found by event"})`;
    } catch (e) {
      // Unknown outcome of an earlier send: stop here rather than risk charging the same jobs twice.
      return `earlier charge of epoch ${epochId} still unresolved: ${describeChainError(e)}`;
    }
  }
  if (prev?.status === "failed") dropCharge(epochId, "failed");

  // Settled without agreement: never charged.
  db.prepare(
    "UPDATE jobs SET charge_status = 'released' WHERE charge_status = 'pending' AND status IN ('disagreed','expired','rejected')",
  ).run();
  const due = db
    .prepare(
      "SELECT id, payer, price_wei, api_key_id, output_hash FROM jobs WHERE charge_status = 'pending' AND status = 'agreed' ORDER BY settled_at, id",
    )
    .all() as DueJob[];
  if (!due.length) return "no paid jobs to charge";

  // Budget per payer: contract balance, and the payer's own per-epoch limit minus what this epoch already took.
  const c = { address: contract, abi: jobPaymentsAbi } as const;
  const payers = [...new Set(due.map((j) => j.payer))];
  const budget = new Map<string, { balance: bigint; room: bigint | null }>();
  for (const p of payers) {
    const [balance, limit, already] = await Promise.all([
      publicClient.readContract({ ...c, functionName: "balanceOf", args: [p] }),
      publicClient.readContract({ ...c, functionName: "spendLimitPerEpoch", args: [p] }),
      publicClient.readContract({ ...c, functionName: "chargedInEpoch", args: [p, BigInt(epochId)] }),
    ]);
    budget.set(p, { balance, room: limit === 0n ? null : limit > already ? limit - already : 0n });
  }
  const list: ListEntry[] = [];
  const unpaid: string[] = [];
  const sum = new Map<string, bigint>();
  for (const j of due) {
    const b = budget.get(j.payer)!;
    const next = (sum.get(j.payer) ?? 0n) + BigInt(j.price_wei);
    if (next > b.balance) unpaid.push(j.id); // the customer withdrew below what they signed for
    else if (b.room !== null && next > b.room) continue; // over their per-epoch limit: next epoch
    else {
      sum.set(j.payer, next);
      list.push({ jobId: j.id, payer: j.payer, priceWei: j.price_wei, apiKeyId: j.api_key_id ?? null });
    }
  }
  if (unpaid.length) {
    const up = db.prepare("UPDATE jobs SET charge_status = 'unpaid' WHERE id = ?");
    tx(() => unpaid.forEach((id) => up.run(id)));
  }
  // D6 (feature brief): agreed jobs left unpaid still count for node payouts; the count goes in the operator log.
  const unpaidNote = unpaid.length ? `; ${unpaid.length} agreed job(s) unpaid: the balance was withdrawn before the charge` : "";
  // No charge, no Charged event: released / unpaid jobs wait for the next charge's jobs root (D15).
  if (!list.length) return `no chargeable jobs (${unpaid.length} unpaid, rest over spend limits)`;

  list.sort((a, b) => (a.jobId < b.jobId ? -1 : 1));
  // listHash = the jobs root (v2): the jobs charged now plus the not-charged ones since the last confirmed charge.
  let built: ReturnType<typeof buildJobsTree>;
  try {
    built = buildJobsTree(epochId, jobsTreeEntries(list, new Map(due.map((j) => [j.id, j]))));
  } catch (e) {
    // Never block the epoch close: nothing was sent, the jobs stay due for the next close.
    return `charge not sent: jobs tree failed: ${e instanceof Error ? e.message : String(e)}${unpaidNote}`;
  }
  const { tree, leaves } = built;
  const listHash = tree.root;
  const customers = [...sum.keys()].map((p) => getAddress(p));
  const amounts = customers.map((p) => sum.get(p)!);
  const total = amounts.reduce((s, a) => s + a, 0n);
  tx(() => {
    // No confirmed or in-flight charge of this epoch exists here, so any leaves left for it are stale.
    db.prepare("DELETE FROM charge_leaves WHERE epoch_id = ?").run(epochId);
    db.prepare(
      "INSERT INTO charges (epoch_id, list_json, list_hash, total_wei, status, created_at, hash_rule) VALUES (?, ?, ?, ?, 'sending', ?, ?)",
    ).run(epochId, JSON.stringify(list), listHash, total.toString(), nowSec(), JOBS_HASH_RULE);
    const ins = db.prepare(
      "INSERT INTO charge_leaves (epoch_id, job_id, payer, price_wei, verdict, charge_status, output_hash, leaf) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const l of leaves) ins.run(epochId, l.jobId, l.payer, l.priceWei.toString(), l.verdict, l.chargeStatus, l.outputHash, l.leaf);
  });
  try {
    const { request } = await publicClient.simulateContract({
      account,
      ...c,
      functionName: "charge",
      args: [BigInt(epochId), customers, amounts, listHash],
    });
    const wallet = createWalletClient({ account, chain: targetChain, transport: http(targetChain.rpcUrls.default.http[0]) });
    const hash = await wallet.writeContract(request);
    db.prepare("UPDATE charges SET tx = ? WHERE epoch_id = ?").run(hash, epochId);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`charge transaction ${hash} reverted`);
    markCharged(epochId, list, hash);
    return `charged ${list.length} jobs from ${customers.length} customers, ${total} wei, jobs root over ${leaves.length} jobs (tx ${hash})${unpaidNote}`;
  } catch (e) {
    const msg = describeChainError(e);
    const row = db.prepare("SELECT tx FROM charges WHERE epoch_id = ?").get(epochId) as { tx: Hex | null };
    // A sent transaction keeps 'sending' so the next attempt resolves it instead of charging again.
    if (row.tx) db.prepare("UPDATE charges SET error = ? WHERE epoch_id = ?").run(msg, epochId);
    else db.prepare("UPDATE charges SET status = 'failed', error = ? WHERE epoch_id = ?").run(msg, epochId);
    return `charge failed: ${msg}${unpaidNote}`;
  }
}

/** The sorted leaves of a charge's jobs tree (layer 0 of the tree whose root is the charge's listHash). */
export function chargeLeaves(epochId: number): Hex[] {
  const rows = getDb().prepare("SELECT leaf FROM charge_leaves WHERE epoch_id = ?").all(epochId) as { leaf: Hex }[];
  return buildTree(rows.map((r) => r.leaf)).layers[0];
}

/**
 * GET /api/v1/epochs/:id/charges — what an epoch's charge committed.
 *   v2 ("v2-jobs-merkle"): each customer's total (equal to the CustomerCharged events) and the sorted leaves of the jobs
 *      tree, whose root is the listHash of the Charged event. No job ids, per-job payers or prices (D7): a payer proves
 *      their own job with its receipt (GET /api/v1/jobs/:id/receipt).
 *   v1 (charges stored before job receipts): the per-job list exactly as stored; its keccak256 is the listHash.
 *   none: nothing was charged in this epoch (no Charged event).
 */
export function chargesJson(epochId: number) {
  const row = getDb().prepare("SELECT * FROM charges WHERE epoch_id = ?").get(epochId) as ChargeRow | undefined;
  if (!row) return { epochId, status: "none", jobs: [], totalWei: "0", listHash: null, tx: null };
  if (row.hash_rule !== JOBS_HASH_RULE) {
    return {
      epochId,
      status: row.status,
      listHash: row.list_hash,
      totalWei: row.total_wei,
      tx: row.tx,
      jobs: JSON.parse(row.list_json) as ListEntry[],
      hashRule: V1_HASH_RULE,
    };
  }
  const totals = new Map<string, bigint>();
  for (const e of JSON.parse(row.list_json) as ListEntry[]) {
    const who = getAddress(e.payer);
    totals.set(who, (totals.get(who) ?? 0n) + BigInt(e.priceWei));
  }
  return {
    epochId,
    status: row.status,
    hashRule: JOBS_HASH_RULE,
    listHash: row.list_hash,
    totalWei: row.total_wei,
    tx: row.tx,
    customers: [...totals]
      .sort(([a], [b]) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
      .map(([customer, amount]) => ({ customer, amountWei: amount.toString() })),
    leaves: chargeLeaves(epochId),
    leafRule: JOBS_LEAF_RULE,
    codes: { verdict: LEAF_VERDICT, chargeStatus: LEAF_CHARGE_STATUS },
  };
}
