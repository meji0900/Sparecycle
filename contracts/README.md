# Sparecycle reward contract

`src/SparecycleRewards.sol` holds the node-reward pot on Robinhood Chain (chain id 4663) and pays node
operators from per-epoch Merkle roots. It is funded only by real inflows: Pons v2 creator fees claimed from
the fee escrow, and public `fund` / `fundToken` calls. The interface contract is
`../src/contracts/sparecycleRewards.ts` (checked by `npm run contracts:abi-check` and `test/AbiSync.t.sol`).
The behaviour spec is `../docs/SPEC.md` ("Reward contract").

## Design

- **Payout asset**: native ETH (`payoutToken == address(0)`) or one standard ERC-20 (intended: USDG). Fixed
  at deploy. Fee-on-transfer, rebasing and double-entry tokens are not supported as the payout token.
- **Roles**: `owner` = the multisig (OpenZeppelin `Ownable2Step`; `renounceOwnership` is disabled so a lost
  scheduler key can always be rotated). `scheduler` = the root-posting key (centralized in the MVP).
- **Epochs**: epoch 0 opens at deploy. Every inflow credits the *current open* epoch. After `epochLength`
  seconds the scheduler calls `closeEpochAndPostRoot(epochId, root, reserved)`. This credits unaccounted
  inflows (`sync`), requires `reserved <= pot` and `root != 0` unless `reserved == 0`, settles the epoch,
  rolls `pot - reserved` into epoch+1 and opens it at the close timestamp. There is no re-post and no
  correction function.
- **Claims**: `claim(epochId, amount, proof)` pays `msg.sender` once per epoch if
  `leaf = keccak256(abi.encodePacked(uint64 epochId, address account, uint256 amount))` is in the root.
  The tree uses OpenZeppelin `MerkleProof` rules: sorted-pair keccak256, with the odd node promoted. The
  epoch's `claimed` can never exceed `reserved`, so even a tree whose leaves over-allocate cannot pay more
  than `reserved`. Unclaimed reservations stay claimable forever.
- **No withdraw, mint or setPot.** `rescueToken` reverts for the payout token. In ETH mode it only rescues
  ERC-20s; in ERC-20 mode `token = address(0)` returns stray ETH. It also reverts if the payout balance
  drops during the transfer.

### Accounting model

```
accounted   = pot(open epoch) + Σ settled epochs (reserved − claimed)
unaccounted = balance − accounted        (floored at 0)
```

- `receive()` is empty, so a 2300-gas `transfer` push succeeds. Pushed value is *unaccounted* until
  `sync()` (permissionless, and also run inside every close) credits it to the open pot with
  `PotFunded(epoch, address(0), amount)`.
- `fund` / `fundToken` credit what was actually received (`fundToken` measures the balance delta).
  `claimFeesFromEscrow[Token]` credits the balance delta across the escrow call. If the escrow reports a
  zero balance it returns 0 without calling it, because the real escrow reverts `NoBalance()` in that case.
- Close leaves `accounted` unchanged. Claims lower it by exactly what they pay. Nothing ever credits more
  than the measured balance, so `accounted <= balance` always holds.
- Every state-changing entry point is `nonReentrant`. A reentrant `fund()` from inside an escrow claim
  reverts, so an inflow cannot be counted twice (`test_EscrowClaim_ReentrantFundCannotDoubleCount`).

### Invariants (tested)

| Invariant | Where |
| --- | --- |
| every epoch: `reserved <= pot`, `claimed <= reserved`, `claimed` == paid | invariant `PerEpochBounds`, fuzz |
| `pot == rolled in + credited while open`; rollover = `pot − reserved` | invariant `PerEpochBounds`, unit rollover tests |
| `accounted == open pot + Σ(reserved − claimed) <= balance` | invariant `Accounting`, `_assertAccounting` in unit tests |
| total paid ≤ total funded; balance == funded − paid (nothing else leaves) | invariant `Accounting` |
| over-allocated trees are capped at `reserved` | fuzz `PayoutsBoundedByReservedAndPot`, unit `OverAllocatedTreeCappedByReserved` |
| only the scheduler closes; owner cannot move the payout asset; settled reservations survive a compromised owner/scheduler | unit + fuzz `OnlySchedulerCloses` |

