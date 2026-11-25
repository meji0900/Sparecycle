"use client";

// Reading a job's output (docs/private-outputs.md). The output is fetched from /api/v1/jobs/:id/result with the job's
// read secret (`Authorization: Bearer`, kept with the job in this browser's history) and the wallet session cookie,
// then shown from a blob: URL: an <img src> can't carry the secret. Paid and team jobs can also be read after a
// wallet sign-in (EIP-4361 message, no gas) by the wallet that paid, on any device.
import { useEffect, useState, useSyncExternalStore } from "react";
import { BaseError, UserRejectedRequestError } from "viem";
import { createSiweMessage } from "viem/siwe";
import { useSignMessage } from "wagmi";
import { apiFetch, apiUrl, type StatusResponse } from "./api";
import { useApiGet } from "./use-api";
import { useWallet } from "./use-wallet";

/** URL of a job's gated output. */
export const resultUrl = (id: string) => apiUrl(`/jobs/${id}/result`);

// A counter bumped by every sign-in: outputs that answered "sign in" or "not this wallet" are fetched again.
let authEpoch = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const bumpAuth = () => {
  authEpoch += 1;
  for (const fn of listeners) fn();
};
const useAuthEpoch = () => useSyncExternalStore(subscribe, () => authEpoch, () => 0);

export type OutputState = "loading" | "ready" | "signin" | "forbidden" | "missing" | "error";
type Outcome = { kind: "ok"; blob: Blob } | { kind: Exclude<OutputState, "loading" | "ready"> };

// Agreed outputs never change: keep the bytes of the last few so the history tile and the result panel share one
// download. Failures are not cached (a sign-in or a retry may change them).
const MAX_CACHED = 48;
const blobs = new Map<string, Blob>();
const inflight = new Map<string, Promise<Outcome>>();

function load(id: string, secret: string | null, epoch: number): Promise<Outcome> {
  const hit = blobs.get(id);
  if (hit) return Promise.resolve({ kind: "ok", blob: hit });
  const key = `${id}|${secret ?? ""}|${epoch}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p: Promise<Outcome> = fetch(resultUrl(id), {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
    credentials: "include",
    cache: "no-store",
  })
    .then(async (res): Promise<Outcome> => {
      if (res.ok) {
        const blob = await res.blob();
        blobs.set(id, blob);
        if (blobs.size > MAX_CACHED) blobs.delete(blobs.keys().next().value as string);
        return { kind: "ok", blob };
      }
      if (res.status === 401) return { kind: "signin" };
      if (res.status === 403) return { kind: "forbidden" };
      if (res.status === 404 || res.status === 409 || res.status === 410) return { kind: "missing" };
      return { kind: "error" };
    })
    .catch((): Outcome => ({ kind: "error" }))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * The output of job `id` (null = nothing to load): `url` is a blob: URL for images (revoked on unmount or change),
 * `text` the body of text outputs. "signin" = no credential was accepted (no secret here, no session);
 * "forbidden" = the secret or the signed-in wallet can't read this job.
 */
export function useJobOutput(id: string | null, secret: string | null | undefined, opts: { text?: boolean } = {}) {
  const epoch = useAuthEpoch();
  const asText = !!opts.text;
  const key = id ? `${id}|${secret ?? ""}|${epoch}|${asText}` : null;
  const [got, setGot] = useState<{ key: string; state: OutputState; url: string | null; text: string | null } | null>(null);

  useEffect(() => {
    if (!id || !key) return;
    let alive = true;
    let url: string | null = null;
    void load(id, secret ?? null, epoch).then(async (o) => {
      if (!alive) return;
      if (o.kind !== "ok") {
        setGot({ key, state: o.kind, url: null, text: null });
        return;
      }
      if (asText) {
        const text = await o.blob.text();
        if (alive) setGot({ key, state: "ready", url: null, text });
        return;
      }
      url = URL.createObjectURL(o.blob);
      setGot({ key, state: "ready", url, text: null });
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, secret, epoch, asText, key]);

  const mine = got && got.key === key ? got : null;
  return { state: (mine?.state ?? "loading") as OutputState, url: mine?.url ?? null, text: mine?.text ?? null };
}

/** True when the scheduler enforces private outputs (OUTPUT_AUTH=enforce); null while unknown. */
export function useOutputsPrivate(): boolean | null {
  const q = useApiGet<StatusResponse>("/status");
  return q.result?.ok ? q.result.data.outputAuth === "enforce" : null;
}

/**
 * Wallet sign-in for reading paid outputs on any device: a nonce from the scheduler, an EIP-4361 message signed by
 * the connected wallet (no transaction, no gas), then an HttpOnly session cookie set by the scheduler.
 */
export function useOutputSignIn() {
  const { address, isConnected } = useWallet();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    if (!address || busy) return;
    setBusy(true);
    setError(null);
    try {
      const n = await apiFetch<{ nonce: string; chainId: number; statement: string; expiresAt: number }>("/auth/nonce", { credentials: "include" });
      if (!n.ok) {
        setError("Sign-in is not available right now. Try again in a moment.");
        return;
      }
      const message = createSiweMessage({
        address,
        chainId: n.data.chainId,
        domain: window.location.host,
        uri: window.location.origin,
        nonce: n.data.nonce,
        version: "1",
        statement: n.data.statement,
        issuedAt: new Date(),
        expirationTime: new Date(n.data.expiresAt * 1000),
      });
      let signature: string;
      try {
        signature = await signMessageAsync({ message });
      } catch (e) {
        setError(
          e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)
            ? "You declined the signature in your wallet."
            : "The wallet did not sign the message. Try again.",
        );
        return;
      }
      const v = await apiFetch<{ ok: true; address: string }>("/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, signature }),
        credentials: "include",
      });
      if (!v.ok) {
        setError(v.failure.kind === "http" && v.failure.message ? `Sign-in failed: ${v.failure.message}.` : "Sign-in failed. Try again.");
        return;
      }
      bumpAuth();
    } finally {
      setBusy(false);
    }
  }

  return { address, isConnected, busy, error, signIn };
}
