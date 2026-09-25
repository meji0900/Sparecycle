// On-demand GPU pool for the bootstrap phase: the project's own rented GPU nodes (Vast.ai instances that already
// have the node client installed and start it on boot) are switched on when jobs wait and fewer than two node
// owners that can run them are online, and switched off again after GPU_POOL_IDLE_MINUTES without open jobs.
// A stopped Vast instance bills disk only; a running one bills GPU time too.
//
//   VAST_API_KEY            secret, typed by the operator (never logged, never returned)
//   GPU_POOL_INSTANCE_IDS   "61906174,61906182": the pool's instances (two, with different owner wallets, because a
//                           job's two copies always go to two different owners)
//   GPU_POOL_IDLE_MINUTES   default 10
//   VAST_API_URL            default https://console.vast.ai (tests point it at a mock)
//
// The pool nodes' owner wallets belong in PROJECT_NODE_OWNERS: they never get a payout (see payouts.ts) and the
// status page marks them as run by Sparecycle. Without VAST_API_KEY and GPU_POOL_INSTANCE_IDS this module is idle.
import { getDb, nowSec } from "./db";
import { POLICY } from "./env";

type PoolState = "unknown" | "starting" | "running" | "stopping" | "stopped";
type Pool = {
  state: PoolState;
  lastActivityAt: number;
  lastStartAt: number | null;
  lastStopAt: number | null;
  error: string | null;
  ticking: boolean;
};

const g = globalThis as typeof globalThis & { __sparecyclePool?: Pool; __sparecyclePoolTimer?: ReturnType<typeof setInterval> };
const pool = (): Pool =>
  (g.__sparecyclePool ??= { state: "unknown", lastActivityAt: nowSec(), lastStartAt: null, lastStopAt: null, error: null, ticking: false });

const str = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : null);
export const poolEnv = {
  apiKey: () => str(process.env.VAST_API_KEY),
  apiUrl: () => (str(process.env.VAST_API_URL) ?? "https://console.vast.ai").replace(/\/+$/, ""),
  instanceIds: () =>
    (str(process.env.GPU_POOL_INSTANCE_IDS) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s)),
  idleSeconds: () => {
    const n = Number(str(process.env.GPU_POOL_IDLE_MINUTES) ?? "10");
    return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : 600;
  },
};
export const poolConfigured = () => poolEnv.apiKey() !== null && poolEnv.instanceIds().length > 0;

/** A start can take a few minutes (container boot + model load); don't send another before this. */
const START_RETRY_SECONDS = 5 * 60;

