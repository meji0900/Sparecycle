"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useSwitchChain } from "wagmi";
import { targetChain } from "@/lib/chain";
import { truncateMiddle } from "@/lib/format";
import { Button } from "@/components/ui/button";

/**
 * Wallet states for the app shell: disconnected → "Connect Wallet"; wrong network → force Robinhood Chain;
 * connected → short address (opens the account modal).
 */
export function WalletButton({ className }: { className?: string }) {
  const { switchChain, isPending } = useSwitchChain();
  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, openAccountModal, mounted }) => {
        const ready = mounted;
        if (!ready) {
          return (
            <Button size="sm" variant="secondary" className={className} disabled aria-hidden>
              Connect Wallet
            </Button>
          );
        }
        if (!account) {
          return (
            <Button size="sm" className={className} onClick={openConnectModal}>
              Connect Wallet
            </Button>
          );
        }
        if (chain?.unsupported || chain?.id !== targetChain.id) {
          return (
            <Button
              size="sm"
              variant="secondary"
              className={`${className ?? ""} border-amber/50 text-amber`}
              disabled={isPending}
              onClick={() => switchChain({ chainId: targetChain.id })}
            >
              {isPending ? "Confirm in wallet…" : `Switch to ${targetChain.name}`}
            </Button>
          );
        }
        return (
          <Button size="sm" variant="secondary" className={className} onClick={openAccountModal}>
            <span aria-hidden className="size-1.5 rounded-full bg-signal" />
            <span className="num">{truncateMiddle(account.address, 6, 4)}</span>
          </Button>
        );
      }}
    </ConnectButton.Custom>
  );
}
