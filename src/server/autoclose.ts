// Boot hook of the scheduler (called from src/instrumentation.ts in the Node.js runtime): opens the DB
// (running migrations), starts the GPU pool, sweep and DB-snapshot timers when configured, and, when SCHEDULER_AUTOCLOSE=1,
// starts the epoch autoclose timer. Guarded so it runs once per process even if the module is evaluated more
// than once.
import { getDb } from "./db";
import { POLICY, serverEnv } from "./env";
import { autocloseTick } from "./epochs";
import { startPoolTimer } from "./gpu-pool";
import { startSweepTimer } from "./sweep";
import { startBackupTimer } from "./backup";
import { startX402Timer } from "./x402";

const g = globalThis as typeof globalThis & { __sparecycleBooted?: boolean; __sparecycleAutoclose?: ReturnType<typeof setInterval> };

export function bootScheduler() {
  if (g.__sparecycleBooted) return;
  g.__sparecycleBooted = true;
  try {
    getDb();
  } catch (e) {
    console.error(`[sparecycle] scheduler DB could not be opened: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  startPoolTimer();
  startSweepTimer();
  startBackupTimer();
  startX402Timer(); // x402 escrow settlement (./x402): only when X402_ENABLED=1 and configured
  if (!serverEnv.autoclose() || g.__sparecycleAutoclose) return;
  let running = false;
  g.__sparecycleAutoclose = setInterval(() => {
    if (running) return;
    running = true;
    autocloseTick().finally(() => {
      running = false;
    });
  }, POLICY.autocloseCheckMs);
  g.__sparecycleAutoclose.unref?.();
  console.log(`[sparecycle] epoch autoclose timer on (checks every ${POLICY.autocloseCheckMs / 1000} s)`);
}
