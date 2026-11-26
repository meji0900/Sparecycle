# Uniswap v4 swap adapter (SPARE/ETH)

> **INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED.** Written, unit-tested and fork-tested against the live pool on a
> local fork. **Not deployed**: no transaction was signed or sent.

`contracts/src/adapters/UniswapV4SpareAdapter.sol` implements `ISpareSwapAdapter`
(`contracts/src/interfaces/ISparecycleV2.sol`) for the one native-ETH / SPARE Uniswap v4 pool. `SparecycleBurner`
uses `buySpare` and `SparecycleJobPaymentsV2` uses `sellSpare` (see `docs/contracts-v2.md`).

## Addresses (Robinhood Chain mainnet, chain id 4663)

Verified 27 Nov 2026. Each Uniswap contract was checked three ways:

1. It is listed under "Robinhood Chain: 4663" on Uniswap's deployment page
   (`developers.uniswap.org/docs/protocols/v4/deployments`) **and** in `github.com/Uniswap/contracts`
   (`deployments/4663.md`, `deployments/json/4663.json`).
2. It has code on-chain (`eth_getCode`).
3. Its source is verified on Sourcify (`sourcify.dev/server/v2/contract/4663/<address>`, status `match`).

| Contract | Address | Evidence |
| --- | --- | --- |
| PoolManager (v4-core) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | Uniswap list (both); 24,009 bytes of code; Sourcify match (solc 0.8.26, `lib/v4-core/src/PoolManager.sol`). Owner `0x2BAD8182C09F50c8318d769245beA52C32Be46CD`, protocol fee controller `0x6d0009504D129CF5002Dba61D9Ae8575AA79314c` (read live). |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | Uniswap list (both); code; Sourcify match; `poolManager()` = the PoolManager. |
| V4Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` | Uniswap list (both); code; Sourcify match (runtime); `poolManager()` = the PoolManager. Used by the fork tests only. |
| Universal Router 2.1.2 | `0x204FAca1764B154221e35c0d20aBb3c525710498` | `latest.UniversalRouter` in `deployments/4663.json`; listed as "Universal Router 2.1.2" in the docs; code; Sourcify match. Default of `UNISWAP_V4.universalRouter`. |
| Universal Router (earlier) | `0x8876789976dEcBfCbBbe364623C63652db8C0904` | Listed as "Universal Router" in the docs and in the JSON history; code; Sourcify match (runtime). Not used by default. |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Uniswap list (both); code; Sourcify match (runtime). Not used by the adapter. |
| SPARE | `0x012D695B94377E0c7b9EdEE3d824259BaA37cf3A` | `ADDR.spareToken`; 18 decimals, total supply 1,000,000,000 (read live). Not verified on Sourcify. |
| Pons v2 meme hook | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | `PONS.memeHook` (Pons' official list, `src/lib/pons.ts`); the pool's `hooks` in the Initialize event; Sourcify match (`PonsV2MemeHook`, solc 0.8.35, verified 2026-08-05); `poolManager()` = the PoolManager, `factory()` = `PONS.factory`. |
| LP position owner | `0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952` | `PONS.launchLocker`: `ownerOf(4367553)` on the v4 PositionManager `0x58daec3116aae6D93017bAAea7749052E8a04fA7` (Uniswap list). |

Both Universal Routers decode v4 `ExactInputSingleParams` as
`{ PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; uint256 minHopPriceX36; bytes hookData }`
(v4-periphery after 4.0; Sourcify source of both). `src/server/burns.ts` now encodes this layout (`minHopPriceX36 = 0`),
and the fork test `test_Fork_UniversalRouterBurnPayloadLayout` runs that exact payload on both routers.

## The pool

**Pool id** `0x6c779d26cc59abb9f22d348257ee013b66d2a5f0d9dcf1bb9fa9338874eab1bd`, read from the PoolManager's
`Initialize` event (topic1 = the id), block 123,451,046, tx
`0x8d9b666219ad3fcf09127b8115ae5b398fd16d296a6ab7cad1dc0c7db85274b5` (the Pons graduation). It is also the id
DexScreener lists.

| PoolKey field | Value |
| --- | --- |
| currency0 | `0x0000000000000000000000000000000000000000` (native ETH) |
| currency1 | `0x012D695B94377E0c7b9EdEE3d824259BaA37cf3A` (SPARE) |
| fee | `0` (static LP fee 0: the hook takes the fee) |
| tickSpacing | `200` |
| hooks | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` (Pons v2 meme hook) |

