import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/dapp/app-shell";
import { StakePanel } from "@/components/dapp/stake-panel";
import { StakingNumbers } from "@/components/dapp/staking-numbers";
import { SectionTitle } from "@/components/dapp/ui";
import { StatusTag } from "@/components/ui/status";
import { repoFile } from "@/lib/site";
import { PROPOSAL_GRACE_EPOCHS } from "@/lib/staking";
import { APPEAL_WINDOW_EPOCHS, FAULT_WINDOW_EPOCHS, FAULTS_PER_PROPOSAL, SLASH_BPS, UNSTAKE_COOLDOWN_EPOCHS } from "@/lib/token-rules";
import { stakeContract } from "@/server/staking";

export const metadata: Metadata = {
  title: "Stake SPARE (optional)",
  description:
    "Node owners can lock SPARE in SparecycleNodeStake as optional collateral. The minimum is 0, so running a node needs no token. Staking pays nothing.",
};

/** The windows as the contract was deployed (six-hour epochs; DeployNodeStake checked them against defaultConfig()). */
const DECISION_WINDOW_EPOCHS = 12;
const hours = (epochs: number) => epochs * 6;
const slashPct = `${SLASH_BPS / 100}%`;

const GLANCE: [string, string][] = [
  ["Needed to run a node", "No. The minimum per node is 0."],
  ["Pays", "Nothing. Nodes are paid for checked work either way."],
  ["Slash", `At most ${slashPct} per proposal, burned`],
  ["Appeal window", `${APPEAL_WINDOW_EPOCHS} epochs (at least ${hours(APPEAL_WINDOW_EPOCHS)} h)`],
  ["Between proposals", `${PROPOSAL_GRACE_EPOCHS} epochs (at least ${hours(PROPOSAL_GRACE_EPOCHS)} h)`],
  ["Unstake cooldown", `${UNSTAKE_COOLDOWN_EPOCHS} epochs (at least ${hours(UNSTAKE_COOLDOWN_EPOCHS) / 24} days); a new request restarts it`],
  ["Decided by", "The treasury Safe. Not trustless."],
  ["Audit", "Internal review only, not externally audited"],
];

const RULES: [string, string][] = [
  [
    "Optional",
    "Staking is voluntary collateral for your nodes. The minimum stake per node is 0, so running a node needs no token, and a node is paid for checked work whether or not its owner stakes. Staking itself pays nothing.",
  ],
  [
    "When part of a stake can be taken",
    `Only after repeated faults proven against two other owners' results: the scheduler counts a fault only when a node's signed result disagrees with a result that two other nodes of two other owner wallets agreed on, and proposes a slash after ${FAULTS_PER_PROPOSAL} such faults within ${FAULT_WINDOW_EPOCHS} epochs. A single mismatch never leads to a slash.`,
  ],
  [
    "Appeal, then the Safe decides",
    `Each proposal names the hash of a public evidence bundle and opens an appeal window of ${APPEAL_WINDOW_EPOCHS} epochs (at least ${hours(APPEAL_WINDOW_EPOCHS)} hours). Your stake is frozen meanwhile and you can appeal. The treasury Safe then executes or cancels the proposal; if it decides nothing within ${DECISION_WINDOW_EPOCHS} more epochs, the proposal expires.`,
  ],
  [
    `At most ${slashPct} per proposal, burned`,
    `One executed proposal takes at most ${slashPct} of your stake (active plus what waits in the cooldown). It is burned: nobody receives it, not the project and not the other nodes. After every proposal, no new one against the same wallet for ${PROPOSAL_GRACE_EPOCHS} epochs.`,
  ],
  [
    "Leaving takes a request and a wait",
    `Request an unstake, wait ${UNSTAKE_COOLDOWN_EPOCHS} epochs (at least ${hours(UNSTAKE_COOLDOWN_EPOCHS) / 24} days), then withdraw. A new request restarts the cooldown for everything already waiting. SPARE in the cooldown no longer counts as stake but can still be slashed, and nothing can leave while a proposal is open.`,
  ],
  [
    "Not trustless",
    "The scheduler proposes and the treasury Safe decides; all three of the Safe's keys are held by the project owner today. The contract enforces the limits (the cap, the appeal window, the burn, the expiry, the grace window) but cannot check the evidence.",
  ],
  [
    "Not externally audited",
    "SparecycleNodeStake has had an internal review only. Stake only what you are prepared to have locked for days, and to lose in part if your node keeps returning wrong results.",
  ],
  [
    "Public",
    "Every stake, request, proposal, appeal and decision is an event on Robinhood Chain. The totals above are read from the contract, and every evidence bundle is meant to be published.",
  ],
];

export default function StakePage() {
  // Read when the page is built (per request in `next dev`): TOKEN_NODE_STAKE_ADDRESS, else the live contract on mainnet.
  const contract = stakeContract();
  return (
    <>
      <p className="mb-4 text-sm">
        <Link href="/nodes" className="text-muted transition-colors hover:text-text">
          <span aria-hidden>← </span>Run a node
        </Link>
      </p>
      <PageHeader
        title="Stake SPARE (optional)"
        description="Node owners can lock SPARE as collateral for their nodes. You don't have to: the minimum per node is 0, so running a node needs no token, and staking pays nothing. Repeated proven faults can cost part of a stake, which is burned."
        aside={<StatusTag tone="neutral">Voluntary</StatusTag>}
      />

      <StakingNumbers />

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <StakePanel contract={contract} />
        <section aria-labelledby="stake-glance" className="min-w-0 rounded-l border border-line bg-coal lg:sticky lg:top-24">
          <h2 id="stake-glance" className="border-b border-line px-5 py-3.5 font-medium text-text">
            At a glance
          </h2>
          <dl className="divide-y divide-line">
            {GLANCE.map(([k, v]) => (
              <div key={k} className="px-5 py-3">
                <dt className="text-xs text-faint">{k}</dt>
                <dd className="mt-0.5 text-sm text-text">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t border-line px-5 py-3.5 text-xs leading-relaxed text-faint">
            Epochs are the reward contract&apos;s six-hour epochs.{" "}
            <a href="#how-staking-works" className="link">
              The rules
            </a>
          </p>
        </section>
      </div>

      <section aria-labelledby="how-staking-works" className="mt-14 scroll-mt-24">
        <SectionTitle
          id="how-staking-works"
          title="How staking works"
          description={
            <>
              Every rule, the evidence and appeal bundle formats and the internal review notes are in{" "}
              <a href={repoFile("docs/node-staking.md")} className="link" target="_blank" rel="noreferrer">
                docs/node-staking.md
              </a>
              .
            </>
          }
        />
        <dl className="grid gap-px overflow-hidden rounded-l border border-line md:grid-cols-2 [&>*]:shadow-[0_0_0_1px_#1f1f1f]">
          {RULES.map(([t, d]) => (
            <div key={t} className="bg-coal px-5 py-4">
              <dt className="font-medium text-text">{t}</dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-muted">{d}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
