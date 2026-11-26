// SQLite storage of the scheduler (Node's built-in node:sqlite). All scheduler state lives here, so a restart
// loses nothing: nodes, jobs, tasks, results, epochs, payout leaves, charge (jobs-tree) leaves, rate limits and seen
// request signatures.
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
    slot          INTEGER NOT NULL,           -- 0 or 1: each job runs on two distinct nodes (v9: 2 x round + 0 or 1)
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
  // v6 (billing invoice, feature brief #4): the sha256 of
  // the agreed output that is kept for the submitter, stored at the verdict for the payer's private invoice
  // (GET /api/v1/jobs/:id/invoice). Older agreed jobs: filled from the result whose output was kept (the first one
  // received, ties by task id, exactly as submitResult picks it). Additive only.
  `
  ALTER TABLE jobs ADD COLUMN output_hash TEXT;
  UPDATE jobs SET output_hash = (
    SELECT r.output_hash FROM results r WHERE r.job_id = jobs.id ORDER BY r.received_at, r.task_id LIMIT 1
  ) WHERE status = 'agreed' AND output IS NOT NULL;
  `,
  // v7 (idle guard): the state a node reports about its own machine (node client 0.4.0+, POST /nodes/heartbeat):
  // active | paused-busy | paused-hot | paused-hours. NULL = nothing reported since the last registration (older
  // clients), treated as active. Separate from the scheduler's verdicts (gpu_status, challenge_state). state_since
  // (unix seconds) is never in a public response. Additive only.
  `
  ALTER TABLE nodes ADD COLUMN state TEXT;
  ALTER TABLE nodes ADD COLUMN state_since INTEGER;
  `,
  // v8 (agent API: API keys, OpenAI-compatible API, MCP; src/server/apikeys.ts, src/server/openai.ts). Additive only.
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
  // v9 (re-check rounds, feature brief #9; src/server/rounds.ts). Self-contained and additive only.
  // A paid or team job whose results do not match, or whose round gets no verdict within PICKUP_TIMEOUT + one task lease
  // of its first lease, runs again on another pair: jobs.round counts up (0 = the first pair, at most MAX_ROUNDS - 1),
  // two new tasks are inserted with slots 2 x round and 2 x round + 1 (so UNIQUE (job_id, slot) still holds), and the
  // earlier round's tasks and results stay for audit. jobs.round_started_at = the current round's first lease (NULL =
  // not leased yet; such a round is never abandoned). Every lease is logged in job_leases, so a node that held a lease
  // and let it expire is still known when a later round excludes the nodes of earlier rounds. job_rounds records, per
  // node, each round that ended without agreement (disagreed | abandoned), as input for GPU suspension later; nothing
  // reads it for suspension yet. Existing rows: round 0; running jobs get round_started_at from their earliest lease,
  // and the current holders of open jobs' tasks are copied into job_leases.
  `
  ALTER TABLE jobs ADD COLUMN round INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE jobs ADD COLUMN round_started_at INTEGER;
  ALTER TABLE tasks ADD COLUMN round INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE results ADD COLUMN round INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX tasks_job_round ON tasks(job_id, round);
  CREATE INDEX results_job_round ON results(job_id, round);
  CREATE INDEX jobs_round_started ON jobs(round_started_at) WHERE round_started_at IS NOT NULL;
  UPDATE jobs SET round_started_at = (SELECT MIN(t.leased_at) FROM tasks t WHERE t.job_id = jobs.id)
    WHERE status IN ('running','checking');
  CREATE TABLE job_leases (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id    TEXT NOT NULL,
    round     INTEGER NOT NULL,
    task_id   TEXT NOT NULL,
    node_key  TEXT NOT NULL,
    owner     TEXT NOT NULL,
    gpu_uuid  TEXT NOT NULL,
    leased_at INTEGER NOT NULL
  );
  CREATE INDEX job_leases_job ON job_leases(job_id, round);
  INSERT INTO job_leases (job_id, round, task_id, node_key, owner, gpu_uuid, leased_at)
    SELECT t.job_id, 0, t.id, t.node_key, t.owner, t.gpu_uuid, COALESCE(t.leased_at, 0) FROM tasks t JOIN jobs j ON j.id = t.job_id
    WHERE j.status IN ('queued','running','checking') AND t.node_key IS NOT NULL AND t.owner IS NOT NULL AND t.gpu_uuid IS NOT NULL;
  CREATE TABLE job_rounds (
    job_id    TEXT NOT NULL,
    round     INTEGER NOT NULL,
    node_key  TEXT NOT NULL,
    owner     TEXT NOT NULL,
    gpu_uuid  TEXT NOT NULL,
    outcome   TEXT NOT NULL CHECK (outcome IN ('disagreed','abandoned')),
    at        INTEGER NOT NULL,
    PRIMARY KEY (job_id, round, node_key)
  );
  CREATE INDEX job_rounds_node ON job_rounds(node_key, at);
  `,
  // v10 (job receipts, feature brief #8 option B; src/lib/job-receipt.ts, src/server/receipts.ts). Additive only.
  // A charge now commits a Merkle root over every paid / team job that reached a final charge status (charged,
  // released, unpaid) and is not yet in a confirmed jobs root: that root is the listHash of the Charged event
  // (charges.hash_rule = 'v2-jobs-merkle'). Charges stored before this keep 'v1' (listHash = keccak256 of the JSON
  // list) and are served unchanged. charge_leaves holds each charge's leaves (like payouts for the payout tree) with
  // each leaf's random salt: the salt goes only into the payer's receipt, never into a public answer, so a published
  // leaf cannot be recomputed from public data. jobs.receipt_epoch is the epoch whose confirmed charge holds the job's
  // leaf (NULL = not yet in a confirmed root).
  `
  ALTER TABLE charges ADD COLUMN hash_rule TEXT NOT NULL DEFAULT 'v1';
  ALTER TABLE jobs ADD COLUMN receipt_epoch INTEGER;
  CREATE TABLE charge_leaves (
    epoch_id      INTEGER NOT NULL,           -- the charge epoch: the leaf's epochId and the Charged event's epochId
    job_id        TEXT NOT NULL,
    payer         TEXT NOT NULL,              -- checksummed wallet
    price_wei     TEXT NOT NULL,              -- decimal string
    verdict       TEXT NOT NULL,              -- agreed | disagreed | expired | rejected (uint8 code: src/lib/job-receipt.ts)
    charge_status TEXT NOT NULL,              -- charged | released | unpaid
    output_hash   TEXT,                       -- NULL = 0x00…00 in the leaf
    salt          TEXT NOT NULL,              -- 32 random bytes (hex) in the leaf; private: payer's receipt only
    leaf          TEXT NOT NULL,
    PRIMARY KEY (epoch_id, job_id)
  );
  CREATE INDEX charge_leaves_job ON charge_leaves(job_id);
  CREATE INDEX jobs_receipt_open ON jobs(charge_status) WHERE payer IS NOT NULL AND receipt_epoch IS NULL;
  `,
  // v11 (token features, docs/token-features.md: src/server/burns.ts, holders.ts, slashing.ts and the stake gate in
  // ./nodes). Self-contained and additive only: new tables, nothing existing changes. Every table stays empty while the
  // TOKEN_* flags are off (the default). Amounts are wei as decimal strings. Nothing here is ever signed or sent: the
  // safe_tx / *_call / fund_safe_tx columns hold UNSIGNED payloads for the Safe signers or the scheduler key.
  //   token_burn_plans     one row per charged epoch: the burn share (N1), the carry-over, the cap (N12) from the pool
  //                        read, and the unsigned Safe transaction that would buy and burn (phase 2a). status:
  //                        prepared | incomplete (missing names what is not live) | nothing-due | carried (the cap allowed
  //                        no buy) | executed | expired.
  //   token_holder_*       the SPARE ledger (wallet and staked balance per address, up to meta token_holder_block),
  //                        ModeSet history, and per epoch the time-weighted weights, leaves and the prepared root.
  //   token_slash_*        per-node faults from re-check rounds, and slash proposals with their public evidence bundle
  //                        (exactly the bytes hashed into evidence_hash).
  //   token_stake_reads    the stake gate's last stakedOf / minStakePerNode read per owner wallet, per epoch.
  `
  CREATE TABLE token_burn_plans (
    epoch_id        INTEGER PRIMARY KEY,      -- the charged epoch (the Charged event's epochId)
    charge_tx       TEXT,                     -- the charge transaction the share was read from
    to_treasury_wei TEXT NOT NULL,            -- Charged.toTreasury, read from that transaction's log
    share_wei       TEXT NOT NULL,            -- burn share: toTreasury x 150 / 500 (N1)
    carry_in_wei    TEXT NOT NULL,            -- carried over from earlier plans (cap, incomplete or expired)
    due_wei         TEXT NOT NULL,            -- share + carry in
    cap_wei         TEXT,                     -- N12 cap from the pool read (NULL = no pool read)
    buy_wei         TEXT NOT NULL,            -- ETH the prepared transaction spends (0 = nothing prepared)
    carry_out_wei   TEXT NOT NULL,            -- due - buy: carried into the next plan
    min_out_wei     TEXT,                     -- SPARE minOut of the swap (N12 slippage)
    pool_read       TEXT,                     -- JSON: sqrtPriceX96, liquidity, lpFee, block of the price read
    method          TEXT NOT NULL,            -- dead | burn (BURN_METHOD)
    status          TEXT NOT NULL,            -- prepared | incomplete | nothing-due | carried | executed | expired
    missing         TEXT,                     -- JSON array: what an incomplete plan lacks
    safe_tx         TEXT,                     -- JSON: the unsigned SafeTx and a Safe Transaction Builder batch
    safe_tx_hash    TEXT,                     -- EIP-712 SafeTx hash at the nonce read (what 2 of 3 signers would sign)
    data_hash       TEXT,                     -- keccak256 of the SafeTx data (matches an executed transaction)
    deadline        INTEGER,                  -- router deadline: after it the swap reverts and the buy is carried over
    prepared_block  INTEGER,                  -- chain head when prepared (executions are searched from here)
    executed_tx     TEXT,                     -- the treasury Safe transaction that executed it (found on-chain)
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE token_holder_ledger (
    address    TEXT PRIMARY KEY,              -- lowercase
    wallet_wei TEXT NOT NULL,                 -- SPARE balance held in the wallet
    staked_wei TEXT NOT NULL                  -- SPARE the address staked in SparecycleNodeStake (counts as held, N15)
  );
  CREATE TABLE token_holder_modes (
    holder          TEXT NOT NULL,            -- lowercase
    mode            INTEGER NOT NULL,
    effective_epoch INTEGER NOT NULL,
    block           INTEGER NOT NULL,
    log_index       INTEGER NOT NULL,
    PRIMARY KEY (holder, block, log_index)
  );
  CREATE TABLE token_holder_roots (
    epoch_id        INTEGER PRIMARY KEY,
    status          TEXT NOT NULL,            -- prepared | incomplete | nothing-due (no charge in the epoch)
    missing         TEXT,                     -- JSON array: what an incomplete root lacks
    to_treasury_wei TEXT,                     -- Charged.toTreasury of the epoch (NULL = no charge)
    total_eth_wei   TEXT NOT NULL,            -- holder share (N1), the postRoot totalEth
    root            TEXT,
    leaves          INTEGER NOT NULL DEFAULT 0,
    total_weight    TEXT,                     -- sum of the eligible time-weighted balances
    from_block      INTEGER,
    to_block        INTEGER,
    post_call       TEXT,                     -- JSON: unsigned postRoot call for the scheduler key
    fund_safe_tx    TEXT,                     -- JSON: unsigned SafeTx sending totalEth to the pool (until V2)
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE token_holder_leaves (
    epoch_id        INTEGER NOT NULL,
    holder          TEXT NOT NULL,            -- checksummed
    mode            INTEGER NOT NULL,
    avg_balance_wei TEXT NOT NULL,            -- time-weighted average SPARE (wallet + staked) over the epoch
    amount_wei      TEXT NOT NULL,
    leaf            TEXT NOT NULL,
    PRIMARY KEY (epoch_id, holder)
  );
  CREATE TABLE token_slash_faults (
    job_id      TEXT NOT NULL,
    node_key    TEXT NOT NULL,
    owner       TEXT NOT NULL,
    task_id     TEXT NOT NULL,                -- the node's signed result (results.task_id)
    round       INTEGER NOT NULL,
    epoch_id    INTEGER NOT NULL,             -- the epoch of the job's agreed verdict
    proposal_id INTEGER,                      -- the proposal that used this fault (NULL = not used yet)
    at          INTEGER NOT NULL,
    PRIMARY KEY (job_id, node_key)
  );
  CREATE INDEX token_slash_faults_node ON token_slash_faults(node_key, epoch_id);
  CREATE TABLE token_slash_proposals (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner         TEXT NOT NULL,
    node_key      TEXT NOT NULL,
    from_epoch    INTEGER NOT NULL,
    to_epoch      INTEGER NOT NULL,
    faults        INTEGER NOT NULL,
    evidence_json TEXT NOT NULL,              -- the public bundle, exactly the bytes evidence_hash is taken over
    evidence_hash TEXT NOT NULL UNIQUE,       -- keccak256(utf8(evidence_json))
    stake_wei     TEXT,                       -- stakedOf(owner) when prepared (NULL = NodeStake not live)
    amount_wei    TEXT,                       -- stake x SLASH_BPS (N4)
    call_json     TEXT,                       -- JSON: unsigned proposeSlash call
    status        TEXT NOT NULL,              -- prepared | incomplete
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE token_stake_reads (
    owner            TEXT PRIMARY KEY,        -- lowercase owner wallet
    epoch_id         INTEGER NOT NULL,
    staked_wei       TEXT NOT NULL,
    min_per_node_wei TEXT NOT NULL,
    active_nodes     INTEGER NOT NULL,
    ok               INTEGER NOT NULL,        -- staked >= min x active nodes at the read
    read_at          INTEGER NOT NULL
  );
  `,
  // v12 (x402 pay-per-job, option X1; src/server/x402.ts, contracts/src/SparecycleX402Escrow.sol). Self-contained and
  // additive only; nothing writes these tables unless X402_ENABLED=1. One row per x402 payment: the job id is reserved
  // before the escrow is funded and the job row is inserted only once the escrow holds the payment (status 'held'). An
  // x402 job has jobs.payer = the payer, jobs.price_wei = NULL and jobs.charge_status = 'x402', so the prepaid-balance
  // charge path (src/server/payments.ts) never touches it. escrow_salt is private (payer's receipt only): the public
  // escrow events carry escrow_id = keccak256(abi.encode(job_id, escrow_salt)). x402_leaves / x402_roots: one salted
  // Merkle tree per epoch close over the escrows that reached an outcome (src/lib/x402.ts X402_LEAF_RULE).
  `
  CREATE TABLE x402_escrows (
    job_id          TEXT PRIMARY KEY,           -- the job this payment is for (the jobs row exists from 'held' on)
    escrow_id       TEXT NOT NULL UNIQUE,       -- the on-chain key
    escrow_salt     TEXT NOT NULL,              -- private
    payer           TEXT NOT NULL,              -- checksummed
    escrow          TEXT NOT NULL,              -- the escrow contract
    asset           TEXT NOT NULL,
    network         TEXT NOT NULL,              -- CAIP-2, e.g. eip155:4663
    amount          TEXT NOT NULL,              -- asset atomic units, decimal string
    auth_nonce      TEXT NOT NULL,              -- EIP-3009 nonce (one use per payer)
    valid_before    INTEGER NOT NULL,
    surface         TEXT NOT NULL,              -- chat | images
    body_hash       TEXT NOT NULL,              -- sha256 of the request body (replays of the same payment)
    response_format TEXT,                       -- images: b64_json | url
    status          TEXT NOT NULL CHECK (status IN ('funding','held','forwarding','forwarded','refunding','refunded','failed')),
    reason          TEXT,                       -- why it was forwarded / refunded: agreed | disagreed | expired | rejected | not-queued | deadline
    deadline        INTEGER,                    -- on-chain refund deadline
    fund_tx         TEXT,
    settle_tx       TEXT,
    error           TEXT,                       -- last error (never a secret)
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    settled_at      INTEGER,
    leaf_epoch      INTEGER                     -- the epoch whose x402 tree holds this escrow's leaf
  );
  CREATE UNIQUE INDEX x402_escrows_auth ON x402_escrows(payer, auth_nonce) WHERE status <> 'failed';
  CREATE UNIQUE INDEX x402_escrows_one_funding ON x402_escrows(payer) WHERE status = 'funding'; -- one funding in flight per payer
  CREATE INDEX x402_escrows_open ON x402_escrows(status) WHERE status IN ('funding','held','forwarding','refunding');
  CREATE INDEX x402_escrows_leaf ON x402_escrows(leaf_epoch, status);
  CREATE TABLE x402_leaves (
    epoch_id    INTEGER NOT NULL,
    job_id      TEXT NOT NULL,
    escrow_id   TEXT NOT NULL,
    payer       TEXT NOT NULL,
    asset       TEXT NOT NULL,
    amount      TEXT NOT NULL,
    verdict     TEXT NOT NULL,                  -- agreed | disagreed | expired | rejected | not-queued
    outcome     TEXT NOT NULL,                  -- forwarded | refunded
    output_hash TEXT,
    salt        TEXT NOT NULL,                  -- private: payer's receipt only
    leaf        TEXT NOT NULL,
    PRIMARY KEY (epoch_id, job_id)
  );
  CREATE INDEX x402_leaves_job ON x402_leaves(job_id);
  CREATE TABLE x402_roots (
    epoch_id   INTEGER PRIMARY KEY,
    root       TEXT NOT NULL,
    leaves     INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // v13 (SparecycleJobPaymentsV2 behind TOKEN_PAYMENTS_V2; src/server/payments-v2.ts, docs/contracts-v2.md). Additive
  // only; nothing writes the new columns or tables while the flag is off, and NULL means exactly what it meant before.
  //   jobs.pay_contract   the contract a paid job is charged on: NULL or 'v1' = SparecycleJobPayments, 'v2' = V2
  //   jobs.pay_asset      NULL or 'eth' = the ETH balance (V2: credits first, then deposits); 'spare' = the V2 SPARE balance
  //   jobs.spare_price    SPARE job: the accepted epoch price used at the charge (wei per 10^18 SPARE base units)
  //   jobs.spare_wei      SPARE job: SPARE taken for it at that price (ceil(price_wei x 10^18 / spare_price))
  //   jobs.pay_wait       SPARE job not charged at the last close, and why (customer-visible): no-reference | not-posted |
  //                       paused | cap | sale | spare-balance | spend-limit; NULL once charged or never deferred
  //   jobs.pay_waits      epoch closes the job has waited through (after SPARE_MAX_WAIT_EPOCHS it is marked unpaid)
  //   charge_leaves.contract  which contract's jobs root holds the leaf ('v1' for every leaf before this)
  //   v2_charges          V2's one charge per epoch (charge or chargeWithSpare), like `charges` for V1
  //   v2_spare_prices     V2's per-epoch SPARE price post (postSparePrice) and what the contract decided
  `
  ALTER TABLE jobs ADD COLUMN pay_contract TEXT;
  ALTER TABLE jobs ADD COLUMN pay_asset TEXT;
  ALTER TABLE jobs ADD COLUMN spare_price TEXT;
  ALTER TABLE jobs ADD COLUMN spare_wei TEXT;
  ALTER TABLE jobs ADD COLUMN pay_wait TEXT;
  ALTER TABLE jobs ADD COLUMN pay_waits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE charge_leaves ADD COLUMN contract TEXT NOT NULL DEFAULT 'v1';
  CREATE TABLE v2_charges (
    epoch_id       INTEGER PRIMARY KEY,
    list_json      TEXT NOT NULL,             -- the charged jobs: ETH entries and SPARE entries (asset, spareWei)
    list_hash      TEXT NOT NULL,             -- the jobs root (hash_rule v2-jobs-merkle), the Charged event's listHash
    total_wei      TEXT NOT NULL,             -- ETH leg (credits + deposits)
    spare_eth_wei  TEXT NOT NULL,             -- SPARE leg, ETH value of the jobs
    spare_wei      TEXT NOT NULL,             -- SPARE leg, SPARE debited
    spare_price    TEXT,                      -- the epoch's accepted price (NULL = no SPARE leg)
    min_eth_out    TEXT,                      -- the SPARE sale's minimum (NULL = no SPARE leg)
    method         TEXT NOT NULL,             -- charge | chargeWithSpare
    status         TEXT NOT NULL,             -- sending | done | failed
    tx             TEXT,
    error          TEXT,
    hash_rule      TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  );
  CREATE TABLE v2_spare_prices (
    epoch_id       INTEGER PRIMARY KEY,
    price          TEXT,                      -- posted price (NULL = not posted: see status)
    reference      TEXT,                      -- the contract's reference price at the post
    accepted       INTEGER,                   -- 1 = inside the deviation band (SPARE charges run this epoch)
    sqrt_price_x96 TEXT,                      -- the pool read the price came from
    block          INTEGER,
    status         TEXT NOT NULL,             -- sending | done | failed | skipped
    reason         TEXT,                      -- skipped / failed: why
    tx             TEXT,
    created_at     INTEGER NOT NULL
  );
  CREATE INDEX jobs_pay_contract ON jobs(pay_contract, charge_status) WHERE pay_contract IS NOT NULL;
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
