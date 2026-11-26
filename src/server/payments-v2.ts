// Paid jobs on SparecycleJobPaymentsV2 (TOKEN_PAYMENTS_V2=on with TOKEN_JOB_PAYMENTS_V2_ADDRESS; contract and decisions:
// docs/contracts-v2.md). Off by default: then nothing here runs and every answer is exactly what ./payments gives.
// AUDIT REQUIRED BEFORE MAINNET: V2 is not deployed yet; this only prepares the scheduler for it.
//
//   Which contract holds a customer's money: a paid job is charged on V1 or V2, never both (jobs.pay_contract).
//     - A wallet-signed job names its contract in the signed message (`Payments contract:`). The dapp signs for V2
//       when the V2 balance covers the job and for V1 otherwise ("V2 first"); an old client that signs for V1 keeps
//       working. The payment block may say `contract` (an address) and `asset` ("eth" | "spare").
//     - An API-key job is routed here: V2 when its ETH balance covers the price, else V1.
//     - V1 balances stay usable and withdrawable; new deposits in the dapp go to V2.
//   Credits first (N21): V2 spends holder credits before deposits, and credits can never be withdrawn, so
//       available (ETH) = credits left after the holds + max(0, deposits - pending withdrawal - holds not met by credits).
//   SPARE (0% discount, decided by the owner on 26-27 Nov 2026): a SPARE-paid job costs its ETH price in SPARE at the
//       epoch's accepted price. Held amounts are in SPARE at the reference price (the last accepted one).
//   Charging, at each epoch close (after V1's charge, before the root is read):
//     1. the SPARE price: postSparePrice(epoch, price) once per epoch, price = the pool's spot price from StateView
//        slot0 of the verified pool key (UNISWAP_V4), minus nothing: the contract checks it against the reference and
//        pauses SPARE charges for the epoch when it is outside the band. No reference set by the Safe yet: nothing is
//        posted and the SPARE leg is skipped.
//     2. one transaction: chargeWithSpare (ETH leg + SPARE leg) or charge (ETH only), committed to one jobs root
//        (the same "v2-jobs-merkle" rule as V1, over V2's jobs only), so V2 emits one Charged per epoch.
//        minEthOut = the sold SPARE's value at the posted price x (1 - hook cut - SPARE_SALE_BUFFER_BPS), never below
//        the contract's floor or what the pot needs beyond the cover. previewSpareLeg is asked first.
//     3. SPARE jobs that cannot be charged this epoch (no reference, price not posted or paused, cap reached, the sale
//        would not fill, the customer's SPARE balance or spend limit) wait for the next close with the reason on their
//        invoice (jobs.pay_wait); never charged at a wrong price. After SPARE_MAX_WAIT_EPOCHS closes they are marked
//        unpaid (D6: still paid to nodes, never taken from the customer).
import {
  createWalletClient,
  getAddress,
  http,
  isAddress,
  recoverMessageAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { jobPaymentsV2Abi, SPARE_STATUS, type SpareStatusName } from "@/contracts/jobPaymentsV2";
import { UNISWAP_V4 } from "@/lib/addresses";
import { publicClient, targetChain } from "@/lib/chain";
import { ethValueOfSpare, jobPaymentMessage, jobRequestHash, SPARE_PRICE_UNIT, spareForWei, type PayAsset } from "@/lib/job-payment";
import { buildJobsTree, JOBS_HASH_RULE, JOBS_LEAF_RULE, LEAF_CHARGE_STATUS, LEAF_VERDICT } from "@/lib/job-receipt";
import { describeChainError, schedulerAccount, sendAsScheduler, tokenChain } from "./chain-io";
import { getDb, nowSec, tx } from "./db";
import { serverEnv } from "./env";
import { ApiError } from "./http";
import {
  accountJson,
  assertSignatureUnused,
  chargeLeaves,
  customerTotals,
  dropCharge,
  heldFor,
  jobsTreeEntries,
  markCharged,
  parsePaymentBlock,
  paymentsAddress,
  priceWeiPerUnit,
  readAccount,
  releaseUnagreed,
  resolveSending,
  storeLeaves,
  UNSETTLED,
  verifyPayment,
  type ChargeRow,
  type Ledger,
  type ListEntry,
} from "./payments";

// ---- Settings -----------------------------------------------------------------------------------------------------

/** A SPARE job not charged after waiting through this many epoch closes is marked unpaid (never charged). */
export const SPARE_MAX_WAIT_EPOCHS = 8;
/**
 * What the scheduler asks of a SPARE sale on top of the pool hook's cut (UNISWAP_V4.spareEthPoolHookCutBps = 290):
 * room for price impact and movement since the price was posted. 290 + 100 bps stays inside the contract's 4% floor.
 */
export const SPARE_SALE_BUFFER_BPS = 100;
const BPS = 10_000n;
const Q96 = 1n << 96n;
const ON_V2 = "pay_contract = 'v2'";

/** SparecycleJobPaymentsV2's address when TOKEN_PAYMENTS_V2=on and TOKEN_JOB_PAYMENTS_V2_ADDRESS is valid; else null. */
export function v2Address(): Address | null {
  if (!serverEnv.tokenPaymentsV2()) return null;
  const v = (process.env.TOKEN_JOB_PAYMENTS_V2_ADDRESS ?? "").trim();
  return v && isAddress(v, { strict: false }) ? getAddress(v) : null;
}

export const v2Ledger = (address: Address): Ledger => ({ key: "v2", table: "v2_charges", address, abi: jobPaymentsV2Abi, jobsWhere: ON_V2 });

/** Paid jobs are on when either contract is: V1 (NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS) or V2 (the flag). */
export const paidJobsOn = (): boolean => paymentsAddress() !== null || v2Address() !== null;

const v2c = (address: Address) => ({ address, abi: jobPaymentsV2Abi }) as const;

// ---- Pure rules (unit-tested in ./payments-v2.test.ts) -----------------------------------------------------------

/**
 * V2's spendable ETH for new jobs, credits first (N21): holds are paid from credits before deposits, and a pending
 * withdrawal locks only deposits (credits can never be withdrawn).
 */
export function v2EthAvailable(a: { credits: bigint; balance: bigint; withdrawAmount: bigint; held: bigint }): bigint {
  const fromCredits = a.held < a.credits ? a.held : a.credits;
  const fromDeposits = a.held - fromCredits;
  const depositsLeft = a.balance - a.withdrawAmount - fromDeposits;
  return a.credits - fromCredits + (depositsLeft > 0n ? depositsLeft : 0n);
}

/** Spendable SPARE for new jobs: balance minus a pending SPARE withdrawal minus what SPARE jobs hold. */
export function v2SpareAvailable(a: { balance: bigint; withdrawAmount: bigint; held: bigint }): bigint {
  const left = a.balance - a.withdrawAmount - a.held;
  return left > 0n ? left : 0n;
}

/** Wei of ETH per 10^18 SPARE base units from the pool's sqrtPriceX96 (currency0 = native ETH, currency1 = SPARE). */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  return (((SPARE_PRICE_UNIT * Q96) / sqrtPriceX96) * Q96) / sqrtPriceX96;
}

