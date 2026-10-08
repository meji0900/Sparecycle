// Chain layer: Robinhood Chain (Arbitrum Orbit L2, EVM). Mainnet chain id 4663 is verified live
// (eth_chainId on https://rpc.mainnet.chain.robinhood.com returned 4663 on 20 Nov 2026).
// `local` = anvil (31337) for end-to-end tests of the reward contract; never shown on the live site.
import { createPublicClient, fallback, http, type Chain } from "viem";
import { foundry, robinhood, robinhoodTestnet } from "viem/chains";
import { config } from "./config";

export const ROBINHOOD_CHAIN_ID = 4663 as const;

const base: Record<typeof config.network, Chain> = {
  mainnet: robinhood,
  testnet: robinhoodTestnet,
  local: foundry,
};

/** The one chain this deployment targets. Wrong-network UI forces the wallet onto this chain. */
export const targetChain: Chain = (() => {
  const c = base[config.network];
  const rpc = config.rpcUrl;
  const explorer = config.explorerUrl;
  return {
    ...c,
    rpcUrls: rpc ? { default: { http: [rpc, ...c.rpcUrls.default.http] } } : c.rpcUrls,
    blockExplorers: explorer
      ? { default: { name: "Explorer", url: explorer.replace(/\/$/, "") } }
      : c.blockExplorers,
  } as Chain;
})();

export const explorerBase = () => targetChain.blockExplorers?.default.url ?? null;
export const explorerTx = (hash: string) => (explorerBase() ? `${explorerBase()}/tx/${hash}` : null);
export const explorerAddress = (a: string) => (explorerBase() ? `${explorerBase()}/address/${a}` : null);

const direct = http(targetChain.rpcUrls.default.http[0], { batch: true, retryCount: 2, timeout: 12_000 });

/**
 * Server- or client-side read client for the target chain. In the browser the site's read-only relay
 * (/api/rpc) is the fallback, because some ISPs DNS-block the public Robinhood Chain RPC.
 */
export const publicClient = createPublicClient({
  chain: targetChain,
  transport:
    typeof window === "undefined"
      ? direct
      : fallback([direct, http(new URL("/api/rpc", window.location.origin).href, { batch: true, retryCount: 1, timeout: 15_000 })]),
});
