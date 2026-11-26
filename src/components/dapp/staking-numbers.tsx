"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Hex } from "@/components/ui/address";
import { Button, ButtonLink } from "@/components/ui/button";
import { Notice, StatusTag } from "@/components/ui/status";
import { apiDown, type ApiFailure } from "@/lib/dapp/api";
import { useApiGet } from "@/lib/dapp/use-api";
import { formatBps, formatInt, formatTime } from "@/lib/format";
import { formatSpare } from "@/lib/staking";
import { cn } from "@/lib/utils";
import { Dash, Fact, Skeleton } from "./ui";

/** GET /api/v1/staking (src/server/staking.ts). */
export type StakingStats = {
  contract: string;
  chainId: number;
  explorerUrl: string | null;
  token: string;
  decimals: number;
  block: string;
  readAt: number;
  totalStakedWei: string;
  totalSlashedWei: string;
  minStakePerNodeWei: string;
  proposals: number;
  owners: { staking: number; active: number; cooling: number; fromBlock: string } | null;
  ownersError: string | null;
  rules: {
    epochLengthSeconds: number;
    cooldownEpochs: number;
    appealWindowEpochs: number;
    decisionWindowEpochs: number;
    slashBps: number;
    proposalGraceEpochs: number;
    stallFactor: number;
  };
};

const isWei = (s: unknown): s is string => typeof s === "string" && /^\d{1,78}$/.test(s);

function failureText(f: ApiFailure): string {
  if (f.kind === "http" && f.code === "staking-not-deployed") return "The stake contract is not deployed on this network.";
  if (f.kind === "http" && f.code === "chain-read-failed") return "The chain did not answer when the stake contract was read. It is tried again every minute.";
  if (apiDown(f)) return "The site's API did not answer.";
  return "The stake contract could not be read right now.";
}

/** One figure: a big tabular number and a line of what it means. */
function Figure({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <Fact label={label} note={note}>
      <span className="text-xl font-semibold tracking-[-0.02em]">{children}</span>
    </Fact>
  );
}

const Spare = ({ wei }: { wei: string }) => (
  <>
    <span className="num">{formatSpare(BigInt(wei), 2)}</span> <span className="text-sm font-normal text-muted">SPARE</span>
  </>
);

/**
 * The public staking figures, read from SparecycleNodeStake through GET /api/v1/staking: no wallet needed. A failed
 * read shows "could not read", never a zero. `cta` adds a link to the staking page (on /nodes and /token).
 */
export function StakingNumbers({ cta = false, className }: { cta?: boolean; className?: string }) {
  const q = useApiGet<StakingStats>("/staking", 60_000);
  const s = q.result?.ok ? q.result.data : null;
  const failure = q.result && !q.result.ok ? q.result.failure : null;
  const valid = s && isWei(s.totalStakedWei) && isWei(s.totalSlashedWei) && isWei(s.minStakePerNodeWei) ? s : null;
  /** The figure, a loading bar, or "could not read": never a zero in place of a read that failed. */
  const value = (render: (v: StakingStats) => ReactNode) =>
    valid ? render(valid) : !failure && q.loading ? <Skeleton className="h-6 w-28" /> : <Dash why="Could not read" />;

  return (
    <section aria-label="Node staking, read from the chain" className={cn("min-w-0 rounded-l border border-line bg-coal", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
        <p className="font-medium text-text">Node staking, read from the chain</p>
        <div className="flex flex-wrap items-center gap-2">
          {valid ? (
            <StatusTag tone="live">
              Block <span className="num">{formatInt(BigInt(valid.block))}</span>
            </StatusTag>
          ) : failure ? (
            <StatusTag tone="error">Not read</StatusTag>
          ) : (
            <StatusTag tone="neutral">Reading</StatusTag>
          )}
          <StatusTag tone="neutral">Optional</StatusTag>
        </div>
      </div>

      {failure ? (
        <div className="border-b border-line px-5 py-4">
          <Notice
            tone="error"
            title="Could not read the staking figures"
            action={
              <Button size="sm" variant="secondary" onClick={q.reload}>
                Retry
              </Button>
            }
          >
            {failureText(failure)} Nothing is shown rather than a zero.
          </Notice>
        </div>
      ) : null}

      <dl className="grid gap-px overflow-hidden sm:grid-cols-2 xl:grid-cols-4 [&>*]:shadow-[0_0_0_1px_#1f1f1f]">
        <Figure label="Total staked" note="Active stake plus SPARE waiting out the unstake cooldown, all owners.">
          {value((v) => <Spare wei={v.totalStakedWei} />)}
        </Figure>
        <Figure
          label="Owners staking"
          note={
            valid && valid.owners
              ? `${valid.owners.active} with active stake, ${valid.owners.cooling} in the cooldown.`
              : valid && valid.ownersError
                ? "The contract's Staked events could not be read right now."
                : "Owner wallets with SPARE in the contract."
          }
        >
          {valid && valid.owners ? <span className="num">{formatInt(valid.owners.staking)}</span> : value(() => <Dash why="Could not read" />)}
        </Figure>
        <Figure label="Total slashed" note="Executed slashes. Slashed SPARE is burned; nobody receives it.">
          {value((v) => <Spare wei={v.totalSlashedWei} />)}
        </Figure>
        <Figure
          label="Minimum per node"
          note={
            valid
              ? BigInt(valid.minStakePerNodeWei) === 0n
                ? "Zero: running a node needs no token and no stake."
                : "Per active node, set by the treasury Safe with at least one epoch's notice."
              : "Set by the treasury Safe; zero at launch."
          }
        >
          {value((v) => <Spare wei={v.minStakePerNodeWei} />)}
        </Figure>
      </dl>

      <div className="flex flex-col gap-3 border-t border-line px-5 py-3.5 text-xs leading-relaxed text-faint sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0">
          {valid ? (
            <>
              <span className="inline-flex flex-wrap items-center gap-x-1.5">
                SparecycleNodeStake <Hex value={valid.contract} href={valid.explorerUrl ?? undefined} link={!!valid.explorerUrl} />
              </span>{" "}
              Read {formatTime(valid.readAt)}. At most {formatBps(valid.rules.slashBps)} of a stake per slash proposal. Internal review only, not externally
              audited.
            </>
          ) : (
            <>Staking is voluntary and pays nothing. Internal review only, not externally audited.</>
          )}
        </p>
        {cta ? (
          <ButtonLink href="/nodes/stake" variant="secondary" size="sm" className="shrink-0 self-start sm:self-auto">
            Stake or unstake
          </ButtonLink>
        ) : (
          <Link href="/docs/run-a-node#staking" className="link shrink-0">
            How staking works
          </Link>
        )}
      </div>
    </section>
  );
}
