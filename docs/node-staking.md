# Node staking with partial slashing (`SparecycleNodeStake`)

> **INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED.** Launched with `minStakePerNode = 0` (staking is voluntary).
> `contracts/src/SparecycleNodeStake.sol` has had an internal review and the tests below, but no external audit. An
> external audit is still recommended before staking holds meaningful value or the minimum is raised above 0. Every
> default below is **"Default, not yet confirmed by Fabio"**.
>
> Still open from the brief (§3): the treasury Safe's keys are all held by one person today (F2), all six nodes are
> project-run (no community nodes yet), and the copy that says "no token needed to run a node" must change in the
> same release that raises the minimum above 0 (brief §0.7).

## What it does

- A node owner locks SPARE in the contract, per owner wallet. The scheduler leases jobs only to owners whose stake
  covers their active nodes.
- Repeated, **proven** wrong results can cost part of the stake. The slashed SPARE is burned. Nobody receives it:
  not the project, not the Safe, not the other node.
- Staking earns nothing. The contract pays no rewards. Node pay stays "paid for checked work" through
  `SparecycleRewards`.

## This is not trustless

Slashing depends on people and keys:

- **The scheduler proposes.** It decides off-chain which results are faults and when to propose a slash.
- **The treasury Safe judges.** It decides whether a proposal is executed (burned) or cancelled.
- The contract only enforces the limits: the slash cap, the appeal window, the freeze, the burn, the expiry of
  undecided proposals, and a grace period between proposals against the same owner. It cannot check the evidence.

What each key can do:

- **The scheduler key alone** can freeze a stake with a proposal, but cannot keep it frozen. Every proposal ends
  (cancelled, executed, or expired after the decision window), and after each one no new proposal against that
  owner is accepted for `PROPOSAL_GRACE_EPOCHS` (2 epochs). An owner whose cooldown has finished can always
  `unstake()` in that window. The scheduler alone cannot burn anything.
- **The scheduler and the Safe together** can still burn up to 10% of an owner's remaining stake per proposal, one
  proposal at a time, with a grace window between proposals. Over a 16-epoch cooldown that is at most three
  executed slashes (about 27% of the stake) before the owner can leave.
- **Today all three Safe keys are held by one person** (F2 is open). The Safe also rotates the scheduler key, so in
  practice one person controls every decision.
- Nobody can send staked SPARE to themselves or anyone else. Every proposal, appeal and decision is a public
  on-chain event, and every evidence bundle is meant to be published, so a bad decision is visible.

Say this plainly on the node page and in the docs when staking ships.

## Rules

### Stake and the minimum

- `stake(amount)` locks SPARE for the calling wallet. It credits what actually arrived: if the token ever took a
  fee on transfer, only the received amount counts.
- `minStakePerNode()` is the minimum per active node (N3). The scheduler leases to an owner only if
  `stakedOf(owner) >= minStakePerNode() * activeNodes(owner)`. `meetsMinimum(owner, activeNodes)` does that check
  without overflow. `nodesCovered(owner)` says how many nodes the stake covers.
- The node count is off-chain. The contract does not know how many nodes an owner runs.
- Only the Safe can change the minimum: `scheduleMinStakePerNode(value)`. A change takes effect after at least one
  epoch (both one epoch boundary and one epoch length of time). Until then the old value stays in force, and the Safe
  can drop it with `cancelMinStakeChange()`. This gives owners time to top up.
- Topping up is always allowed, even while a proposal is open.
- At launch the minimum is 0: staking is voluntary and `meetsMinimum` is true for everyone.
- There is **no on-chain cap** on the total stake, per owner or overall.

### Leaving (cooldown)

1. `requestUnstake(amount)` moves SPARE from active stake into a cooldown bucket. That SPARE **stops counting
   toward the minimum at once**, but **it can still be slashed** until it leaves.
2. `unstake()` pays the whole bucket back to the owner after the cooldown C (N8). `cancelUnstake()` puts the
   bucket back into active stake.
