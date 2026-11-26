"use client";

// Job submission shared by /jobs (the technical form) and /playground: free requests, paid requests signed from
// the connected wallet's balance, and the scheduler's error messages. Outputs are read with src/lib/dapp/job-output.
import { useState } from "react";
import { useSignMessage } from "wagmi";
import { targetChain } from "@/lib/chain";
import { config } from "@/lib/config";
import { apiDown, apiFetch, type ApiFailure, type PaymentAccount } from "@/lib/dapp/api";
import { durationLabel } from "@/lib/dapp/duration";
import { explainSignError, paidFailureText, quoteJob } from "@/lib/dapp/paid-jobs";
import { jobPaymentMessage, jobRequestHash, type PayAsset } from "@/lib/job-payment";
import { parseJobRequest, SpecError } from "@/lib/protocol";
import { useJobAccount } from "./job-balance";

/** Clock reads for submit handlers (kept out of component bodies). */
export const nowMs = () => Date.now();

/**
 * Where a paid job's money comes from. Without SparecycleJobPaymentsV2: the V1 balance. With it: the SPARE balance
 * when chosen, else V2's ETH (credits first, then deposits) when it covers the price, else the older V1 balance
 * ("V2 first; a job never mixes"). `available` is in ETH wei (SPARE: its ETH value at the reference price).
 */
export type PayRoute = { which: "v1" | "v2"; asset: PayAsset; contract: string; available: bigint | null };

export function payRoute(account: PaymentAccount | null | undefined, priceWei: bigint | null, asset: PayAsset): PayRoute | null {
  const v1 = config.jobPayments;
  const v2 = account?.v2 ?? null;
  const num = (s: string | null | undefined) => (s && /^\d+$/.test(s) ? BigInt(s) : null);
  if (!v2) return v1 ? { which: "v1", asset: "eth", contract: v1, available: num(account?.available) } : null;
  if (asset === "spare") return { which: "v2", asset: "spare", contract: v2.contract, available: num(v2.spare.availableEthValueWei) ?? 0n };
  const a2 = num(v2.available);
  const a1 = num(account?.available);
  if (!v1 || priceWei === null || (a2 !== null && a2 >= priceWei) || a1 === null || a1 < priceWei) {
    return { which: "v2", asset: "eth", contract: v2.contract, available: a2 };
  }
  return { which: "v1", asset: "eth", contract: v1, available: a1 };
}

/** Why POST /api/v1/jobs failed, in words. `limit` is the free jobs per hour per address (null = unknown). */
export function failureText(f: ApiFailure, limit: number | null): { title: string; body: string } {
  // The scheduler's own 503 answers first: apiDown() counts every 5xx as "not reachable".
  if (f.kind === "http" && f.status === 503 && f.code === "queue-full") {
    return { title: "The job queue is full", body: "The scheduler is not accepting new jobs right now. Your form is kept; try again later." };
  }
  if (f.kind === "http" && f.status === 503 && f.code === "no-node-pair") {
    const retry = typeof f.extra.retryAfter === "number" ? f.extra.retryAfter : null;
    return {
      title: "No pair of machines can take this job right now",
      body: `Every job runs on two machines with different owners, and two such machines are not available for this model at the moment. Nothing was queued, held or charged. Your form is kept; ${retry !== null ? `try again in ${durationLabel(retry)}.` : "try again in a few minutes."}`,
    };
  }
  if (f.kind === "unreachable" || apiDown(f)) {
    return { title: "Scheduler API not reachable", body: "Nothing was submitted. Your form is kept; try again in a moment." };
  }
  if (f.status === 429) {
    const retry = typeof f.extra.retryAfter === "number" ? f.extra.retryAfter : null;
    return {
      title: "Rate limit reached",
      body: `${f.message ? `${f.message[0].toUpperCase()}${f.message.slice(1)}.` : limit !== null ? `At most ${limit} jobs per hour from one address.` : ""}${retry !== null ? ` Try again in ${durationLabel(retry)}.` : " Try again later."} Your form is kept.`,
    };
  }
  if (f.status === 400) return { title: "Check the form", body: f.message ? `${f.message[0].toUpperCase()}${f.message.slice(1)}.` : "The scheduler rejected the job spec." };
  return { title: "The job was not submitted", body: `${f.status} ${f.code ?? ""} ${f.message ?? ""}`.trim() };
}

/** The message for a failed submission: payment-specific when the job was paid, otherwise the general one. */
export const submitFailureText = (f: ApiFailure, paid: boolean, limit: number | null) => (paid ? paidFailureText(f) : null) ?? failureText(f, limit);

