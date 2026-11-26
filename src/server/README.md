# Sparecycle scheduler — operator notes

The scheduler is part of this Next.js app: route handlers under `src/app/api/v1/**`, logic in `src/server/**`,
state in one SQLite file. It assigns jobs to nodes, compares the two results of every job, closes epochs, publishes
the payout Merkle tree and posts its root to the reward contract.

**Trust model (MVP): the scheduler is centralized.** It decides who gets jobs, which results agree, and what tree
is posted. The reward contract bounds the damage: a root can reserve at most the epoch's pot, claims can never
exceed `reserved`, there is no withdraw of the pot and no second post. Say so wherever roots or payouts are shown.

## Hosting

- **Always-on Node.js process** (`next start`, Node 24 for `node:sqlite`). Not serverless: node polls hold the
  request open for a few seconds, the autoclose timer lives in the process, and SQLite needs a real file.
- **Exactly one replica.** All state is in SQLite and a second replica would double-assign tasks and double-close
  epochs.
- **SQLite on a persistent volume**: `DB_PATH` (default `./data/sparecycle.db`, WAL mode, migrations run on boot).
  Back it up with `sqlite3 "$DB_PATH" ".backup backup.db"` (not a plain copy while it runs).
- One DB serves one epoch clock. Switching from the local clock to a reward contract (or to a new contract)
  needs a fresh `DB_PATH`; the scheduler refuses a mismatched DB (`db-clock-mismatch`).
- Restart-safe: leases, results, verdicts, epochs and leaves are all in the DB. A crash while a root post is in
  flight is reconciled on the next start (the on-chain root is compared with the stored tree).

## Environment

