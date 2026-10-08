"use client";

import { useEffect, useRef, useState } from "react";
import type { ChainSnapshot } from "./onchain";

export type LiveState<T> = { data: T | null; error: string | null; loading: boolean; updatedAt: number | null };

/** Poll a JSON endpoint. Keeps the last good value; reports the error instead of inventing data. */
export function useLiveJson<T>(url: string | null, intervalMs = 20_000): LiveState<T> & { refresh: () => void } {
  const [state, setState] = useState<LiveState<T>>({ data: null, error: null, loading: !!url, updatedAt: null });
  const tick = useRef(0);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!url) return;
    let alive = true;
    const run = async () => {
      const id = ++tick.current;
      try {
        const res = await fetch(url, { cache: "no-store" });
        const body = await res.json().catch(() => null);
        if (!alive || id !== tick.current) return;
        if (!res.ok) {
          setState((s) => ({ ...s, loading: false, error: body?.error ?? `HTTP ${res.status}` }));
          return;
        }
        setState({ data: body as T, error: null, loading: false, updatedAt: Date.now() });
      } catch (e) {
        if (!alive) return;
        setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : "unreachable" }));
      }
    };
    run();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, intervalMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url, intervalMs, nonce]);

  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

export type ChainApi = ChainSnapshot & {
  configured: {
    rewardContract: string | null;
    token: string | null;
    nodePayoutAsset: string | null;
    pairAsset: string | null;
    creatorTaxBps: number | null;
    multisig: string | null;
  };
};

/** Shape of GET /api/v1/status (docs/SPEC.md). */
export type SchedulerStatus = {
  ok: boolean;
  schedulerOnline: boolean;
  epoch: { id: string | number; startedAt: number; endsAt: number; length: number } | null;
  nodes: { registered: number; online: number };
  jobs: { queued: number; running: number; agreedThisEpoch: number; disagreedThisEpoch: number };
  lastSettled: { id: string | number; root: string; reserved: string; leaves: number; postedTx: string | null } | null;
  rootPosting: "configured" | "not-configured";
  trust: "centralized-scheduler";
};