/**
 * The SPARE sale's minimum: the sold SPARE's value at the posted price minus the hook cut and SPARE_SALE_BUFFER_BPS,
 * raised to the contract's floor and to what the pot needs beyond the cover (so the leg never needs more cover than
 * it has: then it fails at the adapter and waits instead of underpaying).
 */
export function minEthOutFor(p: { soldSpare: bigint; price: bigint; hookCutBps: number; bufferBps: number; floor: bigint; potRequired: bigint; cover: bigint }): bigint {
  const value = (p.soldSpare * p.price) / SPARE_PRICE_UNIT;
  let m = (value * (BPS - BigInt(p.hookCutBps) - BigInt(p.bufferBps))) / BPS;
  if (m < p.floor) m = p.floor;
  const need = p.potRequired > p.cover ? p.potRequired - p.cover : 0n;
  return m < need ? need : m;
}

/** Why a SPARE-paid job was not charged at a close (jobs.pay_wait). */
export type WaitReason = "no-reference" | "not-posted" | "paused" | "cap" | "sale" | "spare-balance" | "spend-limit";

/** The customer-facing reason, in plain words. */
export const WAIT_TEXT: Record<WaitReason, string> = {
  "no-reference":
    "SPARE payments have not started: the treasury Safe has not set the first SPARE reference price yet. The job waits and is charged at the first epoch close with an accepted price.",
  "not-posted": "The scheduler could not post this epoch's SPARE price. Nothing was charged; the job waits for the next epoch close.",
  paused:
    "This epoch's SPARE price moved more than the allowed band from the reference price, so SPARE charges are paused for the epoch. Nothing was charged; the job waits for the next epoch close.",
  cap: "This epoch's cap on SPARE-paid volume was reached. Nothing was charged; the job waits for the next epoch close.",
  sale: "The SPARE sale could not fill at an acceptable price this epoch (the pool moved). Nothing was charged; the job waits for the next epoch close.",
  "spare-balance": `Your SPARE balance does not cover this job at this epoch's SPARE price. Add SPARE: the job is tried again at the next epoch close (after ${SPARE_MAX_WAIT_EPOCHS} closes it is not charged at all).`,
  "spend-limit": "Your spend limit for this epoch was reached; the job is charged in a later epoch.",
};

const COUNTED: Record<WaitReason, boolean> = {
  "no-reference": true,
  "not-posted": true,
  paused: true,
  cap: true,
  sale: true,
  "spare-balance": true,
  "spend-limit": false, // the customer's own limit: waits like an ETH job over its limit, never runs out
};

/** previewSpareLeg's verdict as a wait reason (null = ok). */
export function waitOfStatus(s: SpareStatusName): WaitReason | null {
  switch (s) {
    case "ok":
      return null;
    case "no-price":
      return "not-posted";
    case "paused":
      return "paused";
    case "cap":
      return "cap";
    default:
      return "sale"; // min-out or shortfall: the sale cannot pay the pot at an acceptable price
  }
}

export type V2Due = { id: string; payer: Address; priceWei: bigint; asset: PayAsset; waits: number };
/** One payer's room at the close: ETH = credits + deposits; room = ETH-value spend-limit room (shared by both legs). */
export type V2Budget = { eth: bigint; room: bigint | null; spare: bigint; spareRoom: bigint | null };
export type V2Plan = {
  eth: V2Due[];
  spare: (V2Due & { spareWei: bigint })[];
  /** Agreed jobs that will not be charged: ETH balance withdrawn, or a SPARE job past SPARE_MAX_WAIT_EPOCHS. */
  unpaid: { id: string; reason: WaitReason | "balance" }[];
  waits: { id: string; reason: WaitReason; counts: boolean }[];
};

/**
 * Splits V2's due jobs (in charge order) into the ETH leg, the SPARE leg, waits and unpaid, per payer and per leg the
 * way the contract will check them: ETH jobs against credits + deposits (unpaid when not covered: withdrawn), both legs
 * against the payer's ETH-value spend limit (over it: next epoch), SPARE jobs against the SPARE balance and the SPARE
 * spend limit at `price` (the epoch's accepted price; per payer the contract takes ceil(total x 10^18 / price)) and
 * against the epoch's SPARE cap. `blocked` = the SPARE leg cannot run this epoch at all.
 */
