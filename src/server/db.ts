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
  // v4 (private outputs): a per-job read secret (only its sha256 is kept; NULL = a job created before this change),
  // single-use sign-in nonces and wallet sessions (only the sha256 of the session id is kept). Additive only.
  `
  ALTER TABLE jobs ADD COLUMN read_secret_hash TEXT;
  CREATE TABLE auth_nonces (
    nonce      TEXT PRIMARY KEY,
    address    TEXT,                          -- the wallet that used it (NULL while unused)
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX auth_nonces_expires ON auth_nonces(expires_at);
  CREATE TABLE sessions (
    id_hash    TEXT PRIMARY KEY,              -- sha256 of the session id; the id itself exists only in the cookie
    address    TEXT NOT NULL,                 -- checksummed wallet
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_expires ON sessions(expires_at);
  `,
  // v5 (gpu): GPU allowlist classification (src/server/gpu-allowlist.ts) and the periodic challenge
  // (src/server/challenge.ts). Challenges live in their own table: never jobs, never paid, never in a payout tree.
  `
  ALTER TABLE nodes ADD COLUMN family TEXT;                                -- allowlist family; NULL = not classified yet
  ALTER TABLE nodes ADD COLUMN gpu_status TEXT;                            -- eligible | untested | blocked (allowlist)
  ALTER TABLE nodes ADD COLUMN device_info TEXT;                           -- JSON, self-reported device info (0.3.0+)
  ALTER TABLE nodes ADD COLUMN challenge_cap INTEGER NOT NULL DEFAULT 0;   -- 1 = node advertised "challenge-1"
  ALTER TABLE nodes ADD COLUMN challenge_state TEXT;                       -- pending-challenge | eligible | cooldown | suspended
  ALTER TABLE nodes ADD COLUMN challenge_fails INTEGER NOT NULL DEFAULT 0; -- consecutive failed challenges
  ALTER TABLE nodes ADD COLUMN challenge_due_at INTEGER;                   -- next challenge at or after (NULL = now)
  ALTER TABLE nodes ADD COLUMN cooldown_until INTEGER;
  ALTER TABLE nodes ADD COLUMN allow_until INTEGER;                        -- operator temporary allow (challenge gate only)
  CREATE TABLE challenges (
    id            TEXT PRIMARY KEY,           -- bytes32 hex
    node_key      TEXT NOT NULL,
    owner         TEXT NOT NULL,
    backend       TEXT NOT NULL,
    dev           INTEGER NOT NULL DEFAULT 0,
    suite         INTEGER NOT NULL,           -- BENCH_SUITE of the reference
    case_id       TEXT NOT NULL,
    kind          TEXT NOT NULL,              -- image | text
    spec          TEXT NOT NULL,              -- JSON JobSpec (a public bench case, no private prompt)
    expected      TEXT NOT NULL,              -- JSON array of the reference fingerprints at issue time
    mode          TEXT NOT NULL,              -- observe | enforce (CHALLENGE_MODE when issued)
    status        TEXT NOT NULL,              -- issued | passed | failed | expired
    issued_at     INTEGER NOT NULL,
    lease_expires INTEGER NOT NULL,
    answered_at   INTEGER,
    output_hash   TEXT,
    fingerprint   TEXT,
    detail        TEXT                        -- JSON: distance to each reference fingerprint, state before / after
  );
  CREATE INDEX challenges_node ON challenges(node_key, status);
  CREATE TABLE gpu_admin_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    action    TEXT NOT NULL,                  -- reissue | allow | revoke-allow
    node_key  TEXT NOT NULL,
    detail    TEXT NOT NULL,                  -- JSON: challenge state before / after
    note      TEXT
  );
  `,
  // agent-api (API keys, OpenAI-compatible API, MCP; src/server/apikeys.ts, src/server/openai.ts). Additive only.
  // A key is `sck_<key_id>_<secret>`: only sha256(full key) is stored, never the secret. A key spends from its owner's
  // prepaid balance after one link signature (EIP-191) and within its daily cap (UTC day). api_key_spend counts the
  // price of the key's jobs per UTC day; jobs.api_key_held = 1 while that price still counts (set back to 0 and taken
  // off the counter when the job ends disagreed / expired / rejected). api_requests maps an OpenAI-style or MCP create
  // call to its job (Idempotency-Key, the image response format chosen at create).
  `
  CREATE TABLE api_keys (
    key_id          TEXT PRIMARY KEY,           -- 16 hex chars (8 random bytes), shown in the UI
    owner           TEXT NOT NULL,              -- checksummed wallet the key spends from
    label           TEXT NOT NULL DEFAULT '',
    key_hash        TEXT NOT NULL,              -- sha256(full key), hex; the secret itself is never stored
    daily_cap_wei   TEXT NOT NULL,              -- wei per UTC day, decimal string
    status          TEXT NOT NULL CHECK (status IN ('pending','active','disabled','deleted')),
    link_message    TEXT,                       -- the EIP-191 message the wallet signed (or is asked to sign)
    link_signature  TEXT,
    link_issued     INTEGER,                    -- unix seconds in the link message
    created_at      INTEGER NOT NULL,
    activated_at    INTEGER,
    last_used_at    INTEGER,
    disabled_at     INTEGER
  );
  CREATE INDEX api_keys_owner ON api_keys(owner, status);
  CREATE TABLE api_key_spend (
    key_id    TEXT NOT NULL,
    day       TEXT NOT NULL,                    -- UTC day, YYYY-MM-DD
    held_wei  TEXT NOT NULL,                    -- decimal string
    PRIMARY KEY (key_id, day)
  );
  ALTER TABLE jobs ADD COLUMN api_key_id TEXT;
  ALTER TABLE jobs ADD COLUMN api_key_held INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX jobs_api_key ON jobs(api_key_id, status) WHERE api_key_id IS NOT NULL;
  CREATE INDEX jobs_api_key_held ON jobs(api_key_held) WHERE api_key_held = 1;
  CREATE TABLE api_requests (
    job_id           TEXT PRIMARY KEY,
    key_id           TEXT NOT NULL,
    surface          TEXT NOT NULL,             -- chat | images | mcp
    idempotency_key  TEXT,                      -- Idempotency-Key header (NULL = none sent)
    body_hash        TEXT NOT NULL,             -- sha256 of the request body
    response_format  TEXT,                      -- images: b64_json | url
    created_at       INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX api_requests_idem ON api_requests(key_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
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
