# Contracts V2: payments with credits and SPARE, burner, holder pool

> **AUDIT REQUIRED BEFORE MAINNET. NOT DEPLOYED.** These contracts are written and tested only. Nothing has been
> deployed, signed or broadcast. Items 4–6 of the next-update brief also need the legal review in brief §9 before
> they go live. **N1 (split), N2 (SPARE discount) and the N12 slippage of both contracts were decided by the owner on
> 26–27 Nov 2026** (see "Owner decisions"). Every other number marked N-id below is still **"Default, not yet
> confirmed by Fabio"**.

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
- **The 5% split**: treasury / burner / holder pool in bps of the charge, always summing to 500. Deployed as
  **350 / 0 / 150** (N1, decided by the owner on 26–27 Nov 2026: the burn is postponed). Only the treasury Safe can
  `proposeSplit`. It applies from `currentEpoch + 4` (N1 delay). A new proposal replaces a pending one and restarts
  the delay. `cancelSplit` works until the split applies. With burner 0 every path still works: no ETH is sent to
  the burner (zero amounts are never transferred), no SPARE is burned in a charge (`SpareBurn` skips 0), and
  `Distributed` / `SpareCharged` report `toBurner = 0` / `spareBurned = 0`.
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
    - SPARE jobs keep their ETH price. Each customer pays `ethAmount × (1 − SPARE_DISCOUNT_BPS) / price` SPARE,
      rounded up. **N2 = 0%** (decided by the owner on 26–27 Nov 2026): a SPARE-paid job costs its ETH price in SPARE
      at the epoch price.
    - The burner part of the split (N2b: `burnerBps / 10 000` of the SPARE received) is burned at once. With the
      deployed split that is 0: all of the SPARE is sold.
    - The rest is sold to ETH through the swap adapter. `minEthOut` must be at least the sale value at the epoch
      price minus `maxSwapSlippageBps` (N12, **4%**, decided by the owner on 26–27 Nov 2026).
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
  is ETH set aside to cover SPARE-sale shortfalls. At the deployed values it is never needed (see "Owner decisions");
  it stays for a later discount or burner share.

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
    **4%**, decided by the owner on 26–27 Nov 2026). The SPARE received is measured, not trusted.
  - If the epoch has no accepted price, nothing is bought and it emits `CarriedOver(…, NoPrice)`. So every handled
    epoch has a transaction hash.
  - A skipped epoch cannot be burned later. Its ETH simply carries over into the next (capped) burn, so buys are
    never split or bunched.
- Burn method is a constructor choice: SPARE's `burn()` (the total supply must drop by exactly the amount), or a
  transfer to `0x…dEaD`.
- No ETH exit except `requestRescue` → `executeRescue` by the Safe, to the Safe only. It needs 30 days (a design
  value, see the defaults table) **and** no successful burn since the request, which is the case where the pool is
  gone.
- **Burn postponed**: with V2's deployed burner part of 0 the Burner is deployed but receives nothing until the Safe
  changes the split (≥ 4 epochs later). With no balance `burnEpoch` reverts `NothingToBurn` without using the epoch
  up; the scheduler simply does not call it.

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
  - The pool's Pons hook takes 2.90% of every swap's output. The deployed 4% slippage of `maxSwapSlippageBps` (V2)
    and `maxSlippageBps` (Burner) leaves room for it plus impact (about 0.17% for 0.01 ETH): the fork tests pass at
    the defaults. The earlier 2% default would have made every SPARE sale and every burn revert at its floor
    (`test_Fork_TwoPercentWouldNotFitTheHookCut`).

## Owner decisions (26–27 Nov 2026)

1. **SPARE-paid jobs at 0% discount** (`SPARE_DISCOUNT_BPS = 0`). The Pons hook takes 2.90% of each swap's output
   (`docs/uniswap-v4-adapter.md`), so a SPARE job's sale brings in about 97% of its ETH price (2.90% hook + about 0.17%
   impact for 0.01 ETH on the fork). With 0% discount and burner part 0 the sale floor alone (96% of the value at the
   posted price) is above the pot's 95%: the pot gets its full share **without the discount reserve or any other
   subsidy**, and the surplus (about 1.9%) goes to the treasury. Who bears the hook cut: the protocol's 5%. The
   customer pays the job's ETH price in SPARE at the epoch price, the pot gets 95%, and of the fee only the sale's
   surplus is left (to the treasury; the holder pool gets nothing from a SPARE job). Checked by `test_Spare_ZeroDiscountHookCutNeedsNoSubsidy`, `testFuzz_Spare_ZeroDiscountFloorCoversThePot`,
   the invariant `ZeroBurnerSpareNeedsNoCover` and the fork test `test_Fork_ZeroDiscountSpareChargeNeedsNoSubsidy`.
   The reserve mechanism stays for a later discount or burner share.