export type SubmitResult =
  /** `readSecret`: the job's read secret, returned once; keep it with the job to view the output later. */
  | { ok: true; id: string; readSecret: string | null }
  /** `failure`: the scheduler's (or the local spec check's) answer; `signError`: the wallet did not sign. */
  | { ok: false; failure: ApiFailure | null; signError: string | null };

/**
 * Submits job requests. A paid request is signed with the connected wallet (the account from JobAccountProvider)
 * over exactly the request object that is sent, so the request hash matches the scheduler's.
 */
export function useJobSubmit() {
  const acct = useJobAccount();
  const { signMessageAsync } = useSignMessage();
  const [stage, setStage] = useState<"sign" | "send" | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosenAsset, setAsset] = useState<PayAsset>("eth");
  const paidOn = acct !== null && (!!config.jobPayments || !!acct.account?.v2);
  const weiPerUnit = acct?.account && /^\d+$/.test(acct.account.priceWeiPerUnit) ? BigInt(acct.account.priceWeiPerUnit) : config.jobPriceWeiPerUnit;
  // V2 only: pay with the SPARE balance instead of ETH, offered when SPARE payments are open and there is SPARE.
  const v2 = acct?.account?.v2 ?? null;
  const spareChoice = !!v2 && v2.spare.open && /^\d+$/.test(v2.spare.balance) && BigInt(v2.spare.balance) > 0n;
  const asset: PayAsset = spareChoice ? chosenAsset : "eth";
  const route = (priceWei: bigint | null) => payRoute(acct?.account, priceWei, asset);

  /** Signs the payment for `request` and returns the paid-job body, or the reason it can't. */
  async function paidBody(request: unknown): Promise<{ body: string } | Extract<SubmitResult, { ok: false }>> {
    const payer = acct?.address;
    if (!payer || (!config.jobPayments && !v2)) return { ok: false, failure: null, signError: "Connect a wallet to pay from your balance. Nothing was submitted." };
    // Check the spec here so a broken form never asks for a signature (same error shape as the scheduler's).
    try {
      parseJobRequest(request);
    } catch (err) {
      if (err instanceof SpecError) {
        return { ok: false, failure: { kind: "http", status: 400, code: "invalid-job", message: err.message, extra: { field: err.field } }, signError: null };
      }
      throw err;
    }
    const q = quoteJob(request, weiPerUnit);
    if (!q) return { ok: false, failure: null, signError: "The price could not be worked out for these settings. Nothing was submitted." };
    const r = route(q.wei);
    if (!r) return { ok: false, failure: null, signError: "Connect a wallet to pay from your balance. Nothing was submitted." };
    const contract = r.contract;
    const issued = Math.floor(nowMs() / 1000);
    const message = jobPaymentMessage({ chainId: targetChain.id, contract, requestHash: jobRequestHash(request), priceWei: q.wei, issued, asset: r.asset });
    setStage("sign");
    let signature: string;
    try {
      signature = await signMessageAsync({ message });
    } catch (err) {
      return { ok: false, failure: null, signError: explainSignError(err) };
    }
    // `request` goes out exactly as it was hashed: the scheduler hashes JSON.stringify(body.request).
    // With V2 the payment names its contract and asset (the scheduler also finds them from the signature alone).
    const extra = v2 ? { contract, asset: r.asset } : {};
    return { body: JSON.stringify({ request, payment: { payer, signature, issued, priceWei: q.wei.toString(), ...extra } }) };
  }

  /** POSTs `request` (free) or `{ request, payment }` (paid). */
  async function submit(rawRequest: unknown, paid: boolean): Promise<SubmitResult> {
    // Round-trip through JSON so the object signed is exactly the object sent (undefined fields dropped).
    const request = JSON.parse(JSON.stringify(rawRequest)) as unknown;
    setBusy(true);
    try {
      let body: string;
      if (paid) {
        const signed = await paidBody(request);
        if (!("body" in signed)) return signed;
        body = signed.body;
      } else {
        body = JSON.stringify(request);
      }
      setStage("send");
      const res = await apiFetch<{ id: string; status: string; readSecret?: string }>("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (paid) acct?.reload();
      return res.ok
        ? { ok: true, id: res.data.id, readSecret: typeof res.data.readSecret === "string" ? res.data.readSecret : null }
        : { ok: false, failure: res.failure, signError: null };
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return { acct, paidOn, weiPerUnit, stage, busy, submit, route, asset, setAsset, spareChoice };
}
