"use client";

import { useSyncExternalStore } from "react";
import { useAccount } from "wagmi";

const noop = () => () => undefined;

/** True only in the browser after hydration. */
export const useMounted = () => useSyncExternalStore(noop, () => true, () => false);

/**
 * The connected account, but only after hydration: the server never renders wallet state, so a page can't show
 * one visitor's address to another and the first client render always matches the server HTML.
 */
export function useWallet() {
  const acct = useAccount();
  const mounted = useMounted();
  return {
    mounted,
    address: mounted ? acct.address : undefined,
    chainId: mounted ? acct.chainId : undefined,
    isConnected: mounted && acct.isConnected,
  };
}
