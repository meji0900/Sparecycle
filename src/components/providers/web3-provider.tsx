"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { darkTheme, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { targetChain } from "@/lib/chain";
import { wagmiConfig } from "@/lib/wagmi";

const theme = darkTheme({
  accentColor: "#00c805",
  accentColorForeground: "#041a05",
  borderRadius: "small",
  fontStack: "system",
  overlayBlur: "none",
});
theme.colors.modalBackground = "#111111";
theme.colors.modalBorder = "rgba(255,255,255,0.08)";
theme.colors.profileForeground = "#111111";
theme.colors.generalBorder = "rgba(255,255,255,0.08)";
theme.colors.closeButtonBackground = "#171717";
theme.fonts.body = "var(--font-geist-sans), system-ui, sans-serif";

export function Web3Provider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false } } }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme} initialChain={targetChain} modalSize="compact" appInfo={{ appName: "Sparecycle" }}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
