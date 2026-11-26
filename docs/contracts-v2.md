# Contracts V2: payments with credits and SPARE, burner, holder pool

> **AUDIT REQUIRED BEFORE MAINNET. NOT DEPLOYED.** These contracts are written and tested only. Nothing has been
> deployed, signed or broadcast. Items 4–6 of the next-update brief also need the legal review in brief §9 before
> they go live. Every number marked N-id below is **"Default, not yet confirmed by Fabio"**.

Source: `contracts/src/`. Spec: next-update brief §4 (phase 2b), §5, §6.1–6.5 (credit mode only), §8 (X2 note) and
stage 3 of §11. The live V1 contracts (`SparecycleJobPayments`, `SparecycleRewards`) are unchanged.

## What each contract does

### `SparecycleJobPaymentsV2.sol`

Prepaid balances for jobs, a successor to V1 for new deposits. It keeps V1's guarantees:

- Only `rewards.scheduler()` of the live `SparecycleRewards` can charge, and only for its open epoch.
- 95% of every ETH-paid charge goes to `rewards.fund()` (the node pot). `FEE_BPS = 500` is fixed.
- Each customer can cap their per-epoch charge (`setSpendLimit`, in ETH value). New: `setSpareSpendLimit` caps SPARE.
- Two-step withdraw: `requestWithdraw` → `withdraw` after two epoch closes or `WITHDRAW_TIMEOUT` (2 days). The same
  rule applies to SPARE (`requestWithdrawSpare` → `withdrawSpare`).
- `Charged` and `CustomerCharged` have the same topics as V1, so `src/lib/job-receipt.ts` reads both contracts.
  `listHash` is passed through as is (the v2 jobs root). The fifth `Charged` field is named `toFee` in V2: it is
  the whole 5%. The per-recipient split is in `Distributed`.

New in V2:

- **`depositFor(customer)`**: anyone can add to a customer's withdrawable balance. Only the customer can withdraw it.
  This unblocks x402 option X2 (see "X2" below).
- **`creditFor(customer)`**: payable, callable only by the immutable holder pool. It adds **spend-only credits**
  (N20). Credits pay for jobs and are never withdrawable. `charge` spends credits first, then deposits (N21).
- **The 5% split**: treasury / burner / holder pool in bps of the charge, always summing to 500. Default 200/150/150
  (N1). Only the treasury Safe can `proposeSplit`. It applies from `currentEpoch + 4` (N1 delay). A new proposal
  replaces a pending one and restarts the delay. `cancelSplit` works until the split applies.
- **SPARE balance and SPARE-paid jobs** (brief §5):
  - `depositSpare` credits the measured balance increase, so fee-on-transfer tokens are not over-credited.
  - `postSparePrice(epochId, price)`: the scheduler posts the price once per open epoch. Price is in wei per 10^18
    SPARE base units (SPARE has 18 decimals, so wei per 1 SPARE).
    - It is **accepted** only within `maxPriceDeviationBps` (N13, 20%) of `referenceSparePrice`.
    - An accepted price becomes the new reference.
    - A price outside the band, or one posted before the Safe has set a first reference, **pauses SPARE charges
      for that epoch**. ETH charges are not affected.
    - The Safe re-anchors the reference with `setReferenceSparePrice` after a real move.
  - `chargeWithSpare(epochId, ethCustomers, ethAmounts, spareCustomers, spareEthAmounts, minEthOut, listHash)`:
    - SPARE jobs keep their ETH price. Each customer pays `ethAmount × (1 − 10%) / price` SPARE (N2, rounded up).
    - The burner part of the split (N2b: `burnerBps / 10 000` of the SPARE received) is burned at once.
    - The rest is sold to ETH through the swap adapter. `minEthOut` must be at least the sale value at the epoch
      price minus `maxSwapSlippageBps` (N12, 2%).
    - The node pot then gets **exactly what an ETH-paid charge of the same size gives** (95%). A surplus goes to
      the treasury.
    - A shortfall is covered in this order: this charge's ETH treasury part, then the discount reserve, then this
      charge's ETH burner part. The holder-pool part is never used.
    - If the cover is not enough even at `minEthOut`, the call reverts. Nothing is charged, so the SPARE jobs are
      **deferred, never underpaid**. The scheduler calls `previewSpareLeg` first and can always fall back to the
      ETH-only `charge`.
    - Per-epoch cap on SPARE-paid volume (N13, `spareCapEthPerEpoch`, a `[SPARE_PAY_CAP_ETH]` constructor parameter).
      The default in the dry-run script is 0, which means off.
