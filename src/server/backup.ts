// Daily SQLite snapshot of the scheduler database: `VACUUM INTO <db dir>/backups/sparecycle-<UTC stamp>.db`, keeping
// the newest DB_BACKUP_KEEP (default 7). Guards against corruption or a bad migration, not against losing the
// volume itself: the public /api/v1/epochs/{id}/tree endpoint lets anyone mirror every published Merkle tree, and
// `node scripts/backup-trees.mjs <site>` downloads them all off the server.
// DB_BACKUP_HOURS: hours between snapshots (default 24, 0 = off). Uses the same synchronous DB handle as the API,
// so a snapshot briefly blocks requests (milliseconds for a DB of this size).
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getDb } from "./db";
import { serverEnv } from "./env";

const g = globalThis as typeof globalThis & { __sparecycleBackupTimer?: ReturnType<typeof setInterval> };

const num = (name: string, fallback: number) => {
  const s = (process.env[name] ?? "").trim();
  const n = Number(s);
  return s !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
};

export function backupDir(): string {
  return join(dirname(resolve(serverEnv.dbPath())), "backups");
}

/** Writes one snapshot and prunes old ones. Returns the new file's path. */
export function snapshotDb(): string {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const file = join(dir, `sparecycle-${stamp}.db`);
  getDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const keep = Math.max(1, num("DB_BACKUP_KEEP", 7));
  const old = readdirSync(dir)
    .filter((f) => /^sparecycle-\d{8}T\d{6}Z\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return file;
}

/** Starts the snapshot timer once per process (first snapshot 2 minutes after boot). */
export function startBackupTimer() {
  const hours = num("DB_BACKUP_HOURS", 24);
  if (!hours || g.__sparecycleBackupTimer) return;
  const tick = () => {
    try {
      const f = snapshotDb();
      console.log(`[sparecycle] DB snapshot ${f}`);
    } catch (e) {
      console.error(`[sparecycle] DB snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  g.__sparecycleBackupTimer = setInterval(tick, hours * 3_600_000);
  g.__sparecycleBackupTimer.unref?.();
  setTimeout(tick, 120_000).unref?.();
}
