// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// =====================================================================================================================
// INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED. Written and fork-tested against the live pool only; NOT deployed.
// See docs/uniswap-v4-adapter.md (addresses and how each was verified, the pool's hook, measured price impact, risks).
// =====================================================================================================================

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {ISpareSwapAdapter} from "../interfaces/ISparecycleV2.sol";
import {IPoolManagerMinimal, IUnlockCallback, PoolKey, SwapParams} from "../interfaces/IUniswapV4Minimal.sol";

/// @title UniswapV4SpareAdapter
/// @notice ISpareSwapAdapter for one fixed native-ETH / SPARE Uniswap v4 pool, calling the PoolManager directly
///         (unlock -> swap -> settle / take). Used by SparecycleBurner (buySpare) and SparecycleJobPaymentsV2
///         (sellSpare).
///
///         - Exact input only, no price limit: a swap either uses the whole input or reverts (`PartialFill`), so
///           no input is ever left over to refund.
///         - The minimum output is enforced here too, on what actually reached the recipient (buy) or the adapter
///           (sell), on top of the callers' own balance checks.
///         - No owner, no admin, no settings: every value is an immutable constructor parameter.
///         - Holds nothing between calls. Every call ends by checking that the adapter's ETH and SPARE balances are
///           what they were before it (`AdapterKeptFunds`), and ETH is accepted only from the PoolManager while one
///           of this adapter's own swaps is running.
///         - SPARE bought is taken by the PoolManager straight to `to`. ETH from a sale is taken to the adapter and
///           then sent to `to` with a plain call from the adapter, after the PoolManager is locked again
///           (SparecycleJobPaymentsV2 accepts ETH during a sale only from its swap adapter).
///         - The pool's hook runs inside `swap`; whatever fee it takes is already out of the returned delta
///           (afterSwapReturnDelta), so the output and the minimum check are net of it.
/// @dev    The PoolManager calls back only the contract that called `unlock` (v4-core), so `unlockCallback` checks
///         the caller and nothing else. Entry points are non-reentrant (transient guard).
contract UniswapV4SpareAdapter is ISpareSwapAdapter, IUnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    /// @notice v4-core TickMath bounds, one inside: no price limit in either direction.
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128739 + 1;
    uint160 internal constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;
    /// @notice v4-core StateLibrary.POOLS_SLOT: the PoolManager's `mapping(PoolId => Pool.State) _pools`.
    bytes32 internal constant POOLS_SLOT = bytes32(uint256(6));
    /// @notice Native ETH as a v4 Currency (always currency0, since it sorts first).
    address internal constant NATIVE = address(0);

    IPoolManagerMinimal public immutable poolManager;
    /// @notice SPARE: the pool's currency1.
    IERC20 public immutable spare;
    /// @notice The rest of the PoolKey: LP fee (pips), tick spacing and hooks.
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    address public immutable hooks;
    /// @notice keccak256(abi.encode(poolKey())).
    bytes32 public immutable poolId;

    error ZeroAddress();
    error NoCode(address account);
    error PoolNotInitialized(bytes32 poolId);
    error ZeroAmount();
    error AmountTooLarge(uint256 amount);
    error BadRecipient(address to);
    error NotPoolManager();
    error UnexpectedEth();
    error PartialFill(uint256 amountIn, uint256 consumed);
    error NoOutput();
    error InsufficientOutput(uint256 received, uint256 minOut);
    error PulledWrongAmount(uint256 expected, uint256 pulled);
    error EthTransferFailed();
    error AdapterKeptFunds();

    /// @param poolManager_ The Uniswap v4 PoolManager (Robinhood Chain: 0x8366a39CC670B4001A1121B8F6A443A643e40951).
    /// @param spare_ SPARE, the pool's currency1 (currency0 is native ETH).
    /// @param fee_ The PoolKey's fee (SPARE/ETH pool: 0; the hook takes its fee itself).
    /// @param tickSpacing_ The PoolKey's tick spacing (SPARE/ETH pool: 200).
    /// @param hooks_ The PoolKey's hooks (SPARE/ETH pool: the Pons v2 meme hook
    ///        0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044).
    /// @dev Reverts unless the key names an initialized pool on `poolManager_`.
    constructor(address poolManager_, address spare_, uint24 fee_, int24 tickSpacing_, address hooks_) {
        if (poolManager_ == address(0) || spare_ == address(0)) revert ZeroAddress();
        if (poolManager_.code.length == 0) revert NoCode(poolManager_);
        if (spare_.code.length == 0) revert NoCode(spare_);
        if (hooks_ != address(0) && hooks_.code.length == 0) revert NoCode(hooks_);
        bytes32 id = keccak256(abi.encode(NATIVE, spare_, fee_, tickSpacing_, hooks_));
        if (_sqrtPriceX96(IPoolManagerMinimal(poolManager_), id) == 0) revert PoolNotInitialized(id);
        poolManager = IPoolManagerMinimal(poolManager_);
        spare = IERC20(spare_);
        fee = fee_;
        tickSpacing = tickSpacing_;
        hooks = hooks_;
        poolId = id;
    }

    /// @notice ETH only from the PoolManager, and only during this adapter's own swap (the `take` of a sale).
    receive() external payable {
        if (msg.sender != address(poolManager) || !_reentrancyGuardEntered()) revert UnexpectedEth();
    }

    // ------------------------------------------------------------------------------------------------------------
    // ISpareSwapAdapter
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Swaps all of `msg.value` ETH for SPARE (exact input) and has the PoolManager send it to `to`.
    /// @return spareOut SPARE that reached `to` (measured), at least `minSpareOut`.
    function buySpare(uint256 minSpareOut, address to) external payable nonReentrant returns (uint256 spareOut) {
        _checkRecipient(to);
        uint256 ethIn = msg.value;
        _checkAmount(ethIn);
        uint256 ethBefore = address(this).balance - ethIn;
        uint256 spareBefore = spare.balanceOf(address(this));
        uint256 toBefore = spare.balanceOf(to);

        poolManager.unlock(abi.encode(true, ethIn, to, address(0)));

        spareOut = spare.balanceOf(to) - toBefore;
        if (spareOut < minSpareOut) revert InsufficientOutput(spareOut, minSpareOut);
        _checkNothingKept(ethBefore, spareBefore);
    }

    /// @notice Pulls exactly `spareIn` SPARE from the caller into the PoolManager (needs allowance), swaps it for ETH
    ///         (exact input) and sends the ETH to `to` from this adapter.
    /// @return ethOut ETH sent to `to`, at least `minEthOut`.
    function sellSpare(uint256 spareIn, uint256 minEthOut, address payable to)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        _checkRecipient(to);
        _checkAmount(spareIn);
        uint256 ethBefore = address(this).balance;
        uint256 spareBefore = spare.balanceOf(address(this));
        uint256 callerBefore = spare.balanceOf(msg.sender);

        ethOut = abi.decode(poolManager.unlock(abi.encode(false, spareIn, address(0), msg.sender)), (uint256));

        uint256 pulled = callerBefore - spare.balanceOf(msg.sender);
        if (pulled != spareIn) revert PulledWrongAmount(spareIn, pulled);
        if (address(this).balance != ethBefore + ethOut) revert AdapterKeptFunds();
        if (ethOut < minEthOut) revert InsufficientOutput(ethOut, minEthOut);
        (bool ok,) = to.call{value: ethOut}("");
        if (!ok) revert EthTransferFailed();
        _checkNothingKept(ethBefore, spareBefore);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Uniswap v4
    // ------------------------------------------------------------------------------------------------------------

    /// @notice PoolManager callback inside `unlock`: one exact-input swap, then settle the input and take the output.
    /// @dev data = (isBuy, amountIn, recipient of SPARE (buy), payer of SPARE (sell)). Returns abi.encode(output).
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        IPoolManagerMinimal pm = poolManager;
        if (msg.sender != address(pm)) revert NotPoolManager();
        (bool isBuy, uint256 amountIn, address recipient, address payer) =
            abi.decode(data, (bool, uint256, address, address));

        int256 delta = pm.swap(
            poolKey(),
            SwapParams({
                zeroForOne: isBuy,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: isBuy ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT
            }),
            ""
        );
        int128 d0 = int128(delta >> 128); // ETH
        int128 d1 = int128(delta); // SPARE
        (int128 dIn, int128 dOut) = isBuy ? (d0, d1) : (d1, d0);
        uint256 consumed = dIn < 0 ? uint256(uint128(-dIn)) : 0;
        if (consumed != amountIn) revert PartialFill(amountIn, consumed);
        if (dOut <= 0) revert NoOutput();
        uint256 out = uint256(uint128(dOut));

        if (isBuy) {
            // sync(native) clears any currency left synced earlier in the same transaction (as v4-periphery does);
            // a native settle then counts exactly msg.value.
            pm.sync(NATIVE);
            pm.settle{value: amountIn}();
            pm.take(address(spare), recipient, out);
        } else {
            pm.sync(address(spare));
            spare.safeTransferFrom(payer, address(pm), amountIn);
            pm.settle();
            pm.take(NATIVE, address(this), out);
        }
        return abi.encode(out);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    /// @notice The fixed pool key: native ETH / SPARE.
    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({currency0: NATIVE, currency1: address(spare), fee: fee, tickSpacing: tickSpacing, hooks: hooks});
    }

    /// @notice The pool's current sqrtPriceX96 (sqrt of SPARE per ETH, Q64.96), read from the PoolManager's storage.
    ///         A spot value: it moves with every swap and must not be used as a price oracle.
    function spotSqrtPriceX96() external view returns (uint160) {
        return _sqrtPriceX96(poolManager, poolId);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------------------------

    function _sqrtPriceX96(IPoolManagerMinimal pm, bytes32 id) internal view returns (uint160) {
        return uint160(uint256(pm.extsload(keccak256(abi.encodePacked(id, POOLS_SLOT)))));
    }

    function _checkRecipient(address to) internal view {
        if (to == address(0) || to == address(this) || to == address(poolManager)) revert BadRecipient(to);
    }

    function _checkAmount(uint256 amount) internal pure {
        if (amount == 0) revert ZeroAmount();
        if (amount > uint256(uint128(type(int128).max))) revert AmountTooLarge(amount);
    }

    function _checkNothingKept(uint256 ethBefore, uint256 spareBefore) internal view {
        if (address(this).balance != ethBefore || spare.balanceOf(address(this)) != spareBefore) {
            revert AdapterKeptFunds();
        }
    }
}
