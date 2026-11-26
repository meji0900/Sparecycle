// Paid jobs in the browser: price quotes, ETH amounts and plain-English messages for the payments API and
// the SparecycleJobPayments contract. Server side: src/server/payments.ts.
import { BaseError, formatUnits, InsufficientFundsError, parseEther, UserRejectedRequestError } from "viem";
import type { Tone } from "@/components/ui/status";
import { jobPriceWei, JOB_PAYMENT_WINDOW_SECONDS } from "@/lib/job-payment";
import { formatAmount } from "@/lib/format";
import { parseJobRequest, SpecError, workUnits, type JobRequest } from "@/lib/protocol";
import type { ApiFailure, ApiJob, PaidInvoice } from "./api";
import { revertName } from "./claim-errors";
import { durationLabel } from "./duration";

/** SparecycleJobPayments.WITHDRAW_TIMEOUT (a constant in the contract): a request unlocks after this at the latest. */
export const WITHDRAW_TIMEOUT_SECONDS = 2 * 24 * 3600;

const toBig = (v: bigint | string) => (typeof v === "bigint" ? v : BigInt(v));

/** Wei as ETH with every significant decimal (job prices are tiny; never round a real amount to 0). */
export const formatEth = (wei: bigint | string) => formatAmount(toBig(wei), 18, 18);

/** Wei per work unit as gwei, for "at 0.5 gwei per unit". */
export const formatGwei = (wei: bigint | string) => formatUnits(toBig(wei), 9);

