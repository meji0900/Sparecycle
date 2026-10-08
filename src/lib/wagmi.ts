import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  braveWallet,
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { createConfig, fallback, http } from "wagmi";
import { targetChain } from "./chain";
import { config } from "./config";
import { FUNDING } from "./funding-copy";

const projectId = config.walletConnectProjectId;

// Without a WalletConnect project id only browser-extension wallets are offered (no QR / mobile deep links).
const wallets = projectId
  ? [{ groupName: "Wallets", wallets: [injectedWallet, rabbyWallet, metaMaskWallet, coinbaseWallet, walletConnectWallet, braveWallet] }]
  : [{ groupName: "Browser wallets", wallets: [injectedWallet, rabbyWallet, coinbaseWallet, braveWallet] }];

const connectors = connectorsForWallets(wallets, {
  appName: "Sparecycle",
  projectId: projectId ?? "not-configured",
  appDescription: FUNDING.tagline,
});

// Direct RPC first; in the browser the site's own read-only relay (/api/rpc) follows as a fallback, because some
// ISPs DNS-block the public Robinhood Chain RPC while the server can still reach it.
const relay = typeof window !== "undefined" ? [http(new URL("/api/rpc", window.location.origin).href)] : [];

export const wagmiConfig = createConfig({
  chains: [targetChain],
  connectors,
  transports: {
    [targetChain.id]: fallback([...targetChain.rpcUrls.default.http.map((u) => http(u)), ...relay]),
  },
  // No server-side wallet state: the server never knows who is connected, so one visitor's account can
  // never be rendered into another visitor's HTML. The browser restores the session (localStorage) on mount.
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
