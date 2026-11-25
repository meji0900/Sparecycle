"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import SplitFlapText from "@/components/reactbits/SplitFlapText";
import { Hex } from "@/components/ui/address";
import { StatusTag } from "@/components/ui/status";
import { config } from "@/lib/config";
import { EM_DASH, formatAmount, formatInt } from "@/lib/format";
import { useLiveJson, type ChainApi, type SchedulerStatus } from "@/lib/use-live";

function Row({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 bg-coal px-5 py-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-h-6 text-[15px] text-text">{children}</dd>
      {note ? <dd className="text-xs text-faint">{note}</dd> : null}
    </div>
  );
}

const Dash = ({ why }: { why: string }) => (
  <span className="text-faint">
    <span aria-hidden>{EM_DASH}</span> <span className="text-sm">{why}</span>
  </span>
);

export function OnchainStatus() {
  const chain = useLiveJson<ChainApi>("/api/chain", 20_000);
  const sched = useLiveJson<SchedulerStatus>(`${config.schedulerApiUrl}/status`, 20_000);

  const net = chain.data?.network;
  const rewards = chain.data?.rewards;
  const r = rewards && rewards.ok ? rewards.data : null;
  const payout = r ? r.payout.symbol : config.nodePayoutAsset ?? "[NODE_PAYOUT_ASSET]";
  const dec = r?.payout.decimals ?? 18;
  const posted = sched.data?.lastSettled?.postedTx ? sched.data.lastSettled : null;

  const rewardNote = !config.rewardContract
    ? "Not deployed yet"
    : rewards && !rewards.ok
      ? "Contract set, read failed"
      : null;

  return (
    <section id="status" aria-labelledby="status-title" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div className="max-w-[640px]">
            <h2 id="status-title" className="text-title font-semibold text-text">
              On-chain status
            </h2>
            <p className="mt-4 text-muted">
              Live reads only. Anything that can&apos;t be read right now shows a dash, not a zero.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2.5 sm:items-end">
            <div className="flex items-center gap-2 text-xs text-muted">
              {net?.ok ? (
                <StatusTag tone="live">Latest block, Robinhood Chain</StatusTag>
              ) : chain.loading ? (
                <StatusTag tone="neutral">Reading chain</StatusTag>
              ) : (
                <StatusTag tone="error">RPC unreachable</StatusTag>
              )}
            </div>
            {net?.ok ? (
              <div aria-label={`Block ${formatInt(BigInt(net.data.blockNumber))}`} role="img">
                <SplitFlapText
                  text={net.data.blockNumber}
                  charset="numeric"
                  tileStyle="board"
                  fontSize={26}
                  padTo={0}
                  intro={false}
                  gap={3}
                  tileRadius={4}
                  tileColor="#151515"
                  textColor="#ededed"
                  glare={0.04}
                  flipsPerChar={4}
                  stagger={30}
                  align="right"
                  aria-hidden
                />
              </div>
            ) : null}
            <Link href="/app" className="link text-sm">
              Open status page
            </Link>
          </div>
        </div>

        <dl className="mt-10 grid gap-px overflow-hidden rounded-l border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          <Row label="Network">
            Robinhood Chain, chain id{" "}
            <span className="num">{net?.ok ? net.data.chainId : 4663}</span>
          </Row>
          <Row label="Token">
            {config.tokenAddress ? <Hex value={config.tokenAddress} /> : <Dash why="Not launched yet" />}
          </Row>
          <Row label="Reward contract">
            {config.rewardContract ? <Hex value={config.rewardContract} /> : <Dash why="Not deployed yet" />}
          </Row>
          <Row label="Current epoch">{r ? <span className="num">{r.currentEpoch}</span> : <Dash why={rewardNote ?? "Reading"} />}</Row>
          <Row label={`Epoch pot (${payout})`}>
            {r ? <span className="num">{formatAmount(BigInt(r.epoch.pot), dec)}</span> : <Dash why={rewardNote ?? "Reading"} />}
          </Row>
          <Row label="Reserved for claims" note={r && !r.previous ? "No settled epoch yet" : r ? `Epoch ${r.previous?.index}, latest settled` : undefined}>
            {r?.previous ? (
              <span className="num">{formatAmount(BigInt(r.previous.reserved), dec)}</span>
            ) : (
              <Dash why={rewardNote ?? "No settled epoch yet"} />
            )}
          </Row>
          <Row label="Claimed" note={r?.previous ? `Epoch ${r.previous.index}` : undefined}>
            {r?.previous ? (
              <span className="num">{formatAmount(BigInt(r.previous.claimed), dec)}</span>
            ) : (
              <Dash why={rewardNote ?? "No settled epoch yet"} />
            )}
          </Row>
          <Row label="Jobs eligible this epoch" note="Passed the two-node check. Read from the scheduler.">
            {sched.data ? (
              <span className="num">{formatInt(sched.data.jobs.agreedThisEpoch)}</span>
            ) : (
              <Dash why={sched.loading ? "Reading" : "Scheduler API not reachable"} />
            )}
          </Row>
          <Row label="Nodes with a claim in the current root" note="Counted from the posted root only.">
            {posted ? <span className="num">{formatInt(posted.leaves)}</span> : <Dash why="No root posted yet" />}
          </Row>
        </dl>
      </div>
    </section>
  );
}
