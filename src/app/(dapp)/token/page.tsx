import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/dapp/app-shell";
import { Dash, Fact, Facts, Panel, SectionTitle, TableBox, td, th } from "@/components/dapp/ui";
import { Hex } from "@/components/ui/address";
import { Notice, StatusTag } from "@/components/ui/status";
import { explorerAddress } from "@/lib/chain";
import { config, tickerLabel } from "@/lib/config";
import { formatAmount, formatBps, formatInt } from "@/lib/format";
import { chainSnapshot } from "@/lib/onchain";
import { PONS, PONS_DOCS_URL, PONS_LABELS, USDG_ADDRESS } from "@/lib/pons";
import { FUNDING } from "@/lib/funding-copy";
import { HeyBuilderCard } from "@/components/dapp/hey-builder-card";
import { StakingNumbers } from "@/components/dapp/staking-numbers";
import { serverEnv } from "@/server/env";
import { tokenCopy } from "@/lib/token-copy";
import { tokenCopyState } from "@/server/token-copy-state";

export const metadata: Metadata = {
  title: "Token",
  description: "Token address, the Pons v2 factory, live fee reads and the plain facts: no allocation, LP locked by Pons, buyback off.",
};

export const dynamic = "force-dynamic";

type Launch = {
  exists: boolean;
  curve: string;
  creatorFeeRecipient: string;
  pairToken: string;
  graduationThreshold: string;
  creatorTaxBps: number;
  buybackEnabled: boolean;
  phase: string;
  protocolFeeShareBps: number;
};
type Curve = { address: string; feeBps: string; creatorTaxBps: string; buybackEnabled: boolean };

const ZERO = "0x0000000000000000000000000000000000000000";
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const FACTS: [string, string][] = [
  ["No allocation", "The entire supply is minted to the Pons bonding curve at launch. The creator receives no reserved tokens, and nobody holds a bag set aside before trading opens."],
  ["LP locked by Pons at graduation", "If the curve sells out, Pons moves the launch into a Uniswap v4 pool with a Pons hook and locks the liquidity permanently in its launch locker. Sparecycle provides no LP of its own and cannot pull any. A lock is not a price floor."],
  ["Buyback off", config.creatorFeeWallet ? "The launch parameters set buybackEnabled to false. The creator share of fees goes to the team wallet set at launch, not to a token vest." : "The launch parameters set buybackEnabled to false, so the creator share of fees funds node work instead of a token vest. The live read above shows the setting once the token exists."],
  ["Opening snipe tax", "Pons taxes buys in the first 5 seconds after launch: 99% at the start, about 25% at 1 second and 3% at 2 seconds, zero by 5 seconds. Sells are never taxed by it. It joins the trading fee, so part of it reaches the reward pot. A buy in those seconds loses most of what was paid."],
  [FUNDING.factTitle, FUNDING.factBody],
  [`Unaudited as of ${config.factsCheckedOn}`, "Official Pons docs listed reviews by SB Security, Dingbats and Pashov Audit Group as in progress, with no report closed. Treat Pons v2 as unaudited until reports are published. The Sparecycle reward contract is a separate contract."],
  ["Can go to zero", "Pons launch tokens are volatile. Names and symbols are not unique; the token address is the only reliable identifier. Graduation means the curve sold out, not that the project is good."],
];

function Decision({ label, value, placeholder, children }: { label: string; value: ReactNode | null; placeholder: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 bg-coal px-5 py-4">
      <dt className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        {label}
        {value === null ? <StatusTag tone="warn">Not decided yet</StatusTag> : <StatusTag tone="neutral">Set</StatusTag>}
      </dt>
      <dd className="text-[15px] text-text">{value ?? <span className="num text-muted">{placeholder}</span>}</dd>
      <dd className="text-xs leading-relaxed text-faint">{children}</dd>
    </div>
  );
}

