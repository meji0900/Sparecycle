"use client";

// The private invoice of a job (GET /api/v1/jobs/:id/invoice, src/server/invoices.ts), read like the output: with
// the job's read secret (kept with the job in this browser's history) and the wallet session cookie. Plus two
// in-browser helpers for the invoice panel: save the invoice as a JSON file, and the sha256 of a file the payer
// drops, to check it against the invoice's output hash. Nothing is uploaded.
import { useEffect, useState } from "react";
import { apiUrl, type JobInvoice } from "./api";
import { useAuthEpoch } from "./job-output";

export type InvoiceState =
  | { state: "loading" }
  | { state: "ready"; invoice: JobInvoice }
  /** 401: no credential was accepted (no read secret in this browser, no session). */
  | { state: "signin" }
  /** 403: the secret or the signed-in wallet can't read this job's invoice. */
  | { state: "forbidden" }
  /** 404: the scheduler has no such job (or an older scheduler without invoices). */
  | { state: "missing" }
  | { state: "error" };

// The result panel and the history tile of the same job share one answer for a few seconds. Failures are not cached
// (a sign-in or a retry may change them).
const FRESH_MS = 10_000;
const MAX_CACHED = 64;
const cache = new Map<string, { at: number; invoice: JobInvoice }>();
const inflight = new Map<string, Promise<InvoiceState>>();

function load(id: string, secret: string | null, key: string): Promise<InvoiceState> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve({ state: "ready", invoice: hit.invoice });
  const pending = inflight.get(key);
  if (pending) return pending;
  const p: Promise<InvoiceState> = fetch(apiUrl(`/jobs/${id}/invoice`), {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    credentials: "include",
    cache: "no-store",
  })
    .then(async (res): Promise<InvoiceState> => {
      if (res.ok) {
        const invoice = (await res.json()) as JobInvoice;
        if (!invoice || invoice.jobId !== id) return { state: "error" };
        cache.set(key, { at: Date.now(), invoice });
        if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
        return { state: "ready", invoice };
      }
      if (res.status === 401) return { state: "signin" };
      if (res.status === 403) return { state: "forbidden" };
      if (res.status === 404) return { state: "missing" };
      return { state: "error" };
    })
    .catch((): InvoiceState => ({ state: "error" }))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** True while a paid job's price may still be charged (read again now and then: charges land at epoch closes). */
const chargePending = (s: InvoiceState | undefined) => s?.state === "ready" && s.invoice.invoice && s.invoice.chargeStatus === "pending";

/**
 * The invoice of job `id` (null = nothing to load). `refreshKey` (e.g. the job's status) forces a new read when it
 * changes; with `poll`, an invoice whose charge is still pending is read again every minute.
 */
export function useJobInvoice(id: string | null, secret: string | null | undefined, opts: { refreshKey?: string; poll?: boolean } = {}): InvoiceState {
  const epoch = useAuthEpoch();
  const key = id ? `${id}|${secret ?? ""}|${epoch}|${opts.refreshKey ?? ""}` : null;
  const [got, setGot] = useState<{ key: string; value: InvoiceState } | null>(null);
  const mine = got && got.key === key ? got.value : undefined;
  const poll = !!opts.poll && chargePending(mine);

  useEffect(() => {
    if (!id || !key) return;
    let alive = true;
    const read = () =>
      void load(id, secret ?? null, key).then((value) => {
        if (alive) setGot({ key, value });
      });
    read();
    const t = poll
      ? setInterval(() => {
          if (document.visibilityState === "visible") read();
        }, 60_000)
      : undefined;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [id, secret, key, poll]);

  return mine ?? { state: "loading" };
}

/** Saves `data` as a pretty-printed JSON file (a blob: download; nothing leaves the browser). */
export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** sha256 of a file's bytes, computed in this browser, as 0x + 64 lowercase hex (the format of the invoice). */
export async function sha256OfFile(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return `0x${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Two hex hashes are the same (case and 0x prefix ignored). */
export const sameHash = (a: string, b: string) => a.replace(/^0x/i, "").toLowerCase() === b.replace(/^0x/i, "").toLowerCase();
