# Sparecycle — implementation spec (interfaces between parts)

Source: the original product brief (its rules win over this file).
Product: fee-funded idle-GPU job network on Robinhood Chain (EVM, Arbitrum Orbit, chain id 4663), token launched via Pons v2.
Never use the IdleX name/brand in UI, metadata or user-facing strings. MIT attribution for code derived from
https://github.com/idlexnetwork/idlex lives only in `NOTICE` / file headers.

## Hard rules (from the brief)
- No invented addresses, fees, volumes, node counts, tickers, URLs. Unset → `null` in `src/lib/config.ts` → UI shows "Not configured" / "Not deployed yet" / em dash.
- No team withdrawal of the pot, no mint, no setPot. Payouts ≤ pot, claimed ≤ reserved.
- No yield/APY/staking language. No holding requirement. Not an open marketplace (only SD 1.5 + one small text model).
- Scheduler is centralized in the MVP — say so wherever roots/payouts are shown.

## Shared modules (already written — import, don't duplicate)
- `src/lib/config.ts` — every env placeholder, parsed (`config.rewardContract`, `config.nodePayoutAsset`, …).
- `src/lib/chain.ts` — `targetChain` (robinhood 4663 / robinhoodTestnet 46630 / foundry 31337 by `NEXT_PUBLIC_NETWORK`), `publicClient`, explorer helpers.
- `src/lib/pons.ts` — verified Pons v2 addresses and ABI fragments.
- `src/contracts/sparecycleRewards.ts` — the reward contract ABI (interface contract; Solidity must match it exactly).

## Reward contract — `contracts/src/SparecycleRewards.sol`
Constructor: `(address admin, address scheduler, address payoutToken /* 0 = ETH */, address feeEscrow, uint64 epochLength)`.
Admin = `Ownable2Step` owner (intended: multisig). Epoch 0 starts at deploy.

Accounting (robust to 2300-gas ETH pushes from the Pons escrow):
- `receive()` is **empty** (accepts ETH, no storage writes). Arriving value is credited by `sync()`.
- `accounted` = sum of (open epoch pot) + Σ settled (reserved − claimed). `unaccounted()` = balance − accounted.
- `sync()` credits `unaccounted()` to the **current open** epoch pot, emits `PotFunded(epoch, address(0), amount)`.
- `fund()` payable (ETH mode only) / `fundToken(amount)` (ERC-20 mode only, transferFrom) credit the current epoch and emit `PotFunded(epoch, msg.sender, amount)`. Public on purpose; every inflow is an event with its sender.
- `claimFeesFromEscrow()` (ETH mode) calls `IPonsFeeEscrow(feeEscrow).claim()`, `claimFeesFromEscrowToken()` (ERC-20 mode) calls `claimToken(payoutToken)`; both then credit the balance delta, emit `FeesClaimedFromEscrow` + `PotFunded(epoch, feeEscrow, amount)`. Permissionless.
- `closeEpochAndPostRoot(epochId, root, reserved)` — only scheduler; `epochId == currentEpoch`; `block.timestamp >= startedAt + epochLength`; `sync()` first; `reserved <= pot`; `root == 0` only if `reserved == 0`. Sets root/reserved/settled/endedAt, emits `EpochSettled`; rolls `pot − reserved` into epoch+1 (`RolledOver`), starts epoch+1 (`EpochStarted`). No second post, no correction function (documented choice).
- `claim(epochId, amount, proof)` — settled, not paused, not already claimed by `msg.sender`, `MerkleProof.verify(proof, root, leaf)`, `claimed + amount <= reserved`, pays `msg.sender`, `accounted -= amount`, `Claimed`. `nonReentrant`.
- `setScheduler` (owner), `pauseClaims` / `unpauseClaims` (owner; disclosed in UI), `rescueToken(token,to,amount)` (owner; reverts for the payout token). **No withdraw of the payout asset.**
- Leaf: `keccak256(abi.encodePacked(uint64 epochId, address account, uint256 amount))` — 60 bytes, so it can't collide with a 64-byte inner node. Tree: OpenZeppelin `MerkleProof` (commutative / sorted-pair keccak256). One leaf per (epoch, account).
- Unclaimed reserved amounts stay claimable indefinitely (`[CLAIM_WINDOW]` = indefinite unless changed and disclosed).

