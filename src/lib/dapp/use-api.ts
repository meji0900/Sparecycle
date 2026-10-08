"use client";

import { useEffect, useState } from "react";
import { apiFetch, type ApiResult } from "./api";

/**
 * GET a scheduler API path. `path = null` means "nothing to load yet". The last answer for the same path is kept
 * while a reload or a poll is in flight; a different path never shows the previous path's data.
 */
export function useApiGet<T>(path: string | null, refreshMs?: number) {
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<{ path: string; nonce: number; res: ApiResult<T> } | null>(null);

  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    const load = () =>
      apiFetch<T>(path, { signal: ctrl.signal })
        .then((res) => setResult({ path, nonce, res }))
        .catch(() => undefined);
    load();
    const t = refreshMs
      ? setInterval(() => {
          if (document.visibilityState === "visible") load();
        }, refreshMs)
      : undefined;
    return () => {
      ctrl.abort();
      if (t) clearInterval(t);
    };
  }, [path, nonce, refreshMs]);

  const mine = path && result && result.path === path ? result : null;
  return {
    result: mine ? mine.res : null,
    /** True until the first answer for this path (or this reload) arrives. */
    loading: !!path && (!mine || mine.nonce !== nonce),
    reload: () => setNonce((n) => n + 1),
  };
}

/** Current time in ms, refreshed on an interval (for "closes in" / "x min ago" without impure renders). */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [intervalMs]);
  return now;
}