The invariant handler (`test/invariant/RewardsHandler.sol`) does random `fund`, 2300-gas pushes, forced
ETH, escrow claims (both push styles), `sync`, time warps, closes with random (sometimes over-allocated)
splits, valid claims and bad claims. It runs in ETH and ERC-20 mode with `fail_on_revert = true`. Mutating
the contract (no `accounted -= amount`, no reserved cap, an off-by-one rollover) makes it fail.

### Merkle cross-check vector (for `src/lib/merkle.ts`)

Epoch `1`; accounts `0x…01`, `0x…02`, `0x…03`; amounts 1, 2 and 3 ether:

```
leaves  0x048d78b241b1346f17fd3dae57260e459ee74d81d73c08ad8cda31cbc70471fc
        0xf871567b802ca48cef05b1172094a5d175d420723ee040ede02c4edfd595194f
        0xb4de704126bca82e18914d2799c541dce7d4d18e0f640f0d2e09789f25803a40
root    0x4971f2383291235f443738a07a4de878815dbfa43170bc2af3e913c86fb3e7b9
```

## Trust model and security notes

- **Scheduler trust (disclosed in the UI).** The scheduler decides each epoch's split. The owner can rotate
  the scheduler, so together they could assign an *open* pot to themselves. They can never touch a settled
  epoch's reservations: no re-post, and `reserved <= pot` applies to the open pot only
  (`test_CompromisedOwnerCannotTouchSettledReservations`). Pausing claims is a liveness lever, not a
  withdrawal path.
- **Reentrancy on claim**: CEI plus `nonReentrant` on every state-changing entry point. A reentrant claim
  from `receive()` gets `ReentrancyGuardReentrantCall` and is paid once (`test_Claim_ReentrancyBlocked`).
- **ETH push failures**: a recipient that rejects ETH makes its own claim revert `TransferFailed`. Nothing
  changes and its reservation stays claimable (there is no claim-to-other-address). Operators should link an
  EOA or an ETH-accepting wallet.
- **Fee-on-transfer / rebasing tokens**: not supported. Delta crediting keeps fee-on-transfer inflows from
  over-crediting. A rebasing-down token would break `accounted <= balance`.
- **Rounding**: no division on-chain. The scheduler floors leaf amounts, so Σ leaves ≤ reserved ≤ pot.
- **Epoch-boundary races**: the open pot only grows. Fees that arrive between the scheduler's read
  (`pot + unaccounted()`) and its close are credited by the in-close `sync()` and only enlarge the pot, so a
  correct root never fails `ReservedExceedsPot`. Fees arriving after the close go to the next epoch.
- **`sync()` griefing**: anyone can call it, and it only credits value the contract already holds.
- **Immutable recipient**: the contract has no `transferCreatorFeeRecipient` passthrough. Once it is the
  Pons `creatorFeeRecipient`, only Pons' protocol-side timelocked change can redirect future fees.
  `feeEscrow` is immutable too. If Pons ever migrates its escrow, fees can still be forwarded with
  `fund()` / a push plus `sync()`.

## Pons integration, fork-verified (20 Nov 2026, Robinhood mainnet fork, nothing broadcast)

- `escrow.balanceOf(freshRewardContract) == 0`.
- The real escrow **reverts `NoBalance()` (0xc2caa2a6)** on `claim()` / `claimToken(token)` with a zero
  balance. `claimFeesFromEscrow()` pre-checks `balanceOf` and returns 0 instead.
- The escrow pays with a full-gas `CALL` to `msg.sender` (bytecode). `credit(address)` is payable and
  permissionless. The fork test credits 1.5 ETH and `claimFeesFromEscrow()` moves it into the pot.
