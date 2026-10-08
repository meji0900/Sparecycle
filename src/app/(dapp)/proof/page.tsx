import type { Metadata } from "next";
import type { ReactNode } from "react";
import { formatEther, type Address, type Hash } from "viem";
import { PageHeader } from "@/components/dapp/app-shell";
import { Dash, Fact, Facts, Panel, SectionTitle, TableBox, td, th } from "@/components/dapp/ui";
import { Hex } from "@/components/ui/address";
import { StatusTag } from "@/components/ui/status";
import { sparecycleRewardsAbi } from "@/contracts/sparecycleRewards";
import { publicClient, targetChain } from "@/lib/chain";
import { formatInt } from "@/lib/format";
import { LAUNCH_PHASES, PONS, ponsFactoryAbi } from "@/lib/pons";
import { ALL_MAINNET_TXS, LAUNCH_TX, MAINNET, MAINNET_EXPLORER, PAYMENTS, SOURCIFY_REPO, TEST_RUNS, TESTNET, TESTNET_EXPLORER, TOKEN, EARLIER_TOKEN, TREASURY } from "@/lib/proof";
import { config } from "@/lib/config";
import { parseAbi } from "viem";
import { HeyBuilderCard } from "@/components/dapp/hey-builder-card";

export const metadata: Metadata = {
  title: "Proof",
  description:
    "The mainnet reward contract, its verified source, every setup transaction and the tests run before launch, each with a link you can open and check.",
};

export const dynamic = "force-dynamic";

const ZERO = "0x0000000000000000000000000000000000000000";
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Everything a stranger needs to confirm the deployment, read from the chain on each request. */
async function readLive() {
  if (targetChain.id !== MAINNET.chainId) return null;
  try {
    const c = { address: MAINNET.rewardContract as Address, abi: sparecycleRewardsAbi } as const;
    const [code, owner, scheduler, escrow, payout, epochLength, current, contractBalance, schedulerBalance, sweepBalance, receipts] = await Promise.all([
      publicClient.getCode({ address: c.address }),
      publicClient.readContract({ ...c, functionName: "owner" }),
      publicClient.readContract({ ...c, functionName: "scheduler" }),
      publicClient.readContract({ ...c, functionName: "feeEscrow" }),
      publicClient.readContract({ ...c, functionName: "payoutToken" }),
      publicClient.readContract({ ...c, functionName: "epochLength" }),
      publicClient.readContract({ ...c, functionName: "currentEpoch" }),
      publicClient.getBalance({ address: c.address }),
      publicClient.getBalance({ address: MAINNET.scheduler as Address }),
      publicClient.getBalance({ address: MAINNET.sweepBot as Address }),
      Promise.all(
        ALL_MAINNET_TXS.map((t) =>
          publicClient
            .getTransactionReceipt({ hash: t.hash as Hash })
            .then((r) => [t.hash, r.status] as const)
            .catch(() => [t.hash, "unknown"] as const),
        ),
      ),
    ]);
    const block = await publicClient.getBlockNumber();
    // The launch as the Pons factory records it. Read on its own so a failure here hides only this section.
    const launch = await publicClient
      .readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [TOKEN.address as Address] })
      .catch(() => null);
    // The treasury Safe as the chain reports it (owners and threshold), read on its own like the launch.
    const safeAbi = parseAbi(["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"]);
    const safe = await Promise.all([
      publicClient.readContract({ address: TREASURY.safe as Address, abi: safeAbi, functionName: "getOwners" }),
      publicClient.readContract({ address: TREASURY.safe as Address, abi: safeAbi, functionName: "getThreshold" }),
    ])
      .then(([owners, threshold]) => ({ owners, threshold: Number(threshold) }))
      .catch(() => null);
    return {
      safe,
      launch,
      deployed: !!code && code !== "0x",
      owner,
      scheduler,
      escrow,
      payout,
      epochLength: Number(epochLength),
      currentEpoch: current,
      contractBalance,
      schedulerBalance,
      sweepBalance,
      receipts: Object.fromEntries(receipts) as Record<string, "success" | "reverted" | "unknown">,
      block,
    };
  } catch {
    return null;
  }
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="link">
      {children}
    </a>
  );
}

const mainAddr = (a: string) => `${MAINNET_EXPLORER}/address/${a}`;
const mainTx = (h: string) => `${MAINNET_EXPLORER}/tx/${h}`;
const testTx = (h: string) => `${TESTNET_EXPLORER}/tx/${h}`;

