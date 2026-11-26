# Token features (scheduler side): NOT LIVE

The scheduler side of the next update's token features: node staking with evidence-based slashing, the usage burn
(phase 2a), holder weights and the holder-pool root (credit mode), and the holder page. Everything here is behind a
feature flag that **defaults to off**, and every flag stays off in production until:

- **a legal review** of the burn, the holder share and staking (brief §9.1) is recorded as done;
- **external audits** of the new contracts (`SparecycleNodeStake`, `SparecycleHolderPool`, `SparecycleBurner`,
  `SparecycleJobPaymentsV2`) have passed, and they are deployed (brief §9.2);
- **the treasury Safe's 2-of-3 keys are split across different people** (F2): the Safe executes burns, funds the
  holder pool and judges slashes, and today one person holds all three keys;
- for staking: **community nodes exist** (all six nodes are project-run today, brief §0.3).

With every flag off the site and the scheduler behave exactly as before: no chain read, no new route, no link, no
copy change (the "no token needed" lines of brief §0.7 stay true because staking is off). Each flag is built to be
turned on in production once the audited contracts are deployed: their addresses are set by environment variables
(below), and the copy of brief §0.7 that a flag makes false switches with that flag in the same deploy
(`src/lib/token-copy.ts`).

**One transaction is sent, and only with `TOKEN_HOLDERS` on and both `SparecycleHolderPool` and
`SparecycleJobPaymentsV2` configured:** the holder-pool root, `postRoot(epochId, root, totalEth)`, from the scheduler key
(`src/server/holder-posts.ts` through `holderPoolSender` in `src/server/chain-io.ts`, serialized with every other
scheduler-key send by `sendAsScheduler`). Every other on-chain action is *prepared* as an unsigned payload: a SafeTx (with
its EIP-712 hash and a Safe Transaction Builder batch) for the treasury Safe's signers, or an unsigned call for the
scheduler key. The token modules (`burns.ts`, `holders.ts`, `slashing.ts`, `stake-gate.ts`, `holder-page.ts`,
`token-work.ts`) contain no wallet client, no key and no write call (`src/server/burns.test.ts` checks it), and
`holder-posts.ts` sends only through that one sender (`src/server/holder-posts.test.ts` checks it).

All values of brief section 10 are named constants in `src/lib/token-rules.ts`, each labelled **"Default, not yet
confirmed by Fabio"**. Every feature means **SPARE** (`ADDR.spareToken`) only, never CYCLE (N16).

## Flags

Server-side, read at runtime (no rebuild needed). A flag is on only when set to exactly `on` (any case).

| Flag | Default | What it does when on | Needs before it can do anything useful |
| --- | --- | --- | --- |
| `TOKEN_BURNS` | off | At each epoch close, plans the burn share of every confirmed charge and prepares an unsigned Safe transaction (phase 2a) | Universal Router, StateView and the SPARE/ETH pool key in `src/lib/addresses.ts`; legal review; F2 |
| `TOKEN_HOLDERS` | off | At each epoch close (and every 5 minutes for retries), computes time-weighted SPARE weights and the HolderPool root. **With the pool and V2 set:** splits the epoch's V2 funding and sends `postRoot` from the scheduler key; serves `GET /api/v1/holders/epochs` and `/api/v1/holders/:address` (and their OpenAPI entries); shows the claim panel on `/token/holders` (with `TOKEN_HOLDER_PAGE`). Without V2: prepares the unsigned `postRoot` call and the Safe funding transaction only | `SPARE_START_BLOCK`; `SparecycleHolderPool` and `SparecycleJobPaymentsV2` deployed; `SCHEDULER_SIGNER_KEY`; legal review; audit; F2 |
| `TOKEN_SLASHING` | off | At each epoch close, attributes faults from re-check rounds and prepares slash proposals; serves `GET /api/v1/slashing` and `/api/v1/slashing/:id` | `SparecycleNodeStake` deployed (else proposals stay `incomplete`); audit; F2; community nodes |
| `TOKEN_STAKE_GATE` | off | Leases jobs only to owners with `stakedOf(owner) >= minStakePerNode x active nodes` | `SparecycleNodeStake` deployed. **Turned on without it, no node gets a lease** (the gate fails closed) |
| `TOKEN_HOLDER_PAGE` | off | Serves `/token/holders` and links to it from `/token` and `/proof` | Nothing (it shows `[NOT LIVE YET]` for every part that is not deployed) |
| `TOKEN_PAYMENTS_V2` | off | Paid jobs can also be paid and charged on `SparecycleJobPaymentsV2`: new deposits go there, V1 balances stay usable; credits first; SPARE-paid jobs at 0% discount; the per-epoch SPARE price and one V2 charge per epoch are **sent from the scheduler key** (like the V1 charge); receipts and invoices version 2 (`docs/contracts-v2.md`) | `TOKEN_JOB_PAYMENTS_V2_ADDRESS` set (else it stays off); V2, HolderPool and Burner deployed; the Safe's first SPARE reference price for SPARE payments |

