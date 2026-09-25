// SQLite storage of the scheduler (Node's built-in node:sqlite). All scheduler state lives here, so a restart
// loses nothing: nodes, jobs, tasks, results, epochs, payout leaves, rate limits and seen request signatures.
// One process per DB file (run one replica); WAL mode; schema migrations run on first open.
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { serverEnv } from "./env";

const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE nodes (
    node_key      TEXT PRIMARY KEY,           -- checksummed node signing key
    owner         TEXT NOT NULL,              -- checksummed owner wallet (Merkle leaf account)
    owner_sig     TEXT NOT NULL,
    gpu           TEXT NOT NULL,
    gpu_uuid      TEXT NOT NULL,
    vram_mb       INTEGER NOT NULL,
    caps          TEXT NOT NULL,              -- JSON array of capability tags
    dev           INTEGER NOT NULL DEFAULT 0, -- registered with the dev runner (no GPU)
    version       TEXT,
    registered_at INTEGER NOT NULL,
    last_seen     INTEGER NOT NULL,
    agreed_jobs   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX nodes_gpu_uuid ON nodes(gpu_uuid);
  CREATE INDEX nodes_owner ON nodes(owner);

  CREATE TABLE jobs (
    id           TEXT PRIMARY KEY,            -- bytes32 hex
    kind         TEXT NOT NULL,
    model        TEXT NOT NULL,
    spec         TEXT NOT NULL,               -- JSON JobSpec (private: holds the prompt)
    prompt_hash  TEXT NOT NULL,
    work_units   INTEGER NOT NULL,
    status       TEXT NOT NULL,               -- queued|running|checking|agreed|disagreed|expired|rejected
    dev          INTEGER NOT NULL DEFAULT 0,  -- verdict reached on dev-runner results (local tests only)
    ip_hash      TEXT,
    created_at   INTEGER NOT NULL,
    settled_at   INTEGER,
    epoch_id     INTEGER,                     -- epoch open when the verdict was reached (agreed => paid from it)
    output       BLOB,                        -- agreed output (PNG bytes or UTF-8 text)
    output_type  TEXT,                        -- image/png | text/plain; charset=utf-8
    note         TEXT
  );
  CREATE INDEX jobs_status ON jobs(status, created_at);
  CREATE INDEX jobs_epoch ON jobs(epoch_id, status);

  CREATE TABLE tasks (
    id            TEXT PRIMARY KEY,
    job_id        TEXT NOT NULL REFERENCES jobs(id),
    slot          INTEGER NOT NULL,           -- 0 or 1: each job runs on two distinct nodes
    status        TEXT NOT NULL,              -- open|leased|done|cancelled
    node_key      TEXT,
    owner         TEXT,
    gpu_uuid      TEXT,
    epoch         INTEGER,                    -- epoch handed to the node with the lease
    leased_at     INTEGER,
    lease_expires INTEGER,
    attempts      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (job_id, slot)
  );
  CREATE INDEX tasks_job ON tasks(job_id);
  CREATE INDEX tasks_status ON tasks(status);
  CREATE INDEX tasks_node ON tasks(node_key, status);

  CREATE TABLE results (
    task_id      TEXT PRIMARY KEY REFERENCES tasks(id),
    job_id       TEXT NOT NULL REFERENCES jobs(id),
    node_key     TEXT NOT NULL,
    owner        TEXT NOT NULL,
    gpu_uuid     TEXT NOT NULL,
    output_hash  TEXT NOT NULL,
    fingerprint  TEXT NOT NULL,
    gpu_ms       INTEGER NOT NULL,
    epoch        INTEGER NOT NULL,
    signature    TEXT NOT NULL,
    nsfw         INTEGER NOT NULL DEFAULT 0,
    dev          INTEGER NOT NULL DEFAULT 0,
    runner       TEXT,
    output       BLOB,                        -- dropped once the job has a verdict
    output_type  TEXT NOT NULL,
    received_at  INTEGER NOT NULL
  );
  CREATE INDEX results_job ON results(job_id);

  CREATE TABLE epochs (
    id           INTEGER PRIMARY KEY,
    clock        TEXT NOT NULL,               -- contract | scheduler-local
    status       TEXT NOT NULL,               -- open | closed-unposted | posted
    started_at   INTEGER NOT NULL,
    length       INTEGER NOT NULL,
    provisional  INTEGER NOT NULL DEFAULT 0,  -- 1 = start time not yet confirmed on-chain
    ended_at     INTEGER,
    closed_at    INTEGER,
    root         TEXT,
    reserved     TEXT,                        -- wei, decimal string
    pot_at_close TEXT,                        -- wei, decimal string (pot + unaccounted read at close)
    leaves       INTEGER NOT NULL DEFAULT 0,
    total_units  INTEGER NOT NULL DEFAULT 0,
    agreed_jobs  INTEGER NOT NULL DEFAULT 0,
    posted_tx    TEXT,
    pending_tx   TEXT,                        -- sent but not yet confirmed
    post_error   TEXT
  );

  CREATE TABLE payouts (
    epoch_id  INTEGER NOT NULL REFERENCES epochs(id),
    account   TEXT NOT NULL,                  -- checksummed owner wallet
    amount    TEXT NOT NULL,                  -- wei, decimal string
    leaf      TEXT NOT NULL,
    weight    INTEGER NOT NULL,               -- 2 x work units credited to this account
    PRIMARY KEY (epoch_id, account)
  );

  CREATE TABLE rate_limits (
    bucket       TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL,
    PRIMARY KEY (bucket, window_start)
  );

  CREATE TABLE seen_requests (
    sig     TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );
  CREATE INDEX seen_requests_at ON seen_requests(seen_at);
  `,
  // v2: compute backends (cuda | vulkan | cpu). A job's two tasks run on the same backend.
  `
  ALTER TABLE nodes ADD COLUMN backend TEXT NOT NULL DEFAULT 'cuda';
  ALTER TABLE tasks ADD COLUMN backend TEXT;      -- backend of the node holding / that held the task
  ALTER TABLE tasks ADD COLUMN dev INTEGER;       -- 1 = held by a dev-runner node (paired with dev nodes only)
  ALTER TABLE results ADD COLUMN backend TEXT;
  CREATE INDEX nodes_backend ON nodes(backend, last_seen);
  `,
  // v3: paid jobs (SparecycleJobPayments). A paid job carries its payer, quoted price and the customer's
  // signature (unique: a signature pays for one job). charge_status: pending | charged | released | unpaid.
  `
  ALTER TABLE jobs ADD COLUMN payer TEXT;
  ALTER TABLE jobs ADD COLUMN price_wei TEXT;
  ALTER TABLE jobs ADD COLUMN payment_sig TEXT;
  ALTER TABLE jobs ADD COLUMN charge_status TEXT;
  ALTER TABLE jobs ADD COLUMN charged_epoch INTEGER;
  CREATE UNIQUE INDEX jobs_payment_sig ON jobs(payment_sig) WHERE payment_sig IS NOT NULL;
  CREATE INDEX jobs_payer ON jobs(payer, charge_status);
  -- One charge() call per epoch: the published list, its hash, and the transaction.
  CREATE TABLE charges (
    epoch_id   INTEGER PRIMARY KEY,
    list_json  TEXT NOT NULL,
    list_hash  TEXT NOT NULL,
    total_wei  TEXT NOT NULL,
    status     TEXT NOT NULL,          -- sending | done | failed
    tx         TEXT,
    error      TEXT,
    created_at INTEGER NOT NULL
  );
  `,
];

type Holder = { db: DatabaseSync; path: string; txDepth: number };
const g = globalThis as typeof globalThis & { __sparecycleDb?: Holder };

function open(): Holder {
  const path = resolve(serverEnv.dbPath());
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.prepare("UPDATE schema_version SET version = ?").run(version);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return { db, path, txDepth: 0 };
}

function holder(): Holder {
  if (!g.__sparecycleDb) g.__sparecycleDb = open();
  return g.__sparecycleDb;
}

export function getDb(): DatabaseSync {
  return holder().db;
}

/** Runs `fn` in one IMMEDIATE transaction (nested calls join the outer one). `fn` must be synchronous. */
export function tx<T>(fn: (db: DatabaseSync) => T): T {
  const h = holder();
  if (h.txDepth > 0) return fn(h.db);
  h.db.exec("BEGIN IMMEDIATE");
  h.txDepth++;
  try {
    const out = fn(h.db);
    h.txDepth--;
    h.db.exec("COMMIT");
    return out;
  } catch (e) {
    h.txDepth--;
    h.db.exec("ROLLBACK");
    throw e;
  }
}

export function getMeta(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string) {
  getDb().prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Health probe: the DB opens and answers. */
export function dbHealthy(): boolean {
  try {
    getDb().prepare("SELECT 1 AS ok").get();
    return true;
  } catch {
    return false;
  }
}

/** Random hex id from the platform CSPRNG. */
export function randomHex(bytes: number): `0x${string}` {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}
