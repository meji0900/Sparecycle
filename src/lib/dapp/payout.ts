import { config, payoutAssetLabel } from "@/lib/config";
import { formatAmount, formatInt } from "@/lib/format";
import type { ChainApi } from "@/lib/use-live";

export type PayoutUnit = { symbol: string; decimals: number };

/**
 * Unit of the payout asset: read from the reward contract (`payoutToken`, ERC-20 decimals/symbol) when it is
 * configured. Without a contract, ETH is the only asset whose decimals are a fact; anything else stays unknown.
 */
export function payoutUnit(chain: ChainApi | null | undefined): PayoutUnit | null {
  const r = chain?.rewards;
  if (r && r.ok) return r.data.payout;
  if (!config.rewardContract && config.nodePayoutAsset === "ETH") return { symbol: "ETH", decimals: 18 };
  return null;
}

/** An amount of the payout asset for display. Unknown decimals → raw base units, labelled as such. */
export function formatPayout(amount: string | bigint | null | undefined, unit: PayoutUnit | null, digits = 6) {
  if (amount === null || amount === undefined) return { value: "—", unit: unit?.symbol ?? payoutAssetLabel() };
  const v = typeof amount === "bigint" ? amount : BigInt(amount);
  if (!unit) return { value: formatInt(v), unit: `base units (${payoutAssetLabel()})` };
  const value = formatAmount(v, unit.decimals, digits);
  // Never show a real, non-zero amount as 0.
  if (v > 0n && value === "0") return { value: `< 0.${"0".repeat(Math.max(0, digits - 1))}1`, unit: unit.symbol };
  return { value, unit: unit.symbol };
}