With `TOKEN_BURNS`, `TOKEN_HOLDERS` or `TOKEN_SLASHING` on, the operator reads the prepared payloads at
`GET /api/v1/admin/token-payloads` (`Authorization: Bearer $SCHEDULER_ADMIN_TOKEN`). They are not public: a prepared
buy on a thin pool is a trade signal.

The token endpoints are served by the JSON 404 catch-all (`src/app/api/v1/[...path]/route.ts`), so with the flags off
they are exactly the unknown path they were before, and the public OpenAPI description does not change. The holder
endpoints' OpenAPI entries (`src/lib/openapi-holders.ts`) are added to `GET /api/v1/openapi.json` only while
`TOKEN_HOLDERS` is on.

## Addresses (set by environment once deployed)

`src/lib/addresses.ts` stays the one source of addresses. Each token-feature value there is `null` (not live) unless a
server environment variable sets it; a malformed value is ignored. The server reads them when it starts; pages that are
prerendered at build (`/nodes`) read them at build time, so set them before the deploy builds. Set a value only after
checking it on the explorer; once final it can also be written into `addresses.ts` as the default.

| Variable | Value |
| --- | --- |
| `TOKEN_NODE_STAKE_ADDRESS` | `SparecycleNodeStake` |
| `TOKEN_HOLDER_POOL_ADDRESS` | `SparecycleHolderPool` |
| `TOKEN_BURNER_ADDRESS` | `SparecycleBurner` (phase 2b; only its `Burned` events are read) |
| `TOKEN_JOB_PAYMENTS_V2_ADDRESS` | `SparecycleJobPaymentsV2`. With `TOKEN_HOLDER_POOL_ADDRESS` also set, holder roots are live: the funding is read from its `Distributed` events and the claim panel reads `creditOf` |
| `TOKEN_V4_POOL_MANAGER_ADDRESS` | Uniswap v4 PoolManager on Robinhood Chain (excluded from holder weights; its `Swap` event gives a burn's ETH in). All four `TOKEN_V4_*` values default to the ones verified on-chain in `UNISWAP_V4_DEFAULTS` (`docs/uniswap-v4-adapter.md`); set them only to override |
| `TOKEN_V4_STATE_VIEW_ADDRESS` | Uniswap v4 StateView (the price read of a burn plan) |
| `TOKEN_V4_UNIVERSAL_ROUTER_ADDRESS` | Uniswap v4 Universal Router (the burn swap) |
| `TOKEN_V4_POOL_KEY` | `fee,tickSpacing,hooks` of the SPARE/ETH pool (currency0 native ETH, currency1 SPARE). It must hash to the recorded pool id or no burn payload is prepared |
| `TOKEN_SAFE_MULTISEND_CALL_ONLY_ADDRESS` | Safe MultiSendCallOnly (only for `BURN_METHOD = "burn"`) |
| `TOKEN_SPARE_START_BLOCK` | The block of the SPARE launch transaction (first block of the Transfer history) |

## Copy that switches with the flags

`src/lib/token-copy.ts` holds every line of brief §0.7 that a flag makes false, with today's text as the off value
(pinned by `src/lib/token-copy.test.ts`); the server resolves the state (`src/server/token-copy-state.ts`) and passes the
lines down. With every flag off the state is resolved without any read and every page renders exactly as before.

| Flag on | What changes |
| --- | --- |
| `TOKEN_STAKE_GATE`, and `minStakePerNode()` read from the chain is above 0 (or cannot be read) | The "no token needed to run a node" lines: hero fact, "No token needed" card, "Who it is for", "Run a node" (home), the token facts, `/nodes` header and "Hold" row (with the minimum read from the chain). Paying for a job still needs no token. Adds a staking section to the disclosures, the token page facts and a clause to the terms summary. **With a minimum of 0 nothing changes**: "no token needed to run a node" is still true. |
| `TOKEN_BURNS` | Adds the usage-burn fact (home disclosures, token facts, `/legal/disclosures`, terms clause); the "fees fund the pot / buybacks are off" fact (used only when creator fees fund the pot) says the burn is separate. |
| `TOKEN_HOLDERS` | Adds the holder-credits fact the same way. With `TOKEN_HOLDER_PAGE` also on: the "Claim compute credits" panel and "Who is eligible" on `/token/holders`, the holder minimum as a figure under Rules, and a "Claim compute credits" link on `/token`. |
| `TOKEN_HOLDER_PAGE` | Links `/token/holders` from `/token` and `/proof`. |

"Not a yield product", "the token can go to zero" and "not financial advice" stay in the terms, the disclosures and the
footer whatever the flags. The "on" wording is for the legal review before any flag is turned on. `/nodes` is
prerendered while every flag is off; with any flag on (at build) it renders per request so its staking lines follow the
chain. The home page already re-renders every 60 s.

## Turning a flag on (checklist)

1. Legal review recorded as done (brief §9.1); audits passed; Safe keys split (F2); for staking, community nodes exist.
2. The contract addresses (and for burns the v4 addresses and pool key, for holders `TOKEN_SPARE_START_BLOCK`) set in the
   environment, each checked on the explorer, and `src/lib/token-contracts.ts` aligned with the deployed ABIs.
3. Set the flag and deploy (a rebuild, so prerendered pages pick it up). The copy and the links switch in that deploy.
4. With `TOKEN_BURNS` / `TOKEN_HOLDERS` / `TOKEN_SLASHING` on: read the prepared payloads at
   `GET /api/v1/admin/token-payloads` after each close. Burns are Safe transactions for the signers; `proposeSlash` is a
   prepared call for the scheduler key that this code does not send. Holder roots: with the pool and V2 set, `postRoot`
   is sent by the scheduler (see "Holder roots, live" below); the payloads view shows each root's status, transaction and
   last error. Without V2 the holder-pool funding is a Safe transaction and `postRoot` a prepared call, as before.
5. For holder roots specifically (`TOKEN_HOLDERS`), before switching on: V2 deployed with `holderPool` = the pool and the
   pool with `payments()` = V2 (the constructors cross-check this); the pool's `rewards()` = the live SparecycleRewards,
   so its `scheduler()` is the key in `SCHEDULER_SIGNER_KEY` (otherwise every post is refused `NotScheduler`, retried and
   never counted); `TOKEN_SPARE_START_BLOCK` recorded; the scheduler key funded for one more transaction per epoch
   (`postRoot` ~176k gas median, ~196k max); and the server's charge path sending charges to V2 (its `Distributed` event
   is the funding). Roots start with the first epoch that closes after the flag is on and the pool was deployed (the pool
   refuses earlier epochs: they are marked `unpostable`).
