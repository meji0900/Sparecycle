// API keys per wallet (docs: /docs/api/keys). A payer creates keys from a signed-in wallet session; a key spends from
// that wallet's prepaid balance in the payments contract, within its own daily cap, and can be switched off at once.
// A key can never withdraw: withdrawals are msg.sender-only in the contract and no route calls them for a payer.
//
//   create:   POST /api/v1/keys makes a `pending` key `sck_<keyId>_<secret>` and returns its link message. Only
//             sha256(full key) goes to the DB; the full key waits in this process's memory for PENDING_KEY_SECONDS.
//   activate: the wallet signs the link message once (EIP-191; EOA, ERC-1271 or ERC-6492, like the sign-in). Only then
//             is the key active and its full value returned, exactly once.
//   spend:    a job submitted with `Authorization: Bearer sck_…` is paid without a per-job signature: same available-
//             balance check, its price counts against the key's UTC-day cap (api_key_spend), and comes back off the
//             counter when the job ends disagreed / expired / rejected (never charged).
//   kill:     disabling or deleting a key takes effect on the next request; its queued jobs end `expired` with the note
//             "cancelled: API key disabled" and are never charged. Running jobs settle normally.
//
// Trust: the scheduler key could always charge a customer up to their balance and on-chain spend limit; a key moves the
// per-job evidence to the one link signature plus the scheduler's records. The on-chain `spendLimitPerEpoch` is the only
// ceiling that does not depend on the scheduler. Never logs a key, a secret or a signature.
import { randomBytes } from "node:crypto";
import { type Address, type Hex } from "viem";
import { targetChain } from "@/lib/chain";
import { keyLinkMessage, keyPrefix, MAX_KEYS, nextUtcReset, utcDay, type ApiKeyInfo, type ApiKeyList } from "@/lib/api-keys";
import { apiKeyFromToken, apiKeyHash, bearerToken, sessionFromRequest, signatureValid, type KeyViewer } from "./auth";
import { getDb, nowSec, tx } from "./db";
import { serverEnv } from "./env";
import { ApiError, AUTH_REQUIRED } from "./http";
import { limitBucket, takeHourly } from "./limits";
import { paymentsAddress, readAccount } from "./payments";

export { MAX_KEYS };

/** A2 (Default, not yet confirmed by Fabio): a zero on-chain spend limit (= no limit) only warns; true = activation refused until one is set. */
export const REQUIRE_SPEND_LIMIT_FOR_KEYS = false;
/** A3 (Default, not yet confirmed by Fabio): raising a key's daily cap needs a new link signature; lowering, disabling and deleting need only the session. */
export const RAISE_CAP_NEEDS_SIGNATURE = true;
/** A4 (Default, not yet confirmed by Fabio): jobs paid with a key get no per-job read secret; the key itself reads them. */
export const KEY_JOBS_GET_READ_SECRET = false;
/** A5 (Default, not yet confirmed by Fabio): a key reads only the jobs submitted with that key, never other jobs of its wallet. */
export const KEY_READS_WALLET_JOBS = false;
/** A pending key (its full value lives only in memory) and a link signature are valid this long. */
export const PENDING_KEY_SECONDS = 10 * 60;
/** Key creations per wallet per hour. */
export const KEY_CREATES_PER_HOUR = 30;
/** Note of a queued job cancelled by the kill switch (it then follows the never-charged path of an expired job). */
export const KEY_DISABLED_NOTE = "cancelled: API key disabled";

const MAX_LABEL_CHARS = 64;
const MAX_WEI_DIGITS = 30;
/** Allowed clock difference for the issued time of a cap-raise signature. */
const CLOCK_SKEW_SECONDS = 60;

type KeyRow = {
  key_id: string;
  owner: Address;
  label: string;
  key_hash: string;
  daily_cap_wei: string;
  status: "pending" | "active" | "disabled" | "deleted";
  link_message: string | null;
  link_signature: string | null;
  link_issued: number | null;
  created_at: number;
  activated_at: number | null;
  last_used_at: number | null;
  disabled_at: number | null;
};