/** An ETH amount typed by the user. null = empty or not a positive amount with at most 18 decimals. */
export function parseEthInput(raw: string): bigint | null {
  const s = raw.trim();
  if (!/^(\d+(\.\d{0,18})?|\.\d{1,18})$/.test(s)) return null;
  try {
    const wei = parseEther(s.startsWith(".") ? `0${s}` : s);
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

export type Quote = { units: number; wei: bigint; /** the prompt is still blank or invalid; the price may change */ draft: boolean };

/**
 * Price of a job request exactly as the scheduler computes it (work units of the parsed request x wei per unit).
 * Null while a setting other than the prompt is invalid. A blank prompt still gets a (draft) price.
 */
export function quoteJob(request: unknown, weiPerUnit: bigint): Quote | null {
  try {
    const req = parseJobRequest(request);
    return { units: workUnits(req), wei: jobPriceWei(req, weiPerUnit), draft: false };
  } catch (e) {
    if (!(e instanceof SpecError) || e.field !== "prompt") return null;
  }
  // Only the prompt is wrong: check the other settings with a stand-in prompt, then price the real one.
  const r = request as { params?: Record<string, unknown> };
  try {
    parseJobRequest({ ...r, params: { ...r.params, prompt: "x" } });
  } catch {
    return null;
  }
  const prompt = typeof r.params?.prompt === "string" ? r.params.prompt : "";
  const units = workUnits({ ...r, params: { ...r.params, prompt, system: typeof r.params?.system === "string" ? r.params.system : "" } } as JobRequest);
  return { units, wei: BigInt(units) * weiPerUnit, draft: true };
}

/** Who paid for a job, as a tag. Null when the scheduler does not report it. */
export function paymentTag(job: Pick<ApiJob, "payment">): { tone: Tone; label: string } | null {
  switch (job.payment) {
    case "free":
      return { tone: "off", label: "Free trial" };
    case "paid":
      return { tone: "neutral", label: "Paid" };
    case "team":
      // Disclosure: the project's own test jobs, not customer demand.
      return { tone: "warn", label: "Team-funded" };
    default:
      return null;
  }
}

/** Whether a job's payment source is shown: always for paid / team jobs, for free jobs only when paid jobs exist. */
export const showPayment = (job: Pick<ApiJob, "payment">, paymentsOn: boolean) =>
  job.payment === "paid" || job.payment === "team" || (paymentsOn && job.payment === "free");

/**
 * What happened to a paid job's price, from its invoice (the public job views no longer carry it, D7). `label` is a
 * short tag; `text` the plain sentence (feature brief §3.2 step 3: held / charged in epoch N / not charged / matched,
 * but the balance was withdrawn before the charge). Never "refund": nothing was taken, so nothing is given back.
 */
export function chargeWords(
  inv: Pick<PaidInvoice, "chargeStatus" | "verdict" | "chargedEpoch"> & Partial<Pick<PaidInvoice, "round">>,
): { tone: Tone; label: string; text: string } {
  switch (inv.chargeStatus) {
    case "pending":
      return inv.verdict === "agreed"
        ? { tone: "neutral", label: "Held", text: "Held: the results matched, and the price is charged when the epoch closes." }
        : (inv.round ?? 0) > 0
          ? {
              tone: "neutral",
              label: "Held",
              text: "Held while another pair of GPUs checks the job again. Charged only if a pair's two results match.",
            }
          : { tone: "neutral", label: "Held", text: "Held from your balance until the two results are compared. Charged only if they match." };
    case "charged":
      return {
        tone: "live",
        label: inv.chargedEpoch !== null ? `Charged in epoch ${inv.chargedEpoch}` : "Charged",
        text: `The results matched; charged${inv.chargedEpoch !== null ? ` in epoch ${inv.chargedEpoch}` : ""} with that epoch's batch.`,
      };
    case "released":
      return {
        tone: "off",
        label: "Not charged",
        text:
          inv.verdict === "disagreed"
            ? (inv.round ?? 0) > 0
              ? `Not charged: no pair's two results matched (${(inv.round ?? 0) + 1} pairs tried).`
              : "Not charged: the two results did not match."
            : inv.verdict === "expired"
              ? "Not charged: the job expired without a verdict."
              : inv.verdict === "rejected"
                ? "Not charged: the safety check rejected it."
                : "Not charged.",
      };
    case "unpaid":
      return { tone: "warn", label: "Matched, not charged", text: "Matched, but the balance was withdrawn before the charge." };
  }
}

/** Messages for the paid-job error codes of POST /api/v1/jobs. Null = not payment-specific. */
export function paidFailureText(f: ApiFailure): { title: string; body: string } | null {
  if (f.kind !== "http") return null;
  const wei = (k: string) => (typeof f.extra[k] === "string" && /^\d+$/.test(f.extra[k] as string) ? `${formatEth(f.extra[k] as string)} ETH` : null);
  switch (f.code) {
    case "insufficient-balance": {
      const available = wei("available");
      const price = wei("priceWei");
      return {
        title: "Not enough balance",
        body: `${available && price ? `Available balance is ${available}; this job costs ${price}. ` : ""}Deposit more or pick a smaller job. Nothing was charged.`,
      };
    }
    case "price-changed":
      return {
        title: "The price changed",
        body: `${wei("priceWei") ? `This job now costs ${wei("priceWei")}. ` : ""}Check the new price and submit again. Nothing was charged.`,
      };
    case "payment-used":
      return { title: "This signature was already used", body: "Each signature pays for one job. Submit again to sign a new one. Nothing was charged twice." };
    case "bad-payment-signature":
      return {
        title: "Signature not accepted",
        body: "It does not match the connected wallet. Sign with the wallet shown under Your balance (an ordinary account; smart-contract wallets cannot sign here) and submit again.",
      };
    case "stale-payment":
      return {
        title: "The signature expired",
        body: `Payment signatures are valid for ${durationLabel(JOB_PAYMENT_WINDOW_SECONDS)}. Check that this device's clock is right, then submit again. Nothing was charged.`,
      };
    case "invalid-payment":
      return { title: "The payment could not be read", body: "Reload the page and submit again. Nothing was charged." };
    case "payments-off":
      return { title: "Paid jobs are off on this scheduler", body: "Nothing was charged. Use the free trial instead." };
    case "internal-error":
      // The paid path reads the payments contract on-chain; that read is what usually fails.
      return {
        title: "Your payment could not be checked",
        body: "The scheduler could not finish checking your balance, usually because it could not reach the chain. Nothing was submitted or charged. Try again in a moment.",
      };
    default:
      return null;
  }
}

/** Why a wallet signature request failed. */
export function explainSignError(error: unknown): string {
  if (error instanceof BaseError && error.walk((e) => e instanceof UserRejectedRequestError)) {
    return "You declined the signature in your wallet. Nothing was submitted or charged.";
  }
  const msg = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : null;
  return `${msg ? `${msg.replace(/\.$/, "")}. ` : ""}Nothing was submitted or charged.`;
}

const TX_SENTENCES: Record<string, string> = {
  ZeroAmount: "The amount must be above zero.",
  InsufficientBalance: "That is more than your balance in the payments contract.",
  NoWithdrawRequest: "There is no pending withdrawal request.",
  WithdrawLocked: "The withdrawal is still locked. It unlocks once the request's epoch and the next one have closed, or 2 days after the request.",
  TransferFailed: "The contract could not send the ETH to this wallet. Nothing was withdrawn.",
};

/** Why a payments-contract transaction failed, in one sentence. */
export function explainPaymentTxError(error: unknown): string {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return "You rejected the request in your wallet. Nothing was sent.";
    if (error.walk((e) => e instanceof InsufficientFundsError)) return "Your wallet does not hold enough ETH for this amount plus gas.";
    const name = revertName(error);
    if (name && TX_SENTENCES[name]) return TX_SENTENCES[name];
    if (name) return `The payments contract refused the transaction (${name}).`;
    return error.shortMessage || "The transaction failed.";
  }
  return error instanceof Error ? error.message : "The transaction failed.";
}