- **Full launch path**: a throwaway token was launched through the real factory
  (`launchToken(TokenParams,uint256,address)`, 0xf35abbcf) with `creatorFeeRecipient = reward contract`,
  `buybackEnabled = false`, `creatorTaxBps = 0` and `expectedEconomics = previewLaunchEconomics(0, 0)`. The
  curve was resolved with `getLaunchedToken`. A 1 ETH buy left 0.01 ETH in `quoteFeeBalance()`. Then:
  - `curve.sweepFees(0)` reverts **`NotFeeSweepOperator()`** for the launcher and for a random EOA. It
    succeeds only for the `creatorFeeRecipient` (which this contract cannot call) or the Pons operator.
  - The Pons fee-sweep operator, read live from `hook.feeSweepOperator()` (`0xa101…cA83`), exposes
    `sweepCurve(address)`. **It succeeded from a random EOA** and credited 0.007 ETH (70%, at
    `protocolFeeShareBps = 3000`) to the reward contract in the escrow. `claimFeesFromEscrow()` then grew the
    pot by 0.007 ETH.
  - So the sweep bot's path is `operator.sweepCurve(curve)` → `reward.claimFeesFromEscrow()`. No sweep
    function is needed on this contract. `sweepCurve` and `feeSweepOperator` are not in the Pons docs.
    Their selectors come from deployed bytecode and the behaviour from the fork, so re-run the fork tests
    before launch. The post-graduation path (`hook.sweepPoolFees` / operator `sweepPool(bytes32)`) was **not**
    exercised.

## SparecycleNodeStake (internal review only, not externally audited)

`src/SparecycleNodeStake.sol` is node staking with partial slashing (brief §3). **Internal review only — not
externally audited**; an external audit is still recommended before it holds meaningful value. Launched with
`minStakePerNode = 0` (staking is voluntary). Rules, defaults (N3–N9), the appeal flow and grace period, the
evidence-bundle format, the scheduler-key rotation runbook and the open review points are in
`../docs/node-staking.md`. Tests: `test/SparecycleNodeStake.t.sol`, `test/invariant/SparecycleNodeStake.invariant.t.sol`
and the opt-in fork round trip `test/fork/NodeStakeFork.t.sol` (real SPARE, live reward contract).

## Run

```bash
export PATH="$HOME/.foundry/bin:$PATH"     # Git Bash; npm scripts add it themselves
npm run contracts:build                    # forge build
npm run contracts:test                     # unit + fuzz (512 runs) + invariant (256 x 64) + AbiSync; fork suite skipped
npm run contracts:abi-check                # compiled ABI vs src/contracts/sparecycleRewards.ts
cd contracts
forge test --match-contract SparecycleRewardsTest          # unit
forge test --match-path 'test/*fuzz*'                      # fuzz
forge test --match-path 'test/invariant/*'                 # invariant
FORK_TESTS=1 forge test --match-path 'test/fork/*' -vv     # Robinhood mainnet fork (public RPC, read-only)
forge test --match-contract GasScenarios --isolate -vv     # gas table below
```

## Deploy

Constructor: `(admin, scheduler, payoutToken, feeEscrow, epochLength)`. `script/Deploy.s.sol` reads `ADMIN`,
`SCHEDULER`, `EPOCH_LENGTH` (required), `PAYOUT_TOKEN` (default ETH) and `FEE_ESCROW` (default the Pons
escrow). It calls `vm.startBroadcast()` with no key; the signer comes from the CLI. On 4663 it requires the
Pons escrow and `ADMIN != SCHEDULER`. `DEPLOY_MOCK_ESCROW=1` works on anvil, and on Robinhood testnet
(46630), where Pons is not deployed. It is refused elsewhere.

**Local** (anvil, unlocked account 0, mock escrow, 60 s epochs; writes `src/contracts/deployments.json`
and prints the `NEXT_PUBLIC_*` lines):