3. **A new `requestUnstake` restarts the cooldown for the whole bucket**, including SPARE requested earlier. To
   leave fastest, request everything at once.
4. `unstake()` and `requestUnstake()` fail while the owner has an open proposal (the stake is frozen). The cooldown
   keeps running during a freeze; once it is over, the owner can leave as soon as no proposal is open, and the grace
   period after every proposal guarantees such a moment.

The cooldown must be longer than the fault window plus the appeal window (C > W + A). The constructor refuses any
configuration that breaks this. So an owner who starts leaving while their node is faulting is still staked when
the proposal comes, and stays frozen while it is judged.

SPARE can leave the contract in exactly two ways: `unstake()` to the owner who staked it, or an executed slash to
the burn.

### Slashing

1. **Propose.** The scheduler (the live `SparecycleRewards.scheduler()`) calls
   `proposeSlash(owner, amount, evidenceHash)`.
   - `amount <= slashBps * (active + cooldown bucket) / 10_000` (N4: 10%). `maxSlashOf(owner)` returns the cap.
   - `evidenceHash` is the keccak256 of the published evidence bundle (format below).
   - One open proposal per owner at a time, and none during the grace period after the previous one (step 5).
     `canPropose(owner)` says whether the timing allows a proposal now; otherwise the call reverts with
     `ProposalAlreadyOpen` or `ProposalGraceActive`.
   - The scheduler key can be rotated by the Safe in `SparecycleRewards`; this contract follows the rotation. If the
     Safe ever made itself the scheduler, proposals would be refused (the judge must not be the accuser).
2. **Appeal window (A epochs, N7).** The stake is frozen: nothing moves, nothing is taken.
   - The owner can call `appeal(proposalId, evidenceHash)` with the hash of an appeal bundle, as often as they like
     while the window is open. The latest hash is stored.
   - Grounds (brief §3): a re-run on project-chosen independent hardware with the job's deterministic seed, or a
     scheduler fault (wrong model hash, bad input).
3. **Decision (Safe).**
   - `cancelSlash(proposalId)`: any time while the proposal is open. The stake is released. On a proposal already
     past its decision window it records the expiry instead (`SlashExpired`) and does not revert.
   - `executeSlash(proposalId)`: only after the appeal window. It burns `amount` and emits
     `Slashed(owner, amount, proposalId, evidenceHash)`, then
     `SlashSplit(proposalId, owner, fromStaked, fromUnstaking)`. The amount is taken from active stake first, then
     from the cooldown bucket.
4. **Expiry.** If the Safe neither executes nor cancels within the decision window (12 epochs after the appeal
   window), the proposal expires and the freeze ends by itself. Anyone can record it with `expireSlash(proposalId)`
   (for indexers); the next `unstake`, `requestUnstake`, `proposeSlash` or `cancelSlash` for it records it too.
5. **Grace period.** After a proposal is cancelled, executed or expires, no new proposal against the same owner is
   accepted for `PROPOSAL_GRACE_EPOCHS` = 2 epochs (same epoch-and-time rule and stall fallback as every window;
   after an expiry it counts from the expiry itself, so it does not matter when the expiry is recorded). This is the
   owner's exit window: without it the scheduler key alone could re-propose 1 wei right after every cancel or expiry
   and keep a finished cooldown frozen forever.
6. **Again.** Repeated faults escalate through repeated proposals: each one takes at most 10% of what is left.

Burn (N9): fixed at deploy. With `burnWithBurnFunction = true` the contract calls SPARE's `burn(uint256)`; with
`false` it transfers to `0x000000000000000000000000000000000000dEaD`. Either way the contract checks that its own
SPARE balance fell by exactly the slashed amount. The brief found the `burn(uint256)` selector in SPARE's bytecode
only heuristically; the fork test (below) now shows on a mainnet fork that `SPARE.burn` burns from the caller and
lowers `totalSupply`. Still confirm it against the verified source.