2. **Burn postponed**: initial split **treasury 350 / burner 0 / holder pool 150** bps. The Burner is still
   deployed (V2 checks it at construction) but receives nothing until the Safe changes the split (≥ 4-epoch delay).
3. **Slippage 400 bps** for V2 (`DEFAULT_MAX_SWAP_SLIPPAGE_BPS`) and the Burner (`DEFAULT_MAX_SLIPPAGE_BPS`), so the
   2.90% hook cut plus impact fits. Both stay Safe-settable (≤ 10%).

If the Safe later gives the burner a share, the SPARE leg burns `burnerBps` of the SPARE and sells the rest, and the
sale floor (e.g. 98.5% × 96% = 94.56% at burner 150) can sit just below the pot's 95%: the gap is then covered by
the charge's ETH treasury part, the reserve, or the ETH burner part, in that order (a real fill at about 97% of the
sold value still covers the pot on its own: `test_Fork_AfterSplitChange_SpareChargeAndBurnAtDefaults`).

## Defaults

| ID | Value | Where |
| --- | --- | --- |
| N1 | Split of the 5%: **treasury 350 / burner 0 / holder pool 150 bps** (owner, 26–27 Nov 2026); Safe-only change, ≥ 4-epoch delay | `DEFAULT_TREASURY_BPS`, `DEFAULT_BURNER_BPS`, `DEFAULT_HOLDER_POOL_BPS`, `SPLIT_CHANGE_DELAY_EPOCHS` (V2) |
| N2 | SPARE discount **0%** (owner, 26–27 Nov 2026) | `SPARE_DISCOUNT_BPS` (V2, constant) |
| N2b | SPARE burned = burner part of the current split on the discounted value (0 at the deployed split) | `_spareLeg` (V2), no separate number |
| N12 | Burn cap: 1% of the pool's quote-side liquidity at epoch close; slippage **4%** for the burn buy and the SPARE sale (owner, 26–27 Nov 2026); rest carried over | `maxEthPerBurn` (Burner constructor param, `[PLACEHOLDER]`, Safe-settable), `DEFAULT_MAX_SLIPPAGE_BPS` (Burner), `DEFAULT_MAX_SWAP_SLIPPAGE_BPS` (V2, reused for the SPARE sale) |
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

1. **Discount math.** With the brief's first N2 of 10% and a 5% fee, a SPARE-paid job brought in at most 90% of its
   ETH price (about 86% after the hook), but the node pot must get 95%, so every SPARE job needed a subsidy from the
   ETH leg's treasury and burner parts or the Safe-funded **discount reserve**. The owner settled this on 26–27 Nov
   2026 with N2 = 0% (see "Owner decisions"): no subsidy is needed at the deployed values. The reserve and the cover
   order remain for a later discount or burner share.
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
- **The scheduler side, not part of the payments work** (stage 4): time-weighted holder weights, exclusions and
  minimum (N11/N14/N15), holder root posting, the burns and holder pages (built separately).
- Copy changes listed in brief §0.7.

## Scheduler and dapp (behind `TOKEN_PAYMENTS_V2`)

Built in `src/server/payments-v2.ts` (with `src/server/payments.ts`), off by default. It is on only when
`TOKEN_PAYMENTS_V2=on` **and** `TOKEN_JOB_PAYMENTS_V2_ADDRESS` is a valid address. With it off every answer of the API
and every page is exactly what it was before V2. With it on, the scheduler key sends V2 transactions (the charge and the
per-epoch SPARE price), exactly as it sends the V1 charge.

- **Which contract holds a customer's money.** A paid job is charged on V1 or V2, never both (`jobs.pay_contract`).
  A wallet-signed job is charged on the contract named in its signed message; the dapp signs for V2 when the V2
  balance covers the job and for V1 otherwise ("V2 first"). An API-key job: V2 when its ETH covers the price, else V1.
  V1 balances stay usable and withdrawable; new deposits in the dapp go to V2.
- **Credits first (N21).** V2's available ETH = the credits left after the holds + the deposits not asked out minus
  the holds credits do not cover. A pending withdrawal locks only deposits. The charge checks credits + deposits.
- **SPARE.** Deposit (approve, then `depositSpare`) and two-step withdraw in the balance panel; per job the customer
  picks "ETH balance" or "SPARE balance". Held amounts are in SPARE at the reference price. SPARE jobs are refused
  (409 `spare-payments-closed`) until the Safe sets the first reference price.
- **Price posting.** At each epoch close, before the V2 charge: if the contract has no price for the open epoch and the
  Safe has set a reference, `postSparePrice(epoch, price)` with the pool's spot price from StateView `getSlot0` of the
  verified pool key (`UNISWAP_V4`), minus nothing. The contract's 20% band decides (paused = SPARE jobs wait).
