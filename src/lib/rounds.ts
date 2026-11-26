// Re-check rounds (feature brief #9): a paid or team job whose two results do not match, or whose pair never finishes,
// runs again on a different pair of nodes before it is given up uncharged. Browser-safe: the scheduler
// (src/server/rounds.ts) and the UI both read these values.
//
//   round 0        the first pair
//   rounds 1 and 2 re-checks, each on two nodes whose node key, owner wallet and GPU took no part in an earlier round
//
// Every round fits inside the job TTL (POLICY.jobTtlSeconds, 6 h): a new round starts only while at least one full
// round (PICKUP_TIMEOUT_SECONDS + the 10 min task lease = 2400 s) is left of it. Free trial jobs get one round (D17).

/** Rounds a paid or team job can use: the first pair plus up to two re-pairs (D16). */
export const MAX_ROUNDS = 3;

/** A round with a first lease but no verdict this long (plus one task lease) after that lease is abandoned (D16). */
export const PICKUP_TIMEOUT_SECONDS = 30 * 60;

/** Rounds a job can use: MAX_ROUNDS when someone pays for it (paid or team), 1 for a free trial job (D17). */
export const maxRoundsFor = (payer: string | null | undefined): number => (payer ? MAX_ROUNDS : 1);

/**
 * The payer-facing line for a job that is being checked again, e.g. "Re-checking on another pair (round 2 of 3)".
 * `round` is 0-based as in the API (0 = the first pair); null for the first pair or a missing field (older scheduler).
 */
export function recheckLabel(round: number | null | undefined, maxRounds: number | null | undefined): string | null {
  if (typeof round !== "number" || round < 1) return null;
  return `Re-checking on another pair (round ${round + 1} of ${maxRounds ?? MAX_ROUNDS})`;
}