export function planV2Charge(input: {
  due: V2Due[];
  budgets: Map<string, V2Budget>;
  price: bigint | null;
  blocked: WaitReason | null;
  capRoom: bigint;
  maxWaits?: number;
}): V2Plan {
  const maxWaits = input.maxWaits ?? SPARE_MAX_WAIT_EPOCHS;
  const plan: V2Plan = { eth: [], spare: [], unpaid: [], waits: [] };
  const ethSum = new Map<string, bigint>();
  const used = new Map<string, bigint>();
  const spareValue = new Map<string, bigint>();
  let capUsed = 0n;
  const wait = (j: V2Due, reason: WaitReason) => {
    const counts = COUNTED[reason];
    if (counts && j.waits >= maxWaits) plan.unpaid.push({ id: j.id, reason });
    else plan.waits.push({ id: j.id, reason, counts });
  };
  for (const j of input.due) {
    const key = j.payer.toLowerCase();
    const b = input.budgets.get(key) ?? { eth: 0n, room: 0n, spare: 0n, spareRoom: 0n };
    const u = used.get(key) ?? 0n;
    if (j.asset === "eth") {
      const next = (ethSum.get(key) ?? 0n) + j.priceWei;
      if (next > b.eth) plan.unpaid.push({ id: j.id, reason: "balance" }); // withdrew below what they signed for
      else if (b.room !== null && u + j.priceWei > b.room) continue; // over their per-epoch limit: next epoch (as V1)
      else {
        ethSum.set(key, next);
        used.set(key, u + j.priceWei);
        plan.eth.push(j);
      }
      continue;
    }
    const price = input.price;
    if (input.blocked || price === null || price <= 0n) {
      wait(j, input.blocked ?? "not-posted");
      continue;
    }
    const nextValue = (spareValue.get(key) ?? 0n) + j.priceWei;
    const need = spareForWei(nextValue, price);
    if (b.room !== null && u + j.priceWei > b.room) wait(j, "spend-limit");
    else if (b.spareRoom !== null && need > b.spareRoom) wait(j, "spend-limit");
    else if (need > b.spare) wait(j, "spare-balance");
    else if (capUsed + j.priceWei > input.capRoom) wait(j, "cap");
    else {
      spareValue.set(key, nextValue);
      used.set(key, u + j.priceWei);
      capUsed += j.priceWei;
      plan.spare.push({ ...j, spareWei: spareForWei(j.priceWei, price) });
    }
  }
  return plan;
}

/** Per-payer totals of a leg, in first-seen order: the arrays the contract takes. */
function legArrays(jobs: { payer: Address; priceWei: bigint }[]): { customers: Address[]; amounts: bigint[] } {
  const m = new Map<string, { who: Address; sum: bigint }>();
  for (const j of jobs) {
    const k = j.payer.toLowerCase();
    const cur = m.get(k) ?? { who: getAddress(j.payer), sum: 0n };
    cur.sum += j.priceWei;
    m.set(k, cur);
  }
  return { customers: [...m.values()].map((v) => v.who), amounts: [...m.values()].map((v) => v.sum) };
}

// ---- Holds and accounts ------------------------------------------------------------------------------------------

/** Prices (ETH wei) of this payer's V2 jobs of `asset` that are not yet charged and may still be. */
function heldPricesV2(payer: Address, asset: PayAsset): bigint[] {
  const rows = getDb()
    .prepare(
      `SELECT price_wei FROM jobs WHERE payer = ? AND charge_status = 'pending' AND status IN ${UNSETTLED} AND ${ON_V2}
       AND COALESCE(pay_asset, 'eth') = ?`,
    )
    .all(payer, asset) as { price_wei: string }[];
  return rows.map((r) => BigInt(r.price_wei));
}

const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);

/** SPARE held for this payer's SPARE jobs at `price` (each job rounded up, as it will be charged). */
const heldSpareAt = (payer: Address, price: bigint) => sum(heldPricesV2(payer, "spare").map((p) => spareForWei(p, price)));

/** Whether SPARE payments are open (reference set by the Safe, cap above 0) and the hold price (the reference). */
async function spareTerms(address: Address): Promise<{ price: bigint | null; open: boolean; cap: bigint }> {
  const c = v2c(address);
  const [ref, cap] = await Promise.all([
    publicClient.readContract({ ...c, functionName: "referenceSparePrice" }),
    publicClient.readContract({ ...c, functionName: "spareCapEthPerEpoch" }),
  ]);
  return { price: ref > 0n ? ref : null, open: ref > 0n && cap > 0n, cap };
}

export async function readAccountV2(payer: Address) {
  const address = v2Address();
  if (!address) throw new ApiError(503, "payments-off", "V2 payments are not enabled on this scheduler");
  const c = v2c(address);
  const [balance, credits, spendLimit, request, canWithdraw, spareBalance, spareSpendLimit, spareRequest, canWithdrawSpare, spareToken, terms] =
    await Promise.all([
      publicClient.readContract({ ...c, functionName: "balanceOf", args: [payer] }),
      publicClient.readContract({ ...c, functionName: "creditOf", args: [payer] }),
      publicClient.readContract({ ...c, functionName: "spendLimitPerEpoch", args: [payer] }),
      publicClient.readContract({ ...c, functionName: "withdrawRequestOf", args: [payer] }),
      publicClient.readContract({ ...c, functionName: "canWithdraw", args: [payer] }),
      publicClient.readContract({ ...c, functionName: "spareBalanceOf", args: [payer] }),
      publicClient.readContract({ ...c, functionName: "spareSpendLimitPerEpoch", args: [payer] }),
      publicClient.readContract({ ...c, functionName: "spareWithdrawRequestOf", args: [payer] }),
      publicClient.readContract({ ...c, functionName: "canWithdrawSpare", args: [payer] }),
      publicClient.readContract({ ...c, functionName: "spare" }),
      spareTerms(address),
    ]);
  const [withdrawAmount, withdrawEpoch, withdrawRequestedAt] = request;
  const [spareWithdrawAmount, spareWithdrawEpoch, spareWithdrawRequestedAt] = spareRequest;
  const held = sum(heldPricesV2(payer, "eth"));
  const heldSpareJobs = heldPricesV2(payer, "spare");
  const heldSpare = terms.price ? sum(heldSpareJobs.map((p) => spareForWei(p, terms.price!))) : 0n;
  return {
    address,
    spareToken: getAddress(spareToken),
    balance,
    credits,
    spendLimit,
    withdrawAmount,
    withdrawEpoch,
    withdrawRequestedAt,
    canWithdraw,
    held,
    available: v2EthAvailable({ credits, balance, withdrawAmount, held }),
    spare: {
      balance: spareBalance,
      spendLimit: spareSpendLimit,
      withdrawAmount: spareWithdrawAmount,
      withdrawEpoch: spareWithdrawEpoch,
      withdrawRequestedAt: spareWithdrawRequestedAt,
      canWithdraw: canWithdrawSpare,
      held: heldSpare,
      heldEthValue: sum(heldSpareJobs),
      available: v2SpareAvailable({ balance: spareBalance, withdrawAmount: spareWithdrawAmount, held: heldSpare }),
      price: terms.price,
      open: terms.open,
    },
  };
}

