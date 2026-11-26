import type { Metadata } from "next";
import { ClaimView } from "@/components/dapp/claim-view";
import { ButtonLink } from "@/components/ui/button";
import { Notice } from "@/components/ui/status";

export const metadata: Metadata = {
  title: "Claim",
  description: "Claim a settled epoch's payout with a Merkle proof against the posted root.",
};

export default function ClaimPage() {
  return (
    <>
      <ClaimView />
      <Notice
        tone="neutral"
        title="Optional: stake SPARE for your nodes"
        className="mt-10"
        action={
          <ButtonLink href="/nodes/stake" variant="secondary" size="sm">
            Stake or unstake
          </ButtonLink>
        }
      >
        Owner wallets can lock SPARE as collateral. Nobody has to: the minimum per node is 0, so payouts and claims work the same without it, and
        staking pays nothing.
      </Notice>
    </>
  );
}