`keccak256(abi.encode(key))` equals the pool id (checked by `cast`, by the unit test
`test_LivePoolKeyHashesToLivePoolId`, by `src/lib/token-rules.test.ts`, and on the fork).

**Liquidity.** One position, full range (ticks −887,200 to 887,200), L = 29,277,002,188,455,996,456,113, added in the
initialize block through the v4 PositionManager; the position NFT is held by the Pons launch locker. No other
`ModifyLiquidity` event for this pool. With full-range liquidity the in-range virtual reserves are the real reserves.

**State at block 123,678,047** (StateView): sqrtPriceX96 402,068,041,980,415,802,526,053,282,136,449, tick 170,649,
protocol fee 0, LP fee 0. Spot price 38,829,344,367 wei per 10^18 SPARE (about 25.75 million SPARE per ETH). **ETH side:
5.769 ETH** (L × 2^96 / sqrtPriceX96). DexScreener had shown about 4.6 ETH; the side moves with every trade
(5.30 to 5.84 ETH during this work).

## The hook (Pons v2 meme hook)

From the verified source and the live state:

- **Permissions** (from the source and the address bits `0x2044`): `beforeInitialize`, `afterSwap`,
  `afterSwapReturnDelta`. No `beforeSwap`, no liquidity hooks.
- **`beforeInitialize`**: only the Pons factory may create a pool with this hook.
- **`afterSwap`**: takes `hookFeeBps + creatorTaxBps` of the swap's **unspecified** side straight out of the
  PoolManager (`take`) and returns it as the hook delta, so the swapper's output is reduced by it. For an exact-input
  swap the unspecified side is the output: **a buy pays the cut in SPARE, a sell pays it in ETH.**
- **SPARE pool terms** (`launches(poolId)`, read live): hookFeeBps **100**, creatorTaxBps **190** → **290 bps (2.90%)
  of every swap's output**. Creator (receives the 1.90% tax): the team wallet `0xBA839DD7…C728`. protocolFeeShareBps
  3,000, buybackBurnBps 5,000, buybackEnabled false, maxInternalPriceImpactBps 300.
- **Can it change?** The terms are copied into `launches[poolId]` at registration. No function changes `hookFeeBps` or
  `creatorTaxBps` of a registered pool (the global setters only affect pools registered later); the factory can change
  the creator recipient and the buyback flag only.
- **Restrictions**: none on swaps. No allowlist, no sender check, no size limit, no pause; `hookData` is ignored. The
  only revert in `afterSwap` is an inexact ERC-20 take (not possible with SPARE or native ETH).
- **Side effect**: the SPARE the hook collects on buys is later sold into this same pool by the Pons fee-sweep
  operator (`sweepPoolFees`, each internal swap capped at a 3% sqrt-price move). About 2.90% of every SPARE buy comes
  back as sell pressure at an unknown later time.

## Adapter design

- **Direct PoolManager calls**, one fixed pool: `unlock` → `unlockCallback` → one `swap` → settle the input → `take`
  the output. No router, no Permit2.
- **Exact input only, no price limit** (`MIN_SQRT_PRICE + 1` / `MAX_SQRT_PRICE − 1`). The swap must consume exactly
  the input or the call reverts (`PartialFill`), so there is never leftover input to refund.
- **Buy** (`buySpare(minSpareOut, to)`): settles `msg.value` as native ETH (`sync(native)` first, as v4-periphery
  does, then `settle{value}`), the PoolManager sends the SPARE straight to `to`; `minSpareOut` is checked on what `to`
  actually received.
- **Sell** (`sellSpare(spareIn, minEthOut, to)`): `sync(SPARE)`, `transferFrom(caller → PoolManager, spareIn)`,
  `settle()`, `take` the ETH **to the adapter**, then, after the PoolManager is locked again, a plain call sends it to
  `to`. The ETH must come from the adapter: `SparecycleJobPaymentsV2.receive()` accepts ETH during a sale only from its
  swap adapter. The adapter checks that exactly `spareIn` left the caller and that `minEthOut` is met.
- **Holds nothing.** No owner, no admin, no settings, nothing to withdraw. Every call ends by checking that the
  adapter's ETH and SPARE balances equal what they were before the call (`AdapterKeptFunds`). `receive()` accepts ETH
  only from the PoolManager while one of the adapter's own calls is running. It gives no allowances.
- **Guards**: `unlockCallback` accepts only the PoolManager (which calls back only the contract that called `unlock`).
  `buySpare` / `sellSpare` are `nonReentrant` (OpenZeppelin `ReentrancyGuardTransient`). Recipient 0, the adapter and
  the PoolManager are refused; amounts must be > 0 and fit in int128.
