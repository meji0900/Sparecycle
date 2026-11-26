// Server-only settings of the Sparecycle scheduler. Secrets (SCHEDULER_SIGNER_KEY, SCHEDULER_ADMIN_TOKEN) are
// read on demand from process.env and never logged or returned by any API.
import type { Hex } from "viem";

const str = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : null);

/** A token-feature flag (docs/token-features.md): on only when set to exactly "on" (any case). Unset = off. */
const onFlag = (name: string) => str(process.env[name])?.toLowerCase() === "on";

function intEnv(name: string, fallback: number, min = 0): number {
  const s = str(process.env[name]);
  if (s === null) return fallback;
  const n = Number(s);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

/** A duration given in hours (fractions allowed, e.g. 0.5), returned in whole seconds (at least 1). */
function hoursEnv(name: string, fallbackHours: number): number {
  const s = str(process.env[name]);
  const h = s === null ? fallbackHours : Number(s);
  return Number.isFinite(h) && h > 0 ? Math.max(1, Math.round(h * 3600)) : Math.round(fallbackHours * 3600);
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
  /**
   * Private job outputs (docs/private-outputs.md). "off" (default): outputs are served to anyone, with private,
   * no-store headers. "enforce": only the job's read secret or a session of the paying wallet can read an output.
   */
  outputAuth: (): "off" | "enforce" => (str(process.env.OUTPUT_AUTH)?.toLowerCase() === "enforce" ? "enforce" : "off"),
  /** Output reads per viewer per hour (per job for a read secret, per wallet for a session, else per IP). */
  outputRateLimit: () => intEnv("OUTPUT_RATE_LIMIT", 600, 1),
  /**
   * Hosts a sign-in message may name as its EIP-4361 domain, comma-separated (e.g. sparecycle.tech). Unset = the
   * host the request was sent to.
   */
  authDomains: (): string[] =>
    (str(process.env.AUTH_DOMAIN) ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
      .filter(Boolean),
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
  /**
   * GPU allowlist (src/server/gpu-allowlist.json). observe (default) = classify, log and store, block nothing.
   * enforce = blocked families get 403 gpu-not-supported at registration; untested families register but get no jobs.
   */
  gpuAllowlistMode: (): "observe" | "enforce" => (str(process.env.GPU_ALLOWLIST_MODE) === "enforce" ? "enforce" : "observe"),
  /**
   * Periodic GPU challenge (src/server/challenge.ts). off (default) = none. observe = issue challenges to nodes that
   * support them and record pass / fail, never change eligibility. enforce = pending-challenge -> eligible on a pass;
   * a fail -> cooldown; a second consecutive fail -> suspended (admin re-qualify only).
   */
  challengeMode: (): "off" | "observe" | "enforce" => {
    const v = str(process.env.CHALLENGE_MODE);
    return v === "observe" || v === "enforce" ? v : "off";
  },
  /** Seconds between two challenges of a node that passed (CHALLENGE_INTERVAL_HOURS, default 24). */
  challengeIntervalSeconds: () => hoursEnv("CHALLENGE_INTERVAL_HOURS", 24),
  /** Seconds a node waits after a failed challenge before the next one (CHALLENGE_COOLDOWN_HOURS, default 6). */
  challengeCooldownSeconds: () => hoursEnv("CHALLENGE_COOLDOWN_HOURS", 6),
  /**
   * API keys (src/server/apikeys.ts; decision D11, Default, not yet confirmed by Fabio): "on" (default) = a wallet may
   * create keys that pay for jobs without a per-job signature after one link signature; "off" = no key can be created
   * or activated and every key-paid submission is refused (503 api-keys-off). Reading results with a key still works.
   */
  apiKeys: (): "on" | "off" => (str(process.env.API_KEYS)?.toLowerCase() === "off" ? "off" : "on"),
  /**
   * Longest `Prefer: wait=<seconds>` the OpenAI-compatible routes honour (decision A9, open). Must stay below the
   * hosting platform's request timeout, which is not known for Railway yet: 25 s until it is checked. 0 = never wait.
   */
  apiMaxWaitSeconds: () => Math.min(intEnv("API_MAX_WAIT_SECONDS", 25, 0), 300),
  // ---- Token features (docs/token-features.md). Every flag defaults to OFF and stays off in production until the legal
  // review (brief §9.1), the external audits of the new contracts and the Safe key split (F2) are done. Nothing behind
  // them signs or sends a transaction: payloads are prepared, unsigned, for the Safe signers or the scheduler key.
  /** TOKEN_BURNS=on: at each epoch close, plan the burn share (N1) and prepare an unsigned Safe transaction (phase 2a). */
  tokenBurns: () => onFlag("TOKEN_BURNS"),
  /** TOKEN_HOLDERS=on: at each epoch close, compute time-weighted SPARE holder weights and prepare the HolderPool root. */
  tokenHolders: () => onFlag("TOKEN_HOLDERS"),
  /** TOKEN_SLASHING=on: attribute faults from re-check rounds, prepare slash proposals, serve GET /api/v1/slashing. */
  tokenSlashing: () => onFlag("TOKEN_SLASHING"),
  /** TOKEN_STAKE_GATE=on: lease jobs only to owners with stakedOf(owner) >= minStakePerNode x active nodes. */
  tokenStakeGate: () => onFlag("TOKEN_STAKE_GATE"),
  /** TOKEN_HOLDER_PAGE=on: serve /token/holders (off = 404, and nothing links to it). */
  tokenHolderPage: () => onFlag("TOKEN_HOLDER_PAGE"),
  /**
   * TOKEN_PAYMENTS_V2=on (together with TOKEN_JOB_PAYMENTS_V2_ADDRESS): paid jobs can also be paid and charged on
   * SparecycleJobPaymentsV2 (src/server/payments-v2.ts): new deposits go there, V1 balances stay usable. Unlike the
   * other token flags this one sends transactions from the scheduler key (V2 charges and the per-epoch SPARE price),
   * exactly as the V1 charge does. Off (the default): everything behaves as before V2 existed.
   */
  tokenPaymentsV2: () => onFlag("TOKEN_PAYMENTS_V2"),
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
  /** Wallet sign-in (src/server/auth.ts): nonce lifetime, session lifetime, nonces per IP per hour. */
  authNonceSeconds: 10 * 60,
  sessionSeconds: 12 * 60 * 60,
  authNoncesPerHour: 60,
  /** Cache of on-chain epoch reads. */
  chainSyncMs: 5_000,
};
