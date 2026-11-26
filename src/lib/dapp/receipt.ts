"use client";

// A paid job's receipt in the browser (feature brief #8): read from /api/v1/jobs/:id/receipt like the invoice (the
// job's read secret and the wallet session cookie), and checked against the chain with a read client of its own on
// the chain's public RPC, or an RPC URL the viewer pastes. The check never goes through the Sparecycle API or the
// site's /api/rpc relay, so it also works from a saved receipt file while the Sparecycle API is unreachable.
// Format and checks: src/lib/job-receipt.ts.
import { useEffect, useState } from "react";
import { createPublicClient, http } from "viem";
import { robinhoodTestnet } from "viem/chains";
import { ROBINHOOD_PUBLIC_RPC, targetChain } from "@/lib/chain";
import { config } from "@/lib/config";
import { verifyReceipt, type JobReceipt, type ReceiptChainClient, type ReceiptVerification } from "@/lib/job-receipt";
import { apiUrl } from "./api";
import { useAuthEpoch } from "./job-output";

/** The RPC the check uses unless the viewer picks another: the chain's public RPC, never the site's relay. */
export function defaultVerifyRpc(): string {
  if (config.network === "testnet") return robinhoodTestnet.rpcUrls.default.http[0];
  if (config.network === "local") return config.rpcUrl ?? "http://127.0.0.1:8545";
  return ROBINHOOD_PUBLIC_RPC;
}

const RPC_KEY = "sparecycle.receipt-rpc";

/** The RPC URL this viewer chose before (this browser only), or null. */
export function savedVerifyRpc(): string | null {
  try {
    const v = window.localStorage.getItem(RPC_KEY);
    return v && checkRpcUrl(v) === null ? v : null;
  } catch {
    return null;
  }
}

export function saveVerifyRpc(url: string | null) {
  try {
    if (url) window.localStorage.setItem(RPC_KEY, url);
    else window.localStorage.removeItem(RPC_KEY);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

/**
 * Null when `raw` is an RPC URL the check may use, else why not. Never a Sparecycle server: the point of the check is
 * not to trust Sparecycle, so this site's origin, its /api/rpc relay and the configured site domain are refused.
 */
export function checkRpcUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "That is not a URL. It looks like https://rpc.example.org";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Use an http:// or https:// RPC URL.";
  const host = u.hostname.toLowerCase();
  const site = (config.domain ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
  const own = typeof window !== "undefined" && u.origin === window.location.origin;
  if (own || /\/api\/rpc\b/.test(u.pathname) || (site && (host === site || host.endsWith(`.${site}`)))) {
    return "This check never uses Sparecycle's servers or relay. Use an RPC run by someone else.";
  }
  return null;
}

/** A read client on `url` only: no fallback to the site's relay. */
export function verifyClient(url: string): ReceiptChainClient {
  return createPublicClient({ transport: http(url, { timeout: 15_000, retryCount: 1 }) });
}

/** Checks a receipt (an object or the raw JSON value) against this site's chain and payments contract via `rpcUrl`. */
export async function checkReceipt(raw: unknown, rpcUrl: string): Promise<ReceiptVerification> {
  if (!config.jobPayments) {
    return {
      outcome: "failed",
      checks: [{ id: "contract", label: "Payments contract", status: "fail", detail: "this site has no payments contract configured" }],
      receipt: null,
      computedLeaf: null,
      computedRoot: null,
      onchain: null,
      error: null,
    };
  }
  return verifyReceipt(raw, { client: verifyClient(rpcUrl), chainId: targetChain.id, paymentsContract: config.jobPayments });
}

/** The receipt route's answer for a free trial job. */
export type FreeReceiptStub = { jobId: string; payment: "free"; receipt: false; note: string };

export type ReceiptState =
  | { state: "loading" }
  | { state: "ready"; receipt: JobReceipt }
  | { state: "free" }
  /** 409: the two results are not compared yet. */
  | { state: "no-verdict" }
  | { state: "signin" }
  | { state: "forbidden" }
  | { state: "missing" }
  | { state: "error" };

/**
 * The receipt of job `id` (null = nothing to load). `refreshKey` (e.g. the job's status) forces a new read when it
 * changes; a provisional receipt is read again every minute while the page is visible (it seals at an epoch close).
 */
export function useJobReceipt(id: string | null, secret: string | null | undefined, opts: { refreshKey?: string } = {}): ReceiptState {
  const epoch = useAuthEpoch();
  const key = id ? `${id}|${secret ?? ""}|${epoch}|${opts.refreshKey ?? ""}` : null;
  const [got, setGot] = useState<{ key: string; value: ReceiptState } | null>(null);
  const mine = got && got.key === key ? got.value : undefined;
  const poll = mine?.state === "ready" && mine.receipt.state === "provisional";

  useEffect(() => {
    if (!id || !key) return;
    let alive = true;
    const read = () =>
      void fetch(apiUrl(`/jobs/${id}/receipt`), {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
        credentials: "include",
        cache: "no-store",
      })
        .then(async (res): Promise<ReceiptState> => {
          if (res.ok) {
            const body = (await res.json()) as JobReceipt | FreeReceiptStub;
            if ("receipt" in body && body.receipt === false) return { state: "free" };
            const r = body as JobReceipt;
            return r && r.jobId === id ? { state: "ready", receipt: r } : { state: "error" };
          }
          if (res.status === 401) return { state: "signin" };
          if (res.status === 403) return { state: "forbidden" };
          if (res.status === 404) return { state: "missing" };
          if (res.status === 409) return { state: "no-verdict" };
          return { state: "error" };
        })
        .catch((): ReceiptState => ({ state: "error" }))
        .then((value) => {
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
