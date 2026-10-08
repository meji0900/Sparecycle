import { formatUnits } from "viem";

export const EM_DASH = "—";

export function truncateMiddle(value: string, head = 6, tail = 4) {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Fixed-point amount for display; trims trailing zeros, keeps up to `digits` decimals. */
export function formatAmount(value: bigint | null | undefined, decimals = 18, digits = 6) {
  if (value === null || value === undefined) return EM_DASH;
  const s = formatUnits(value, decimals);
  const [whole, frac = ""] = s.split(".");
  const trimmed = frac.slice(0, digits).replace(/0+$/, "");
  const w = BigInt(whole).toLocaleString("en-US");
  return trimmed ? `${w}.${trimmed}` : w;
}

export function formatBps(bps: bigint | number | null | undefined) {
  if (bps === null || bps === undefined) return EM_DASH;
  const n = Number(bps);
  return `${(n / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

export function formatInt(n: bigint | number | null | undefined) {
  if (n === null || n === undefined) return EM_DASH;
  return BigInt(n).toLocaleString("en-US");
}

export function formatDuration(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EM_DASH;
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

export function formatTime(unixSeconds: number | bigint | null | undefined) {
  if (unixSeconds === null || unixSeconds === undefined || Number(unixSeconds) === 0) return EM_DASH;
  return new Date(Number(unixSeconds) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function relativeTime(unixMs: number, now = Date.now()) {
  const d = Math.round((now - unixMs) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return `${Math.floor(d / 86400)} d ago`;
}