// Full keys of pending keys, by key id, until activation or PENDING_KEY_SECONDS. In globalThis so every route bundle of
// this process shares one map (like the DB handle in ./db). A restart forgets them: the pending key must be created again.
type Pending = { fullKey: string; expiresAt: number };
const g = globalThis as typeof globalThis & { __sparecyclePendingKeys?: Map<string, Pending> };
const pendingKeys = (): Map<string, Pending> => (g.__sparecyclePendingKeys ??= new Map());

function prunePending(now: number) {
  for (const [id, p] of pendingKeys()) if (p.expiresAt <= now) pendingKeys().delete(id);
}

const fingerprintOf = (keyHash: string) => keyHash.slice(0, 16);

function requireKeysOn() {
  if (serverEnv.apiKeys() !== "on") throw new ApiError(503, "api-keys-off", "API keys are switched off on this scheduler");
}

function requirePayments(): Address {
  const c = paymentsAddress();
  if (!c) throw new ApiError(503, "payments-off", "paid jobs are not enabled on this scheduler");
  return c;
}

/** The signed-in wallet of a key-management request; 401 (empty body via handlePrivate) without a live session. */
export function sessionOwner(req: Request): Address {
  const s = sessionFromRequest(req);
  if (!s) throw new ApiError(401, AUTH_REQUIRED, "sign in with the wallet first");
  return s.address;
}

function parseCap(v: unknown, field = "dailyCapWei"): bigint {
  if (typeof v !== "string" || !new RegExp(`^\\d{1,${MAX_WEI_DIGITS}}$`).test(v)) {
    throw new ApiError(400, "invalid-key", `${field} must be a whole number of wei as a decimal string`, { field });
  }
  const cap = BigInt(v);
  if (cap <= 0n) throw new ApiError(400, "invalid-key", `${field} must be above zero`, { field });
  return cap;
}

function parseLabel(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string" || v.length > MAX_LABEL_CHARS || /[\u0000-\u001f\u007f]/.test(v)) {
    throw new ApiError(400, "invalid-key", `label must be text of at most ${MAX_LABEL_CHARS} characters`, { field: "label" });
  }
  return v.trim();
}

function parseSignature(v: unknown): Hex {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{2,20000}$/.test(v)) {
    throw new ApiError(400, "invalid-key", "signature must be a hex signature", { field: "signature" });
  }
  return v as Hex;
}

const parseKeyId = (raw: string) => {
  if (!/^[0-9a-f]{16}$/.test(raw)) throw new ApiError(400, "invalid-key-id", "key id must be 16 lowercase hex characters");
  return raw;
};

/** A key of `owner` (never another wallet's: those answer 404 like unknown keys). Deleted keys are gone. */
function ownKey(owner: Address, keyIdRaw: string): KeyRow {
  const keyId = parseKeyId(keyIdRaw);
  const row = getDb().prepare("SELECT * FROM api_keys WHERE key_id = ?").get(keyId) as KeyRow | undefined;
  if (!row || row.owner.toLowerCase() !== owner.toLowerCase() || row.status === "deleted") {
    throw new ApiError(404, "unknown-key", "no key with this id for the signed-in wallet");
  }
  return row;
}

// ---- Daily counter (UTC day) ---------------------------------------------------------------------------

/**
 * Takes the price of every key-paid job that ended disagreed / expired / rejected off its key's counter for the day it
 * was submitted (once per job: api_key_held goes back to 0). Called before every read or check of a counter.
 */
export function releaseKeyHolds() {
  tx((db) => {
    const done = db
      .prepare("SELECT id, api_key_id, price_wei, created_at FROM jobs WHERE api_key_held = 1 AND status IN ('disagreed','expired','rejected')")
      .all() as { id: string; api_key_id: string; price_wei: string; created_at: number }[];
    const get = db.prepare("SELECT held_wei FROM api_key_spend WHERE key_id = ? AND day = ?");
    const set = db.prepare("UPDATE api_key_spend SET held_wei = ? WHERE key_id = ? AND day = ?");
    const clear = db.prepare("UPDATE jobs SET api_key_held = 0 WHERE id = ?");
    for (const j of done) {
      const day = utcDay(j.created_at);
      const row = get.get(j.api_key_id, day) as { held_wei: string } | undefined;
      if (row) {
        const left = BigInt(row.held_wei) - BigInt(j.price_wei);
        set.run((left > 0n ? left : 0n).toString(), j.api_key_id, day);
      }
      clear.run(j.id);
    }
  });
}