type WithdrawJson = { amount: string; epoch: number; requestedAt: number; ready: boolean } | null;
const withdrawJson = (amount: bigint, epoch: bigint, requestedAt: bigint, ready: boolean): WithdrawJson =>
  amount > 0n ? { amount: amount.toString(), epoch: Number(epoch), requestedAt: Number(requestedAt), ready } : null;

/** SPARE jobs of this payer waiting at the last close, by reason (what the balance panel says). */
function waitingOf(payer: Address): { jobs: number; reason: WaitReason; text: string } | null {
  const rows = getDb()
    .prepare(
      `SELECT pay_wait AS reason, COUNT(*) AS n FROM jobs WHERE payer = ? AND ${ON_V2} AND charge_status = 'pending' AND status = 'agreed'
       AND pay_wait IS NOT NULL GROUP BY pay_wait ORDER BY n DESC`,
    )
    .all(payer) as { reason: WaitReason; n: number }[];
  if (!rows.length) return null;
  return { jobs: rows.reduce((s, r) => s + r.n, 0), reason: rows[0].reason, text: WAIT_TEXT[rows[0].reason] ?? rows[0].reason };
}

/** The `v2` block of GET /api/v1/payments/account (null when V2 is off). */
export async function accountJsonV2(payer: Address) {
  if (!v2Address()) return null;
  const a = await readAccountV2(payer);
  return {
    contract: a.address,
    spareToken: a.spareToken,
    /** ETH: withdrawable deposits and spend-only credits (never withdrawable, spent first). */
    balance: a.balance.toString(),
    credits: a.credits.toString(),
    held: a.held.toString(),
    available: a.available.toString(),
    spendLimitPerEpoch: a.spendLimit.toString(),
    withdrawal: withdrawJson(a.withdrawAmount, a.withdrawEpoch, a.withdrawRequestedAt, a.canWithdraw),
    spare: {
      /** SPARE base units (18 decimals). */
      balance: a.spare.balance.toString(),
      held: a.spare.held.toString(),
      heldEthValueWei: a.spare.heldEthValue.toString(),
      available: a.spare.available.toString(),
      availableEthValueWei: a.spare.price ? ethValueOfSpare(a.spare.available, a.spare.price).toString() : null,
      spendLimitPerEpoch: a.spare.spendLimit.toString(),
      withdrawal: withdrawJson(a.spare.withdrawAmount, a.spare.withdrawEpoch, a.spare.withdrawRequestedAt, a.spare.canWithdraw),
      /** The reference SPARE price (the last accepted epoch price): wei per 10^18 SPARE base units. Holds use it. */
      priceWeiPer1e18Spare: a.spare.price?.toString() ?? null,
      /** False until the Safe sets the first reference price (and while the SPARE cap is 0): SPARE jobs are refused. */
      open: a.spare.open,
      discountBps: 0,
      waiting: waitingOf(payer),
    },
  };
}

/**
 * GET /api/v1/payments/account?address= — V1's answer, plus a `v2` block when V2 is on (exactly V1's answer when it
 * is off). Without a V1 contract the V1 fields are zero.
 */
export async function accountJsonAll(addressRaw: string | null) {
  if (!v2Address()) return accountJson(addressRaw);
  if (!addressRaw || !isAddress(addressRaw)) throw new ApiError(400, "invalid-address", "address must be a wallet address");
  const payer = getAddress(addressRaw);
  const v1 = paymentsAddress()
    ? await accountJson(payer)
    : { address: payer, contract: null, priceWeiPerUnit: priceWeiPerUnit().toString(), balance: "0", held: "0", available: "0", spendLimitPerEpoch: "0", withdrawal: null };
  return { ...v1, v2: await accountJsonV2(payer) };
}

// ---- Paying for a job ----------------------------------------------------------------------------------------------

/** A paid job as submitJob holds it. `fits` re-checks inside the insert transaction (fresh holds, the chain read before). */
export type PaidJob = {
  payer: Address;
  priceWei: bigint;
  signature: Hex | null;
  contract: "v1" | "v2";
  asset: PayAsset;
  /** availableBefore / availableAfter in ETH wei (a SPARE job: the SPARE's ETH value at the hold price). */
  fits: () => { ok: boolean; availableBefore: bigint; availableAfter: bigint };
};

const insufficient = (available: bigint, price: bigint, what = "available balance") =>
  new ApiError(402, "insufficient-balance", `${what} ${available} wei is below the price ${price} wei`, {
    available: available.toString(),
    priceWei: price.toString(),
  });

function v1Fits(payer: Address, price: bigint, balance: bigint, withdrawAmount: bigint): PaidJob["fits"] {
  return () => {
    const locked = heldFor(payer) + withdrawAmount + price;
    const before = balance > locked - price ? balance - (locked - price) : 0n;
    return { ok: locked <= balance, availableBefore: before, availableAfter: locked <= balance ? balance - locked : 0n };
  };
}

function v2EthFits(payer: Address, price: bigint, a: { credits: bigint; balance: bigint; withdrawAmount: bigint }): PaidJob["fits"] {
  return () => {
    const held = sum(heldPricesV2(payer, "eth"));
    const before = v2EthAvailable({ ...a, held });
    return { ok: before >= price, availableBefore: before, availableAfter: before >= price ? before - price : 0n };
  };
}

function v2SpareFits(payer: Address, price: bigint, a: { balance: bigint; withdrawAmount: bigint; price: bigint }): PaidJob["fits"] {
  return () => {
    const avail = v2SpareAvailable({ balance: a.balance, withdrawAmount: a.withdrawAmount, held: heldSpareAt(payer, a.price) });
    const need = spareForWei(price, a.price);
    return {
      ok: avail >= need,
      availableBefore: ethValueOfSpare(avail, a.price),
      availableAfter: avail >= need ? ethValueOfSpare(avail - need, a.price) : 0n,
    };
  };
}

