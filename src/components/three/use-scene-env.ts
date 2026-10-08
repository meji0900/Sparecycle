"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

function mediaStore(query: string, serverValue: boolean) {
  return {
    subscribe(cb: () => void) {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    get: () => window.matchMedia(query).matches,
    server: () => serverValue,
  };
}

const reducedStore = mediaStore("(prefers-reduced-motion: reduce)", false);
const wideStore = mediaStore("(min-width: 768px)", true);

let webglCache: boolean | null = null;
function hasWebgl() {
  if (webglCache === null) {
    try {
      const c = document.createElement("canvas");
      webglCache = !!(c.getContext("webgl2") || c.getContext("webgl"));
    } catch {
      webglCache = false;
    }
  }
  return webglCache;
}
const noop = () => () => {};

/**
 * Environment for a 3D scene: reduced motion (still frame), on-screen (pause offscreen),
 * a "dense" flag for wide screens (phones get fewer instances and a lower DPR), WebGL support.
 */
export function useSceneEnv(ref: RefObject<HTMLElement | null>) {
  const reduced = useSyncExternalStore(reducedStore.subscribe, reducedStore.get, reducedStore.server);
  const dense = useSyncExternalStore(wideStore.subscribe, wideStore.get, wideStore.server);
  const webgl = useSyncExternalStore(noop, hasWebgl, () => true);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);

  return { reduced, inView, dense, webgl };
}