6. Turn `TOKEN_STAKE_GATE` on only after every node owner that should keep leasing has staked, and with the stake contract
   address set: without it the gate fails closed and no node gets a lease.

## What is not live, and why

| Part | State in this code | Why |
| --- | --- | --- |
| `SparecycleNodeStake`, `SparecycleHolderPool`, `SparecycleBurner`, `SparecycleJobPaymentsV2` | `null` in `TOKEN_CONTRACTS` unless set by env | Written elsewhere (brief stage 3), not audited, not deployed |
| Uniswap v4 PoolManager, StateView, Universal Router, SPARE/ETH pool key | `null` in `UNISWAP_V4` unless set by env | Not recorded and checked on Robinhood Chain. The pool id is DexScreener's (third-party); a pool key set later must hash to it or no payload is prepared |
| Safe MultiSendCallOnly | `null` (`SAFE_MULTISEND_CALL_ONLY`) unless set by env | Only needed for `BURN_METHOD = "burn"` |
| SPARE start block | `null` (`SPARE_START_BLOCK`) unless set by env | Holder balances need the full Transfer history; the holder page needs a first block to read burns from |
| Sending `proposeSlash` | Prepared, never sent | Who submits it is an open decision. (`postRoot` of the holder pool is sent by the scheduler once the pool and V2 are set.) |
| Burn phase 2b | Only its `Burned` event is read (holder page) | Needs V2 and the Burner contract |
| NVDA holder mode | Not built | Gates G1–G3 (brief §6.6) are open; a holder who chose it gets credits in the root |
| Split of the 5% | Read from V2 on the page once deployed; the defaults (N1) are used by the scheduler plans | V2 is not deployed; the live contract fixes 95% / 5% |