/** The V2 account check for one job (throws 402 / 409 when it cannot pay). */
async function v2PaidJob(payer: Address, price: bigint, asset: PayAsset, signature: Hex | null): Promise<PaidJob> {
  const a = await readAccountV2(payer);
  if (asset === "spare") {
    if (!a.spare.open || !a.spare.price) {
      throw new ApiError(409, "spare-payments-closed", "SPARE payments are not open yet: the treasury Safe has not set the first SPARE reference price");
    }
    const fits = v2SpareFits(payer, price, { balance: a.spare.balance, withdrawAmount: a.spare.withdrawAmount, price: a.spare.price });
    const f = fits();
    if (!f.ok) throw insufficient(f.availableBefore, price, "available SPARE balance (its ETH value at the reference price)");
    return { payer, priceWei: price, signature, contract: "v2", asset, fits };
  }
  const fits = v2EthFits(payer, price, a);
  const f = fits();
  if (!f.ok) throw insufficient(f.availableBefore, price);
  return { payer, priceWei: price, signature, contract: "v2", asset, fits };
}

/**
 * A wallet-signed payment block, checked against the request and the balance on the contract it was signed for.
 * With V2 off this is exactly ./payments' verifyPayment (V1).
 */
export async function verifyJobPayment(request: unknown, paymentRaw: unknown, price: bigint): Promise<PaidJob> {
  const v2 = v2Address();
  const v1 = paymentsAddress();
  if (!v2) return verifyV1(request, paymentRaw, price);
  const block = parsePaymentBlock(paymentRaw, price);
  const asset: PayAsset = block.asset === "spare" ? "spare" : "eth";
  if (block.asset !== null && block.asset !== "eth" && block.asset !== "spare") {
    throw new ApiError(400, "invalid-payment", 'payment.asset must be "eth" or "spare"');
  }
  let candidates: { key: "v1" | "v2"; address: Address }[];
  if (block.contract !== null) {
    if (!isAddress(block.contract)) throw new ApiError(400, "invalid-payment", "payment.contract must be a payments contract address");
    const named = getAddress(block.contract);
    if (named === v2) candidates = [{ key: "v2", address: v2 }];
    else if (v1 && named === v1) candidates = [{ key: "v1", address: v1 }];
    else throw new ApiError(400, "unknown-contract", "payment.contract is not a payments contract of this scheduler");
  } else {
    candidates = [...(v1 && asset === "eth" ? [{ key: "v1" as const, address: v1 }] : []), { key: "v2" as const, address: v2 }];
  }
  if (asset === "spare" && candidates.some((c) => c.key === "v1")) {
    throw new ApiError(400, "invalid-payment", "SPARE payments are made on the V2 payments contract only");
  }
  const requestHash = jobRequestHash(request);
  let chosen: "v1" | "v2" | null = null;
  for (const c of candidates) {
    const message = jobPaymentMessage({ chainId: targetChain.id, contract: c.address, requestHash, priceWei: block.priceWei, issued: block.issued, asset });
    let signer: Address | null = null;
    try {
      signer = await recoverMessageAddress({ message, signature: block.signature });
    } catch {
      throw new ApiError(401, "bad-payment-signature", "payment signature could not be recovered");
    }
    if (signer.toLowerCase() === block.payer.toLowerCase()) {
      chosen = c.key;
      break;
    }
  }
  if (!chosen) throw new ApiError(401, "bad-payment-signature", "payment is not signed by the payer");
  assertSignatureUnused(block.signature);
  if (chosen === "v1") {
    const acct = await readAccount(block.payer);
    if (acct.available < price) throw insufficient(acct.available, price);
    return {
      payer: block.payer,
      priceWei: price,
      signature: block.signature,
      contract: "v1",
      asset: "eth",
      fits: v1Fits(block.payer, price, acct.balance, acct.withdrawAmount),
    };
  }
  return v2PaidJob(block.payer, price, asset, block.signature);
}

async function verifyV1(request: unknown, paymentRaw: unknown, price: bigint): Promise<PaidJob> {
  const p = await verifyPayment(request, paymentRaw, price);
  return { payer: p.payer, priceWei: p.priceWei, signature: p.signature, contract: "v1", asset: "eth", fits: v1Fits(p.payer, price, p.balance, p.withdrawAmount) };
}

/** An API-key job (ETH only): V2 first when it is on and its ETH covers the price, else V1. */
export async function keyPaidJob(owner: Address, price: bigint): Promise<PaidJob> {
  const v2 = v2Address();
  if (v2) {
    const a = await readAccountV2(owner);
    const fits = v2EthFits(owner, price, a);
    if (fits().ok || !paymentsAddress()) {
      const f = fits();
      if (!f.ok) throw insufficient(f.availableBefore, price);
      return { payer: owner, priceWei: price, signature: null, contract: "v2", asset: "eth", fits };
    }
  }
  if (!paymentsAddress()) throw new ApiError(503, "payments-off", "paid jobs are not enabled on this scheduler");
  const acct = await readAccount(owner);
  if (acct.available < price) throw insufficient(acct.available, price);
  return { payer: owner, priceWei: price, signature: null, contract: "v1", asset: "eth", fits: v1Fits(owner, price, acct.balance, acct.withdrawAmount) };
}

// ---- The SPARE price of an epoch -----------------------------------------------------------------------------------

export type PriceOutcome = { price: bigint | null; blocked: WaitReason | null; note: string };

type PriceRow = { epoch_id: number; status: string; tx: Hex | null };

function recordPrice(epochId: number, r: { price?: bigint | null; reference?: bigint | null; accepted?: boolean | null; sqrt?: bigint | null; block?: bigint | null; status: string; reason?: string | null; tx?: Hex | null }) {
  getDb()
    .prepare(
      `INSERT INTO v2_spare_prices (epoch_id, price, reference, accepted, sqrt_price_x96, block, status, reason, tx, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(epoch_id) DO UPDATE SET price = COALESCE(excluded.price, price), reference = COALESCE(excluded.reference, reference),
         accepted = COALESCE(excluded.accepted, accepted), sqrt_price_x96 = COALESCE(excluded.sqrt_price_x96, sqrt_price_x96),
         block = COALESCE(excluded.block, block), status = excluded.status, reason = excluded.reason, tx = COALESCE(excluded.tx, tx)`,
    )
    .run(
      epochId,
      r.price?.toString() ?? null,
      r.reference?.toString() ?? null,
      r.accepted === undefined || r.accepted === null ? null : r.accepted ? 1 : 0,
      r.sqrt?.toString() ?? null,
      r.block === undefined || r.block === null ? null : Number(r.block),
      r.status,
      r.reason ?? null,
      r.tx ?? null,
      nowSec(),
    );
}