### Windows, epochs and a stalled scheduler

All windows count the epochs of the live `SparecycleRewards` (`currentEpoch()`), so they line up with the payout
epochs. A window of `n` epochs ends when **both**:

- `n * epochLength` seconds have passed since it started (so it is never shorter than its nominal length), and
- the reward contract has closed `n` epochs since it started,

**or**, if the scheduler stops closing epochs, after `2 * n * epochLength` seconds (`STALL_FACTOR = 2`). Without
this fallback, a scheduler outage would lock every stake forever.

### What the contract never does

- Pay rewards.
- Let the Safe, the scheduler or anyone else move staked SPARE, except the burn in `executeSlash`.
- Rescue SPARE. `rescueToken(token, to, amount)` is Safe-only and only for **other** tokens (or ETH) sent by
  mistake. It reverts for SPARE, and it reverts if SPARE's balance drops during the call (double-entry tokens).
  SPARE sent here without `stake()` is stuck for good; it is never credited to anyone.
- Accept a slash larger than `slashBps`, or one executed during the appeal window or after expiry.

## Defaults

All values are **Default, not yet confirmed by Fabio**. Epoch counts assume the reward contract's 6-hour epochs.

| ID | Parameter | Default | Where it lives |
| --- | --- | --- | --- |
| N3 | Minimum stake per active node | Launched at **0** (staking voluntary). Brief default for when it is raised: `[MIN_STAKE_SPARE]`, at least the largest single-node payout of the previous 4 epochs | Constructor `minStakePerNode_`; later `scheduleMinStakePerNode` (Safe, delay below) |
| N4 | Slash per executed proposal | 10% of the owner's stake (`slashBps = 1000`) | `Config.slashBps`, `DEFAULT_SLASH_BPS` |
| N5 | Faults needed for a proposal (F) | 3 attributed faults | Off-chain (scheduler). Not stored on-chain |
| N6 | Fault window (W) | 8 epochs (48 h) | Off-chain (scheduler). On-chain only for the C > W + A check: `Config.faultWindowEpochs` |
| N7 | Appeal window (A) | 4 epochs (24 h) | `Config.appealWindowEpochs` |
| N8 | Unstake cooldown (C) | 16 epochs (4 days) | `Config.cooldownEpochs` |
| N9 | Where slashed SPARE goes | Burned | Constructor `burnWithBurnFunction_` (`burn()` or `0x…dEaD`) |
| N10 | Project-run nodes stake | Yes, same rules, shown separately on the holder page | Off-chain / UI |
| — | Decision window (not in the brief) | 12 epochs (72 h) after the appeal window | `Config.decisionWindowEpochs` |
| — | Minimum-stake change delay (brief §3: "at least one epoch") | 1 epoch | `Config.minStakeDelayEpochs` (must be ≥ 1) |
| — | Grace period between proposals against one owner (not in the brief) | 2 epochs (12 h) | Constant `PROPOSAL_GRACE_EPOCHS` (fixed in code) |

Fixed in code (not configurable): `MAX_SLASH_BPS = 5000` (a deploy can never make slashing total),
`MAX_WINDOW = 365 days` for any window, `STALL_FACTOR = 2`.

## Attribution (off-chain, the scheduler's job)

From brief §3 (Default, not yet confirmed by Fabio). A single mismatch is **never** slashable: with two nodes it
only says that one or both are wrong.

1. Every result carries the node's EIP-712 receipt signature (`results.signature`), so it is evidence the node
   cannot deny.
2. A **fault** is attributed to node N for a job only when N's signed result disagrees with the agreed result, and
   the agreed result comes from **at least two other nodes of two other owner wallets**, neither of which is N's
   owner (for example re-check rounds 2 and 3 agreeing with each other against N). A mismatch with no later agreement
   attributes nothing.
3. A proposal is made only after **F faults in a rolling window of W epochs** (N5, N6), and exactly one proposal per
   such set.