- **Discount reserve** (`fundDiscountReserve` by anyone, `withdrawDiscountReserve` to the treasury Safe only). This
  is ETH set aside to cover SPARE-sale shortfalls. See "Decisions" for why it exists.

ETH leaves V2 only to the reward contract, the treasury Safe, the burner, the holder pool, or a customer's own
withdrawal. Credits leave only inside a charge. The swap adapter is only ever given SPARE.

### `SparecycleBurner.sol`

Usage burn, phase 2b (brief §4).

- Receives ETH from V2 (and from anyone).
- `burnEpoch(epochId, minOut)`, scheduler only, once per epoch, only for the epoch that closed last:
  - Buys SPARE with at most `maxEthPerBurn` (N12 cap, `[PLACEHOLDER]`: 1% of the pool's quote-side liquidity, set
    from a live read). It burns the SPARE in the same transaction and emits `Burned(epochId, ethIn, spareBurned)`.
  - Whatever is over the cap stays and emits `CarriedOver(epochId, amount, Cap)`.
  - `minOut` must be at least the value at the epoch's accepted SPARE price (from V2) minus `maxSlippageBps` (N12,
    2%). The SPARE received is measured, not trusted.
  - If the epoch has no accepted price, nothing is bought and it emits `CarriedOver(…, NoPrice)`. So every handled
    epoch has a transaction hash.
  - A skipped epoch cannot be burned later. Its ETH simply carries over into the next (capped) burn, so buys are
    never split or bunched.
- Burn method is a constructor choice: SPARE's `burn()` (the total supply must drop by exactly the amount), or a
  transfer to `0x…dEaD`.
- No ETH exit except `requestRescue` → `executeRescue` by the Safe, to the Safe only. It needs 30 days (a design
  value, see the defaults table) **and** no successful burn since the request, which is the case where the pool is
  gone.

### `SparecycleHolderPool.sol`

Holder share, credit mode (brief §6). Modelled on `SparecycleRewards`.

- `postRoot(epochId, root, totalEth)`:
  - Scheduler only, for a closed epoch, with strictly increasing epoch ids (gaps allowed; a skipped epoch can never
    be posted later).
  - `totalEth` must fit in `available()` (balance minus open roots). It rolls expired roots over first.
- `claim(epochId, mode, amount, proof)`:
  - Leaf `keccak256(abi.encodePacked(uint64 epochId, address holder, uint8 mode, uint256 amount))`, OpenZeppelin
    sorted-pair tree (same as the reward contract). One claim per holder per epoch.
  - The epoch's `claimed` is capped by `total`.
  - Mode 1 (credits) calls `V2.creditFor{value: amount}(holder)` in the same transaction.
  - **Mode 2 (NVDA) is in the leaf format but reverts `NvdaModeNotAvailable()`.** Any other mode reverts
    `UnknownMode(mode)`.
- `setMode(uint8)`: stored per holder as a checkpoint, effective from the next epoch. Emits
  `ModeSet(holder, mode, effectiveEpoch)`. Only mode 1 can be chosen today. Holders who never chose get credits
  (N18). `modeOf(holder, epoch)` gives the mode for any epoch.
- Unclaimed shares roll back into the pool after K = 8 epochs (N19): claims are open while
  `currentEpoch <= postedInEpoch + 8`. `rollExpired` (permissionless, also run inside every `postRoot`) returns the
  unclaimed part to `available()`. Nothing ever goes to the treasury: the only ETH exit is `creditFor`.

### Shared pieces

- `src/interfaces/ISparecycleV2.sol`: the reward-contract view, `ISpareSwapAdapter`, `ISparePriceSource`,
  `ISpareBurnable` and the wiring interfaces.
