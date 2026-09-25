// Epoch payout rule (stated in the UI and in src/server/README.md):
//   - an epoch's agreed jobs share the on-chain pot pro rata by work units (scheduler-computed from the spec);
//   - the two agreeing nodes split each job's units equally; shares are summed per owner wallet;
//   - amounts are floored, so the sum is <= pot; optional cap PAYOUT_CAP_PER_UNIT (wei per unit);
//   - owners in `exclude` (project-run nodes) get nothing; their share is not reserved and rolls over;
//   - whatever is not reserved rolls over to the next epoch on-chain.
// Pure function: no DB, no chain.
import { getAddress, type Address } from "viem";

export type AgreedJob = { units: number; owners: readonly [Address, Address] };
export type Allocation = {
  entries: { account: Address; amount: bigint; weight: number }[];
  reserved: bigint;
  totalUnits: number;
};

export function allocate(input: {
  pot: bigint;
  capPerUnit: bigint | null;
  jobs: readonly AgreedJob[];
  /** Lower-case owner addresses that are never paid. */
  exclude?: ReadonlySet<string>;
}): Allocation {
  // weight = 2 x units credited to an owner (each of a job's two nodes gets half of its units).
  const weights = new Map<Address, number>();
  let totalUnits = 0;
  for (const job of input.jobs) {
    if (!Number.isSafeInteger(job.units) || job.units <= 0) continue;
    const [a, b] = job.owners.map((o) => getAddress(o)) as [Address, Address];
    if (a === b) continue; // never happens: assignment requires distinct owners
    totalUnits += job.units;
    weights.set(a, (weights.get(a) ?? 0) + job.units);
    weights.set(b, (weights.get(b) ?? 0) + job.units);
  }
  const totalWeight = BigInt(totalUnits) * 2n;
  const entries: Allocation["entries"] = [];
  let reserved = 0n;
  if (totalWeight > 0n && input.pot > 0n) {
    for (const [account, weight] of [...weights.entries()].sort(([x], [y]) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1))) {
      if (input.exclude?.has(account.toLowerCase())) continue;
      let amount = (input.pot * BigInt(weight)) / totalWeight;
      if (input.capPerUnit !== null) {
        const cap = (input.capPerUnit * BigInt(weight)) / 2n;
        if (amount > cap) amount = cap;
      }
      if (amount <= 0n) continue;
      entries.push({ account, amount, weight });
      reserved += amount;
    }
  }
  if (reserved > input.pot) throw new Error("allocation exceeds pot"); // unreachable with floored shares
  return { entries, reserved, totalUnits };
}