async function setState(id: string, state: "running" | "stopped") {
  const res = await fetch(`${poolEnv.apiUrl()}/api/v0/instances/${id}/`, {
    method: "PUT",
    headers: { authorization: `Bearer ${poolEnv.apiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ state }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Vast ${state} ${id}: HTTP ${res.status}`);
}

async function actualStatus(id: string): Promise<string | null> {
  const res = await fetch(`${poolEnv.apiUrl()}/api/v0/instances/${id}/?owner=me`, {
    headers: { authorization: `Bearer ${poolEnv.apiKey()}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Vast status ${id}: HTTP ${res.status}`);
  const body = (await res.json()) as { instances?: { actual_status?: string | null } | null };
  return body.instances?.actual_status ?? null;
}

/** Open jobs, and distinct online owners whose nodes can take each open model. */
function demand() {
  const db = getDb();
  const open = db.prepare("SELECT model, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','checking') GROUP BY model").all() as {
    model: string;
    n: number;
  }[];
  const since = nowSec() - POLICY.onlineWindowSeconds;
  const nodes = db.prepare("SELECT owner, caps FROM nodes WHERE last_seen >= ?").all(since) as { owner: string; caps: string }[];
  const tagOf: Record<string, string> = { sd15: "image:sd15", "qwen2.5-1.5b": "text:qwen2.5-1.5b" };
  const short = open.filter((o) => {
    const owners = new Set(nodes.filter((n) => (JSON.parse(n.caps) as string[]).includes(tagOf[o.model] ?? "")).map((n) => n.owner.toLowerCase()));
    return owners.size < 2;
  });
  return { openJobs: open.reduce((s, o) => s + o.n, 0), uncovered: short.length > 0 };
}

async function startAll(now: number) {
  const p = pool();
  p.state = "starting";
  p.lastStartAt = now;
  try {
    await Promise.all(poolEnv.instanceIds().map((id) => setState(id, "running")));
    p.state = "running";
    p.error = null;
    console.log(`[sparecycle] GPU pool: started ${poolEnv.instanceIds().length} instance(s) for waiting jobs`);
  } catch (e) {
    p.error = e instanceof Error ? e.message : String(e);
    p.state = "unknown";
    console.error(`[sparecycle] GPU pool start failed: ${p.error}`);
  }
}

async function stopAll(now: number) {
  const p = pool();
  p.state = "stopping";
  try {
    await Promise.all(poolEnv.instanceIds().map((id) => setState(id, "stopped")));
    p.state = "stopped";
    p.lastStopAt = now;
    p.error = null;
    console.log(`[sparecycle] GPU pool: stopped after ${Math.round(poolEnv.idleSeconds() / 60)} min without jobs`);
  } catch (e) {
    p.error = e instanceof Error ? e.message : String(e);
    p.state = "unknown";
    console.error(`[sparecycle] GPU pool stop failed: ${p.error}`);
  }
}

/** One decision: start when jobs wait uncovered, stop after the idle window. `now` is injectable for tests. */
export async function poolTick(now = nowSec()) {
  if (!poolConfigured()) return;
  const p = pool();
  if (p.ticking) return;
  p.ticking = true;
  try {
    if (p.state === "unknown") {
      // After a restart (or a failed call) ask Vast what is running, so an idle pool isn't left on.
      const states = await Promise.all(poolEnv.instanceIds().map((id) => actualStatus(id).catch(() => null)));
      p.state = states.some((s) => s === "running" || s === "loading") ? "running" : states.every((s) => s !== null) ? "stopped" : "unknown";
    }
    const d = demand();
    if (d.openJobs > 0) p.lastActivityAt = now;
    const recentlyStarted = p.lastStartAt !== null && now - p.lastStartAt < START_RETRY_SECONDS;
    if (d.uncovered && !recentlyStarted && p.state !== "starting") {
      // Also covers a running pool whose nodes went missing (e.g. Vast stopped a container): ask again.
      await startAll(now);
    } else if (d.openJobs === 0 && p.state !== "stopped" && now - p.lastActivityAt >= poolEnv.idleSeconds()) {
      await stopAll(now);
    }
  } finally {
    p.ticking = false;
  }
}

/** Called when a job is queued: decide right away instead of waiting for the next tick. Never throws. */
export function poolNudge() {
  if (!poolConfigured()) return;
  void poolTick().catch((e: unknown) => console.error(`[sparecycle] GPU pool: ${e instanceof Error ? e.message : String(e)}`));
}

/** Starts the minute timer (from the scheduler boot hook). */
export function startPoolTimer() {
  if (!poolConfigured() || g.__sparecyclePoolTimer) return;
  g.__sparecyclePoolTimer = setInterval(() => poolNudge(), 60_000);
  g.__sparecyclePoolTimer.unref?.();
  console.log(`[sparecycle] GPU pool on: ${poolEnv.instanceIds().length} instance(s), stop after ${Math.round(poolEnv.idleSeconds() / 60)} min idle`);
  poolNudge();
}

/** For /api/v1/status: no IDs, no key. */
export function poolStatus() {
  if (!poolConfigured()) return { configured: false as const };
  const p = pool();
  return {
    configured: true as const,
    state: p.state,
    instances: poolEnv.instanceIds().length,
    idleMinutes: Math.round(poolEnv.idleSeconds() / 60),
    lastStartAt: p.lastStartAt,
    lastStopAt: p.lastStopAt,
    error: p.error,
  };
}
