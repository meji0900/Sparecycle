// API keys (src/server/apikeys.ts): the parts the browser and the docs share with the scheduler. Pure, browser-safe.

/** D13 (Default, not yet confirmed by Fabio): keys per wallet that are active or waiting for their link signature. */
export const MAX_KEYS = 10;

/** D12 (Default, not yet confirmed by Fabio): a key's daily cap runs per UTC day and resets at 00:00 UTC (08:00 WITA). */
export const KEY_CAP_PERIOD = "utc-day" as const;

const DAY_SECONDS = 86_400;

/** The UTC day (YYYY-MM-DD) a unix time falls in. */
export const utcDay = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

/** Unix time of the next 00:00 UTC after `unixSeconds` (when the daily caps reset). */
export const nextUtcReset = (unixSeconds: number): number => (Math.floor(unixSeconds / DAY_SECONDS) + 1) * DAY_SECONDS;

/** Visible, non-secret handle of a key: `sck_<keyId>`. The full key is `sck_<keyId>_<secret>`. */
export const keyPrefix = (keyId: string) => `sck_${keyId}`;

/**
 * The EIP-191 message (personal_sign, no gas) a wallet signs once to let one API key pay for jobs from its balance in
 * the payments contract. Human-readable on purpose: the wallet shows it before signing. The fingerprint is the first
 * 16 hex characters of sha256(full key), so the signature is bound to that exact key.
 */
export const keyLinkMessage = (p: { chainId: number; contract: string; keyId: string; fingerprint: string; dailyCapWei: bigint; issued: number }) =>
  [
    "Sparecycle: allow one API key to pay for jobs from my balance",
    `Chain: ${p.chainId}`,
    `Payments contract: ${p.contract.toLowerCase()}`,
    `Key: ${keyPrefix(p.keyId)}`,
    `Key fingerprint: ${p.fingerprint}`,
    `Daily cap: ${p.dailyCapWei.toString()} wei per UTC day`,
    `Issued: ${p.issued}`,
    "This key cannot withdraw. Revoke it at any time.",
  ].join("\n");

/**
 * A2 (Default, not yet confirmed by Fabio): the keys panel warns while the wallet's on-chain spend limit per epoch is 0,
 * which means "no limit": that limit is the only ceiling that does not depend on the scheduler. Null = not read yet.
 */
export const spendLimitWarning = (spendLimitPerEpoch: string | bigint | null | undefined): boolean =>
  spendLimitPerEpoch !== null && spendLimitPerEpoch !== undefined && BigInt(spendLimitPerEpoch) === 0n;

/** A key as GET /api/v1/keys lists it (wei amounts as decimal strings, times in unix seconds). */
export type ApiKeyInfo = {
  keyId: string;
  prefix: string;
  fingerprint: string;
  label: string;
  status: "pending" | "active" | "disabled";
  dailyCapWei: string;
  spentTodayWei: string;
  remainingTodayWei: string;
  day: string;
  nextResetAt: number;
  createdAt: number;
  activatedAt: number | null;
  lastUsedAt: number | null;
  disabledAt: number | null;
};

export type ApiKeyList = { owner: string; keys: ApiKeyInfo[]; maxKeys: number; day: string; nextResetAt: number };