- **One V2 charge per epoch**, with the same `v2-jobs-merkle` rule over V2's jobs (V1 has its own): `chargeWithSpare`
  when SPARE jobs can be charged, else `charge`. `minEthOut` = the sold SPARE's value at the posted price × (1 − 2.90%
  hook − 1% buffer), raised to the contract floor and to what the pot needs beyond the cover (fork: 0.00961 ETH for a
  0.01 ETH job against a 0.0096 floor; the sale gave 0.0096942). `previewSpareLeg` is asked first; if it, or the
  simulation of `chargeWithSpare`, refuses the SPARE leg, ETH goes alone and the SPARE jobs wait.
- **Deferred, never mispriced.** A SPARE job not charged at a close keeps its hold and records why (`no-reference`,
  `not-posted`, `paused`, `cap`, `sale`, `spare-balance`, `spend-limit`); its invoice and the balance panel show it.
  After 8 closes (`SPARE_MAX_WAIT_EPOCHS`) it is marked unpaid (D6: never taken from the customer).
- **Receipts version 2 and invoice version 2** (only while the flag is on): plus the contract (V1/V2), the asset and,
  for a charged SPARE job, the price used and the SPARE taken. The verifier checks a SPARE job against V2's
  `CustomerChargedSpare(epoch, payer, ethValue, spareAmount)`: `spareAmount = ceil(ethValue × 10^18 / price)` and
  `ethValue ≥` the job's price. The leaf and the jobs root are unchanged; saved version 1 receipts keep verifying.
- **Public charge answer**: `GET /api/v1/epochs/{id}/charges` gains a `v2` block (V2's charge of the epoch, the SPARE
  leg per customer, the epoch price record).
- **DB**: migration v13 (`pay_contract`, `pay_asset`, `spare_price`, `spare_wei`, `pay_wait`, `pay_waits`,
  `charge_leaves.contract`, tables `v2_charges` and `v2_spare_prices`). Additive only.
- **Tests**: `src/server/payments-v2.test.ts` (routing, credits-first holds, SPARE holds, price posting, paused price,
  a sale that does not fill, the wait limit, receipts v2 against V2 events, flag off), `src/lib/job-receipt.test.ts`
  (version 2 format), `E2E_V2=1 npm run e2e:local` (V2 + HolderPool + Burner + a mock adapter and StateView on anvil:
  an ETH-paid and a SPARE-paid job charged through V2 next to a V1 job charged through V1).

### After deploying (Safe)

1. **Set the first SPARE reference price** on V2: `setReferenceSparePrice(price)` (wei per 10^18 SPARE, the pool's
   spot price at that time). Until then SPARE payments are closed and the scheduler posts no price.
2. **Set the SPARE cap** if it was deployed as 0 (`setSpareCapEthPerEpoch`): 0 keeps SPARE charges off.
3. Nothing else is required: the split (350 / 0 / 150), the 0% discount and the 4% slippage are the deployed defaults.
   The Burner's `maxEthPerBurn` is a constructor value; it matters only once the Safe gives the burner a share.
4. Then set `TOKEN_PAYMENTS_V2=on` and `TOKEN_JOB_PAYMENTS_V2_ADDRESS` on the scheduler (and the V2, HolderPool and
   Burner rows in `src/lib/addresses.ts` for `/docs/contracts`).

## Tests

Run with `npm run contracts:test` (or `node contracts/tools/forge.mjs test --no-match-path "test/fork/*"`). After
the owner decisions of 26–27 Nov 2026 the non-fork suite is 351 passed (fork suites are opt-in).

