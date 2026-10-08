import { AppShell } from "@/components/dapp/app-shell";
import { Web3Provider } from "@/components/providers/web3-provider";

export default function DappLayout({ children }: { children: React.ReactNode }) {
  return (
    <Web3Provider>
      <AppShell>{children}</AppShell>
    </Web3Provider>
  );
}
