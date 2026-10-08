"use client";

// Job submission shared by /jobs (the technical form) and /playground: free requests, paid requests signed from
// the connected wallet's balance, the scheduler's error messages, and output URLs.
import { useState } from "react";
import { useSignMessage } from "wagmi";
import { targetChain } from "@/lib/chain";
import { config } from "@/lib/config";
import { apiDown, apiFetch, type ApiFailure } from "@/lib/dapp/api";
import { durationLabel } from "@/lib/dapp/duration";
import { explainSignError, paidFailureText, quoteJob } from "@/lib/dapp/paid-jobs";
import { jobPaymentMessage, jobRequestHash } from "@/lib/job-payment";
import { parseJobRequest, SpecError } from "@/lib/protocol";
import { useJobAccount } from "./job-balance";

/** Clock reads for submit handlers (kept out of component bodies). */
export const nowMs = () => Date.now();

/** Why POST /api/v1/jobs failed, in words. `limit` is the free jobs per hour per address (null = unknown). */
export function failureText(f: ApiFailure, limit: number | null): { title: string; body: string } {
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
  if (f.status === 503 && f.code === "queue-full") return { title: "The job queue is full", body: "The scheduler is not accepting new jobs right now. Your form is kept; try again later." };
  if (f.status === 400) return { title: "Check the form", body: f.message ? `${f.message[0].toUpperCase()}${f.message.slice(1)}.` : "The scheduler rejected the job spec." };
  return { title: "The job was not submitted", body: `${f.status} ${f.code ?? ""} ${f.message ?? ""}`.trim() };
}

/** The message for a failed submission: payment-specific when the job was paid, otherwise the general one. */
export const submitFailureText = (f: ApiFailure, paid: boolean, limit: number | null) => (paid ? paidFailureText(f) : null) ?? failureText(f, limit);

/** Absolute URL of an output path the API returns (it is relative to the scheduler API's host). */
export function outputUrl(path: string) {
  const api = config.schedulerApiUrl;
  if (/^https?:\/\//.test(api)) return new URL(path, api).toString();
  return path;
}

export type SubmitResult =
  | { ok: true; id: string }
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
  const paidOn = acct !== null && !!config.jobPayments;
  const weiPerUnit = acct?.account && /^\d+$/.test(acct.account.priceWeiPerUnit) ? BigInt(acct.account.priceWeiPerUnit) : config.jobPriceWeiPerUnit;

  /** Signs the payment for `request` and returns the paid-job body, or the reason it can't. */
  async function paidBody(request: unknown): Promise<{ body: string } | Extract<SubmitResult, { ok: false }>> {
    const contract = config.jobPayments;
    const payer = acct?.address;
    if (!contract || !payer) return { ok: false, failure: null, signError: "Connect a wallet to pay from your balance. Nothing was submitted." };
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
    const issued = Math.floor(nowMs() / 1000);
    const message = jobPaymentMessage({ chainId: targetChain.id, contract, requestHash: jobRequestHash(request), priceWei: q.wei, issued });
    setStage("sign");
    let signature: string;
    try {
      signature = await signMessageAsync({ message });
    } catch (err) {
      return { ok: false, failure: null, signError: explainSignError(err) };
    }
    // `request` goes out exactly as it was hashed: the scheduler hashes JSON.stringify(body.request).
    return { body: JSON.stringify({ request, payment: { payer, signature, issued, priceWei: q.wei.toString() } }) };
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
      const res = await apiFetch<{ id: string; status: string }>("/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (paid) acct?.reload();
      return res.ok ? { ok: true, id: res.data.id } : { ok: false, failure: res.failure, signError: null };
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  return { acct, paidOn, weiPerUnit, stage, busy, submit };
}