So today, with a flag turned on: burn plans are stored `incomplete` (whole share carried over), holder roots
`incomplete`, slash proposals `incomplete` (evidence published, no amount), the stake gate blocks every lease, and the
holder page shows `[NOT LIVE YET]` everywhere except the live 5% treasury cut.

## Parts

### Usage burn, phase 2a (`src/server/burns.ts`, `TOKEN_BURNS`)

Per closed epoch with a confirmed charge (oldest first, so carry-over chains in order):

- **Share** = `Charged.toTreasury x 150 / 500` (N1), read from the charge transaction's `Charged` log.
- **Due** = share + carry-in (what earlier plans did not buy, plus the buy of an expired plan).
- **Cap** (N12) = 1% of the pool's quote-side (ETH) liquidity at the read: the in-range virtual reserve
  `L x 2^96 / sqrtPriceX96` from StateView `getSlot0` / `getLiquidity`. **Buy** = min(due, cap); the rest carries over.
  Never split into many small buys.
- **minOut** = the constant-product quote of the buy at the read (after the LP fee, and net of the Pons hook's 2.90%
  cut of the output, `UNISWAP_V4.spareEthPoolHookCutBps`), minus 2% (N12). A moved price makes the swap revert:
  nothing is spent and the amount carries over. The router call encodes v4-periphery's `ExactInputSingleParams` with
  `minHopPriceX36 = 0`, the layout of both Universal Routers on chain 4663 (`docs/uniswap-v4-adapter.md`).
- **Payload**: one SafeTx to the Universal Router, `execute(V4_SWAP)` with `SWAP_EXACT_IN_SINGLE` (exact `amountIn`
  ETH, `amountOutMinimum = minOut`), `SETTLE_ALL`, and `TAKE` of all SPARE straight to the dead address
  (`BURN_METHOD = "dead"`, the default while `burn()` is only a bytecode heuristic). `BURN_METHOD = "burn"` instead
  takes SPARE to the Safe and calls `SPARE.burn(minOut + what the Safe holds)` in the same MultiSend batch. Router
  deadline: one epoch (`BURN_PAYLOAD_TTL_SECONDS`).