```bash
npm run deploy:local                                      # anvil already on :8545
node scripts/deploy-local.mjs --start --port 8547         # start anvil too (left running, PID printed)
```

**Mainnet** goes through `node scripts/mainnet.mjs` (root README, "Mainnet"): settings in `mainnet.json`,
`Rehearse.s.sol` dry-runs deploy + launch + a test buy and sweep from the real wallet, `Launch.s.sol` launches on
Pons with the rules in `PonsLaunch.sol`, and every broadcast is simulated first and confirmed by hand.

**Testnet / mainnet** use an encrypted keystore. Never put a raw key on the command line.

```bash
cast wallet import sparecycle-deployer --interactive      # once; key is stored encrypted in ~/.foundry/keystores
cd contracts
# testnet (Pons absent → mock escrow)
ADMIN=0x<multisig> SCHEDULER=0x<scheduler> EPOCH_LENGTH=<seconds> DEPLOY_MOCK_ESCROW=1 \
  forge script script/Deploy.s.sol:Deploy --rpc-url robinhood_testnet \
  --account sparecycle-deployer --sender 0x<deployer> --broadcast
node ../scripts/sync-deployments.mjs Deploy.s.sol --chain 46630
# mainnet: simulate first (no --broadcast), run `npm run prelaunch:check`, then add --broadcast
ADMIN=0x<multisig> SCHEDULER=0x<scheduler> EPOCH_LENGTH=<seconds> \
  forge script script/Deploy.s.sol:Deploy --rpc-url robinhood --account sparecycle-deployer --sender 0x<deployer>
```

## Gas (measured)

Measured on 20 Nov 2026 with solc 0.8.28, optimizer 200 runs. Figures are whole-transaction gas: intrinsic +
calldata + execution. They come from `GasScenarios --isolate` and were cross-checked against anvil receipts:
`fund` 72,250 / 38,050 matched exactly, a 2-leaf close used 156,561 and a depth-1 claim 93,219. These are
**gas units of L2 execution**. On Robinhood Chain (Arbitrum Orbit) the receipt adds an L1-data component that
depends on calldata size and the L1 base fee at the time. Calldata is 100 bytes for a close and
132 + 32·depth bytes for a claim.

| Function | Scenario | Gas |
| --- | --- | ---: |
| `closeEpochAndPostRoot` → **`[EPOCH_POST_GAS_COST]`** | steady state: rollover > 0, nothing to sync (any tree size) | **156,561** |
| `closeEpochAndPostRoot` | with an in-close `sync` of pushed fees | 164,879 |
| `closeEpochAndPostRoot` | `reserved == pot` (rollover 0) | 136,649 |
| `closeEpochAndPostRoot` | empty epoch, zero root | 96,416 – 116,328 |
| `claim` (ETH) | first claim of an epoch, proof depth 1 / 4 / 7 / 10 | 93,161 / 95,424 / 97,703 / 99,934 |
| `claim` (ETH) | later claims in the same epoch, depth 1 | ~76,100 |
| `claim` (ERC-20 mock) | first claim, depth 7 | 123,595 |
| `fund` | first / later inflow of an epoch | 72,250 / 38,050 |
| `fundToken` (ERC-20 mock) | | 109,824 |
| `sync` | crediting a push | 38,529 |
| `claimFeesFromEscrow` | mock escrow / zero balance no-op | 54,752 / 29,263 |
| `claimFeesFromEscrow` | real Pons escrow on the fork (execution only) | ~94,500 |
| deployment | `SparecycleRewards` / `MockPonsFeeEscrow` (anvil receipts) | 1,796,413 / 477,074 |

`forge test --gas-report` over the unit + gas suites gives `closeEpochAndPostRoot` min 29,150 (reverting
auth checks), median 136,661, max 164,879, and `claim` median 92,450, max 123,595. Runtime size is
8,838 bytes.