/**
 * Makes sure the open epoch `epochId` has its SPARE price on V2: once per epoch, the pool's spot price (StateView slot0
 * of the verified pool key), checked by the contract against the reference. The contract's record is the truth, so a
 * retry after a crash never posts twice. No reference set by the Safe: nothing is posted, the SPARE leg is skipped.
 */
export async function ensureSparePrice(epochId: number, address: Address, account: PrivateKeyAccount): Promise<PriceOutcome> {
  const c = v2c(address);
  const posted = async (): Promise<PriceOutcome | null> => {
    const rec = await publicClient.readContract({ ...c, functionName: "sparePriceOf", args: [BigInt(epochId)] });
    if (!rec.posted) return null;
    const row = getDb().prepare("SELECT * FROM v2_spare_prices WHERE epoch_id = ?").get(epochId) as PriceRow | undefined;
    if (row?.status !== "done") recordPrice(epochId, { price: rec.price, reference: rec.referencePrice, accepted: rec.accepted, status: "done" });
    return rec.accepted
      ? { price: rec.price, blocked: null, note: `SPARE price ${rec.price} wei per SPARE accepted` }
      : { price: null, blocked: "paused", note: `SPARE price ${rec.price} outside the band of the reference ${rec.referencePrice}: SPARE charges paused this epoch` };
  };
  const already = await posted();
  if (already) return already;
  const ref = await publicClient.readContract({ ...c, functionName: "referenceSparePrice" });
  if (ref === 0n) {
    recordPrice(epochId, { status: "skipped", reason: "no-reference" });
    return { price: null, blocked: "no-reference", note: "no SPARE reference price set by the Safe yet: SPARE leg skipped" };
  }
  const pool = await tokenChain.poolState();
  const price = priceFromSqrtPriceX96(pool.sqrtPriceX96);
  if (price === 0n) {
    recordPrice(epochId, { status: "skipped", reason: "pool price 0", sqrt: pool.sqrtPriceX96, block: pool.block });
    return { price: null, blocked: "not-posted", note: "the pool price read as 0: nothing posted" };
  }
  recordPrice(epochId, { price, reference: ref, sqrt: pool.sqrtPriceX96, block: pool.block, status: "sending" });
  const { request } = await publicClient.simulateContract({ account, ...c, functionName: "postSparePrice", args: [BigInt(epochId), price] });
  const wallet = createWalletClient({ account, chain: targetChain, transport: http(targetChain.rpcUrls.default.http[0]) });
  const hash = await sendAsScheduler(() => wallet.writeContract(request));
  recordPrice(epochId, { status: "sending", tx: hash });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") {
    recordPrice(epochId, { status: "failed", reason: "postSparePrice reverted", tx: hash });
    return { price: null, blocked: "not-posted", note: `postSparePrice ${hash} reverted` };
  }
  const done = await posted();
  return done ?? { price: null, blocked: "not-posted", note: "posted, but the contract shows no price" };
}

// ---- Charging ------------------------------------------------------------------------------------------------------

type V2ChargeRow = ChargeRow & { spare_price: string | null; spare_wei: string; spare_eth_wei: string; min_eth_out: string | null; method: string };
type DueRow = { id: string; payer: Address; price_wei: string; api_key_id: string | null; output_hash: string | null; pay_asset: string | null; pay_waits: number };

/** In the transaction that marks a V2 charge done: the SPARE jobs get the price used and the SPARE taken for each. */
function spareChargedUpdate(list: ListEntry[], price: string | null) {
  return () => {
    const db = getDb();
    const up = db.prepare("UPDATE jobs SET spare_price = ?, spare_wei = ?, pay_wait = NULL WHERE id = ?");
    const clear = db.prepare("UPDATE jobs SET pay_wait = NULL WHERE id = ?");
    for (const e of list) {
      if (e.asset === "spare" && price) up.run(price, e.spareWei ?? null, e.jobId);
      else clear.run(e.jobId);
    }
  };
}

function applyWaits(waits: V2Plan["waits"]) {
  if (!waits.length) return;
  tx((db) => {
    const up = db.prepare("UPDATE jobs SET pay_wait = ?, pay_waits = pay_waits + ? WHERE id = ? AND charge_status = 'pending'");
    for (const w of waits) up.run(w.reason, w.counts ? 1 : 0, w.id);
  });
}

function applyUnpaid(unpaid: V2Plan["unpaid"]) {
  if (!unpaid.length) return;
  tx((db) => {
    const up = db.prepare("UPDATE jobs SET charge_status = 'unpaid', pay_wait = ? WHERE id = ? AND charge_status = 'pending'");
    for (const u of unpaid) up.run(u.reason === "balance" ? null : u.reason, u.id);
  });
}

/**
 * Charges V2's due jobs into the open epoch `epochId` (after V1's charge, before the root is read). Never throws for an
 * on-chain failure: returns a one-line summary; due jobs stay pending (SPARE jobs with their wait reason).
 */