- **Status**: `prepared` | `incomplete` (what is missing is listed) | `nothing-due` | `executed` (found on-chain: the
  Safe's `ExecutionSuccess` carries the plan's SafeTx hash, or the executed data hashes like the plan's) | `expired`
  (deadline passed, not executed: its buy is carried over).
- **Public rows** (holder page): only on-chain events. SPARE `Transfer` to the zero or dead address in transactions
  executed by the treasury Safe (2a), `Burned` events (2b), and SPARE leaving the stake contract to a burn address
  (executed slashes, shown apart). A plan never creates a burn row; it only names the epoch of an executed one, and
  gives each "carried over" row its amount and reason (`cap`, `burn path not live`, `not executed before its deadline`),
  linked to the charge transaction.

### Holder weights and root, credit mode (`src/server/holders.ts`, `TOKEN_HOLDERS`)

- **Weight** = time-weighted average SPARE over the epoch: `sum(balance x seconds) / epoch length`, replayed from SPARE
  `Transfer` logs with block timestamps. SPARE bought one block before the end and sold right after weighs two seconds.
  The ledger (`token_holder_ledger`, cursor `meta.token_holder_block`) replays every transfer from `SPARE_START_BLOCK`.
- **Staked SPARE counts for its owner** (N15): a transfer to the stake contract moves wallet → staked for the sender,
  one from it moves staked → wallet for the receiver, and one from it to a burn address (an executed slash) takes the
  stake of the `Slashed` event's owner in the same transaction.
- **Excluded** (N14, shown on the holder page): the list `HOLDER_EXCLUSIONS` (PoolManager, the Pons curve, fee escrow,
  buyback vault, meme hook and launch locker, the team and launch wallets, the treasury Safe, the stake, burner and pool
  contracts, the zero and dead address), and any address with contract code unless allow-listed
  (`HOLDER_CONTRACT_ALLOWLIST`, empty). An EIP-7702 delegated wallet (23-byte `0xef0100…` code) counts as a wallet.
  LP positions are held by the PoolManager, so LPs are not counted.
- **Minimum** (N11): an average below `HOLDER_MIN_SPARE_WEI` gets nothing.
- **Share** (live, pool and V2 set): the epoch's funding is the sum of `Distributed.toHolderPool` of V2's charges for
  that epoch (`epochId` is indexed), capped by the pool's `available()`. It is final once the epoch is closed on-chain,
  because V2 charges only the open epoch; until then the epoch is not computed (retried). Each holder gets
  `floor(funding x weight / total weight)`; `totalEth` is the sum of the leaves, so the rounding remainder (under one
  wei per holder) stays in the pool's `available()`. ETH that is in no root (remainders, epochs with no eligible holder,
  rolled-over unclaimed shares) stays in the pool: this code does not add it to a later root.
  Without V2 (the earlier prepared-only mode): the holder share of the V1 charge (`toTreasury x 150 / 500`), pro rata by
  weight, floored.
- **Mode**: the last `ModeSet` with `effectiveEpoch <= epoch` (a choice made in epoch N counts from N+1); default
  credits (N18); NVDA is not offered, so it is put in the root as credits.
- **Leaf** `keccak256(abi.encodePacked(uint64 epochId, address holder, uint8 mode, uint256 amount))`, sorted-pair tree
  (`src/lib/merkle.ts` `holderLeafOf`), proofs stored with each leaf. Without V2: prepared only (the root, the unsigned
  `postRoot` call and an unsigned SafeTx sending `totalEth` to the pool), not sent.
- **Status** of a root (`token_holder_roots.status`): `ready` (to post) → `sent` (transaction out, receipt pending) →
  `posted`; or `skipped` (no funding, no eligible holder, or every share rounds to 0: nothing to post), `unpostable` (the
  pool no longer accepts the epoch id: a later one was posted, or it predates the pool), `conflict` (the pool holds a
  different root for it: for the operator), `failed` (refused by the contract `MAX_POST_ATTEMPTS` = 3 times). Earlier
  mode: `prepared` / `nothing-due` / `incomplete`.
- Tests: `src/server/holders.test.ts`, against an independent second-by-second reference on **recorded** mainnet SPARE
  Transfer logs (`src/server/test-fixtures/spare-transfers-recorded.json`) and labelled synthetic scenarios;
  `src/server/holder-posts.test.ts` (live split, posting, reads); `src/server/holder-vectors.test.ts` with
  `contracts/test/v2/HolderPoolVectors.t.sol` (the same vectors posted and claimed on the real pool).

