// Paid jobs (SparecycleJobPayments): price and the message a customer signs. Kept out of protocol.ts, which the
// node client ships an identical copy of.
import type { Hex } from "viem";
import { sha256Hex, workUnits, type JobRequest, type JobSpec } from "./protocol";

/** A paid job's signature is accepted for this long after its `issued` time. */
export const JOB_PAYMENT_WINDOW_SECONDS = 600;

/** Price of a job: its work units times the price per unit (wei). */
export const jobPriceWei = (spec: JobSpec | JobRequest, weiPerUnit: bigint): bigint => BigInt(workUnits(spec)) * weiPerUnit;

/** SparecycleJobPayments.TREASURY_BPS (a constant in the contract): the treasury's share of each charge, 5%. */
export const TREASURY_BPS = 500n;

/**
 * One job's share of the protocol cut, for display. The contract takes TREASURY_BPS of each epoch's charged total
 * (rounded down on the batch), not per job, so the amount on-chain can differ from the sum of these by rounding dust.
 */
export const protocolCutWei = (priceWei: bigint): bigint => (priceWei * TREASURY_BPS) / 10_000n;

/**
 * Low-credit warning: the available balance covers fewer than this many jobs at the current price.
 * D20 in the feature brief: a default, not yet confirmed. Change it here; the banner and the API field both use it.
 */
export const LOW_CREDIT_JOBS = 5;

/** True when `availableWei` covers fewer than LOW_CREDIT_JOBS jobs of `jobPriceWei`. */
export const isLowBalance = (availableWei: bigint, jobPriceWei: bigint): boolean =>
  jobPriceWei > 0n && availableWei < BigInt(LOW_CREDIT_JOBS) * jobPriceWei;

/** Hash a paid job's signature commits to: sha256 of the exact JSON text of the request object. */
export const jobRequestHash = (request: unknown): Hex => sha256Hex(JSON.stringify(request));

/**
 * The EIP-191 message a customer signs (personal_sign, no gas) to pay for one job from their balance in the
 * payments contract. Human-readable on purpose: the wallet shows it before signing.
 */
export const jobPaymentMessage = (p: { chainId: number; contract: string; requestHash: string; priceWei: bigint; issued: number }) =>
  [
    "Sparecycle: pay for one job from my balance",
    `Chain: ${p.chainId}`,
    `Payments contract: ${p.contract.toLowerCase()}`,
    `Job request: ${p.requestHash.toLowerCase()}`,
    `Price: ${p.priceWei.toString()} wei`,
    `Issued: ${p.issued}`,
  ].join("\n");