- `src/libraries/SpareBurn.sol`: burn-or-dead logic with exact-amount checks.
- **Swap adapter**: all Uniswap v4 specifics sit behind `ISpareSwapAdapter` (`buySpare`, `sellSpare`, both with a
  minimum output). Tests use `test/mocks/V2Mocks.sol:MockSwapAdapter`.
  - **The v4 adapter** is `contracts/src/adapters/UniswapV4SpareAdapter.sol` (internal review only, not externally
    audited, not deployed). It calls the PoolManager directly for one fixed pool key; the PoolManager and the
    SPARE/ETH PoolKey were verified on-chain and are in `src/lib/addresses.ts` (`UNISWAP_V4_DEFAULTS`).
  - Addresses and their evidence, the pool's hook, measured price impact, fork tests and risks:
    `docs/uniswap-v4-adapter.md`.
  - **Before deploying V2 and the Burner with it:** the pool's Pons hook takes 2.90% of every swap's output, more than
    the 2% default of `maxSwapSlippageBps` (V2) and `maxSlippageBps` (Burner). With the defaults every SPARE sale and
    every burn reverts at its floor; the Safe must raise both (a fork test passes at 500 bps) or the posted price
    must already be net of the hook.

## Defaults (all "Default, not yet confirmed by Fabio")

| ID | Value | Where |
| --- | --- | --- |
| N1 | Split of the 5%: treasury 200 / burner 150 / holder pool 150 bps; Safe-only change, ≥ 4-epoch delay | `DEFAULT_TREASURY_BPS`, `DEFAULT_BURNER_BPS`, `DEFAULT_HOLDER_POOL_BPS`, `SPLIT_CHANGE_DELAY_EPOCHS` (V2) |
| N2 | SPARE discount 10% | `SPARE_DISCOUNT_BPS` (V2, constant) |
| N2b | SPARE burned = burner part of the current split on the discounted value | `_spareLeg` (V2), no separate number |
| N12 | Burn cap: 1% of the pool's quote-side liquidity at epoch close; slippage 2%; rest carried over | `maxEthPerBurn` (Burner constructor param, `[PLACEHOLDER]`, Safe-settable), `DEFAULT_MAX_SLIPPAGE_BPS` (Burner), `DEFAULT_MAX_SWAP_SLIPPAGE_BPS` (V2, reused for the SPARE sale) |
| N13 | SPARE-paid volume cap per epoch `[SPARE_PAY_CAP_ETH]`; pause on > 20% deviation | `spareCapEthPerEpoch` (V2 constructor param, Safe-settable), `DEFAULT_MAX_PRICE_DEVIATION_BPS` (V2) |
| N16 | SPARE only (`ADDR.spareToken`), CYCLE excluded | `spare` constructor param of V2 and Burner |
| N18 | Mode of holders who never chose: credits | `DEFAULT_MODE` (HolderPool) |
| N19 | Unclaimed shares roll into the pool after 8 epochs | `UNCLAIMED_ROLLOVER_EPOCHS` (HolderPool) |
| N20 | Credits are spend-only, never withdrawable | `creditOf` is separate from `balanceOf` (V2) |
| N21 | Charge order: credits first, then deposits | `_chargeOne` (V2) |
| — | Rescue delay 30 days (not in the brief; "a long delay") | `RESCUE_DELAY` (Burner): design value, to confirm |
| — | Hard bounds: deviation ≤ 50%, slippage ≤ 10% | `*_LIMIT` constants: design values, to confirm |

N3–N10 (staking), N11/N14/N15 (holder weights and exclusions, scheduler side), N17, N22 (NVDA), N23–N25 are not part
of these contracts.

## Decisions made here (not spelled out in the brief)

1. **Discount math.** With N2 = 10% and a 5% fee, a SPARE-paid job brings in at most 90% of its ETH price, but the
   node pot must get 95%. Every SPARE-paid job therefore needs a subsidy of at least 5% of its price, plus sale
   slippage (about 6.4% at the defaults with no slippage).
   - Within one charge the subsidy comes from the ETH leg's treasury and burner parts (3.5% of the ETH leg at the
     default split). So a charge can carry SPARE jobs worth up to about half its ETH jobs.
   - A SPARE-only epoch needs the **discount reserve**, which the Safe funds (treasury money) and can take back.
   - The brief's rationale for N2 ("small enough to be covered from treasury/burn shares") does not hold on its own.
     Fabio should confirm N2, or accept the reserve.
2. **Deferral is a revert.** A SPARE leg that is paused, over the cap, below the slippage floor or not coverable
   reverts the whole `chargeWithSpare`, so the `listHash` never commits to jobs that were not charged. The scheduler
   uses `previewSpareLeg` and ETH-only `charge` keeps working.
