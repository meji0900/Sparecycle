"use client";

import { apiUrl, type EpochsResponse } from "@/lib/dapp/api";
import { formatPayout, payoutUnit } from "@/lib/dapp/payout";
import { useLiveJson, type ChainApi } from "@/lib/use-live";

/**
 * "Last epoch, not a forecast": reserved ÷ agreed jobs of the latest epoch whose root is posted on-chain.
 * Renders nothing unless every input is a real, non-zero read (posted root, reserved > 0, agreed jobs > 0,
 * known payout decimals). Never a projection.
 */
export function LastEpochAverage() {
  const chain = useLiveJson<ChainApi>("/api/chain", 60_000);
  const epochs = useLiveJson<EpochsResponse>(apiUrl("/epochs"), 60_000);
  const unit = payoutUnit(chain.data);
  const rewards = chain.data?.rewards;
  if (!unit || !rewards || !rewards.ok) return null;
  const last = epochs.data?.epochs.find((e) => e.status === "posted" && e.postedTx);
  if (!last || !last.agreedJobs || last.agreedJobs <= 0) return null;
  const reserved = BigInt(last.reserved);
  if (reserved <= 0n) return null;
  const avg = formatPayout(reserved / BigInt(last.agreedJobs), unit);
  return (
    <div className="rounded-l border border-line px-5 py-4">
      <p className="text-sm text-muted">Last epoch, not a forecast</p>
      <p className="mt-1 text-lg text-text">
        <span className="num">{avg.value}</span> <span className="text-sm text-muted">{avg.unit}</span> per agreed job in epoch{" "}
        <span className="num">{last.id}</span>
      </p>
      <p className="mt-1 text-xs leading-relaxed text-faint">
        Reserved in the posted root divided by that epoch&apos;s agreed jobs; each job&apos;s share is split between its two nodes.
        It moves with trading volume and the number of jobs, and can be zero.
      </p>
    </div>
  );
}
