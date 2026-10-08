import type { Metadata } from "next";
import { StatusView } from "@/components/dapp/status-view";

export const metadata: Metadata = {
  title: "Network status",
  description: "Live epoch, pot, reserved and claimed amounts, the Merkle root, recent jobs and registered nodes.",
};

export default function StatusPage() {
  return <StatusView />;
}