3. **Holder pool and SPARE-paid jobs.** All non-burned SPARE is sold, the pot is paid first, and any surplus goes to
   the treasury. The holder pool gets nothing from SPARE-paid jobs ("the rest goes to the treasury", brief §5).
4. **Reference price.** The reference is the last accepted price; a rejected price does not move it. The Safe sets
   the first reference and re-anchors after a real move. A compromised scheduler can move the reference by at most
   20% per epoch, and only with accepted prices.
5. **Burner price reference.** There is no on-chain oracle for SPARE, so the burner's `minOut` floor uses V2's
   accepted price for the epoch (deviation-checked). No accepted price means no buy.
6. **Adapter is immutable** in V2 and the Burner. If the pool moves, SPARE payments stop (no price posted), ETH
   payments continue, and the Burner's ETH can leave only through the 30-day rescue. A new adapter means new
   contracts.
7. **Deploy wiring.** The Burner is deployed with V2's predicted address, and V2 with the pool's predicted address.
   The constructors cross-check each other, and V2 refuses to push the holder part to an address with no code
   (`HolderPoolNotDeployed`).
8. **Credits never expire.** Unused credits stay in V2 forever (spend-only). Whether they should expire is open.

## X2 note (brief §8)

`depositFor` lets an x402 facilitator fund a customer's withdrawable balance without a separate escrow. It does not
include X2's refund-on-mismatch: once deposited, only the customer can withdraw, with the normal two-step wait. A13
and A14 are still open (`docs/x402-decision.md`).

## Not built

- **NVDA mode (6b).** Gates G1–G3 (brief §6.6) have not passed. Mode 2 exists only in the leaf format. `setMode(2)`
  and mode-2 claims revert `NvdaModeNotAvailable()`. No NVDA token, Chainlink feed, swap, market-hours or
  jurisdiction logic is present.