export default async function TokenPage() {
  // Token features (docs/token-features.md): one extra fact per TOKEN_* flag that is on; none while they are off.
  const copy = tokenCopy(await tokenCopyState());
  const snap = await chainSnapshot();
  const pons = snap.pons.ok ? snap.pons.data : null;
  const tok = snap.token && snap.token.ok ? snap.token.data : null;
  const launch = (tok?.launch ?? null) as Launch | null;
  const curve = (tok?.curve ?? null) as Curve | null;
  const network = snap.network.ok ? snap.network.data : null;

  const recipient = launch?.creatorFeeRecipient ?? null;
  const recipientIs = same(recipient, config.rewardContract) ? "reward contract" : same(recipient, config.multisig) ? "multisig" : null;
  const buybackOn = launch?.buybackEnabled === true || curve?.buybackEnabled === true;

  return (
    <>
      <PageHeader
        art="/art/banner-token.webp"
        title="Token"
        description={
          <>
            The token, stated plainly. Live reads where the contracts exist, labelled placeholders where they do not. No price
            chart and no forecast.
          </>
        }
        aside={
          network ? (
            <StatusTag tone="live">
              Block <span className="num">{formatInt(BigInt(network.blockNumber))}</span>
            </StatusTag>
          ) : (
            <StatusTag tone="error">RPC unreachable</StatusTag>
          )
        }
      />

      <div className="space-y-3">
        {/* Token features (docs/token-features.md): only with TOKEN_HOLDER_PAGE on; off (the default) renders nothing. */}
        {serverEnv.tokenHolderPage() ? (
          <Notice
            tone="neutral"
            title="Holders"
            action={
              // TOKEN_HOLDERS on as well: also a link to the claim panel. Off: exactly the one link as before.
              serverEnv.tokenHolders() ? (
                <span className="flex flex-wrap gap-x-4 gap-y-1">
                  <Link href="/token/holders#claim" className="link text-sm">
                    Claim compute credits
                  </Link>
                  <Link href="/token/holders" className="link text-sm">
                    Open the holder page
                  </Link>
                </span>
              ) : (
                <Link href="/token/holders" className="link text-sm">
                  Open the holder page
                </Link>
              )
            }
          >
            SPARE burned, distributed to holders and staked by node owners, read from the chain.
            {serverEnv.tokenHolders() ? " Eligible holders can claim compute credits there; credits pay for jobs and cannot be withdrawn." : null}
          </Notice>
        ) : null}
        {config.tokenAddress && snap.token && !snap.token.ok ? (
          <Notice tone="error" title="Could not read the token">
            The token address is configured but the read failed. Nothing is shown rather than a stale number.
          </Notice>
        ) : null}
        {recipient && !recipientIs ? (
          <Notice tone="warn" title="Creator fee recipient is not the reward contract or the multisig">
            Fees from this token go to <Hex value={recipient} />. The plan is to send them to the reward contract, or to the
            multisig that forwards them. Check before relying on any payout.
          </Notice>
        ) : null}
        {buybackOn ? (
          <Notice tone="warn" title="Buybacks are on for this token">
            The plan is to launch with buybacks off so the creator share funds node work. Part of the fees go to a token vest
            instead.
          </Notice>
        ) : null}
      </div>

      <section aria-labelledby="the-token" className="mt-10">
        <SectionTitle id="the-token" title="The token" />
        <Panel>
          <Facts cols={3}>
            <Fact label="Token address" note="The only reliable identifier. Names and symbols are not unique.">
              {config.tokenAddress ? <Hex value={config.tokenAddress} /> : <Dash why="Not launched yet" />}
            </Fact>
            <Fact label="Ticker">
              {config.ticker ? <span className="num">{tickerLabel()}</span> : <span className="num text-muted">[TICKER]</span>}
              {config.ticker ? null : <span className="ml-1.5 text-sm text-faint">set at launch</span>}
            </Fact>
            <Fact label="Launched through" note={<a href={PONS_DOCS_URL} className="link" target="_blank" rel="noreferrer">Pons v2 docs</a>}>
              <span className="mr-2">Pons v2 factory</span>
              <Hex value={PONS.factory} />
            </Fact>
            {tok ? (
              <>
                <Fact label="Name and symbol">
                  {tok.name} <span className="num text-muted">{tok.symbol}</span>
                </Fact>
                <Fact label="Decimals">
                  <span className="num">{tok.decimals}</span>
                </Fact>
                <Fact label="Total supply">
                  <span className="num">{formatAmount(BigInt(tok.totalSupply), tok.decimals, 0)}</span>
                </Fact>
              </>
            ) : null}
            {launch ? (
              <>
                <Fact label="Phase">{launch.phase}</Fact>
                <Fact label="Bonding curve">{launch.curve && launch.curve !== ZERO ? <Hex value={launch.curve} /> : <Dash />}</Fact>
                <Fact label="Pair token">{launch.pairToken === ZERO ? "ETH (native)" : <Hex value={launch.pairToken} />}</Fact>
                <Fact label="Creator fee recipient" note={recipientIs ? `This is the ${recipientIs}.` : "Not the reward contract or the multisig."}>
                  <Hex value={launch.creatorFeeRecipient} />
                </Fact>
                <Fact label="Protocol share of the standard fee">
                  <span className="num">{formatBps(launch.protocolFeeShareBps)}</span>
                </Fact>
                <Fact label="Buyback">{launch.buybackEnabled ? <StatusTag tone="warn">On</StatusTag> : "Off"}</Fact>
              </>
            ) : null}
            {curve ? (
              <>
                <Fact label="Standard fee (curve feeBps)">
                  <span className="num">{formatBps(Number(curve.feeBps))}</span>
                </Fact>
                <Fact label="Creator tax (curve creatorTaxBps)" note="Fixed at launch. It cannot be raised.">
                  <span className="num">{formatBps(Number(curve.creatorTaxBps))}</span>
                </Fact>
              </>
            ) : null}
          </Facts>
        </Panel>
        {!config.tokenAddress ? (
          <p className="mt-3 text-sm text-muted">
            Until the launch transaction confirms there is no token address. Live token reads (name, supply, phase, fee rates,
            creator fee recipient) appear here once it is set.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="decisions" className="mt-14">
        <SectionTitle
          id="decisions"
          title="Open product decisions"
          description="Chosen before a mainnet launch and recorded in the deployment settings. They are fixed or expensive to change, so no default is assumed here."
        />
        <dl className="grid gap-px overflow-hidden rounded-l border border-line bg-line md:grid-cols-3">
          <Decision label="Creator tax" value={config.creatorTaxBps === null ? null : <span className="num">{formatBps(config.creatorTaxBps)}</span>} placeholder="[CREATOR_TAX_BPS]">
            Optional, on top of the standard Pons fee, capped by the factory
            {pons ? (
              <>
                {" "}
                (<span className="num">{formatBps(Number(pons.maxCreatorTaxBps))}</span> read live)
              </>
            ) : null}
            . Fixed at launch.
          </Decision>
          <Decision label="Pair asset" value={config.pairAsset} placeholder="[PAIR_ASSET]">
            ETH or USDG. Fees, and so the pot, arrive in this asset. Fixed at launch.
          </Decision>
          <Decision label="Node payout asset" value={config.nodePayoutAsset} placeholder="[NODE_PAYOUT_ASSET]">
            The asset nodes are paid in: the pair asset, or the token bought on the market with fees, never minted.
          </Decision>
        </dl>
      </section>

      <section aria-labelledby="factory" className="mt-14">
        <SectionTitle
          id="factory"
          title="Pons v2 factory, read live"
          description="Factory parameters can be changed by the Pons owner. They are re-read immediately before any launch."
        />
        <Panel>
          {pons ? (
            <Facts cols={3}>
              <Fact label="Launch fee">
                <span className="num">{formatAmount(BigInt(pons.launchFee), 18)}</span> <span className="text-sm text-muted">ETH</span>
              </Fact>
              <Fact label="Creator tax cap">
                <span className="num">{formatBps(Number(pons.maxCreatorTaxBps))}</span>
              </Fact>
              <Fact label="Launches enabled" note="Whether a given wallet can launch is a separate check (canLaunch).">
                {pons.launchEnabled ? "Yes" : "No"}
              </Fact>
              <Fact label="Launch config" note={pons.launchConfigIdIsDefault ? "[LAUNCH_CONFIG_ID] not set; showing config 0." : undefined}>
                <span className="num">{pons.launchConfigId}</span> {pons.config.enabled ? <span className="text-sm text-muted">enabled</span> : <StatusTag tone="warn">Disabled</StatusTag>}
              </Fact>
              <Fact label={`Supply, config ${pons.launchConfigId}`}>
                <span className="num">{formatAmount(BigInt(pons.config.supply), 18, 0)}</span>
              </Fact>
              <Fact label={`Standard fee, config ${pons.launchConfigId}`} note="curveFeeBps">
                <span className="num">{formatBps(Number(pons.config.curveFeeBps))}</span>
              </Fact>
              <Fact label={`Graduation threshold, config ${pons.launchConfigId}`}>
                <span className="num">{formatAmount(BigInt(pons.config.graduationThreshold), 18)}</span> <span className="text-sm text-muted">ETH</span>
              </Fact>
              <Fact label="USDG approved as a pair" note={<Hex value={USDG_ADDRESS} />}>
                {pons.usdgApproved ? "Yes" : "No"}
              </Fact>
            </Facts>
          ) : (
            <p className="px-5 py-5 text-sm text-muted">
              <Dash why={snap.pons.ok ? undefined : snap.pons.error === "pons-not-on-this-network" ? "Pons v2 is not deployed on this network" : "Could not read the Pons factory right now"} />
            </p>
          )}
        </Panel>
      </section>

      <HeyBuilderCard />

      <section aria-labelledby="node-staking" className="mt-14 scroll-mt-24">
        <SectionTitle
          id="node-staking"
          title="Node staking (optional)"
          description={
            <>
              Node owners can lock SPARE in SparecycleNodeStake as collateral. It is voluntary and pays nothing; with a minimum of 0
              per node, running a node needs no token. A slash, only after repeated proven faults and an appeal window, is decided by
              the treasury Safe, takes at most 10% per proposal and is burned.
            </>
          }
        />
        <StakingNumbers cta />
      </section>

      <section aria-labelledby="plainly" className="mt-14">
        <SectionTitle id="plainly" title="Stated plainly" />
        <dl className="grid gap-px overflow-hidden rounded-l border border-line bg-line md:grid-cols-2">
          {[...FACTS, ...copy.disclosures.map((x): [string, string] => [x.title, x.body])].map(([t, d]) => (
            <div key={t} className="bg-coal px-5 py-4">
              <dt className="font-medium text-text">{t}</dt>
              <dd className="mt-1.5 text-sm leading-relaxed text-muted">{d}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="pons-contracts" className="mt-14">
        <SectionTitle
          id="pons-contracts"
          title="Official Pons v2 contracts"
          description={
            <>
              Robinhood Chain, chain id <span className="num">4663</span>, from the deployed-address list in the{" "}
              <a href={PONS_DOCS_URL} className="link" target="_blank" rel="noreferrer">
                Pons v2 docs
              </a>
              . Sparecycle is not affiliated with or endorsed by Pons.
            </>
          }
        />
        <Panel>
          <TableBox label="Pons v2 contracts" minWidth={560}>
            <thead>
              <tr>
                <th className={th}>Contract</th>
                <th className={th}>Address</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(PONS) as (keyof typeof PONS)[]).map((k) => (
                <tr key={k}>
                  <td className={`${td} text-text`}>{PONS_LABELS[k]}</td>
                  <td className={td}>
                    <Hex value={PONS[k]} head={10} tail={8} />
                    {!explorerAddress(PONS[k]) ? <span className="ml-2 text-xs text-faint">explorer not set</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableBox>
        </Panel>
      </section>
    </>
  );
}
