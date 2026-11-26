"use client";

// SparecycleJobPaymentsV2 only (the scheduler runs it with TOKEN_PAYMENTS_V2): the per-job choice "pay with ETH balance /
// SPARE balance" and a plain line on which balance and contract pay. Renders nothing without V2.
import type { PaymentAccountV2 } from "@/lib/dapp/api";
import { spareForWei, type PayAsset } from "@/lib/job-payment";
import type { PayRoute } from "./use-job-submit";

/** "1,234.5 SPARE" from base units (18 decimals), for display. */
export function formatSpare(units: bigint | string): string {
  const v = typeof units === "string" ? BigInt(units) : units;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n) / 10n ** 14n; // 4 decimals
  return `${whole.toLocaleString("en-US")}${frac > 0n ? `.${frac.toString().padStart(4, "0").replace(/0+$/, "")}` : ""}`;
}

export function PayFrom({
  name,
  v2,
  route,
  priceWei,
  asset,
  setAsset,
  spareChoice,
}: {
  /** Radio group name, unique per form. */
  name: string;
  v2: PaymentAccountV2 | null | undefined;
  route: PayRoute | null;
  priceWei: bigint | null;
  asset: PayAsset;
  setAsset: (a: PayAsset) => void;
  spareChoice: boolean;
}) {
  if (!v2 || !route) return null;
  const price = v2.spare.priceWeiPer1e18Spare && /^\d+$/.test(v2.spare.priceWeiPer1e18Spare) ? BigInt(v2.spare.priceWeiPer1e18Spare) : null;
  const spareNow = route.asset === "spare" && price && priceWei !== null ? spareForWei(priceWei, price) : null;
  return (
    <div className="space-y-2 border-t border-line px-5 py-3.5 text-xs leading-relaxed text-muted">
      {spareChoice ? (
        <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <legend className="mb-1 text-sm text-text">Pay with</legend>
          {(["eth", "spare"] as const).map((a) => (
            <label key={a} className="inline-flex cursor-pointer items-center gap-2 text-sm text-text">
              <input type="radio" name={name} value={a} checked={asset === a} onChange={() => setAsset(a)} className="accent-current" />
              {a === "eth" ? "ETH balance" : "SPARE balance"}
            </label>
          ))}
        </fieldset>
      ) : null}
      <p>
        {route.asset === "spare" ? (
          <>
            Paid from your SPARE balance: the job&apos;s ETH price in SPARE at the epoch&apos;s SPARE price, with no discount
            {spareNow !== null ? (
              <>
                {" "}
                (about <span className="num text-text">{formatSpare(spareNow)}</span> SPARE at the current reference price)
              </>
            ) : null}
            . Taken only if two nodes agree. If this epoch&apos;s SPARE price is paused or the SPARE sale cannot run, the job waits for the
            next epoch close and its invoice says why.
          </>
        ) : route.which === "v2" ? (
          <>Paid from your ETH balance in the V2 payments contract: holder credits first, then deposits.</>
        ) : (
          <>Paid from your older balance in the V1 payments contract (still usable): your V2 balance does not cover this job.</>
        )}
      </p>
    </div>
  );
}