function spentOn(keyId: string, day: string): bigint {
  const row = getDb().prepare("SELECT held_wei FROM api_key_spend WHERE key_id = ? AND day = ?").get(keyId, day) as { held_wei: string } | undefined;
  return row ? BigInt(row.held_wei) : 0n;
}

/** The key's cap, what it spent today (UTC) and when the counter resets. */
export function keySpend(keyId: string, now = nowSec()) {
  releaseKeyHolds();
  const row = getDb().prepare("SELECT daily_cap_wei FROM api_keys WHERE key_id = ?").get(keyId) as { daily_cap_wei: string } | undefined;
  const cap = BigInt(row?.daily_cap_wei ?? "0");
  const day = utcDay(now);
  const spent = spentOn(keyId, day);
  return { cap, spent, remaining: cap > spent ? cap - spent : 0n, day, nextResetAt: nextUtcReset(now) };
}

function capError(cap: bigint, spent: bigint, price: bigint, now: number): ApiError {
  return new ApiError(429, "key-daily-cap", "this job would take the API key over its daily cap (UTC day)", {
    dailyCapWei: cap.toString(),
    spentTodayWei: spent.toString(),
    priceWei: price.toString(),
    resetsAt: nextUtcReset(now),
    retryAfter: nextUtcReset(now) - now,
  });
}

/** Cheap check before the chain read of a key-paid submission: the key is still active and the price fits today's cap. */
export function assertKeyCanSpend(key: KeyViewer, priceWei: bigint, now = nowSec()) {
  requireKeysOn();
  const s = keySpend(key.keyId, now);
  const row = getDb().prepare("SELECT status FROM api_keys WHERE key_id = ?").get(key.keyId) as { status: string } | undefined;
  if (row?.status !== "active") throw new ApiError(401, "invalid-api-key", "unknown, disabled or deleted API key");
  if (s.spent + priceWei > s.cap) throw capError(s.cap, s.spent, priceWei, now);
}

/**
 * Inside the submit transaction: re-checks status and cap (a concurrent request may have used the room or disabled
 * the key) and adds the price to today's counter. The caller inserts the job with api_key_held = 1.
 */
export function holdKeySpend(keyId: string, priceWei: bigint, now: number) {
  tx((db) => {
    releaseKeyHolds();
    const row = db.prepare("SELECT status, daily_cap_wei FROM api_keys WHERE key_id = ?").get(keyId) as
      | { status: string; daily_cap_wei: string }
      | undefined;
    if (row?.status !== "active") throw new ApiError(401, "invalid-api-key", "unknown, disabled or deleted API key");
    const day = utcDay(now);
    const spent = spentOn(keyId, day);
    const cap = BigInt(row.daily_cap_wei);
    if (spent + priceWei > cap) throw capError(cap, spent, priceWei, now);
    db.prepare(
      `INSERT INTO api_key_spend (key_id, day, held_wei) VALUES (?, ?, ?)
       ON CONFLICT(key_id, day) DO UPDATE SET held_wei = excluded.held_wei`,
    ).run(keyId, day, (spent + priceWei).toString());
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE key_id = ?").run(now, keyId);
  });
}

// ---- Request auth ----------------------------------------------------------------------------------------

/**
 * The API key of a request: null when the bearer token is not an `sck_` key (no key sent); 401 invalid-api-key when
 * it is one but unknown, disabled, deleted or wrong (checked on every request: the kill switch acts at once).
 */
export function keyFromRequest(req: Request): KeyViewer | null {
  const token = bearerToken(req);
  if (!token || !token.startsWith("sck_")) return null;
  const key = apiKeyFromToken(token);
  if (!key) throw new ApiError(401, "invalid-api-key", "unknown, disabled or deleted API key");
  return key;
}

// ---- Management (session required) ------------------------------------------------------------------------