- **Constructor checks**: PoolManager and SPARE have code, the hook (if set) has code, and the key names an initialized
  pool (slot0 read through `extsload`, the v4-core `StateLibrary` slot).
- The v4 types and the five PoolManager functions it calls are written out in
  `contracts/src/interfaces/IUniswapV4Minimal.sol` (no v4-core dependency), matching the verified PoolManager source.
- Runtime size 6,989 bytes. Gas on the fork: `buySpare` about 150,000, `sellSpare` about 137,000.

### Deploy parameters

```
new UniswapV4SpareAdapter(
  0x8366a39CC670B4001A1121B8F6A443A643e40951, // poolManager_
  0x012D695B94377E0c7b9EdEE3d824259BaA37cf3A, // spare_ (currency1; currency0 is native ETH)
  0,                                          // fee_
  200,                                        // tickSpacing_
  0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044  // hooks_
)
```

Then `SparecycleBurner` and `SparecycleJobPaymentsV2` take the adapter's address as `swapAdapter_`. The Burner's
`maxEthPerBurn_` (N12: 1% of the ETH side) is about **0.058 ETH** at the state above; read it again at deploy.

## Measured cost (fork of block 123,678,047)

`FORK_TESTS=1 FORK_BLOCK=123678047 node contracts/tools/forge.mjs test --match-path "test/fork/*V4*" -vv`. "Total"
is against the spot price before the swap; "impact" is the same with the hook's 2.90% removed. Each output equals the
official V4Quoter's quote exactly.

| Swap | Output | Total cost | Price impact (excl. hook) |
| --- | --- | --- | --- |
| Buy with 0.001 ETH | 25,002.53 SPARE | 2.917% | 0.017% |
| Buy with 0.01 ETH | 249,635.89 SPARE | 3.068% | 0.173% |
| Sell the 25,002.53 SPARE back | 0.000942846 ETH | 2.916% | 0.017% |
| Sell the 249,635.89 SPARE back | 0.009428883 ETH | 3.063% | 0.168% |
| Sell SPARE worth 0.001 ETH at spot (25,753.72) | 0.000970832 ETH | 2.917% | 0.017% |
| Sell SPARE worth 0.01 ETH at spot (257,537.18) | 0.009693198 ETH | 3.068% | 0.173% |

Round trip ETH → SPARE → ETH: −5.715% (0.001 ETH) and −5.711% (0.01 ETH): the hook is paid twice. Price impact is
about size / ETH side (0.01 / 5.77 = 0.17%); the hook cut dominates at these sizes. A dump of SPARE worth 5× the ETH
side gets 4.67 of 5.77 ETH (constant product: never the whole side).

## Using it with V2 and the Burner: the slippage settings

Both contracts check a floor against the epoch's accepted SPARE price, with a 2% default slippage:

- `SparecycleBurner.maxSlippageBps` = 200 (`burnEpoch` needs `minOut ≥ value × 98%`);
- `SparecycleJobPaymentsV2.maxSwapSlippageBps` = 200 (`chargeWithSpare` needs `minEthOut ≥ sale value × 98%`).

The hook alone takes 2.90%, so **with the defaults every burn and every SPARE sale reverts at the adapter's minimum
check** (`test_Fork_DefaultSlippageIsBelowTheHookCut`). Nothing is lost: the burn's epoch stays open for a retry, and
the SPARE jobs stay uncharged (deferred). To use the adapter, either:

- the Safe raises both settings after deploy: `setMaxSlippageBps` (Burner) and `setMaxSwapSlippageBps` (V2), at most
  1,000 bps. 290 bps hook + impact + price movement since the posted price: the fork test uses **500 bps** (a test
  value, not a decision); or
- the scheduler posts a price that is already net of the hook. One price serves both directions, though, so this does
  not work for both buys and sells at once.

With 500 bps on the fork (`test_Fork_SpareChargeAndBurnEndToEnd`): a SPARE-paid charge of 0.01 ETH (231,783.47 SPARE,
sale floor 0.00842175 ETH) paid the live pot exactly 95% of both legs and burned the burner part of the SPARE; then,
after the epoch closed, `burnEpoch` spent 0.01015 ETH and burned 254,152.46 SPARE (floor 248,330.23), and SPARE's
total supply fell by exactly that.

The discount economics also change: a SPARE-paid job's sale returns about 0.9 × 0.985 × 0.969 ≈ 86% of its ETH
price, so about 9% of each SPARE job must come from the ETH treasury part, the discount reserve or the ETH burner part
(the fork test funds the reserve).