export async function chargeOpenEpochV2(epochId: number): Promise<string> {
  const address = v2Address();
  const account = schedulerAccount();
  if (!address) return "V2 payments off";
  if (!account) return "SCHEDULER_SIGNER_KEY not set: no V2 charge";
  const ledger = v2Ledger(address);
  const db = getDb();
  const c = v2c(address);

  const prev = db.prepare("SELECT * FROM v2_charges WHERE epoch_id = ?").get(epochId) as V2ChargeRow | undefined;
  if (prev?.status === "done") return `V2: epoch ${epochId} already charged (${prev.tx})`;
  if (prev?.status === "sending") {
    try {
      const list = JSON.parse(prev.list_json) as ListEntry[];
      if (await resolveSending(ledger, prev, spareChargedUpdate(list, prev.spare_price))) return `V2: epoch ${epochId} charge confirmed (${prev.tx ?? "found by event"})`;
    } catch (e) {
      return `V2: earlier charge of epoch ${epochId} still unresolved: ${describeChainError(e)}`;
    }
  }
  if (prev?.status === "failed") dropCharge(ledger, epochId, "failed");
  releaseUnagreed();

  let price: PriceOutcome;
  try {
    price = await ensureSparePrice(epochId, address, account);
  } catch (e) {
    price = { price: null, blocked: "not-posted", note: `SPARE price not posted: ${describeChainError(e)}` };
  }

  const rows = db
    .prepare(
      `SELECT id, payer, price_wei, api_key_id, output_hash, pay_asset, pay_waits FROM jobs
       WHERE charge_status = 'pending' AND status = 'agreed' AND ${ON_V2} ORDER BY settled_at, id`,
    )
    .all() as DueRow[];
  if (!rows.length) return `V2: no paid jobs to charge; ${price.note}`;
  const due: V2Due[] = rows.map((r) => ({ id: r.id, payer: getAddress(r.payer), priceWei: BigInt(r.price_wei), asset: r.pay_asset === "spare" ? "spare" : "eth", waits: r.pay_waits }));
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Budgets: one read per payer of every figure the contract checks.
  const payers = [...new Set(due.map((j) => j.payer.toLowerCase()))].map((p) => getAddress(p));
  const budgets = new Map<string, V2Budget>();
  const e = BigInt(epochId);
  for (const p of payers) {
    const [balance, credits, limit, already, spareBalance, spareLimit, spareAlready] = await Promise.all([
      publicClient.readContract({ ...c, functionName: "balanceOf", args: [p] }),
      publicClient.readContract({ ...c, functionName: "creditOf", args: [p] }),
      publicClient.readContract({ ...c, functionName: "spendLimitPerEpoch", args: [p] }),
      publicClient.readContract({ ...c, functionName: "chargedInEpoch", args: [p, e] }),
      publicClient.readContract({ ...c, functionName: "spareBalanceOf", args: [p] }),
      publicClient.readContract({ ...c, functionName: "spareSpendLimitPerEpoch", args: [p] }),
      publicClient.readContract({ ...c, functionName: "spareChargedInEpoch", args: [p, e] }),
    ]);
    budgets.set(p.toLowerCase(), {
      eth: balance + credits,
      room: limit === 0n ? null : limit > already ? limit - already : 0n,
      spare: spareBalance,
      spareRoom: spareLimit === 0n ? null : spareLimit > spareAlready ? spareLimit - spareAlready : 0n,
    });
  }
  let capRoom = 0n;
  if (price.price !== null && due.some((j) => j.asset === "spare")) {
    const [cap, capUsed] = await Promise.all([
      publicClient.readContract({ ...c, functionName: "spareCapEthPerEpoch" }),
      publicClient.readContract({ ...c, functionName: "spareEthChargedInEpoch", args: [e] }),
    ]);
    capRoom = cap > capUsed ? cap - capUsed : 0n;
  }
  const planFor = (blocked: WaitReason | null) => planV2Charge({ due, budgets, price: blocked ? null : price.price, blocked: blocked ?? price.blocked, capRoom });
  let plan = planFor(null);

  // SPARE leg: ask the contract first (cap, paused, floor, cover); a leg it would refuse waits and ETH goes on.
  let minEthOut = 0n;
  const sizeSpare = async (): Promise<WaitReason | null> => {
    if (!plan.spare.length || price.price === null) return null;
    const ethLeg = sum(plan.eth.map((j) => j.priceWei));
    const value = sum(plan.spare.map((j) => j.priceWei));
    const [, burnerBps] = await publicClient.readContract({ ...c, functionName: "currentSplit" });
    const spareIn = sum(legArrays(plan.spare).amounts.map((a) => spareForWei(a, price.price!)));
    const sold = spareIn - (spareIn * BigInt(burnerBps)) / BPS;
    const [, , floor, potRequired, cover] = await publicClient.readContract({ ...c, functionName: "previewSpareLeg", args: [e, ethLeg, value, 0n] });
    minEthOut = minEthOutFor({ soldSpare: sold, price: price.price, hookCutBps: UNISWAP_V4.spareEthPoolHookCutBps, bufferBps: SPARE_SALE_BUFFER_BPS, floor, potRequired, cover });
    const [status] = await publicClient.readContract({ ...c, functionName: "previewSpareLeg", args: [e, ethLeg, value, minEthOut] });
    return waitOfStatus(SPARE_STATUS[status] ?? "shortfall");
  };
  try {
    const refused = await sizeSpare();
    if (refused) plan = planFor(refused);
  } catch (err) {
    console.error(`[sparecycle] V2 epoch ${epochId}: previewSpareLeg failed: ${describeChainError(err)}`);
    plan = planFor("sale");
  }

  applyUnpaid(plan.unpaid);
  const unpaidNote = plan.unpaid.length ? `; ${plan.unpaid.length} agreed job(s) unpaid` : "";
  const waitNote = plan.waits.length ? `; ${plan.waits.length} SPARE job(s) wait (${[...new Set(plan.waits.map((w) => w.reason))].join(", ")})` : "";
  if (!plan.eth.length && !plan.spare.length) {
    applyWaits(plan.waits);
    return `V2: no chargeable jobs${unpaidNote}${waitNote}; ${price.note}`;
  }

  // Build, simulate (SPARE leg first; if the sale would not fill, the SPARE jobs wait and ETH goes alone), then send.
  const build = () => {
    const list: ListEntry[] = [
      ...plan.eth.map((j) => ({ jobId: j.id, payer: j.payer, priceWei: j.priceWei.toString(), apiKeyId: byId.get(j.id)?.api_key_id ?? null, asset: "eth" as const })),
      ...plan.spare.map((j) => ({
        jobId: j.id,
        payer: j.payer,
        priceWei: j.priceWei.toString(),
        apiKeyId: byId.get(j.id)?.api_key_id ?? null,
        asset: "spare" as const,
        spareWei: j.spareWei.toString(),
      })),
    ].sort((a, b) => (a.jobId < b.jobId ? -1 : 1));
    const built = buildJobsTree(epochId, jobsTreeEntries(ledger, list, byId));
    const eth = legArrays(plan.eth);
    const spare = legArrays(plan.spare);
    const args = plan.spare.length
      ? ({ functionName: "chargeWithSpare", args: [e, eth.customers, eth.amounts, spare.customers, spare.amounts, minEthOut, built.tree.root] } as const)
      : ({ functionName: "charge", args: [e, eth.customers, eth.amounts, built.tree.root] } as const);
    return { list, built, args, eth, spare };
  };
  let b: ReturnType<typeof build>;
  let request: Awaited<ReturnType<typeof publicClient.simulateContract>>["request"];
  try {
    b = build();
    try {
      ({ request } = await publicClient.simulateContract({ account, ...c, ...b.args } as Parameters<typeof publicClient.simulateContract>[0]));
    } catch (err) {
      if (!plan.spare.length) throw err;
      console.error(`[sparecycle] V2 epoch ${epochId}: the SPARE leg would not go through (${describeChainError(err)}); charging ETH only`);
      plan = planFor("sale");
      applyUnpaid(plan.unpaid);
      if (!plan.eth.length) {
        applyWaits(plan.waits);
        return `V2: SPARE leg refused (${describeChainError(err)}), no ETH jobs${unpaidNote}${waitNote}`;
      }
      b = build();
      ({ request } = await publicClient.simulateContract({ account, ...c, ...b.args } as Parameters<typeof publicClient.simulateContract>[0]));
    }
  } catch (err) {
    return `V2 charge not sent: ${describeChainError(err)}${unpaidNote}`;
  }

  const ethTotal = sum(b.eth.amounts);
  const spareEth = sum(b.spare.amounts);
  const spareWei = price.price ? sum(b.spare.amounts.map((a) => spareForWei(a, price.price!))) : 0n;
  tx(() => {
    db.prepare(
      `INSERT INTO v2_charges (epoch_id, list_json, list_hash, total_wei, spare_eth_wei, spare_wei, spare_price, min_eth_out, method, status, hash_rule, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
    ).run(
      epochId,
      JSON.stringify(b.list),
      b.built.tree.root,
      ethTotal.toString(),
      spareEth.toString(),
      spareWei.toString(),
      plan.spare.length && price.price ? price.price.toString() : null,
      plan.spare.length ? minEthOut.toString() : null,
      b.args.functionName,
      JOBS_HASH_RULE,
      nowSec(),
    );
    storeLeaves(ledger, epochId, b.built.leaves);
  });
  try {
    const wallet = createWalletClient({ account, chain: targetChain, transport: http(targetChain.rpcUrls.default.http[0]) });
    const hash = await sendAsScheduler(() => wallet.writeContract(request));
    db.prepare("UPDATE v2_charges SET tx = ? WHERE epoch_id = ?").run(hash, epochId);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error(`V2 charge transaction ${hash} reverted`);
    markCharged(ledger, epochId, b.list, hash, spareChargedUpdate(b.list, plan.spare.length && price.price ? price.price.toString() : null));
    applyWaits(plan.waits);
    return (
      `V2: charged ${plan.eth.length} ETH job(s) (${ethTotal} wei) and ${plan.spare.length} SPARE job(s) (${spareEth} wei, ${spareWei} SPARE units)` +
      ` from ${new Set(b.list.map((x) => x.payer)).size} customers, jobs root over ${b.built.leaves.length} jobs (tx ${hash})${unpaidNote}${waitNote}; ${price.note}`
    );
  } catch (err) {
    const msg = describeChainError(err);
    const row = db.prepare("SELECT tx FROM v2_charges WHERE epoch_id = ?").get(epochId) as { tx: Hex | null };
    if (row.tx) db.prepare("UPDATE v2_charges SET error = ? WHERE epoch_id = ?").run(msg, epochId);
    else db.prepare("UPDATE v2_charges SET status = 'failed', error = ? WHERE epoch_id = ?").run(msg, epochId);
    return `V2 charge failed: ${msg}${unpaidNote}`;
  }
}

/**
 * The `v2` block of GET /api/v1/epochs/:id/charges (nothing when V2 is off): V2's charge of the epoch, the same shape
 * as V1's v2-jobs-merkle answer, plus the SPARE leg: each customer's ETH value and SPARE (equal to the
 * CustomerChargedSpare events) and the epoch price. No job ids, per-job payers or prices (D7).
 */
export function v2ChargesOf(epochId: number): { v2?: unknown } {
  const address = v2Address();
  if (!address) return {};
  const row = getDb().prepare("SELECT * FROM v2_charges WHERE epoch_id = ?").get(epochId) as V2ChargeRow | undefined;
  const priceRow = getDb().prepare("SELECT price, reference, accepted, status, reason FROM v2_spare_prices WHERE epoch_id = ?").get(epochId) as
    | { price: string | null; reference: string | null; accepted: number | null; status: string; reason: string | null }
    | undefined;
  const sparePrice = priceRow
    ? { status: priceRow.status, priceWeiPer1e18Spare: priceRow.price, referenceWeiPer1e18Spare: priceRow.reference, accepted: priceRow.accepted === null ? null : priceRow.accepted === 1, reason: priceRow.reason }
    : null;
  if (!row) return { v2: { contract: address, epochId, status: "none", listHash: null, tx: null, sparePrice } };
  const list = JSON.parse(row.list_json) as ListEntry[];
  const p = row.spare_price ? BigInt(row.spare_price) : null;
  return {
    v2: {
      contract: address,
      epochId,
      status: row.status,
      hashRule: JOBS_HASH_RULE,
      listHash: row.list_hash,
      tx: row.tx,
      method: row.method,
      totalWei: row.total_wei,
      customers: customerTotals(list, "eth"),
      spare:
        p === null
          ? null
          : {
              priceWeiPer1e18Spare: row.spare_price,
              ethValueWei: row.spare_eth_wei,
              spareWei: row.spare_wei,
              minEthOutWei: row.min_eth_out,
              customers: customerTotals(list, "spare").map((x) => ({ ...x, spareWei: spareForWei(BigInt(x.amountWei), p).toString() })),
            },
      sparePrice,
      leaves: chargeLeaves(epochId, "v2"),
      leafRule: JOBS_LEAF_RULE,
      codes: { verdict: LEAF_VERDICT, chargeStatus: LEAF_CHARGE_STATUS },
    },
  };
}
