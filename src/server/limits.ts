// Hourly counters in the rate_limits table, keyed by salted hashes (an IP address or a wallet is never stored).
import { sha256Hex } from "@/lib/protocol";
import { getMeta, nowSec, randomHex, setMeta, tx } from "./db";
import { ApiError } from "./http";

/** Per-database random salt of every rate-limit bucket. */
export const ipSalt = () => {
  let salt = getMeta("ip_salt");
  if (!salt) {
    salt = randomHex(32);
    setMeta("ip_salt", salt);
  }
  return salt;
};

/** Salted bucket name for a rate limit, e.g. limitBucket("output", "ip", ip). */
export const limitBucket = (...parts: string[]) => sha256Hex(`${ipSalt()}|${parts.join("|")}`);

/** Counts one hit in `bucket` for the current hour; 429 rate-limited once `limit` hits were counted. */
export function takeHourly(bucket: string, limit: number, what: string) {
  const now = nowSec();
  const window = Math.floor(now / 3600) * 3600;
  tx((db) => {
    db.prepare("DELETE FROM rate_limits WHERE window_start < ?").run(window - 3600);
    const used = (db.prepare("SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?").get(bucket, window) as
      | { count: number }
      | undefined)?.count ?? 0;
    if (used >= limit) throw new ApiError(429, "rate-limited", `at most ${limit} ${what} per hour`, { retryAfter: window + 3600 - now });
    db.prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1`,
    ).run(bucket, window);
  });
}