- **Deploying the Uniswap v4 swap adapter**: it is written and fork-tested (see above), not deployed.
- `SparecycleNodeStake` (brief §3). It is in stage 3 of §11 but not in this task.
- **The scheduler side** (stage 4). Since built, behind flags (`docs/token-features.md`): time-weighted holder
  weights, exclusions and minimum (N11/N14/N15), and the holder-pool root posting with the claim-as-credits panel
  (`TOKEN_HOLDERS`; `test/v2/HolderPoolVectors.t.sol` posts and claims the scheduler's own vectors on the pool).
  Still open here:
  - price posting;
  - V1+V2 dual charging;
  - receipts with asset and price fields;
  - the burns and holder pages.
- Copy changes listed in brief §0.7.

## Tests

Run with `npm run contracts:test` (or `node contracts/tools/forge.mjs test`). 102 new tests; the whole suite is 216
passed, 4 skipped (fork suites are opt-in).

| File | What it covers |
| --- | --- |
| `test/v2/SparecycleJobPaymentsV2.t.sol` (58) | Wiring and defaults. V1 event topics. Deposits / `depositFor` / receive. `creditFor` only from the pool. Credits first and never withdrawable (incl. fuzz). Three-way split and its conservation (fuzz). Split: Safe-only, sums to 500, ≥ 4 epochs (fuzz), cancel/re-propose. Two-step withdraw for ETH and SPARE. Price posting, band edges, deviation pauses SPARE but not ETH, Safe re-anchor. Pot gets exactly an ETH job's share (incl. moved pool price), surplus to treasury, shortfall order, deferral when not covered, reserve, min-out floor, per-epoch cap, customer limits, burn-to-dead, fee-on-transfer SPARE, fake `burn()` caught. Malicious adapter (short output, short pull, reentrant deposit / charge / withdraw, third-party ETH mid-swap). Missing holder pool refused. |
| `test/v2/SparecycleHolderPool.t.sol` (20) | Leaf format. Root rules (scheduler, closed epochs, increasing, available). Credit claim raises credit by exactly the amount, credits pay for a job and cannot be withdrawn. Double claim. Invalid proofs. Mode 2 → `NvdaModeNotAvailable`, unknown modes. `setMode` applies from N+1 only (two-mode harness + fuzz). Rollover after K = 8, never to treasury, reused by the next root. Over-allocated tree capped. Reentrant `creditFor` blocked. |
| `test/v2/SparecycleBurner.t.sol` (20) | Burn from charges. Scheduler only. Last-closed-epoch and once-per-epoch rules. Cap and carry-over. No-price carry-over. Min-out floor and Safe slippage. Pool moved beyond slippage. Short output. Fee-on-transfer output. Adapter refund. Dead-address mode. Reentrancy. Settings bounds. Rescue (delay, blocked by a later burn, Safe only, to the Safe only). Fuzz: ETH leaves only into buys, never over the cap. |
| `test/invariant/V2System.invariant.t.sol` (5 invariants, 256 × 64, plus 2 tests) | A closed set of addresses holds all the ETH, so any wei sent elsewhere fails. Exact balance of the pot, treasury, burner, pool, adapter and V2 from allowed flows only. Credits never withdrawn: each customer wallet is exact, withdrawn ≤ deposited. V2 buckets equal the per-customer sums. Pot == the ETH-equivalent share (never underpaid). SPARE supply drops only by V2's burns. Pool covers open roots. No unexpected reverts. A 600-step random walk checks that the SPARE, burn, claim and deferral paths are really reached. |
| `test/v2/DryRunDeployV2.t.sol` (1) | The dry-run deploy script wires all three. |
| `test/fork/V2Fork.t.sol` (2, opt-in) | Live chain, simulated locally. SPARE's `burn(uint256)` really lowers total supply. A V2 charge lands 95% in the live open pot with the split. A holder credit claim then pays for a job. Passed on 26 Nov 2026 against `https://rpc.mainnet.chain.robinhood.com` (around block 123,605,400). The `sparecycle.tech/api/rpc` relay refuses `eth_getStorageAt`, so the test skips there. |

Run the fork suite with:

```
FORK_TESTS=1 FORK_RPC_URL=<rpc> node contracts/tools/forge.mjs test --match-path test/fork/V2Fork.t.sol -vv
```

Mutation check (done by hand while writing): letting the SPARE leg underpay the pot, or spending deposits before
credits, makes the unit tests and the invariant fail.

## Gas (forge `--gas-report`, unit tests, mock adapter)

| Function | Median | Max |
| --- | ---: | ---: |
| V2 `charge` (1 customer, 4 ETH transfers) | 169,690 | 200,961 |
| V2 `chargeWithSpare` (mock swap; a real v4 swap costs more) | 296,135 | 433,181 |
| V2 `deposit` / `depositSpare` | 70,081 | 110,443 |
| V2 `postSparePrice` | 101,531 | 104,332 |
| Pool `postRoot` | 176,084 | 195,636 |
| Pool `claim` (credit mode, incl. `creditFor`) | — | 149,231 |
| Burner `burnEpoch` (mock swap) | 174,552 | 233,709 |
| Deployment: V2 / Burner / Pool | 4,539,802 / 1,615,381 / 1,657,758 | |

V2's runtime size is 22,432 bytes, under the 24,576-byte limit but close to it. Watch it if code is added.

## Deploy (simulation only)

`contracts/script/DryRunDeployV2.s.sol` simulates Burner → V2 → HolderPool with predicted addresses and checks the
wiring. It has no broadcast step and refuses `--broadcast`. With no env set it uses local stand-ins. Real values
come from `src/lib/addresses.ts`. The adapter and the burn cap stay `[PLACEHOLDER]` until they exist.

## Open risks for the audit

- **Trust.** The scheduler decides prices (within the band), roots, burn timing and charges, as in V1. The Safe
  decides the split, the reference price, caps, slippage and the reserve. Both are centralised keys, and all three
  Safe keys are with one person today (F2).
- **Thin SPARE pool.** Burns and SPARE sales can be sandwiched up to the slippage floor. The floor is only as good
  as the posted epoch price, which is scheduler-supplied with no on-chain oracle.
- **Discount economics** (decision 1). SPARE payments need a subsidy and stop without one.
- **Credits locked forever** if unused (decision 8).
- **Deploy order** must not be interrupted (predicted addresses). The constructors revert if it is.
- **The Uniswap v4 adapter** is the riskiest part and has had internal review only. The pool's Pons hook takes
  2.90% of every swap's output, above both 2% slippage defaults (`docs/uniswap-v4-adapter.md`).
- **SPARE `burn()`** was verified on a fork. A token upgrade (if any) could change it, and `SpareBurn` would then
  revert rather than mis-burn.
- **Not reviewed**: forced ETH (selfdestruct) into V2 is unaccounted and stuck; it cannot be stolen.
