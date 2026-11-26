// Who may read a job's output (docs/private-outputs.md):
//   - the job's read secret: 32 random bytes returned once by POST /api/v1/jobs, sent back as
//     `Authorization: Bearer <secret>`; only its sha256 is stored (jobs.read_secret_hash);
//   - a wallet session: EIP-4361 "Sign-In with Ethereum" (GET auth/nonce -> the wallet signs -> POST auth/verify)
//     gives an HttpOnly cookie `sc_session`; only the sha256 of the session id is stored. A session reads the jobs
//     whose payer is that wallet (paid and team jobs). EOAs and ERC-1271 / ERC-6492 smart wallets are supported.
//   - an API key (src/server/apikeys.ts): `Authorization: Bearer sck_<keyId>_<secret>`; only sha256(full key) is stored.
//     A key reads the jobs submitted with that key only (never other jobs of its wallet). The `sck_` format keeps keys
//     apart from read secrets on the same header: a token matching API_KEY_PATTERN is never tried as a read secret.
// Node request signatures (x-sc-*) are never credentials here: nodes cannot read outputs.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { generateSiweNonce, parseSiweMessage } from "viem/siwe";
import { publicClient, targetChain } from "@/lib/chain";
import { getDb, nowSec, tx } from "./db";
import { POLICY, serverEnv } from "./env";
import { ApiError, clientIp } from "./http";
import { limitBucket, takeHourly } from "./limits";

export const SESSION_COOKIE = "sc_session";
/** The statement the dapp puts in its sign-in message. */
export const SIGN_IN_STATEMENT = "Sign in to Sparecycle to view the results of jobs this wallet paid for. No transaction and no gas.";
const MAX_MESSAGE_CHARS = 2048;
/** Allowed clock difference between the wallet's issued-at and the scheduler. */
const CLOCK_SKEW_SECONDS = 5 * 60;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Constant-time comparison of two 32-byte hex digests. */
export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** A new per-job read secret and the hash that is stored. The secret itself is returned once and never kept. */
export function newReadSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: sha256(secret) };
}

/** True when `secret` is the job's read secret (constant time). A job without a stored hash matches nothing. */
export function secretMatches(secret: string | null, storedHash: string | null): boolean {
  if (!secret || !storedHash || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  return sameDigest(sha256(secret), storedHash);
}

/** The host the request was sent to (lowercase, with the port). */
export function requestHost(req: Request): string {
  return (req.headers.get("host") ?? new URL(req.url).host).trim().toLowerCase();
}

const isLocalHost = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host.replace(/:\d+$/, ""));