## Merkle (TypeScript) — `src/lib/merkle.ts`
`leafOf(epochId: bigint, account: Address, amount: bigint): Hex` (encodePacked uint64,address,uint256 → keccak256),
`buildTree(leaves: Hex[]) → { root, layers }` (sorted leaves, sorted-pair hashing, odd node promoted),
`getProof(tree, leaf): Hex[]`, `verifyProof(proof, root, leaf): boolean`. Must match OZ `MerkleProof.verify` (tested against the contract on anvil).

## Scheduler API — served by this Next.js app under `/api/v1` (`config.schedulerApiUrl`)
All JSON; bigints as decimal strings; addresses checksummed. Never return raw user prompts in public lists (use `promptHash`).

Public reads
- `GET /api/v1/status` → `{ ok, schedulerOnline: true, epoch: { id, startedAt, endsAt, length }, nodes: { registered, online }, jobs: { queued, running, agreedThisEpoch, disagreedThisEpoch }, lastSettled: { id, root, reserved, leaves, postedTx|null } | null, rootPosting: "configured"|"not-configured", trust: "centralized-scheduler" }`
- `GET /api/v1/epochs` → `{ epochs: [{ id, startedAt, endedAt|null, root|null, reserved, potAtClose, leaves, postedTx|null, status: "open"|"closed-unposted"|"posted" }] }`
- `GET /api/v1/epochs/:id/tree` → `{ id, root, reserved, leaves: [{ account, amount, leaf }] }` (the published tree)
- `GET /api/v1/epochs/:id/proof?account=0x…` → `{ epochId, account, amount, leaf, proof: Hex[], root }` | 404 `{ error: "not-in-root" }` | 404 `{ error: "unknown-epoch" }` | 409 `{ error: "epoch-open" }`
- `GET /api/v1/epochs/:id/charges` → v2 (every charge since job receipts): `{ epochId, status: "sending"|"done"|"failed", hashRule: "v2-jobs-merkle", listHash, totalWei, tx|null, customers: [{ customer, amountWei }], leaves: Hex[], leafRule, codes: { verdict, chargeStatus } }`; `listHash` (the `Charged` event's) is the root of the jobs tree over `leaves` (sorted), each customer's `amountWei` equals its `CustomerCharged` event. Leaf = `keccak256(abi.encode(uint64 epochId, bytes32 jobId, address payer, uint256 priceWei, uint8 verdict, uint8 chargeStatus, bytes32 outputHash, bytes32 salt))`, verdict agreed 1 / disagreed 2 / expired 3 / rejected 4, chargeStatus charged 1 / released 2 / unpaid 3, `outputHash` zero unless agreed, `salt` 32 random bytes per leaf that only the payer's receipt carries (`src/lib/job-receipt.ts`). The tree holds the jobs charged now plus every paid / team job released or left unpaid since the last confirmed charge. v1 (charges stored before receipts, unchanged): `{ epochId, status, listHash, totalWei, tx, jobs: [{ jobId, payer, priceWei, apiKeyId? }], hashRule: "keccak256(utf8(JSON.stringify(jobs))) with jobs sorted by jobId" }`. Nothing charged: `{ epochId, status: "none", jobs: [], totalWei: "0", listHash: null, tx: null }`.
- `GET /api/v1/jobs?limit=20` → `{ jobs: [{ id, model, kind, status, createdAt, settledAt|null, promptHash, workUnits, epochId, eligible, paid, payment: "free"|"paid"|"team" }] }`; status ∈ `queued | running | checking | agreed | disagreed | expired | rejected`, `eligible`/`paid` derived from epoch state. No price, charge status or payer (those are on the private invoice).
- `GET /api/v1/jobs/:id` → job detail for the submitter (status, timestamps, `output` url when agreed).
- `GET /api/v1/jobs/:id/invoice` (session of the paying wallet, or `Authorization: Bearer <readSecret>`; `Cache-Control: private, no-store`) → paid / team job: `{ version: 1, jobId, model, kind, status, verdict: "agreed"|"disagreed"|"expired"|"rejected"|null, createdAt, settledAt, generatedAt, payment: "paid"|"team", invoice: true, payer, priceWei, chargedWei|null, protocolCutBps: 500, protocolCutWei, protocolCutNote, toPotWei, toPotNote, chargeStatus: "pending"|"charged"|"released"|"unpaid", reason|null, epochId|null, epochStatus|null, chargedEpoch|null, outputHash|null, links: { chargeTx: { hash, url }|null, epochRootTx: { hash, url }|null } }`; free job: `{ …, payment: "free", invoice: false, note: "free trial, no charge" }`. 400 bad id, 401 no credentials (empty body), 403 other wallet or secret, 404 unknown job. `protocolCutWei = priceWei × 500 / 10000` is a rounded per-job share: the contract takes 5% of each epoch's charged batch.
- `GET /api/v1/jobs/:id/receipt` (same credentials as the invoice; `Cache-Control: private, no-store`) → paid / team job with a verdict: `{ format: "sparecycle-job-receipt", version: 1, state: "provisional"|"sealed", chainId, paymentsContract, jobId, payer, priceWei, verdict, chargeStatus: "pending"|"charged"|"released"|"unpaid", outputHash|null, nodes: [{ node, outputHash, gpuMs, epoch, signature }], epochId|null, chargeTx|null, anchor: { hashRule: "v2-jobs-merkle", leafInputs: { epochId, jobId, payer, priceWei, verdict (code), chargeStatus (code), outputHash, salt }, leaf, proof: Hex[], listHash }|null, pending: { reason: "waiting-for-charge"|"charge-unconfirmed"|"no-anchor"|"charged-before-receipts", epochId|null }|null }`. Sealed = the charge that committed the leaf is confirmed (`anchor`, `epochId`, `chargeTx` set, `pending` null). `nodes[].signature` is each node's EIP-712 `Receipt` (domain Sparecycle v1). Free job: `{ jobId, payment: "free", receipt: false, note }`. 400 / 401 (empty) / 403 / 404 as the invoice; 409 `no-verdict` before the results are compared. Checked in the browser by `verifyReceipt` (`src/lib/job-receipt.ts`) against the charge transaction's `Charged` / `CustomerCharged` events, read from the chain's public RPC.
- `GET /api/v1/jobs/:id/output` → PNG or text of an agreed job.
- `GET /api/v1/nodes` → `{ nodes: [{ owner, nodeKey, gpu, vramMb, caps, online, state, lastSeen, agreedJobs, epochAgreedJobs }] }` (registered nodes only). `state` ∈ `active | paused-busy | paused-hot | paused-hours | offline` (Idle Guard; no pause start time is published).
- `POST /api/v1/jobs` → body `{ kind: "image", params: { model: "sd15", prompt, negative?, width, height, steps, guidance?, seed? } }` or `{ kind: "text", params: { model: "qwen2.5-1.5b", prompt, system?, maxTokens } }` → `{ id, status: "queued", priceWei|null, readSecret }`; 429 when over `JOB_RATE_LIMIT` per IP per hour. A paid job (`{ request, payment }`) also answers `available` (wei still spendable on new jobs, this job's price held) and `lowBalance` (`available` < 5 × this job's price; `LOW_CREDIT_JOBS` in `src/lib/job-payment.ts`).

Node endpoints (EIP-191 signed headers `x-sc-from`, `x-sc-ts`, `x-sc-sig` over `sparecycle|METHOD|PATH|TS|sha256(body)`, 60 s window)
- `POST /api/v1/nodes/register` `{ gpu, gpuUuid, vramMb, caps, owner, ownerSig }` (owner signs `Sparecycle: link node <nodeKey> to wallet <owner>`; the owner wallet is the Merkle leaf account)
- `POST /api/v1/nodes/poll` → 204 or `{ taskId, jobId, epoch, spec }` (each job is assigned to two distinct nodes with distinct owners and GPUs)
- `POST /api/v1/nodes/heartbeat` `{ state: "active"|"paused-busy"|"paused-hot"|"paused-hours", since? }` → `{ ok, state, since }` (node client 0.4.0+; on every state change and at least every 60 s while paused; counts as a sign of life; a paused node gets no lease)
- `POST /api/v1/tasks/:taskId/result` `{ outputHash, gpuMs, epoch, signature, png?|text? }`

Operator
- `POST /api/v1/epochs/close` (Bearer `SCHEDULER_ADMIN_TOKEN`) → closes the current epoch. Also run by a timer from `src/instrumentation.ts` when `SCHEDULER_AUTOCLOSE=1`.

Payout rule (state it in the UI): an epoch's agreed jobs share the on-chain pot **pro rata by work units** (scheduler-computed from the spec, never node-reported); the two agreeing nodes split a job's units equally; amounts are floored, so Σ ≤ pot; optional cap `PAYOUT_CAP_PER_UNIT` (wei per unit, unset = none); the rest rolls over on-chain. If the contract is not configured the scheduler still publishes the tree (status `closed-unposted`) and says so.

## Env (names; values never invented)
Public: `NEXT_PUBLIC_NETWORK` (mainnet|testnet|local), `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_EXPLORER_URL`, `NEXT_PUBLIC_TICKER`, `NEXT_PUBLIC_TOKEN_ADDRESS`, `NEXT_PUBLIC_CURVE_ADDRESS`, `NEXT_PUBLIC_LAUNCH_CONFIG_ID`, `NEXT_PUBLIC_PAIR_ASSET`, `NEXT_PUBLIC_PAIR_TOKEN_ADDRESS`, `NEXT_PUBLIC_CREATOR_TAX_BPS`, `NEXT_PUBLIC_NODE_PAYOUT_ASSET`, `NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS`, `NEXT_PUBLIC_MULTISIG_ADDRESS`, `NEXT_PUBLIC_SCHEDULER_ADDRESS`, `NEXT_PUBLIC_SWEEP_BOT_ADDRESS`, `NEXT_PUBLIC_SCHEDULER_API_URL`, `NEXT_PUBLIC_EPOCH_LENGTH`, `NEXT_PUBLIC_CLAIM_WINDOW`, `NEXT_PUBLIC_TOS_URL`, `NEXT_PUBLIC_TOS_VERSION`, `NEXT_PUBLIC_PRIVACY_POLICY_URL`, `NEXT_PUBLIC_X_URL`, `NEXT_PUBLIC_DOCS_URL`, `NEXT_PUBLIC_TELEGRAM_URL`, `NEXT_PUBLIC_DOMAIN`, `NEXT_PUBLIC_WC_PROJECT_ID`.
Server: `DB_PATH` (default `./data/sparecycle.db`), `SCHEDULER_SIGNER_KEY` (secret, posts roots), `SCHEDULER_ADMIN_TOKEN` (secret), `SCHEDULER_AUTOCLOSE`, `SCHEDULER_ALLOW_DEV_RUNNER` (local tests only), `PAYOUT_CAP_PER_UNIT`, `JOB_RATE_LIMIT`, `SWEEP_ENABLED`, `SWEEP_SIGNER_KEY` (secret), `LAUNCHER_WALLET`, `EPOCH_POST_GAS_COST`, `LEGAL_REVIEW`.

## File ownership (parallel work — touch only your own files)
- Contracts: `contracts/**`, `scripts/prelaunch-check.mjs`, `scripts/sync-deployments.mjs`, `scripts/deploy-local.mjs`, `src/contracts/deployments.json`.
- Backend: `src/server/**`, `src/app/api/v1/**`, `src/lib/merkle.ts`, `src/lib/protocol.ts`, `src/instrumentation.ts`, `node-client/**`, `scripts/e2e-local.mjs`, `scripts/sweep.mjs`, `NOTICE`.
- Frontend (lead): everything else under `src/app/**`, `src/components/**`, `src/lib/{config,chain,pons,format}.ts`, `src/contracts/sparecycleRewards.ts`, `public/**`.
- `package.json`: only add scripts/deps you need; don't reorder or remove others' entries.