## Evidence bundle (the preimage of `evidenceHash`)

The scheduler publishes one bundle per proposal (planned: `GET /api/v1/slashing/:id`, brief §3 "Scheduler
changes"). It contains **no prompts and no outputs**: only hashes, signed receipts and the comparison metric.

**Encoding.** JSON, canonicalized with RFC 8785 (JSON Canonicalization Scheme: sorted keys, no whitespace),
UTF-8. `evidenceHash = keccak256(canonical bytes)`. Large integers are decimal strings; hashes and signatures are
lowercase `0x` hex.

```json
{
  "kind": "sparecycle-slash-evidence",
  "version": 1,
  "chainId": 4663,
  "stakeContract": "0x…",
  "rewardsContract": "0x…",
  "owner": "0x…",
  "amount": "…",
  "proposedInEpoch": 1234,
  "rule": { "faults": 3, "windowEpochs": 8, "imageMaxBits": 12, "textMinSimilarity": 0.9 },
  "faults": [
    {
      "jobId": "0x…",
      "epoch": 1230,
      "model": "sd15",
      "modelHash": "0x…",
      "kind": "image",
      "inputHash": "0x…",
      "seed": "…",
      "accused": {
        "round": 1,
        "receipt": { "jobId": "0x…", "node": "0x…", "outputHash": "0x…", "gpuMs": "…", "epoch": "1230" },
        "signature": "0x…",
        "owner": "0x…",
        "ownerLinkSignature": "0x…",
        "gpuUuidHash": "0x…",
        "fingerprint": "…"
      },
      "agreeing": [
        { "round": 2, "receipt": { "…": "…" }, "signature": "0x…", "owner": "0x…", "ownerLinkSignature": "0x…", "gpuUuidHash": "0x…", "fingerprint": "…" },
        { "round": 3, "receipt": { "…": "…" }, "signature": "0x…", "owner": "0x…", "ownerLinkSignature": "0x…", "gpuUuidHash": "0x…", "fingerprint": "…" }
      ],
      "metric": {
        "name": "image-dhash-hamming",
        "threshold": 12,
        "agreeingPair": 3,
        "accusedVsAgreeing": [27, 25]
      }
    }
  ]
}
```

Field notes:

- `receipt` is exactly the EIP-712 message the node signed: domain `{ name: "Sparecycle", version: "1", chainId }`,
  type `Receipt(bytes32 jobId, address node, bytes32 outputHash, uint64 gpuMs, uint64 epoch)`
  (`src/lib/protocol.ts`). `signature` must recover to `receipt.node`.
- `ownerLinkSignature` is the owner wallet's EIP-191 signature of
  `Sparecycle: link node <nodeKey> to wallet <owner>` (`linkMessage` in `src/lib/protocol.ts`). It proves which owner
  a node key belongs to.
- `gpuUuidHash` is keccak256 of the GPU UUID, so distinct hardware can be checked without publishing the UUID.
- `inputHash` and `modelHash` identify the job without the prompt.
- `fingerprint` and `metric`:
  - image jobs: `fingerprint` is the 64-bit difference hash (hex) the scheduler compares; anyone can recompute the
    Hamming distances. Agreement is `<= imageMaxBits` (12) bits (`src/server/verify.ts`).
  - text jobs: the fingerprint is the normalized output text, so the bundle carries `fingerprintHash`
    (keccak256 of it) instead, and `metric` = `{ "name": "text-similarity", "threshold": 0.9, "agreeingPair": …,
    "accusedVsAgreeing": [ … ] }`. The public can check the hashes and the signatures, not the similarity itself;
    the accused owner can check it against their own output. This is a known limit for text.

**A valid bundle** (what the Safe and anyone else should check):

- `faults` has at least `rule.faults` entries, all against `owner`, and their epochs fit in one window of
  `rule.windowEpochs` epochs.
- Every signature recovers to its `receipt.node`; every `ownerLinkSignature` links that node to the stated owner.
- In every fault, at least two `agreeing` results come from two different owners, neither equal to `owner`, on
  different GPUs; they agree with each other under the metric, and the accused result disagrees with them.
- `amount` equals the on-chain proposal amount, which the contract already capped at `slashBps`.

## Appeal bundle

Same encoding. `appeal(proposalId, keccak256(canonical bytes))` records it on-chain; the owner sends the bundle
itself to the project (channel to be set up with the slashing API).

```json
{
  "kind": "sparecycle-slash-appeal",
  "version": 1,
  "chainId": 4663,
  "stakeContract": "0x…",
  "proposalId": "…",
  "owner": "0x…",
  "grounds": "rerun",
  "jobs": [
    {
      "jobId": "0x…",
      "rerun": { "hardware": "…", "seed": "…", "receipt": { "…": "…" }, "signature": "0x…", "fingerprint": "…" },
      "schedulerFault": { "expectedModelHash": "0x…", "servedModelHash": "0x…", "inputHash": "0x…", "note": "…" }
    }
  ],
  "statement": "…"
}
```

`grounds` is `"rerun"` (a re-run on project-chosen independent hardware with the job's deterministic seed) or
`"scheduler-fault"` (wrong model hash, bad input). Use the matching object per job.

## For the scheduler integration (stage 4)

Reads (all views):

| Function | Use |
| --- | --- |
| `stakedOf(address) → uint256` | Active stake (excludes the cooldown bucket) |
| `minStakePerNode() → uint256` | Minimum in force now |
| `meetsMinimum(address owner, uint256 activeNodes) → bool` | Lease gate |
| `nodesCovered(address) → uint256` | How many nodes the stake covers |
| `slashableOf(address) → uint256`, `maxSlashOf(address) → uint256` | Cap for a new proposal |
| `openProposalOf(address) → uint256` | Open, unexpired proposal id (0 = none); non-zero = frozen |
| `canPropose(address) → bool` | No open proposal and the grace period after the last one is over (check before `proposeSlash`) |
| `getAccount(address) → Account` | Raw record: `staked`, `unstaking`, `requestEpoch`, `requestedAt`, `lastProposal` (latest proposal against the owner, any status) |
| `unstakingOf(address) → (uint256 amount, uint64 requestEpoch, uint64 requestedAt)`, `canUnstake(address) → bool` | Leaving state |
| `getProposal(uint256) → Proposal`, `proposalStatus(uint256) → Status`, `canAppeal(uint256)`, `canExecute(uint256)` | Proposal state (`Status`: 0 None, 1 Open, 2 Cancelled, 3 Executed, 4 Expired). `Proposal` = `owner, status, proposedEpoch, proposedAt, closedEpoch, closedAt, amount, evidenceHash, appealHash` |
| `scheduledMinStakeChange() → (bool, uint256 next, uint64 epoch, uint64 scheduledAt)` | Pending minimum change |
| `totalStaked()`, `totalSlashed()`, `proposalCount()` | Holder page totals |

Writes: scheduler `proposeSlash(address owner, uint256 amount, bytes32 evidenceHash) → uint256 proposalId`;
owner `stake(uint256) → uint256 received`, `requestUnstake(uint256)`, `cancelUnstake()`, `unstake() → uint256`,
`appeal(uint256 proposalId, bytes32 evidenceHash)`; Safe `cancelSlash(uint256)`, `executeSlash(uint256)`,
`scheduleMinStakePerNode(uint256)`, `cancelMinStakeChange()`, `rescueToken(address,address,uint256)`; anyone
`expireSlash(uint256)`.

Events: `Staked(owner, amount, staked)`, `UnstakeRequested(owner, amount, unstaking, epoch)`,
`UnstakeCancelled(owner, amount, staked)`, `Unstaked(owner, amount)`,
`SlashProposed(proposalId, owner, amount, evidenceHash, epoch)`, `SlashAppealed(proposalId, owner, evidenceHash)`,
`SlashCancelled(proposalId, owner)`, `SlashExpired(proposalId, owner)`,
`Slashed(owner, amount, proposalId, evidenceHash)` (signature fixed),
`SlashSplit(proposalId, owner, fromStaked, fromUnstaking)` (right after `Slashed`),
`MinStakeChangeScheduled(current, next, epoch, scheduledAt)`, `MinStakeChangeCancelled(next)` (also emitted when a
new schedule replaces one that had not taken effect), `TokenRescued(token, to, amount)`.

`proposeSlash` errors the scheduler should expect: `ProposalAlreadyOpen(id)`, `ProposalGraceActive(lastProposalId)`,
`SlashAboveCap(amount, cap)`.

Notes:

- Cache `minStakePerNode()` per epoch, but re-read after an epoch close: a scheduled change takes effect at a
  boundary.
- An owner in cooldown loses leases for the requested part at once (`stakedOf` drops), which is intended.
- The contract does not stop leases while a proposal is open. Whether the scheduler pauses an accused owner's leases
  is an off-chain choice and is not decided.
- The constructor is `(token, rewards, safe, burnWithBurnFunction, minStakePerNode, Config)`, with addresses from
  `src/lib/addresses.ts` (`ADDR.spareToken`, `ADDR.rewards`, `ADDR.treasurySafe`). The deploy goes through
  `contracts/script/DeployNodeStake.s.sol` and `node scripts/mainnet.mjs deploy-stake` on the release branch.
- Do not re-propose against an owner the moment a proposal ends: `canPropose(owner)` stays false for the grace
  period, and a `proposeSlash` in that window reverts.

## Runbook: rotating the scheduler key

The scheduler key is the only key that can propose. If it is lost, leaked or replaced:

1. **Safe:** call `SparecycleRewards.setScheduler(newKey)`. This contract reads `rewards.scheduler()` live, so the old
   key can no longer propose from the next block. The new key must not be the Safe (proposals from the Safe are
   refused).
2. **Safe:** list the open proposals the old key made (`SlashProposed` events, then `openProposalOf(owner)` or
   `proposalStatus(id)` for each) and call `cancelSlash(id)` on every one that is not backed by a published,
   valid evidence bundle. When in doubt, cancel: the new key can re-propose with fresh evidence after the grace
   period.
3. Rotation does not touch stakes, cooldowns or the minimum. Owners in cooldown keep their clocks.
4. Publish the rotation (old key, new key, cancelled proposal ids) with the evidence page.

## Open points for review

- **Trust.** Scheduler and Safe together can burn up to `slashBps` per proposal, one proposal at a time with a
  2-epoch grace window in between (at most about 27% over one 16-epoch cooldown). The scheduler alone can freeze
  but not keep a finished cooldown frozen. All Safe keys are with one person today (F2). Accepted by design (it is
  not trustless); confirm nothing worse is possible.
- **Grace period.** After an expiry the grace counts from the expiry (appeal + decision + grace from the proposal),
  not from when the expiry is recorded, so a scheduler can never get stuck behind an unrecorded expiry, and an
  owner always gets at least 2 epoch lengths of time.
- **Epoch source.** Windows depend on `SparecycleRewards` closing epochs; the stall fallback (2× time) keeps owners
  able to leave. `rewards` and `safe` are immutable: replacing either contract or the Safe address means a new stake
  contract and a migration (owners unstake and re-stake).
- **Burn path.** `burn(uint256)` on SPARE was first a heuristic bytecode finding; the fork test exercises it on
  real SPARE (supply falls by the slashed amount). Both paths check the exact balance drop.
- **Token behaviour.** Fee-on-transfer inflows are credited by measured delta; outflows must lower the balance by
  exactly the amount sent, or they revert (protects other stakers, but a token that taxes the sender extra would make
  unstake impossible). Rebasing tokens are not supported.
- **Read-only reentrancy.** All state-changing functions are `nonReentrant`. During `stake()` the token transfer
  happens before the credit, so a token callback reading views mid-call would see the balance already up and the
  stake not yet credited. Views are not used by the contract itself across that call.
- **One open proposal per owner.** Simpler bookkeeping, and a bounded freeze; the next set of faults waits until
  the current proposal is resolved and its grace period is over.
- **Stuck SPARE.** SPARE sent without `stake()` can never be recovered (no SPARE rescue, by design).
- **No cap on total stake.** Nothing limits how much SPARE one owner or everyone together can stake.
- **Cooldown restart.** Every `requestUnstake` restarts the cooldown for the whole bucket.
- **Grace also follows an executed slash (accepted trade-off).** An owner whose cooldown finished while a proposal was
  open can leave with the rest of the stake during the grace window after the Safe executes it, before the next set of
  faults can be proposed: an owner is slashed at most once per exit. Accepted for the launch (staking is voluntary and
  the minimum is 0); the alternative, grace only after a cancel or an expiry, needs a new contract.
- **For Safe signers: a cancel opens an exit window.** Cancelling a proposal (even one cancelled only to re-propose it
  with a corrected amount or bundle) starts the grace period, so an owner whose cooldown has finished may leave in
  between. Cancel only to clear the owner.

## Internal review and mainnet checks (26 Nov 2026)

- Independent internal review (not an external audit) of `SparecycleNodeStake.sol`: no critical or high findings;
  one medium (the scheduler alone could keep an exit frozen by re-proposing) fixed by the grace period, confirmed
  closed on re-review; the trade-off above accepted.
- Fork round trip on Robinhood Chain mainnet state (`FORK_TESTS=1`, `test/fork/NodeStakeFork.t.sol`): 3/3 pass —
  the config as launched, stake → requestUnstake → unstake returns everything, and an executed slash burns real SPARE
  (total supply falls by the slashed amount).

## Tests

`contracts/test/SparecycleNodeStake.t.sol` (unit and fuzz, every contract-side acceptance criterion of brief §3,
reentrancy, fee-on-transfer, sender-tax and double-entry tokens) and `contracts/test/invariant/` (handler
`NodeStakeHandler.sol`; suites with the default windows in burn and dead-address mode, and one with the shortest
valid windows). Run them with the other contract tests:

```bash
npm run contracts:test
node contracts/tools/forge.mjs test --match-path 'test/*NodeStake*' -vv
node contracts/tools/forge.mjs test --match-path 'test/invariant/SparecycleNodeStake*'
```

Fork round trip against the real SPARE token and the live `SparecycleRewards` (opt-in, local fork, nothing is
broadcast; skips if the RPC cannot be reached):

```bash
FORK_TESTS=1 node contracts/tools/forge.mjs test --match-path test/fork/NodeStakeFork.t.sol -vv
```

It deploys the contract as launched (burn through `SPARE.burn`, minimum 0, default windows), then checks
stake → requestUnstake → cooldown (stall fallback, since no live epoch closes on the fork) → unstake returns
everything, and stake → proposeSlash (live scheduler key) → appeal window → executeSlash (the Safe) burns through
`SPARE.burn` so `totalSupply` falls by the slashed amount.

Invariants checked after every random call sequence:

- the contract's SPARE balance equals `totalStaked` plus SPARE donated outside `stake()`, and `totalStaked` equals
  the sum of all accounts;
- for every owner: staked in = still staked + paid back by `unstake` + slashed, and the owner's wallet changed only
  by its own stakes and unstakes; the Safe, the scheduler and strangers never hold SPARE;
- every slashed unit was burned (supply down in burn mode, `0x…dEaD` up in dead mode);
- at most one open proposal per owner and only the latest can be open, every executed proposal within `slashBps`
  of the stake it was proposed against, executed proposals sum to `totalSlashed`, and no proposal was ever accepted
  inside a grace period (checked against the handler's own record of every proposal's timing);
- no frozen stake moved, no privileged call succeeded for a stranger, and no slash above the cap was accepted.
