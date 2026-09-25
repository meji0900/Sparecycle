// HTTP helpers for the /api/v1 route handlers: JSON responses, kebab-case error codes (never a stack trace),
// body size limits, client IP and the signed node-request check with replay protection.
import { checkSignedRequest, SIGNED_HEADERS, REQUEST_WINDOW_SECONDS, toJson } from "@/lib/protocol";
import type { Address } from "viem";
import { getDb, nowSec } from "./db";

export class ApiError extends Error {
  status: number;
  code: string;
  extra?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const NO_STORE = { "cache-control": "no-store" };

/** JSON response; bigints become decimal strings. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(toJson(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
  });
}

export function errorResponse(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return json({ error: code, message, ...extra }, status);
}

/** Wraps a handler: ApiError -> its JSON error, anything else -> 500 internal-error (logged, not returned). */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ApiError) return errorResponse(e.status, e.code, e.message, e.extra);
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[sparecycle] internal error: ${msg}`);
      return errorResponse(500, "internal-error", "The scheduler hit an internal error.");
    }
  };
}

/** Reads the raw body with a size limit (checks content-length first, then the actual size). */
export async function readBody(req: Request, maxBytes: number): Promise<string> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new ApiError(413, "body-too-large", `request body is larger than ${maxBytes} bytes`);
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ApiError(413, "body-too-large", `request body is larger than ${maxBytes} bytes`);
  }
  return text;
}

export function parseJson(text: string): unknown {
  try {
    return text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid-json", "request body is not valid JSON");
  }
}

/**
 * Client IP for rate limiting: first x-forwarded-for hop (set by the hosting proxy), else x-real-ip.
 * The host must overwrite x-forwarded-for from the client (all mainstream PaaS proxies do).
 */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Verifies a signed node request (x-sc-from / x-sc-ts / x-sc-sig over sparecycle|METHOD|PATH|TS|sha256(body)),
 * 60 s window, and rejects a signature seen before (remembered for 120 s). Returns the node key.
 */
export async function verifyNodeRequest(req: Request, body: string): Promise<Address> {
  const url = new URL(req.url);
  const check = await checkSignedRequest({
    from: req.headers.get(SIGNED_HEADERS.from),
    ts: req.headers.get(SIGNED_HEADERS.ts),
    sig: req.headers.get(SIGNED_HEADERS.sig),
    method: req.method,
    path: url.pathname,
    body,
  });
  if (!check.ok) throw new ApiError(401, check.error, check.message);
  const db = getDb();
  const now = nowSec();
  db.prepare("DELETE FROM seen_requests WHERE seen_at < ?").run(now - 2 * REQUEST_WINDOW_SECONDS);
  const res = db.prepare("INSERT OR IGNORE INTO seen_requests (sig, seen_at) VALUES (?, ?)").run(check.sig, now);
  if (Number(res.changes) === 0) throw new ApiError(401, "replayed-request", "this signed request was already used");
  return check.signer;
}

/** Bearer-token check for operator endpoints (constant-time compare). */
export function requireAdmin(req: Request, token: string | null) {
  if (!token) throw new ApiError(503, "admin-not-configured", "SCHEDULER_ADMIN_TOKEN is not set on the scheduler");
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  if (diff !== 0) throw new ApiError(401, "unauthorized", "a valid Authorization: Bearer token is required");
}

/** Parses a route segment as a non-negative integer id. */
export function parseEpochId(raw: string): number {
  if (!/^\d{1,15}$/.test(raw)) throw new ApiError(400, "invalid-epoch-id", "epoch id must be a non-negative integer");
  return Number(raw);
}
