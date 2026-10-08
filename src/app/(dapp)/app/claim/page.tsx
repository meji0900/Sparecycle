import type { Metadata } from "next";
import { ClaimView } from "@/components/dapp/claim-view";

export const metadata: Metadata = {
  title: "Claim",
  description: "Claim a settled epoch's payout with a Merkle proof against the posted root.",
};

export default function ClaimPage() {
  return <ClaimView />;
}
