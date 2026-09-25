// Server-only settings of the Sparecycle scheduler. Secrets (SCHEDULER_SIGNER_KEY, SCHEDULER_ADMIN_TOKEN) are
// read on demand from process.env and never logged or returned by any API.
import type { Hex } from "viem";

const str = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : null);

function intEnv(name: string, fallback: number, min = 0): number {
  const s = str(process.env[name]);
  if (s === null) return fallback;
  const n = Number(s);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

export const serverEnv = {
  dbPath: () => str(process.env.DB_PATH) ?? "./data/sparecycle.db",
  autoclose: () => process.env.SCHEDULER_AUTOCLOSE === "1",
  allowDevRunner: () => process.env.SCHEDULER_ALLOW_DEV_RUNNER === "1",
  /** Jobs per IP per hour. Unset = 5. 0 = submissions closed. */
  jobRateLimit: () => intEnv("JOB_RATE_LIMIT", 5),
  /** Optional cap, wei of the payout asset per work unit. Unset = no cap. */
  payoutCapPerUnit: (): bigint | null => {
    const s = str(process.env.PAYOUT_CAP_PER_UNIT);
    return s && /^\d{1,78}$/.test(s) ? BigInt(s) : null;
  },
  /** Fallback epoch length of the scheduler-local clock (no reward contract). */
  localEpochLength: () => intEnv("NEXT_PUBLIC_EPOCH_LENGTH", 21_600, 1),
  adminToken: () => str(process.env.SCHEDULER_ADMIN_TOKEN),
  /** Owner wallets of nodes the project runs itself (bootstrap GPU pool): never paid, marked on the status page. */
  projectOwners: (): Set<string> =>
    new Set(
      (str(process.env.PROJECT_NODE_OWNERS) ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
    ),
  /**
   * Project wallets that ARE paid, for an openly labelled team test of the payout path (PAID_TEST_OWNERS). They stay
   * marked as Sparecycle nodes in the UI, with "paid test node", and are taken out of the never-paid exclusion.
   */
  paidTestOwners: (): Set<string> =>
    new Set(
      (process.env.PAID_TEST_OWNERS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^0x[0-9a-f]{40}$/.test(s)),
    ),
  /** The root-posting key. Returns null unless it is a well-formed 32-byte hex key. */
  signerKey: (): Hex | null => {
    const s = str(process.env.SCHEDULER_SIGNER_KEY);
    return s && /^0x[0-9a-fA-F]{64}$/.test(s) ? (s as Hex) : null;
  },
};

/** Scheduler policy constants (documented in src/server/README.md). */
export const POLICY = {
  /** A leased task goes back to the queue when its node doesn't answer within this time. */
  taskLeaseSeconds: 10 * 60,
  /** A job that hasn't reached a verdict after this long is expired (unpaid). */
  jobTtlSeconds: 6 * 60 * 60,
  /** How long a node poll waits for work before answering 204. */
  pollWaitMs: 8_000,
  /** A node counts as online when it polled within this window (or holds a live lease). */
  onlineWindowSeconds: 120,
  /** Upper bound on queued + running jobs, so a flood can't build an endless backlog. */
  maxOpenJobs: 500,
  /** Body size limits. */
  maxJobBodyBytes: 16 * 1024,
  maxNodeBodyBytes: 8 * 1024 * 1024,
  maxTextOutputChars: 16_000,
  /** How often the autoclose timer checks whether the open epoch can close. */
  autocloseCheckMs: 15_000,
  /** Cache of on-chain epoch reads. */
  chainSyncMs: 5_000,
};