### Holder roots, live: posting (`src/server/holder-posts.ts`, `TOKEN_HOLDERS` with the pool and V2 set)

After each close (`runTokenWorkAfterClose`) and every 5 minutes (`startHolderTimer`, for retries), serialized per
process: prepare the closed epochs' roots in order, then post every `ready` root in epoch order with
`postRoot(epochId, root, totalEth)` from the scheduler key. Never twice:

- Before every send the pool's `getRoot(epoch)` is read. Already posted with the same root and total (a crash after an
  earlier send): marked `posted` with the `RootPosted` transaction, nothing sent. Another root: `conflict`, nothing sent.
- A `sent` root waits for its transaction. Only after 15 minutes with no receipt **and** no root on-chain is it treated
  as dropped and sent again; the contract refuses a second post of an epoch anyway (`EpochNotPostable`).
- Epoch ids must increase, so a root that waits (not closed on-chain, a pending transaction, an RPC failure) holds back
  the later ones. A contract revert counts an attempt; after 3 the root is `failed` and the later epochs go on.
  RPC failures and a key that is not the pool's scheduler (`NotScheduler`) are retried without counting.
- Every send is simulated first and goes through `sendAsScheduler`, so it never takes a nonce that the reward root
  post, a charge or an x402 call already took.

### Holder reads and the claim panel (`src/server/holder-api.ts`, `TOKEN_HOLDERS`)

- `GET /api/v1/holders/epochs`: per epoch (newest 100) the status, root, funding, `totalEth`, holder count, total
  weight, when it was computed, the `postRoot` transaction with its Blockscout link and `claimableUntilEpoch`; plus the
  rules (method, minimum N11, rollover, exclusions) and `lastComputedAt`.
- `GET /api/v1/holders/:address`: the address's newest 50 leaves with amount, time-weighted average, leaf, proof, root,
  claim window, `claimed` (the pool's `hasClaimed`, read live), a state (`claimable`, `claimed`, `expired` = rolled
  back, `pending` = root not posted yet) and the exact `claim(epochId, mode, amount, proof)` arguments; and its credit
  balance (`creditOf` in V2). Public: addresses and amounts are public on-chain anyway. No error text, no payload.
- `/token/holders#claim` (`src/components/dapp/holder-claims.tsx`): a connected wallet sees its shares and claims each
  epoch as compute credits, one transaction per epoch (the pool has no batch claim). The browser recomputes the leaf,
  verifies the proof and simulates the claim before the wallet asks to sign; pending / confirmed / failed with the
  Blockscout link, then the V2 credit balance. Mode credits only; no other mode is shown. Any address can be looked up
  read only (also as a link: `/token/holders?address=0x…`). "Who is eligible" shows the minimum, the method, the
  exclusions (under Rules) and "last computed at".

### Fault attribution and slash proposals (`src/server/slashing.ts`, `TOKEN_SLASHING`)

- **Fault** (attribution rule, brief §3): node N gets a fault for job J only when J was agreed in a re-check round, N
  sent a signed result in an earlier round, that result matches **neither** of the two agreeing results (thresholds of
  `src/server/verify.ts`: 12 dHash bits, 0.9 text similarity), and the agreeing results come from two other nodes of two
  other owner wallets, neither of them N's owner. A mismatch with no later agreement (a final `disagreed`, a free job,
  an abandoned round, a node that never answered) attributes nothing; one mismatch never proposes.
- **Proposal**: a node with F = 3 unused faults whose verdict epochs lie in the last W = 8 epochs gets exactly one
  proposal; those faults are then used and never count again. Faults are counted per node key; the stake taken is its
  owner's. Amount = `stakedOf(owner) x 10%` (N4); the unsigned `proposeSlash(owner, amount, evidenceHash)` call is
  prepared when `SparecycleNodeStake` is readable, else the proposal is `incomplete`. Appeal window, freeze and burn of
  the slashed SPARE are the contract's (N7, N9).