/** Live value next to the value on record: a tag says whether they agree. */
function Check({ live, ok, children }: { live: boolean; ok: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {children}
      {live ? ok ? <StatusTag tone="live">Matches</StatusTag> : <StatusTag tone="error">Differs</StatusTag> : null}
    </span>
  );
}

const eth = (wei: bigint) => `${Number(formatEther(wei)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`;

export default async function ProofPage() {
  const live = await readLive();
  const isLive = !!live;

  return (
    <>
      <PageHeader
        title="Proof"
        description={
          <>
            What is deployed, who controls it, and what was tested before launch. Each line links to the transaction or source
            it rests on, so you can check it without trusting this page.
          </>
        }
        aside={
          live ? (
            <StatusTag tone="live">
              Read live at block <span className="num">{formatInt(live.block)}</span>
            </StatusTag>
          ) : (
            <StatusTag tone="off">Live reads unavailable</StatusTag>
          )
        }
      />

      <section aria-labelledby="reward-contract">
        <SectionTitle
          id="reward-contract"
          title="Mainnet reward contract"
          description={
            <>
              Robinhood Chain, chain id <span className="num">{MAINNET.chainId}</span>. The creator share of the token&apos;s Pons
              trading fees and the creator tax are paid into this contract, and node owners claim from it. Live values are read from the chain on every
              page load and compared with the record.
            </>
          }
        />
        <Panel>
          <Facts cols={2}>
            <Fact
              label="Contract"
              note={
                <>
                  <Ext href={mainAddr(MAINNET.rewardContract)}>Open on Blockscout</Ext>
                  {live ? (live.deployed ? " · bytecode present" : " · no bytecode at this address") : null}
                </>
              }
            >
              <Hex value={MAINNET.rewardContract} link={false} head={10} tail={8} />
            </Fact>
            <Fact
              label="Source code"
              note={
                <>
                  Sourcify compiled the published source and got exactly the deployed bytecode (checked {MAINNET.sourcify.checkedOn}).
                </>
              }
            >
              <span className="inline-flex flex-wrap items-center gap-2">
                <StatusTag tone="live">Verified, exact match</StatusTag>
                <Ext href={`${SOURCIFY_REPO}/${MAINNET.chainId}/${MAINNET.rewardContract}`}>Read the source</Ext>
              </span>
            </Fact>
            <Fact label="Owner" note="One wallet, not a multisig. It can replace the scheduler, pause claims and return stray tokens. It has no function to withdraw the payout asset.">
              <Check live={isLive} ok={same(live?.owner, MAINNET.owner)}>
                <Hex value={live?.owner ?? MAINNET.owner} link={false} />
              </Check>
            </Fact>
            <Fact label="Scheduler" note="The only address that can close an epoch and post its Merkle root.">
              <Check live={isLive} ok={same(live?.scheduler, MAINNET.scheduler)}>
                <Hex value={live?.scheduler ?? MAINNET.scheduler} link={false} />
              </Check>
            </Fact>
            <Fact label="Fee source" note="The official Pons v2 fee escrow. Set at deploy and can never change.">
              <Check live={isLive} ok={same(live?.escrow, PONS.feeEscrow)}>
                <Hex value={live?.escrow ?? MAINNET.ponsFeeEscrow} link={false} />
              </Check>
            </Fact>
            <Fact label="Payout asset" note="Fixed at deploy.">
              <Check live={isLive} ok={live?.payout === ZERO}>
                {live ? (live.payout === ZERO ? "ETH" : <Hex value={live.payout} link={false} />) : "ETH"}
              </Check>
            </Fact>
            <Fact label="Epoch length" note="Fixed at deploy.">
              <Check live={isLive} ok={live?.epochLength === MAINNET.epochLengthSeconds}>
                <span className="num">{(live?.epochLength ?? MAINNET.epochLengthSeconds) / 3600} hours</span>
              </Check>
            </Fact>
            <Fact label="Pot right now" note={live ? `Epoch ${live.currentEpoch.toString()}` : undefined}>
              {live ? <span className="num">{eth(live.contractBalance)}</span> : <Dash why="Live read unavailable" />}
            </Fact>
          </Facts>
        </Panel>
      </section>

      <section aria-labelledby="token" className="mt-14">
        <SectionTitle
          id="token"
          title="The token on Pons"
          description={`${TOKEN.name}, the official token, launched through the Pons v2 factory. These settings are stored in the factory at launch and can never change; they are read from it on every page load. An earlier launch, ${EARLIER_TOKEN.name} ${EARLIER_TOKEN.address.slice(0, 6)}…${EARLIER_TOKEN.address.slice(-4)}, sends its creator fees to the reward contract.`}
        />
        <Panel>
          <Facts cols={2}>
            <Fact label="Token" note={<Ext href={mainAddr(TOKEN.address)}>Open on Blockscout</Ext>}>
              <Hex value={TOKEN.address} link={false} head={10} tail={8} />
            </Fact>
            <Fact label="Bonding curve" note={live?.launch ? `Phase: ${LAUNCH_PHASES[live.launch.phase] ?? live.launch.phase}` : undefined}>
              <Hex value={live?.launch?.curve ?? TOKEN.curve} link={false} head={10} tail={8} />
            </Fact>
            <Fact label="Creator fee recipient" note="Where the creator share of trading fees and the creator tax go. Fixed at launch.">
              <Check live={!!live?.launch} ok={same(live?.launch?.creatorFeeRecipient, TOKEN.feeRecipient)}>
                <span className="inline-flex flex-wrap items-center gap-2">
                  <Hex value={live?.launch?.creatorFeeRecipient ?? TOKEN.feeRecipient} link={false} />
                  <span className="text-sm text-muted">{TOKEN.feeRecipientLabel}</span>
                </span>
              </Check>
            </Fact>
            <Fact label="Creator tax" note="Paid by buyers and sellers, all of it to the recipient above. Can never be raised.">
              <Check live={!!live?.launch} ok={live?.launch?.creatorTaxBps === TOKEN.creatorTaxBps}>
                <span className="num">{live?.launch ? `${live.launch.creatorTaxBps / 100}%` : "1%"}</span>
              </Check>
            </Fact>
            <Fact label="Buyback" note="Off: no token vest from the creator share.">
              <Check live={!!live?.launch} ok={live?.launch?.buybackEnabled === false}>
                {live?.launch ? (live.launch.buybackEnabled ? "On" : "Off") : "Off"}
              </Check>
            </Fact>
            <Fact label="Pair" note="Fees, and so node payouts, arrive in this asset.">
              <Check live={!!live?.launch} ok={live?.launch?.pairToken === ZERO}>
                ETH
              </Check>
            </Fact>
          </Facts>
        </Panel>
      </section>

      <section aria-labelledby="mainnet-txs" className="mt-14">
        <SectionTitle
          id="mainnet-txs"
          title="Every setup transaction"
          description="All sent from the launch wallet. The status column is the receipt read from the chain just now."
        />
        <Panel>
          <TableBox label="Mainnet setup transactions" minWidth={760}>
            <thead>
              <tr>
                <th className={th}>When</th>
                <th className={th}>What</th>
                <th className={th}>Transaction</th>
                <th className={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {ALL_MAINNET_TXS.map((t) => {
                const r = live?.receipts[t.hash];
                return (
                  <tr key={t.hash}>
                    <td className={`${td} whitespace-nowrap text-muted`}>{t.date}</td>
                    <td className={td}>
                      <div className="text-text">{t.what}</div>
                      <div className="mt-1 max-w-[420px] text-xs leading-relaxed text-faint">{t.detail}</div>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      <Ext href={mainTx(t.hash)}>
                        <span className="num">{`${t.hash.slice(0, 10)}…${t.hash.slice(-6)}`}</span>
                      </Ext>
                      <div className="mt-1 text-xs text-faint">
                        block <span className="num">{formatInt(t.block)}</span>
                      </div>
                    </td>
                    <td className={td}>
                      {r === "success" ? (
                        <StatusTag tone="live">Confirmed</StatusTag>
                      ) : r === "reverted" ? (
                        <StatusTag tone="error">Reverted</StatusTag>
                      ) : (
                        <StatusTag tone="off">Not read</StatusTag>
                      )}
                    </td>
                  </tr>
                );
              })}
              {LAUNCH_TX ? null : (
                <tr>
                  <td className={`${td} text-muted`}>Next</td>
                  <td className={td} colSpan={3}>
                    <div className="text-text">Token launch on Pons</div>
                    <div className="mt-1 max-w-[560px] text-xs leading-relaxed text-faint">
                      Not sent yet. The token stores this site&apos;s address and logo permanently, so it launches once the site is live
                      on its own domain. Its transaction will be added here.
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </TableBox>
        </Panel>
      </section>

      <section aria-labelledby="wallets" className="mt-14">
        <SectionTitle
          id="wallets"
          title="Who holds which key"
          description="Three wallets touch the contract. No wallet can withdraw the pot directly; it leaves only as claims against a posted Merkle root. The scheduler writes that root and the owner picks the scheduler, so both are trusted. Every root and its full payout list are public, so a bad one would be visible."
        />
        <Panel>
          <Facts cols={3}>
            <Fact label="Launch wallet (owner)" note="Deployed the contract and launches the token. Held by the project owner.">
              <span className="inline-flex flex-col gap-1">
                <Hex value={MAINNET.owner} link={false} />
                <Ext href={mainAddr(MAINNET.owner)}>History</Ext>
              </span>
            </Fact>
            <Fact label="Scheduler" note="Server key. Posts each epoch's Merkle root, nothing else.">
              <span className="inline-flex flex-col gap-1">
                <Hex value={MAINNET.scheduler} link={false} />
                <span className="text-sm text-muted">
                  {live ? <span className="num">{eth(live.schedulerBalance)}</span> : null} gas{" · "}
                  <Ext href={mainAddr(MAINNET.scheduler)}>History</Ext>
                </span>
              </span>
            </Fact>
            <Fact label="Sweep bot" note="Server key. Calls the public Pons sweep and the escrow claim; anyone may call them.">
              <span className="inline-flex flex-col gap-1">
                <Hex value={MAINNET.sweepBot} link={false} />
                <span className="text-sm text-muted">
                  {live ? <span className="num">{eth(live.sweepBalance)}</span> : null} gas{" · "}
                  <Ext href={mainAddr(MAINNET.sweepBot)}>History</Ext>
                </span>
              </span>
            </Fact>
          </Facts>
        </Panel>
      </section>

      <HeyBuilderCard />

      <section aria-labelledby="treasury" className="mt-14">
        <SectionTitle
          id="treasury"
          title="Paid jobs and the treasury"
          description={
            config.jobPayments
              ? "Customers' balances sit in the payments contract, which has no owner. Each verified job is charged once per epoch: 95% into the reward pot above, 5% to this Safe."
              : "Paid jobs are not live yet. When they are, 95% of each verified job's payment goes into the reward pot above and 5% to this Safe."
          }
        />
        <Panel>
          <Facts cols={2}>
            <Fact label="Treasury Safe" note={<Ext href={mainAddr(TREASURY.safe)}>Open on Blockscout</Ext>}>
              <Hex value={TREASURY.safe} link={false} head={10} tail={8} />
            </Fact>
            <Fact label="Signatures needed" note={`${TREASURY.version}, created ${TREASURY.createdOn}. Both keys are currently held by the project owner.`}>
              <Check live={!!live?.safe} ok={live?.safe?.threshold === TREASURY.threshold && live.safe.owners.length === TREASURY.owners.length}>
                <span className="num">
                  {live?.safe ? `${live.safe.threshold} of ${live.safe.owners.length}` : `${TREASURY.threshold} of ${TREASURY.owners.length}`}
                </span>
              </Check>
            </Fact>
            <Fact label="Safe owners">
              <span className="inline-flex flex-col gap-1">
                {(live?.safe?.owners ?? TREASURY.owners).map((o) => (
                  <Hex key={o} value={o} link={false} />
                ))}
              </span>
            </Fact>
            <Fact label="Payments contract" note={config.jobPayments ? "No owner, no admin functions. Only the reward contract's scheduler can charge, only for the open epoch." : undefined}>
              {config.jobPayments ? (
                <span className="inline-flex flex-col gap-1">
                  <Hex value={config.jobPayments} link={false} head={10} tail={8} />
                  <span className="text-sm">
                    <Ext href={mainAddr(config.jobPayments)}>Open on Blockscout</Ext>
                    {same(config.jobPayments, PAYMENTS.address) ? (
                      <>
                        {" · "}
                        <Ext href={`${SOURCIFY_REPO}/${MAINNET.chainId}/${PAYMENTS.address}`}>Verified source</Ext>
                      </>
                    ) : null}
                  </span>
                </span>
              ) : (
                <Dash why="Not deployed yet" />
              )}
            </Fact>
          </Facts>
        </Panel>
      </section>

      <section aria-labelledby="tests" className="mt-14">
        <SectionTitle id="tests" title="Tested before launch" description="Run before any real money was involved. Dates are when each run passed." />
        <dl className="grid gap-px overflow-hidden rounded-l border border-line bg-line md:grid-cols-2">
          {TEST_RUNS.map((t) => (
            // An odd card out at the end spans both columns, so no empty cell shows the grid's hairline colour.
            <div key={t.title} className="min-w-0 bg-coal px-5 py-4 md:[&:last-child:nth-child(odd)]:col-span-2">
              <dt className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="font-medium text-text">{t.title}</span>
                <span className="text-xs text-faint">{t.date}</span>
              </dt>
              <dd className="mt-2">
                <StatusTag tone="live" className="h-auto min-h-6 py-1 whitespace-normal">
                  {t.result}
                </StatusTag>
              </dd>
              <dd className="mt-2.5 text-sm leading-relaxed text-muted">{t.detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="testnet" className="mt-14">
        <SectionTitle
          id="testnet"
          title="The whole loop on testnet"
          description={
            <>
              Robinhood Chain testnet, chain id <span className="num">{TESTNET.chainId}</span>. Pons is not deployed there, so a
              stand-in escrow played its part. Fees in, epochs closed, roots posted, two owners paid.
            </>
          }
        />
        <Panel
          footer={
            <>
              Reward contract <Ext href={`${TESTNET_EXPLORER}/address/${TESTNET.rewardContract}`}>{`${TESTNET.rewardContract.slice(0, 10)}…`}</Ext>
              {" · "}owner A <Ext href={`${TESTNET_EXPLORER}/address/${TESTNET.ownerA}`}>{`${TESTNET.ownerA.slice(0, 8)}…`}</Ext>
              {" · "}owner B <Ext href={`${TESTNET_EXPLORER}/address/${TESTNET.ownerB}`}>{`${TESTNET.ownerB.slice(0, 8)}…`}</Ext>
            </>
          }
        >
          <TableBox label="Testnet transactions" minWidth={620}>
            <thead>
              <tr>
                <th className={th}>Step</th>
                <th className={th}>Amount</th>
                <th className={th}>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {TESTNET.events.map((e) => (
                <tr key={e.hash + e.what}>
                  <td className={`${td} text-text`}>{e.what}</td>
                  <td className={`${td} num whitespace-nowrap text-muted`}>{e.amount ?? ""}</td>
                  <td className={`${td} whitespace-nowrap`}>
                    <Ext href={testTx(e.hash)}>
                      <span className="num">{`${e.hash.slice(0, 10)}…${e.hash.slice(-6)}`}</span>
                    </Ext>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableBox>
        </Panel>
      </section>

      <section aria-labelledby="yourself" className="mt-14">
        <SectionTitle id="yourself" title="Check it yourself" description="No wallet needed. Any Robinhood Chain RPC works." />
        <Panel bodyClassName="space-y-4 px-5 py-5 text-sm leading-relaxed text-muted">
          <p>Read the owner, scheduler and fee source straight from the contract with Foundry:</p>
          <pre className="num overflow-x-auto rounded-s border border-line bg-black/30 p-3 text-xs text-text">
            {[
              `cast call ${MAINNET.rewardContract} "owner()(address)" --rpc-url https://rpc.mainnet.chain.robinhood.com`,
              `cast call ${MAINNET.rewardContract} "scheduler()(address)" --rpc-url https://rpc.mainnet.chain.robinhood.com`,
              `cast call ${MAINNET.rewardContract} "feeEscrow()(address)" --rpc-url https://rpc.mainnet.chain.robinhood.com`,
            ].join("\n")}
          </pre>
          <p>
            Every closed epoch&apos;s full payout list is public at <span className="num text-text">/api/v1/epochs/&#123;id&#125;/tree</span>,
            so anyone can rebuild the Merkle root and compare it with the one the contract stores. The sweep bot&apos;s last run is at{" "}
            <a href="/api/health" className="link">
              /api/health
            </a>
            .
          </p>
        </Panel>
      </section>
    </>
  );
}
