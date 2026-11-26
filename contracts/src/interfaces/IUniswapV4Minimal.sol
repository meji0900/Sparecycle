// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED. See docs/uniswap-v4-adapter.md.

/// @notice The few Uniswap v4-core types and PoolManager functions UniswapV4SpareAdapter uses, written out so the
///         contracts build without the v4-core repository. Each matches the v4-core source verified on Sourcify for
///         the PoolManager at 0x8366a39CC670B4001A1121B8F6A443A643e40951 (Robinhood Chain 4663, solc 0.8.26):
///         - `Currency` and `IHooks` are addresses in the ABI (native ETH is address(0));
///         - `BalanceDelta` is an int256 with amount0 in the upper 128 bits and amount1 in the lower 128 bits, both
///           signed and seen from the caller (negative: the caller owes the PoolManager; positive: it may take);
///         - the pool state of `id` starts at storage slot keccak256(abi.encodePacked(id, POOLS_SLOT = 6)), whose
///           lower 160 bits are slot0's sqrtPriceX96 (v4-core StateLibrary).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    /// @dev Negative: exact input; positive: exact output.
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManagerMinimal {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
    function extsload(bytes32 slot) external view returns (bytes32 value);
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
