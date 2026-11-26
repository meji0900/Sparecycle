import type { Metadata } from "next";
import Link from "next/link";
import { C, Defs, DocsHeader, DocsNext, DocsSection, Ext, Note } from "@/components/docs/docs-ui";
import { NodeGuide } from "@/components/docs/node-guide";
import { ADDR, explorerAddressUrl } from "@/lib/addresses";
import { repoFile, siteOrigin } from "@/lib/site";
import { PROPOSAL_GRACE_EPOCHS } from "@/lib/staking";
import { APPEAL_WINDOW_EPOCHS, FAULT_WINDOW_EPOCHS, FAULTS_PER_PROPOSAL, SLASH_BPS, UNSTAKE_COOLDOWN_EPOCHS } from "@/lib/token-rules";

export const metadata: Metadata = {
  title: "Run a node",
  description:
    "Install the Sparecycle node client on Linux or Windows (NVIDIA, AMD / Intel / iGPU or CPU), link your wallet and see your node online.",
};

export default function RunANodePage() {
  return (
    <>
      <DocsHeader eyebrow="Get started" title="Run a node">
        <p>
          The node client runs checked AI jobs on your GPU (or CPU, for text) while you do not need it. Each job runs on two
          nodes with different owners; when the two results match, the work counts toward a share of that epoch&apos;s pot, which node
          owners claim on-chain. There is no fixed rate: an epoch with an empty pot pays nothing.
        </p>
        <p>Pick your system and hardware; every command below follows the choice.</p>
      </DocsHeader>

      <DocsSection id="install" title="From download to online">
        <NodeGuide origin={siteOrigin()} />
      </DocsSection>

      <DocsSection id="after" title="After it is running">
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          <li>
            Each six-hour epoch, the scheduler splits the pot by the work your node did in matching jobs and publishes the
            split. Claim your share with a Merkle proof on the <Link href="/app/claim" className="link">claim page</Link>.
          </li>
          <li>
            Only cards in a benched family are listed as supported. The list, and how a family gets on it, is in{" "}
            <Ext href={repoFile("docs/gpu-support.md")}>GPU support</Ext>.
          </li>
          <li>
            Every flag and environment variable of the client:{" "}
            <Ext href={repoFile("node-client/README.md")}>node-client/README.md</Ext>.
          </li>
          <li>
            Stuck? Ask on the <Link href="/docs/support" className="link">support page</Link>.
          </li>
        </ul>
      </DocsSection>

      <DocsSection id="staking" title="Staking (optional)">
        <p>
          You can lock SPARE in the stake contract as collateral for your nodes. You don&apos;t have to: the minimum stake per node is
          0, so a node needs no token to run and is paid for checked work either way. Staking pays nothing by itself. To stake, connect
          your owner wallet on the <Link href="/nodes/stake" className="link">staking page</Link>.
        </p>
        <Defs
          items={[
            [
              "Stake",
              <>
                Two transactions: approve exactly the amount for the stake contract, then <C>stake(amount)</C>. Staking more is always
                allowed.
              </>,
            ],
            [
              "When part of it can be taken",
              <>
                Only after repeated faults proven against two other owners&apos; results: a fault is your node&apos;s signed result
                disagreeing with a result two other nodes of two other owner wallets agreed on, and the scheduler proposes a slash after{" "}
                {FAULTS_PER_PROPOSAL} faults within {FAULT_WINDOW_EPOCHS} epochs. A single mismatch never leads to a slash.
              </>,
            ],
            [
              "Appeal and decision",
              <>
                Each proposal opens a {APPEAL_WINDOW_EPOCHS}-epoch appeal window (at least {APPEAL_WINDOW_EPOCHS * 6} hours): your stake is
                frozen and you can record the hash of an appeal bundle with <C>appeal(proposalId, hash)</C>. The treasury Safe then
                executes or cancels it; undecided, it expires.
              </>,
            ],
            [
              "Cap and burn",
              <>
                At most {SLASH_BPS / 100}% of your stake per executed proposal, and it is burned: nobody receives it. After every proposal,
                none against the same wallet for {PROPOSAL_GRACE_EPOCHS} epochs (the grace window).
              </>,
            ],
            [
              "Leaving",
              <>
                <C>requestUnstake(amount)</C>, then wait {UNSTAKE_COOLDOWN_EPOCHS} epochs (at least {(UNSTAKE_COOLDOWN_EPOCHS * 6) / 24}{" "}
                days) and <C>unstake()</C>. A new request restarts the cooldown for everything waiting, so request everything at once.
                SPARE in the cooldown no longer counts as stake but can still be slashed; <C>cancelUnstake()</C> moves it back.
              </>,
            ],
            [
              "Public figures",
              <>
                Total staked, owners staking, total slashed and the minimum, read from the chain: <C>GET /api/v1/staking</C>, and on the{" "}
                <Link href="/nodes#staking" className="link">node page</Link>.
              </>,
            ],
          ]}
        />
        <Note tone="warn" title="Not trustless, not externally audited">
          <p>
            The scheduler proposes and the treasury Safe decides; all three of the Safe&apos;s keys are held by the project owner today. The
            contract only enforces the limits (the cap, the appeal window, the burn, the expiry, the grace window). SparecycleNodeStake has
            had an internal review only.
          </p>
        </Note>
        <p>
          Every rule, the evidence and appeal bundle formats and the review notes:{" "}
          <Ext href={repoFile("docs/node-staking.md")}>docs/node-staking.md</Ext>. The contract:{" "}
          <Ext href={explorerAddressUrl(ADDR.nodeStake)}>SparecycleNodeStake on Blockscout</Ext>.
        </p>
      </DocsSection>

      <DocsNext
        links={[
          { href: "/docs/contracts", title: "Contracts and keys", description: "Where the pot lives and who can do what." },
          { href: "/docs/first-job", title: "Your first job", description: "Send your node some work." },
        ]}
      />
    </>
  );
}