- **Evidence** (public, `GET /api/v1/slashing/:id`): job ids, the node's signed result and the two agreeing signed
  results (node keys, owners, output hashes, gpuMs, epochs and EIP-712 receipt signatures, which anyone can recover),
  the comparison against the thresholds, the rule and its defaults. No prompt, no output, and no text fingerprint (a
  text fingerprint is the output text; image dHashes are included). `evidenceHash = keccak256(utf8(evidenceJson))` over
  the stored string. Note: a bundle discloses which nodes ran the listed jobs, which public job views otherwise hide.
- **Not trustless**: the scheduler attributes and the treasury Safe judges. Say so on the node page and in the docs when
  this goes live.

### Stake gate (`src/server/stake-gate.ts`, wired into `src/server/nodes.ts` and `rounds.ts`, `TOKEN_STAKE_GATE`)

- An owner's nodes get job leases only while `stakedOf(owner) >= minStakePerNode() x activeNodes(owner)`, where active
  nodes are the owner's nodes online now (at least 1). Reads go through `tokenChain` (`src/server/chain-io.ts`) and are
  cached per epoch (`token_stake_reads`, `meta.token_stake_min`): a sufficient stake is not read again in the epoch, an
  insufficient one is read again at the next poll, so a top-up restores leases from the next poll.
- The "compatible peer" of a round's first task, and the registered pair a new re-check round needs, count only owners
  whose last read passed.
- A failed read falls back to the owner's last read; with none the gate fails closed.
- Off: no read, and every query is byte-for-byte the one used before (`stakePeerSql` returns an empty string).

### Holder page (`/token/holders`, `src/server/holder-page.ts`, `TOKEN_HOLDER_PAGE`)

With the flag off, `src/proxy.ts` (matcher `/token/holders` only) rewrites the path to one no route matches, so it answers
exactly the 404 page of any unknown URL; the page also calls `notFound()` as a second guard.

Only on-chain data, each figure with its proof link (transaction, event log or contract read), `[NOT LIVE YET]` for
every part whose contract is not deployed (never a zero or a sample number), and "last read at" with the block. Sections:
burned (2a / 2b / slashes apart, burn rows, carried-over rows), distributed (roots and credit claims), staked (total,
project-run versus community owners, open and executed proposals with evidence links), rules (the live 5% treasury cut;
the split, the minimum stake and the holder minimum from contract reads once deployed; the exclusion list; the mode
rule). Reads are cached per epoch. `src/server/holder-page.test.ts` fails if a figure or a row has no source, and checks
that the page formats no number of its own.

## Interfaces assumed

`src/lib/token-contracts.ts` lists every function, event, field order and indexing this code relies on, so the
integrator can align it with the audited contracts in one place: `NodeStake.stakedOf / minStakePerNode / proposeSlash`,
`Slashed` and `SlashProposed`; `HolderPool.postRoot / setMode / claim`, `ModeSet`, `RootPosted`, `Claimed` and the leaf;
`Burner.Burned`; SPARE as a plain 18-decimal ERC-20; the Uniswap v4 StateView and Universal Router layouts; the Safe
1.5.0 SafeTx hash and `ExecutionSuccess`.

## Storage

Migration v11 (`src/server/db.ts`), additive: `token_burn_plans`, `token_holder_ledger`, `token_holder_modes`,
`token_holder_roots`, `token_holder_leaves`, `token_slash_faults`, `token_slash_proposals`, `token_stake_reads`. All
stay empty while the flags are off. Migration v13, additive: the posting columns of `token_holder_roots` (`funded_wei`,
`available_wei`, `note`, `pending_tx`, `sent_at`, `posted_tx`, `posted_at`, `claimable_until`, `post_error`,
`post_attempts`) and `token_holder_leaves.proof` (each leaf's Merkle proof).

## Copy

New copy (holder page, evidence, docs) describes mechanics only and never says "yield", "earn", "passive income", "APY",
"returns", "dividend", "deflationary" or "value accrual" (`src/server/holder-page.test.ts` scans the page).