/** Hosts a sign-in message may name: AUTH_DOMAIN when set, else the host this request was sent to. */
function allowedDomains(req: Request): string[] {
  const configured = serverEnv.authDomains();
  return configured.length ? configured : [requestHost(req)];
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Set-Cookie value of a session (HttpOnly, SameSite=Strict, Secure unless the site is plain http://localhost). */
export function sessionCookie(req: Request, value: string, maxAge: number): string {
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/api/v1", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (!isLocalHost(requestHost(req))) parts.push("Secure");
  return parts.join("; ");
}

/** GET /api/v1/auth/nonce — a single-use nonce for one sign-in message (POLICY.authNonceSeconds). */
export function issueNonce(req: Request) {
  takeHourly(limitBucket("auth-nonce", clientIp(req)), POLICY.authNoncesPerHour, "sign-in nonces from one address");
  const now = nowSec();
  const nonce = generateSiweNonce();
  const expiresAt = now + POLICY.authNonceSeconds;
  tx((db) => {
    db.prepare("DELETE FROM auth_nonces WHERE expires_at < ?").run(now - 3600);
    db.prepare("INSERT INTO auth_nonces (nonce, created_at, expires_at) VALUES (?, ?, ?)").run(nonce, now, expiresAt);
  });
  return { nonce, expiresAt, chainId: targetChain.id, version: "1", statement: SIGN_IN_STATEMENT };
}

/** EOA signature first (no RPC), then ERC-1271 / ERC-6492 through the chain, like ownerSigValid in ./nodes. */
export async function signatureValid(address: Address, message: string, signature: Hex): Promise<boolean> {
  try {
    if (await verifyMessage({ address, message, signature })) return true;
  } catch {
    /* fall through to the contract-wallet check */
  }
  try {
    return await publicClient.verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}

const denied = (code: string, message: string): never => {
  throw new ApiError(401, code, message);
};

/**
 * POST /api/v1/auth/verify { message, signature }. Checks the EIP-4361 fields (domain, uri, chain id, version,
 * issued-at, expiry), spends the nonce (single use, even when the signature then fails), verifies the signature and
 * opens a session of POLICY.sessionSeconds. Returns the session id for the cookie; only its sha256 is stored.
 */
export async function signIn(req: Request, body: unknown): Promise<{ address: Address; sessionId: string; expiresAt: number }> {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const message = b.message;
  const signature = b.signature;
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE_CHARS) {
    throw new ApiError(400, "invalid-sign-in", `message must be an EIP-4361 sign-in message of at most ${MAX_MESSAGE_CHARS} characters`, { field: "message" });
  }
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{2,20000}$/.test(signature)) {
    throw new ApiError(400, "invalid-sign-in", "signature must be a hex signature", { field: "signature" });
  }
  let f: ReturnType<typeof parseSiweMessage>;
  try {
    f = parseSiweMessage(message);
  } catch {
    f = {};
  }
  if (!f.address || !isAddress(f.address) || !f.domain || !f.uri || !f.nonce || f.version !== "1" || typeof f.chainId !== "number" || !f.issuedAt) {
    throw new ApiError(400, "invalid-sign-in", "message must name address, domain, uri, version 1, chain id, nonce and issued-at (EIP-4361)", {
      field: "message",
    });
  }
  const domain = f.domain.toLowerCase();
  if (!allowedDomains(req).includes(domain)) denied("wrong-domain", "the message was written for another site");
  let uriHost = "";
  try {
    uriHost = new URL(f.uri).host.toLowerCase();
  } catch {
    /* not a URL */
  }
  if (uriHost !== domain) denied("wrong-domain", "the message uri must be on the signed domain");
  if (f.chainId !== targetChain.id) denied("wrong-chain", `the message must name chain id ${targetChain.id}`);
  const now = nowSec();
  const issued = Math.floor(f.issuedAt.getTime() / 1000);
  if (!Number.isFinite(issued) || issued > now + CLOCK_SKEW_SECONDS || issued < now - POLICY.authNonceSeconds - CLOCK_SKEW_SECONDS) {
    denied("stale-sign-in", "the message was issued too long ago or in the future; sign a new one");
  }
  if (f.expirationTime && f.expirationTime.getTime() / 1000 <= now) denied("stale-sign-in", "the message has expired; sign a new one");
  if (f.notBefore && f.notBefore.getTime() / 1000 > now + CLOCK_SKEW_SECONDS) denied("stale-sign-in", "the message is not valid yet");
  const address = getAddress(f.address);

  // Spend the nonce before the (async) signature check: a message can be presented once, and two concurrent
  // presentations can't both pass.
  const spent = getDb()
    .prepare("UPDATE auth_nonces SET used = 1, address = ? WHERE nonce = ? AND used = 0 AND expires_at >= ?")
    .run(address, f.nonce, now);
  if (Number(spent.changes) !== 1) denied("bad-nonce", "unknown, expired or already used nonce; ask for a new one");
  if (!(await signatureValid(address, message, signature as Hex))) denied("bad-signature", "the signature is not from the address in the message");

  const sessionId = randomBytes(32).toString("base64url");
  const expiresAt = nowSec() + POLICY.sessionSeconds;
  tx((db) => {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowSec());
    db.prepare("INSERT INTO sessions (id_hash, address, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(sessionId), address, nowSec(), expiresAt);
  });
  return { address, sessionId, expiresAt };
}

const sessionIdOf = (req: Request) => {
  const id = readCookie(req, SESSION_COOKIE);
  return id && /^[A-Za-z0-9_-]{43}$/.test(id) ? id : null;
};

/** The wallet of a live session cookie, or null (no cookie, unknown or expired session). */
export function sessionFromRequest(req: Request): { address: Address; expiresAt: number } | null {
  const id = sessionIdOf(req);
  if (!id) return null;
  const row = getDb().prepare("SELECT address, expires_at FROM sessions WHERE id_hash = ? AND expires_at > ?").get(sha256(id), nowSec()) as
    | { address: Address; expires_at: number }
    | undefined;
  return row ? { address: row.address, expiresAt: row.expires_at } : null;
}

/** POST /api/v1/auth/logout — ends the session (if any). */
export function signOut(req: Request) {
  const id = sessionIdOf(req);
  if (id) getDb().prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(id));
}

/** An API key that passed the lookup: active, and its sha256 matches (constant time). */
export type KeyViewer = { keyId: string; owner: Address };

/** Who is asking for an output: a session wallet, a read secret and / or an API key. */
export type Viewer = { address: Address | null; secret: string | null; key?: KeyViewer | null };

export const ANONYMOUS: Viewer = { address: null, secret: null, key: null };

/** `sck_` + 16 hex (key id, 8 bytes) + `_` + 43 base64url characters (32 bytes). 64 characters in all. */
export const API_KEY_PATTERN = /^sck_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;

/** sha256 hex of a full API key (the only form in which a key is stored). */
export const apiKeyHash = (fullKey: string) => sha256(fullKey);

/** The bearer token of a request (never the query string), or null. */
export function bearerToken(req: Request): string | null {
  const m = /^Bearer\s+(\S{1,512})\s*$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

/**
 * The active API key named by `token`, or null (not an `sck_` key, unknown, not active, or a wrong secret). The
 * stored hash is compared in constant time. Status is read on every call, so disabling a key takes effect on the
 * next request.
 */
export function apiKeyFromToken(token: string | null): KeyViewer | null {
  const m = token ? API_KEY_PATTERN.exec(token) : null;
  if (!m || !token) return null;
  const row = getDb().prepare("SELECT owner, key_hash, status FROM api_keys WHERE key_id = ?").get(m[1]) as
    | { owner: Address; key_hash: string; status: string }
    | undefined;
  if (!row || row.status !== "active") return null;
  return sameDigest(apiKeyHash(token), row.key_hash) ? { keyId: m[1], owner: row.owner } : null;
}

/**
 * Credentials of a request: the session cookie and `Authorization: Bearer <read secret or API key>` (never the query
 * string). A bearer token in the API key format is only ever tried as a key: an unknown or disabled key gives no
 * credential at all.
 */
export function viewerFromRequest(req: Request): Viewer {
  const token = bearerToken(req);
  const isKey = token !== null && API_KEY_PATTERN.test(token);
  return {
    address: sessionFromRequest(req)?.address ?? null,
    secret: token && !isKey ? token : null,
    key: isKey ? apiKeyFromToken(token) : null,
  };
}