| File | What it covers |
| --- | --- |
| `test/v2/SparecycleJobPaymentsV2.t.sol` (61) | Wiring and the deployed values (350 / 0 / 150, 0% discount, 4%). Burner part 0: nothing sent, events report 0. SPARE at 0% discount with a 3.07% fill below the posted price (hook + impact) pays the pot in full with no ETH leg and no reserve (unit + fuzz over value, price and fill). Three-way split after a Safe change. V1 event topics. Deposits / `depositFor` / receive. `creditFor` only from the pool. Credits first and never withdrawable (incl. fuzz). Three-way split and its conservation (fuzz). Split: Safe-only, sums to 500, ≥ 4 epochs (fuzz), cancel/re-propose. Two-step withdraw for ETH and SPARE. Price posting, band edges, deviation pauses SPARE but not ETH, Safe re-anchor. Pot gets exactly an ETH job's share (incl. moved pool price), surplus to treasury, shortfall order, deferral when not covered, reserve, min-out floor, per-epoch cap, customer limits, burn-to-dead, fee-on-transfer SPARE, fake `burn()` caught. Malicious adapter (short output, short pull, reentrant deposit / charge / withdraw, third-party ETH mid-swap). Missing holder pool refused. |
| `test/v2/SparecycleHolderPool.t.sol` (20) | Leaf format. Root rules (scheduler, closed epochs, increasing, available). Credit claim raises credit by exactly the amount, credits pay for a job and cannot be withdrawn. Double claim. Invalid proofs. Mode 2 → `NvdaModeNotAvailable`, unknown modes. `setMode` applies from N+1 only (two-mode harness + fuzz). Rollover after K = 8, never to treasury, reused by the next root. Over-allocated tree capped. Reentrant `creditFor` blocked. |
| `test/v2/SparecycleBurner.t.sol` (22) | Deployed split: the burner gets nothing from ETH or SPARE charges, `burnEpoch` reverts `NothingToBurn` without using the epoch up. 4% default fits a 3.07% short buy. Burn from charges (after a Safe split change). Scheduler only. Last-closed-epoch and once-per-epoch rules. Cap and carry-over. No-price carry-over. Min-out floor and Safe slippage. Pool moved beyond slippage. Short output. Fee-on-transfer output. Adapter refund. Dead-address mode. Reentrancy. Settings bounds. Rescue (delay, blocked by a later burn, Safe only, to the Safe only). Fuzz: ETH leaves only into buys, never over the cap. |
| `test/invariant/V2System.invariant.t.sol` (6 invariants, 256 × 64, plus 3 tests) | Every fill is 2.90% below the pool price (the hook). New: with burner part 0 a SPARE sale never needs cover. A smoke test at the deployed split (no burn ever runs). A closed set of addresses holds all the ETH, so any wei sent elsewhere fails. Exact balance of the pot, treasury, burner, pool, adapter and V2 from allowed flows only. Credits never withdrawn: each customer wallet is exact, withdrawn ≤ deposited. V2 buckets equal the per-customer sums. Pot == the ETH-equivalent share (never underpaid). SPARE supply drops only by V2's burns. Pool covers open roots. No unexpected reverts. A 600-step random walk checks that the SPARE, burn, claim and deferral paths are really reached. |
| `test/v2/DryRunDeployV2.t.sol` (1) | The dry-run deploy script wires all three. |
| `test/fork/V2Fork.t.sol` (2, opt-in) | Live chain, simulated locally. SPARE's `burn(uint256)` really lowers total supply. A V2 charge lands 95% in the live open pot with the split. A holder credit claim then pays for a job. Passed on 26 Nov 2026 against `https://rpc.mainnet.chain.robinhood.com` (around block 123,605,400). The `sparecycle.tech/api/rpc` relay refuses `eth_getStorageAt`, so the test skips there. |

| `test/adapters/UniswapV4SpareAdapterWiring.t.sol` (2) | The real adapter over a mock PoolManager with a 290 bps output fee: at the 4% defaults a SPARE-only charge sells all of its SPARE and pays the pot 95% with no reserve, a burn buy passes; a 2% setting reverts at the adapter. |
| `test/fork/V4AdapterWiringFork.t.sol` (4, opt-in) | Real adapter, live pool, live reward contract and Safe: the deployed values; a SPARE-only charge at 0% discount and burner 0 pays the live pot exactly 95% with no reserve (sale output 0.0096942 ETH for 0.01 ETH, scheduler minimum 0.00961, floor 0.0096); `NothingToBurn` after it; 2% would revert; after a Safe split change to 200 / 150 / 150 a charge burns 1.5% of the SPARE and `burnEpoch` buys and burns at the 4% default. Passed on 27 Nov 2026 around block 123,684,900. |

Run the fork suites with:

```
FORK_TESTS=1 FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com node contracts/tools/forge.mjs test --match-path test/fork/V2Fork.t.sol -vv
FORK_TESTS=1 node contracts/tools/forge.mjs test --match-path "test/fork/*V4*" -vv
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
- **Discount economics** (decision 1). At 0% discount and burner part 0 the sale pays the pot by itself. A later
  discount or burner share would need cover again, and SPARE legs that cannot be covered are deferred.
- **Credits locked forever** if unused (decision 8).
- **Deploy order** must not be interrupted (predicted addresses). The constructors revert if it is.
- **The Uniswap v4 adapter** is the riskiest part and has had internal review only. The pool's Pons hook takes
  2.90% of every swap's output; the 4% slippage leaves about 1.1% for impact and movement since the posted price
  (`docs/uniswap-v4-adapter.md`). The room is also room a sandwich can take.
- **SPARE `burn()`** was verified on a fork. A token upgrade (if any) could change it, and `SpareBurn` would then
  revert rather than mis-burn.
- **Not reviewed**: forced ETH (selfdestruct) into V2 is unaccounted and stuck; it cannot be stolen.