function keyJson(r: KeyRow, now = nowSec()): ApiKeyInfo {
  const s = keySpend(r.key_id, now);
  return {
    keyId: r.key_id,
    prefix: keyPrefix(r.key_id),
    fingerprint: fingerprintOf(r.key_hash),
    label: r.label,
    status: r.status === "deleted" ? "disabled" : r.status,
    dailyCapWei: r.daily_cap_wei,
    spentTodayWei: s.spent.toString(),
    remainingTodayWei: s.remaining.toString(),
    day: s.day,
    nextResetAt: s.nextResetAt,
    createdAt: r.created_at,
    activatedAt: r.activated_at,
    lastUsedAt: r.last_used_at,
    disabledAt: r.disabled_at,
  };
}

/** Pending keys whose link signature did not arrive in time are dropped (their secret was never shown). */
function dropStalePending(owner: Address, now: number) {
  getDb()
    .prepare("UPDATE api_keys SET status = 'deleted', disabled_at = ? WHERE owner = ? AND status = 'pending' AND created_at <= ?")
    .run(now, owner, now - PENDING_KEY_SECONDS);
  prunePending(now);
}

const liveKeys = (owner: Address) =>
  (getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE owner = ? AND status IN ('pending','active')").get(owner) as { n: number }).n;

/** POST /api/v1/keys { label?, dailyCapWei } — a pending key, its fingerprint and the link message to sign. */
export function createPendingKey(owner: Address, body: unknown) {
  requireKeysOn();
  const contract = requirePayments();
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const label = parseLabel(b.label);
  const cap = parseCap(b.dailyCapWei);
  takeHourly(limitBucket("api-key-create", owner.toLowerCase()), KEY_CREATES_PER_HOUR, "API key creations per wallet");
  const now = nowSec();
  return tx((db) => {
    dropStalePending(owner, now);
    if (liveKeys(owner) >= MAX_KEYS) {
      throw new ApiError(409, "max-keys", `a wallet can have at most ${MAX_KEYS} active or pending keys; disable or delete one first`, { maxKeys: MAX_KEYS });
    }
    const keyId = randomBytes(8).toString("hex");
    const fullKey = `${keyPrefix(keyId)}_${randomBytes(32).toString("base64url")}`;
    const keyHash = apiKeyHash(fullKey);
    const fingerprint = fingerprintOf(keyHash);
    const linkMessage = keyLinkMessage({ chainId: targetChain.id, contract, keyId, fingerprint, dailyCapWei: cap, issued: now });
    db.prepare(
      `INSERT INTO api_keys (key_id, owner, label, key_hash, daily_cap_wei, status, link_message, link_issued, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(keyId, owner, label, keyHash, cap.toString(), linkMessage, now, now);
    pendingKeys().set(keyId, { fullKey, expiresAt: now + PENDING_KEY_SECONDS });
    return {
      keyId,
      prefix: keyPrefix(keyId),
      fingerprint,
      label,
      status: "pending" as const,
      dailyCapWei: cap.toString(),
      linkMessage,
      issued: now,
      expiresAt: now + PENDING_KEY_SECONDS,
    };
  });
}

/**
 * POST /api/v1/keys/:id/activate { signature } — checks the wallet's signature over the stored link message (EOA, then
 * ERC-1271 / ERC-6492 through the chain) and activates the key. The full key is in this answer and nowhere else.
 */
export async function activateKey(owner: Address, keyIdRaw: string, body: unknown) {
  requireKeysOn();
  const row = ownKey(owner, keyIdRaw);
  if (row.status !== "pending") throw new ApiError(409, "not-pending", `this key is ${row.status}; only a pending key can be activated`);
  const now = nowSec();
  const held = pendingKeys().get(row.key_id);
  if (!held || held.expiresAt <= now || (row.link_issued ?? 0) + PENDING_KEY_SECONDS <= now) {
    pendingKeys().delete(row.key_id);
    throw new ApiError(410, "pending-key-expired", "this pending key expired before it was signed; create a new key");
  }
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const signature = parseSignature(b.signature);
  if (!row.link_message || !(await signatureValid(owner, row.link_message, signature))) {
    throw new ApiError(400, "bad-link-signature", "the signature is not from the signed-in wallet over this key's link message");
  }
  if (REQUIRE_SPEND_LIMIT_FOR_KEYS && (await readAccount(owner)).spendLimit === 0n) {
    throw new ApiError(409, "spend-limit-required", "set a spend limit per epoch in the payments contract before activating a key");
  }
  const activated = tx((db) => {
    const cur = db.prepare("SELECT status FROM api_keys WHERE key_id = ?").get(row.key_id) as { status: string };
    if (cur.status !== "pending") throw new ApiError(409, "not-pending", `this key is ${cur.status}; only a pending key can be activated`);
    const active = (db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE owner = ? AND status = 'active'").get(owner) as { n: number }).n;
    if (active >= MAX_KEYS) throw new ApiError(409, "max-keys", `a wallet can have at most ${MAX_KEYS} active keys`, { maxKeys: MAX_KEYS });
    db.prepare("UPDATE api_keys SET status = 'active', link_signature = ?, activated_at = ? WHERE key_id = ?").run(signature.toLowerCase(), nowSec(), row.key_id);
    return db.prepare("SELECT * FROM api_keys WHERE key_id = ?").get(row.key_id) as KeyRow;
  });
  pendingKeys().delete(row.key_id);
  return { ...keyJson(activated), key: held.fullKey, shownOnce: true as const };
}

/** GET /api/v1/keys — the signed-in wallet's keys (never deleted ones), with spent today and the next reset. */
export function listKeys(owner: Address): ApiKeyList {
  const now = nowSec();
  dropStalePending(owner, now);
  const rows = getDb()
    .prepare("SELECT * FROM api_keys WHERE owner = ? AND status != 'deleted' ORDER BY created_at DESC, key_id")
    .all(owner) as KeyRow[];
  return { owner, keys: rows.map((r) => keyJson(r, now)), maxKeys: MAX_KEYS, day: utcDay(now), nextResetAt: nextUtcReset(now) };
}

/**
 * Kill switch, inside a transaction: the key stops working on the next request, and its queued (not yet leased) jobs
 * end `expired` with KEY_DISABLED_NOTE, so they follow the never-charged path. Returns how many jobs were cancelled.
 */
function killKey(keyId: string, status: "disabled" | "deleted", now: number): number {
  return tx((db) => {
    db.prepare("UPDATE api_keys SET status = ?, disabled_at = COALESCE(disabled_at, ?) WHERE key_id = ?").run(status, now, keyId);
    const queued = db.prepare("SELECT id FROM jobs WHERE api_key_id = ? AND status = 'queued'").all(keyId) as { id: string }[];
    const upJob = db.prepare("UPDATE jobs SET status = 'expired', settled_at = ?, note = ? WHERE id = ? AND status = 'queued'");
    const upTasks = db.prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id = ? AND status IN ('open','leased')");
    let n = 0;
    for (const { id } of queued) {
      n += Number(upJob.run(now, KEY_DISABLED_NOTE, id).changes);
      upTasks.run(id);
    }
    releaseKeyHolds();
    pendingKeys().delete(keyId);
    return n;
  });
}

/**
 * PATCH /api/v1/keys/:id { label?, dailyCapWei?, status?: "active" | "disabled", issued?, signature? }. Lowering the
 * cap, disabling and relabelling need only the session. Raising the cap needs a new link signature (A3): without one
 * the answer is 409 link-signature-required with the message to sign and its `issued`; send them back with the
 * signature. Re-enabling a disabled key keeps its original link signature and counts against MAX_KEYS.
 */
export async function updateKey(owner: Address, keyIdRaw: string, body: unknown) {
  const row = ownKey(owner, keyIdRaw);
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const now = nowSec();
  const label = "label" in b ? parseLabel(b.label) : null;
  const cap = "dailyCapWei" in b ? parseCap(b.dailyCapWei) : null;
  const status = "status" in b ? b.status : undefined;
  if (status !== undefined && status !== "active" && status !== "disabled") {
    throw new ApiError(400, "invalid-key", 'status must be "active" or "disabled"', { field: "status" });
  }
  if (row.status === "pending" && (cap !== null || status !== undefined)) {
    throw new ApiError(409, "not-active", "a pending key must be activated (or deleted) before its cap or status changes");
  }

  let link: { message: string; signature: Hex; issued: number } | null = null;
  if (cap !== null && cap > BigInt(row.daily_cap_wei) && RAISE_CAP_NEEDS_SIGNATURE) {
    const contract = requirePayments();
    const fingerprint = fingerprintOf(row.key_hash);
    if (b.signature === undefined) {
      const linkMessage = keyLinkMessage({ chainId: targetChain.id, contract, keyId: row.key_id, fingerprint, dailyCapWei: cap, issued: now });
      throw new ApiError(409, "link-signature-required", "raising a key's daily cap needs a new link signature from the wallet", {
        linkMessage,
        issued: now,
        dailyCapWei: cap.toString(),
      });
    }
    const signature = parseSignature(b.signature);
    const issued = typeof b.issued === "number" && Number.isInteger(b.issued) ? b.issued : null;
    // Not older than the signature on file, within the window, and never the signature on file again (no replay).
    if (
      issued === null ||
      issued > now + CLOCK_SKEW_SECONDS ||
      issued < now - PENDING_KEY_SECONDS ||
      issued < (row.link_issued ?? 0) ||
      signature.toLowerCase() === row.link_signature
    ) {
      throw new ApiError(400, "stale-link-signature", "issued must be the unix time from the link-signature-required answer, within 10 minutes");
    }
    const message = keyLinkMessage({ chainId: targetChain.id, contract, keyId: row.key_id, fingerprint, dailyCapWei: cap, issued });
    if (!(await signatureValid(owner, message, signature))) {
      throw new ApiError(400, "bad-link-signature", "the signature is not from the signed-in wallet over this cap's link message");
    }
    link = { message, signature, issued };
  }

  let cancelledJobs = 0;
  const updated = tx((db) => {
    const cur = db.prepare("SELECT * FROM api_keys WHERE key_id = ?").get(row.key_id) as KeyRow;
    if (cur.status === "deleted") throw new ApiError(404, "unknown-key", "no key with this id for the signed-in wallet");
    if (label !== null) db.prepare("UPDATE api_keys SET label = ? WHERE key_id = ?").run(label, row.key_id);
    if (cap !== null) {
      if (link) {
        db.prepare("UPDATE api_keys SET daily_cap_wei = ?, link_message = ?, link_signature = ?, link_issued = ? WHERE key_id = ?").run(
          cap.toString(),
          link.message,
          link.signature.toLowerCase(),
          link.issued,
          row.key_id,
        );
      } else {
        db.prepare("UPDATE api_keys SET daily_cap_wei = ? WHERE key_id = ?").run(cap.toString(), row.key_id);
      }
    }
    if (status === "disabled" && cur.status === "active") cancelledJobs = killKey(row.key_id, "disabled", now);
    if (status === "active" && cur.status === "disabled") {
      requireKeysOn();
      if (!cur.link_signature) throw new ApiError(409, "not-signed", "this key was never activated with a link signature");
      if (liveKeys(owner) >= MAX_KEYS) throw new ApiError(409, "max-keys", `a wallet can have at most ${MAX_KEYS} active or pending keys`, { maxKeys: MAX_KEYS });
      db.prepare("UPDATE api_keys SET status = 'active', disabled_at = NULL WHERE key_id = ?").run(row.key_id);
    }
    return db.prepare("SELECT * FROM api_keys WHERE key_id = ?").get(row.key_id) as KeyRow;
  });
  return { ...keyJson(updated, now), cancelledJobs };
}

/** DELETE /api/v1/keys/:id — the key stops working at once (kill switch) and leaves the list; its record stays for audit. */
export function deleteKey(owner: Address, keyIdRaw: string) {
  const row = ownKey(owner, keyIdRaw);
  const cancelledJobs = killKey(row.key_id, "deleted", nowSec());
  return { ok: true, keyId: row.key_id, status: "deleted" as const, cancelledJobs };
}

/** POST /api/v1/keys/disable-all — every active key of the wallet is disabled, every pending one deleted. */
export function disableAllKeys(owner: Address) {
  const now = nowSec();
  return tx((db) => {
    const rows = db.prepare("SELECT key_id, status FROM api_keys WHERE owner = ? AND status IN ('pending','active')").all(owner) as {
      key_id: string;
      status: string;
    }[];
    let cancelledJobs = 0;
    for (const r of rows) cancelledJobs += killKey(r.key_id, r.status === "pending" ? "deleted" : "disabled", now);
    return { ok: true, disabled: rows.filter((r) => r.status === "active").length, cancelledJobs };
  });
}