## Tests

| Suite | Tests | What |
| --- | --- | --- |
| `test/adapters/UniswapV4SpareAdapter.t.sol` | 18 (1 fuzz, 512 runs) | Against `test/mocks/MockPoolManager.sol` (v4 flash accounting: `unlock` reverts unless every delta is settled; 290 bps output fee like the hook). Key and id; the live key hashes to the live id and the hook address bits; constructor checks; buy to `to`, exact-input params and price limit; min-out at the edge; bad amounts and recipients; partial fill; zero output; sell pays ETH from the adapter; exact pull; allowance; refusing recipient; re-entry from the recipient blocked; callback only from the PoolManager; ETH only from the PoolManager during a call; fuzz buy-then-sell keeps nothing. |
| `test/adapters/UniswapV4SpareAdapterWiring.t.sol` | 2 | The real adapter (over the mock PoolManager) in V2 and the Burner: default slippage fails, Safe-raised slippage passes, V2 accepts the sale's ETH from the adapter, burns are exact. Runs in CI. |
| `test/fork/V4AdapterFork.t.sol` | 8 | Live pool. Re-reads every fact above; 0.001 / 0.01 ETH buys and sells (outputs = V4Quoter), min-out reverts at +1 wei, a large dump, the adapter keeps nothing; the burns.ts router payload on both routers. |
| `test/fork/V4AdapterWiringFork.t.sol` | 2 | Fresh V2 + Burner + HolderPool with the real adapter against the live SparecycleRewards `0x68A0…8Fe9`, the treasury Safe `0xb262…c71B` and the live pool: defaults revert; at 500 bps a SPARE-paid charge and a `burnEpoch` go through end to end. |

Fork suites are opt-in and skip cleanly without `FORK_TESTS=1` or when the RPC is unreachable
(`FORK_RPC_URL`, default the `robinhood` alias; `FORK_BLOCK` pins a block). Nothing is broadcast.

## Phase 2a (Safe-run burns) changes made with this

- `src/lib/addresses.ts`: `UNISWAP_V4_DEFAULTS` holds the verified PoolManager, StateView, Universal Router 2.1.2 and
  pool key; `UNISWAP_V4` uses them unless a `TOKEN_V4_*` variable overrides. `spareEthPoolHookCutBps = 290`. The
  PoolManager is now on the holder exclusion list with an address.
- `src/server/burns.ts`: the router payload uses the routers' real `ExactInputSingleParams` layout (with
  `minHopPriceX36 = 0`; the old layout read one word shifted), and the quote takes the hook's 2.90% off the output
  (without it, `minOut` = quote − 2% would sit above what the pool gives, and every prepared Safe transaction would
  revert). Burns stay behind `TOKEN_BURNS` (off).

## Risks

- **Not externally audited.** Internal review and tests only. The V2 contracts it plugs into are also unaudited.
- **Thin pool.** About 5.8 ETH on the ETH side. Impact is about size / ETH side; the N12 cap (1% of the side) keeps a
  burn near 1% impact. The side can shrink quickly if liquidity is moved (the LP NFT is in the Pons launch locker; what
  the locker allows was not reviewed here).
- **Hook fees.** 2.90% of every swap's output, fixed for this pool, more than the 2% slippage defaults (see above).
  A round trip costs about 5.7%. The 1.90% creator tax goes to the team wallet, so every Sparecycle burn or sale also
  pays the project's own creator tax.
- **Sandwiching and price movement.** The floor is only as good as the posted epoch price (scheduler-supplied, no
  on-chain oracle), and the raised slippage is room an attacker can take. Robinhood Chain has a sequencer and no public
  mempool, which makes classic sandwiches harder but not impossible (the sequencer, or a searcher landing just
  before). The burn and sale sizes are small and capped.
- **Hook sell pressure.** The SPARE fee from each buy is sold back into the pool later by the Pons operator.
- **Upstream changes.** The PoolManager owner can set a protocol fee on the pool (up to 0.1% per direction; 0 today).
  The adapter is immutable: a new pool (or a pool migration) means a new adapter and, because V2 and the Burner hold
  the adapter as an immutable, new V2 / Burner contracts.
- **Spot reads.** `spotSqrtPriceX96()` is the instantaneous pool price; it is a convenience view, never a price source.
- **Forced ETH** (selfdestruct) into the adapter would be stuck: there is no way out by design, and the balance checks
  compare against each call's starting balance, so it does not block later calls.