| Variable | Secret | Default | Meaning |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_NETWORK` | | `mainnet` | `mainnet` (4663) / `testnet` / `local` (anvil) |
| `NEXT_PUBLIC_RPC_URL` | | chain default | RPC for reads and the root post |
| `NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS` | | unset | Reward contract. Unset = scheduler-local epochs, no pot, nothing posted |
| `NEXT_PUBLIC_EPOCH_LENGTH` | | `21600` | Local clock only; with a contract the contract's `epochLength()` rules |
| `DB_PATH` | | `./data/sparecycle.db` | SQLite file |
| `SCHEDULER_SIGNER_KEY` | **yes** | unset | Key of the contract's `scheduler()`; posts roots. Never logged |
| `SCHEDULER_ADMIN_TOKEN` | **yes** | unset | Bearer token for `POST /api/v1/epochs/close` and `/api/v1/admin/challenges`. Unset = endpoints disabled (503) |
| `SCHEDULER_AUTOCLOSE` | | unset | `1` = check every 15 s and close / retry the post when the chain allows |
| `SCHEDULER_ALLOW_DEV_RUNNER` | | unset | `1` = accept `--dev-runner` nodes. **Local tests only, never in production** |
| `PAYOUT_CAP_PER_UNIT` | | unset | Optional cap, wei of the payout asset per work unit |
| `PROJECT_NODE_OWNERS` | | unset | Owner wallets of project-run nodes: never paid (their share stays in the pot), marked on the status page |
| `GPU_ALLOWLIST_MODE` | | `observe` | GPU allowlist (`gpu-allowlist.json`): `observe` = classify, log and store, block nothing; `enforce` = blocked families get 403 `gpu-not-supported`, untested families register but get no jobs |
| `CHALLENGE_MODE` | | `off` | Periodic GPU challenge: `off`; `observe` = issue and record, never change eligibility; `enforce` = pending-challenge → eligible on a pass, fail → cooldown, second fail → suspended |
| `CHALLENGE_INTERVAL_HOURS` | | `24` | Hours between challenges of a node that passed (fractions allowed) |
| `CHALLENGE_COOLDOWN_HOURS` | | `6` | Hours without jobs after a failed challenge, before the next one (fractions allowed) |
| `VAST_API_KEY` | secret | unset | Bootstrap GPU pool (gpu-pool.ts): Vast.ai key used to start and stop the pool instances |
| `GPU_POOL_INSTANCE_IDS` | | unset | Vast instance ids of the pool, comma-separated (two, linked to two different owners). Optional owner group per entry, `id:a,id:b,id:b`, to add a spare machine for an owner: a start counts when machines of two groups come up |
| `GPU_POOL_ALWAYS_ON` | | unset | Pool instance ids that are never stopped (also listed in `GPU_POOL_INSTANCE_IDS`). Their owner group then needs no spare started: a start brings up only the other owner's machine. A declined start of one that is already running still counts |
| `GPU_POOL_IDLE_MINUTES` | | 10 | Pool instances stop after this many minutes without open jobs |
| `JOB_RATE_LIMIT` | | `5` | Accepted job submissions per IP per hour (`0` closes submissions) |
| `OUTPUT_AUTH` | | `off` | `enforce` = an output is served only to the job's read secret or a session of the paying wallet; the old `/output` URL answers 410. `off` = served to anyone (still `private, no-store`). See `docs/private-outputs.md` |
| `OUTPUT_RATE_LIMIT` | | `600` | Output reads per viewer per hour (per job for a read secret, per wallet for a session, else per IP) |
| `AUTH_DOMAIN` | | unset | Domain(s) a sign-in message may name, comma-separated (e.g. `sparecycle.tech`). Unset = the host the request was sent to |
| `SWEEP_SIGNER_KEY` | **yes** | unset | Sweep bot key (only for `--send`) |
| `SWEEP_ENABLED` | | unset | `0` = kill switch: the sweep bot refuses `--send` |
| `SWEEP_POOL_ID` | | unset | Uniswap v4 pool id after graduation (hook fee checks) |
| `EPOCH_POST_GAS_COST` | | — | `[EPOCH_POST_GAS_COST]`: a measured number, not computed. Measure the gas of real `closeEpochAndPostRoot` transactions on the target chain before quoting a cost |

`NEXT_PUBLIC_*` values are inlined by `next build` (server code included): set them before building and rebuild
after changing them. Server-only variables (`DB_PATH`, `SCHEDULER_*`, `PAYOUT_CAP_PER_UNIT`, `JOB_RATE_LIMIT`, `OUTPUT_*`,
`AUTH_DOMAIN`) are read at runtime.

Rate limiting uses the first `x-forwarded-for` hop, so the host's proxy must overwrite that header (mainstream
PaaS proxies do). IPs are stored only as salted hashes.

## Epochs and roots

- **Clock.** With a reward contract, epoch ids and start times are the contract's (`currentEpoch`, `getEpoch`,
  `epochLength`). Without one, a scheduler-local clock runs (`status.epoch.clock = "scheduler-local"`, note
  "scheduler-local epoch, contract not configured").
- **Which epoch pays a job.** The epoch that is open when the job's two results agree.
- **Close** (`npm run scheduler:close`, `POST /api/v1/epochs/close` with `Authorization: Bearer
  $SCHEDULER_ADMIN_TOKEN`, or the autoclose timer): requires `canClose(id)` on-chain (local clock: start + length
  passed); reads the pot as `getEpoch(id).pot + unaccounted()` (the contract `sync()`s inside the close); allocates;
  builds the tree; stores the leaves; opens the next epoch; then sends `closeEpochAndPostRoot(id, root, reserved)`
  from `SCHEDULER_SIGNER_KEY` (simulated first, receipt awaited, tx hash stored).
- **Payout rule.** An epoch's agreed jobs share the pot pro rata by work units (computed by the scheduler from the
  spec, never reported by nodes); each job's two agreeing nodes split its units equally; shares are summed per
  owner wallet (one leaf per wallet); amounts are floored so Σ ≤ pot; optional `PAYOUT_CAP_PER_UNIT`; the rest
  rolls over on-chain. An epoch with no agreed jobs posts `root = 0x00…00`, `reserved = 0`.
- **Failures.** If the post fails (RPC, gas, signer is not `scheduler()`), the epoch stays `closed-unposted` with
  `postError`; the next close call (or autoclose tick) retries the same root before anything else. Without
  `SCHEDULER_SIGNER_KEY` the tree is still published and the status says so; the operator can post the published
  root manually from the scheduler key, and the scheduler marks the epoch `posted` once it sees it on-chain.
- **No correction.** The contract has no second post: a wrong root is final for that epoch (bounded by its pot).
- Leaf = `keccak256(abi.encodePacked(uint64 epochId, address account, uint256 amount))`; sorted-pair tree
  (`src/lib/merkle.ts`, matches OpenZeppelin `MerkleProof`).

## Jobs and checks

- Only `sd15` (Stable Diffusion 1.5) and `qwen2.5-1.5b` (Qwen2.5-1.5B-Instruct GGUF) — `src/lib/protocol.ts`.
- Each job gets two tasks for two nodes with distinct node keys, owner wallets **and** GPU UUIDs, the model's
  capability and enough VRAM. Leases last 10 minutes, then the task is reassigned. Jobs without a verdict after
  6 hours expire.
- **Backends, like-for-like.** Nodes register a `backend` (`cuda` default, `vulkan`, `cpu`). A job's two tasks always
  go to the same backend, and dev-runner nodes pair only with dev-runner nodes. SD 1.5 is CUDA-only, enforced both
  at registration (`caps` must fit the backend) and at assignment. A job's first task is handed out only when a
  compatible peer (same backend, other owner, other GPU, capable, polled within 2 minutes) exists, so a lone node
  can't strand a job. Why this matters, measured with `node scripts/e2e-backends.mjs` on a Ryzen 7 5700U (Vega iGPU),
  Qwen2.5-1.5B, 128 tokens, greedy:
  - two Vulkan nodes on the iGPU: 6/6 agreed, byte-identical; about 13 tok/s each (about 27 tok/s alone);
  - CPU: about 33 tok/s;
  - Vulkan vs CPU on the same prompts: 0/6 identical, median similarity 0.65, 1/6 above the 0.9 threshold. Mixed pairs
    would mostly disagree.

  `GET /nodes` shows each node's `backend`; `GET /status` adds `nodes.byBackend.{cuda,vulkan,cpu}.{registered,online}`.
  Non-CUDA nodes report a quarter of system RAM (max 4096 MB) as `vramMb` and have no busy/hot pause.
- **GPU gate** ([docs/gpu-support.md](../../docs/gpu-support.md)). Registration classifies the device against
  `gpu-allowlist.json` (family + `allowed` / `untested` / `blocked`); with `GPU_ALLOWLIST_MODE=enforce` blocked
  families get `403 gpu-not-supported` and untested families get no job tasks. With `CHALLENGE_MODE=enforce`, nodes
  that advertise the `challenge-1` feature (node client 0.3.0+) on a backend with a reference
  (`bench/reference/suite-1-cuda.json`) must pass a challenge (a fixed bench case compared with the reference
  fingerprints at the live thresholds) before they get jobs, and again every `CHALLENGE_INTERVAL_HOURS`; a fail means
  `CHALLENGE_COOLDOWN_HOURS` without jobs, a second consecutive fail suspends the node (re-qualify via
  `/api/v1/admin/challenges`, audit-logged). Ineligible nodes are not counted as the "compatible peer" either.
  Challenges are unpaid and stored apart from jobs. `GET /nodes` adds `gpuFamily`, `gpuStatus`, `challengeState`;
  `GET /status` adds `gpuGate`.
- **Idle Guard** (node client 0.4.0+). `POST nodes/heartbeat` `{ state, since }` stores the node's own state in
  `nodes.state` / `nodes.state_since` (active | paused-busy | paused-hot | paused-hours; NULL = never reported =
  active) and refreshes `last_seen`, so a paused node stays online. A paused node gets no job, no challenge and no
  held lease back, and is not counted as the compatible peer. Registering clears the state. `GET /nodes` adds
  `state` (or `offline`) but never `state_since`. Kept apart from `gpu_status` / `challenge_state`, which are the
  scheduler's verdicts.
- A result is accepted only from the leased node, with a valid EIP-712 receipt (domain `Sparecycle` v1, target
  chain id) and an `outputHash` the scheduler recomputes from the submitted PNG / text. Images are compared by
  64-bit dHash (≤ 12 bits apart), text by normalized edit-distance similarity (≥ 0.9).
- Verdicts: `agreed` (one output kept, served at `/api/v1/jobs/:id/result`), `disagreed` (unpaid), `rejected`
  (a node's SD 1.5 safety checker flagged the image; unpaid, no output), `expired`. The per-node copies of the output
  (`results.output`) are dropped at the verdict and when a job expires; hashes and fingerprints stay for audit.
- **Re-check rounds** (`src/server/rounds.ts`, feature brief #9, D16 / D17). Paid and team jobs only; free trial jobs
  get one round. `jobs.round` (0 = the first pair), `MAX_ROUNDS = 3`, `PICKUP_TIMEOUT = 1800 s`; a round lasts at
  most `PICKUP_TIMEOUT + taskLeaseSeconds = 2400 s` from its first lease (`jobs.round_started_at`).
  - A new round also needs a pair that could take it (`pairForNextRound`): among the REGISTERED nodes, online or not
    (a stopped pool machine counts), two with different owners and different GPUs on the same backend, with the job's
    capability and VRAM, the dev flag of the job's round (dev nodes only for a dev job), tryLease's GPU gate
    (`eligibleSql`), and no node key, owner or GPU from this or an earlier round. Without one, a mismatch is final at
    once (`disagreed`, not charged, exactly as before re-checks) and a stuck round is not abandoned.
  - A `disagreed` verdict with `round + 1 < MAX_ROUNDS`, at least 2400 s of the 6 h TTL left and such a pair sends the
    job back to `queued` with `round + 1` and two new tasks (slots `2 × round` and `2 × round + 1`); the round's tasks and results
    stay (`tasks.round`, `results.round`). `submitResult` compares only the current round's two results, and answers
    the node `{ status: "queued", verdict: "disagreed", round }`.
  - A round with a first lease and no verdict 2400 s later is abandoned (its open and leased tasks cancelled, a late
    result gets `409 not-your-task`) and the next round starts, under the same limits; checked in `expireStaleJobs()`,
    which runs on every poll and job read. A round never leased (no compatible pair online) waits and uses up nothing.
    When no further round is allowed (last round, a free job, less than 2400 s of the TTL left, or no registered pair),
    a stuck round is not abandoned and keeps running; `expireStaleJobs()` stays the hard stop at 6 h, whatever the round. `rejected` is
    never retried.
  - Exclusion in `tryLease`: a node whose node key, owner wallet or GPU UUID held a lease (`job_leases`, every lease is
    logged, also one left to expire) or sent a result in an earlier round of the job gets no task of a later round and
    does not count as the "compatible peer" for its first task. The two tasks of a round follow every other rule
    (distinct node / owner / GPU, same backend, dev with dev, GPU gate, Idle Guard).
  - Payouts and stats use only the final round: `agreedJobsOf` (epoch allocation), `nodes.agreed_jobs` and
    `epochAgreedJobs` count the two results with `results.round = jobs.round`. Nodes of a failed round get nothing for it.
  - `job_rounds` logs, per node, each round that ended `disagreed` (also a final one and a free job's) or `abandoned`,
    for the GPU challenge / suspension logic later; nothing reads it yet.
  - The payer: public job views carry `round` and `maxRounds` (no node identities), the invoice too; the price stays
    held (`heldFor`) until a final verdict, and is charged only after a final `agreed`. The dapp shows "Re-checking on
    another pair (round N of 3)".
- Prompts stay in the DB and are never returned; public views carry `promptHash =
  sha256("sparecycle-prompt|" + jobId + "|" + prompt)`.
- **Private outputs** (`docs/private-outputs.md`). Every job gets a read secret, returned once by `POST /jobs`
  (`readSecret`; only its sha256 is stored). With `OUTPUT_AUTH=enforce` an output is served only to
  `Authorization: Bearer <readSecret>` or to a wallet session (EIP-4361 sign-in, cookie `sc_session`) of the job's
  payer (paid and team jobs). Job ids are public (`GET /api/v1/jobs`), so knowing one is not enough. Node request
  signatures are never accepted as credentials, and a node only receives a job's spec while the job is queued,
  running or checking. With `OUTPUT_AUTH=off` (the default until switched) outputs are served to anyone, but always
  with `Cache-Control: private, no-store`. The two nodes of a job still see its prompt and output while they work.
- **Invoices** (`src/server/invoices.ts`, `GET /api/v1/jobs/:id/invoice`). Price, 5% protocol cut (a rounded share:
  the contract takes 5% of each epoch's charged batch), the 95% to the node pot, verdict, charge status, the output
  hash (`jobs.output_hash`, the sha256 of the kept output, stored at the verdict; never the file), the verdict epoch,
  the charged epoch and the charge / root transactions. Only for a session of the wallet that paid (team jobs: the
  team wallet that paid) or the job's read secret, whatever `OUTPUT_AUTH` says: 401 without credentials, 403 for
  others, 404 for an unknown id. A free job answers a "free trial, no charge" stub. Public job views carry only
  `payment` (free / paid / team), never the price, the charge status, the payer or the hash (D7). A job that settles
  without agreement shows `released` (not charged) at once; the stored status follows at the next epoch close.
- Node requests are signed: headers `x-sc-from`, `x-sc-ts`, `x-sc-sig` = EIP-191 signature of
  `sparecycle|METHOD|PATH|TS|sha256(body)`, 60 s window, each signature accepted once.
- Distinct owner / GPU checks rely on what nodes report (GPU UUIDs can be faked); a determined operator with
  several wallets can still run both copies of a job. That is a known limit of the centralized MVP.

## Endpoints (`/api/v1`)

Public: `GET health`, `GET status`, `GET epochs`, `GET epochs/:id/tree`, `GET epochs/:id/proof?account=`,
`GET jobs?limit=`, `POST jobs`, `GET jobs/:id`, `GET nodes`.
Viewer-dependent (always `Cache-Control: private, no-store`, `Vary: Authorization, Cookie`): `GET jobs/:id`,
`GET jobs/:id/result` (read secret or payer session when `OUTPUT_AUTH=enforce`), `GET jobs/:id/output` (retired: 410
when enforced), `GET jobs/:id/invoice` (the private invoice, above), `GET auth/nonce`, `POST auth/verify`,
`POST auth/logout`.
Nodes (signed): `POST nodes/register`, `POST nodes/poll`, `POST nodes/heartbeat`, `POST tasks/:taskId/result`.
Operator: `POST epochs/close`. Errors are always `{ "error": "<kebab-code>", "message": "…" }`. Shapes:
`docs/SPEC.md`. Amounts are decimal strings (wei), timestamps unix seconds.

## Sweep / claim bot

`npm run sweep` (dry-run report) · `npm run sweep -- --send` · `npm run sweep -- --send --interval 300` ·
`npm run sweep -- --self-check` (offline selector check).

Dry-run is the default: reads and `eth_call` simulations only. `--send` transacts from `SWEEP_SIGNER_KEY`; every
call it makes is permissionless, so that key only needs gas. The pre-graduation path was verified on a Robinhood
Chain mainnet fork (`contracts/test/fork/PonsEscrowFork.t.sol`, `contracts/README.md`); the selectors it uses come
from that test (deployed bytecode, not the Pons docs) and `--self-check` asserts them.

1. **Pre-graduation (verified on a fork).** Reads `quoteFeeBalance()` / `creatorTaxBalance()` on the curve. When
   either is non-zero, it reads the Pons fee-sweep operator live from `hook.feeSweepOperator()` (never hardcoded)
   and calls `operator.sweepCurve(curve)`, which credits the creator share to the recipient in the fee escrow.
   The curve's own `sweepFees(uint256)` is **not** used: it reverts `NotFeeSweepOperator()` for everyone except
   the `creatorFeeRecipient` (the reward contract, which has no sweep function) and the operator. On the fork
   `sweepCurve` was callable by any address; if Pons restricts it (trusted sweepers, pause, base-fee limits), the
   revert is reported as an `ALERT` with its decoded name or raw selector and the fees stay on the curve until
   the creatorFeeRecipient or the Pons operator sweeps.
2. **Post-graduation (UNVERIFIED, not exercised on a fork).** `pendingFees` / `pendingCreatorTax` on the Pons hook for
   `SWEEP_POOL_ID`, then `hook.sweepPoolFees(poolId, 0, 0)`; without a pool id it alerts "poolId not set". Re-check
   this path on a fork before relying on it.
3. **Escrow → pot.** If the reward contract is the creator fee recipient, the bot reads `escrow.balanceOf(reward)`
   (ETH) / `balanceOfToken(reward, payoutToken)` (ERC-20) first. Zero → it logs the skip (the real escrow reverts
   `NoBalance()` on an empty claim; the contract also pre-checks and returns 0). Non-zero →
   `claimFeesFromEscrow()` / `claimFeesFromEscrowToken()` (permissionless) and the pot grows. If the multisig is
   the recipient (fallback): an `ALERT` with the amount the multisig must claim from the escrow and forward with
   `fund()` / `fundToken()`.

It never skips silently. With nothing configured it prints "not configured" and exits 0; alerts (human action
needed) keep exit 0, a run with errors (RPC, unexpected reverts) exits 1.

## End-to-end tests

- `npm run e2e:local` (`scripts/e2e-local.mjs`): anvil (8548), reward contract + mock escrow, test ETH, the sweep bot
  against mocks of the fork-observed curve / operator / hook (paused operator → alert, dry-run, then `--send` from a
  key anvil has NOT unlocked: `sweepCurve` → `claimFeesFromEscrow`), `next dev` (3210) from a throw-away copy of the
  app, two `--dev-runner` nodes, jobs, close, both claims with exact balance checks, restart + autoclose. No GPU, no
  real funds; it stops everything it started.
  With `OUTPUT_AUTH=enforce` after the restart it also runs the private-output route matrix (401/403/404/409/200, read
  secrets, EOA and ERC-1271 wallet sign-in, old `/output` -> 410) and checks that no `/api/v1/jobs/*` response
  carried a `public` cache directive.
- `npm run test:private-outputs` (`scripts/test-private-outputs.mjs`): in-process route and unit tests of private
  outputs (no chain, no GPU, scratch DB under `data/`): the enforce matrix, sign-in (nonce reuse, domain, chain,
  forged signature, expired session, logout), team wallets, legacy jobs, the rate limit and node isolation.
- `node scripts/e2e-backends.mjs`: real hardware, no chain. Two `--backend vulkan` nodes on the local GPU, the
  like-for-like pairing checks with CUDA dev-runner nodes, and Vulkan-vs-CPU similarity. Needs
  `node-client/bin/llama-vulkan`, `node-client/bin/llama-cpu` and the GGUF.
- `node scripts/e2e-testnet.mjs [--real-text] [--fresh]`: Robinhood Chain testnet (46630) with the mock escrow and real
  testnet ETH.
  - **Keys:** the encrypted keystores in `.keys/` are decrypted in memory and never printed, logged or written.
  - **Unfunded deployer:** the script prints funding instructions and exits 0 without sending anything.
  - **Resume:** it reuses the 46630 deployment in `src/contracts/deployments.json` and only tops up what is missing.
  - **Amounts:** set by flags (`--owner-gas`, `--fund`, `--escrow-credit`, `--threshold`, `--gas-reserve`).
  - **Output:** every tx with an explorer link, the ETH spent and the L1 data fee.
