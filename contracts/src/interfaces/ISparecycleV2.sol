// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// AUDIT REQUIRED BEFORE MAINNET. Written and tested only; not deployed. See docs/contracts-v2.md.

/// @notice The parts of the live SparecycleRewards that the V2 contracts rely on. Its `currentEpoch()` is the one
///         epoch clock of the whole system, and its `scheduler()` is the one scheduler key (rotated by the Safe in
///         SparecycleRewards, so every V2 contract follows a rotation with no change of its own).
interface ISparecycleRewardsForV2 {
    function currentEpoch() external view returns (uint64);
    function scheduler() external view returns (address);
    function payoutToken() external view returns (address);
    function fund() external payable;
}

/// @notice Swaps between native ETH and SPARE. The Uniswap v4 specifics (PoolManager unlock / swap / settle / take on
///         the SPARE/ETH pool key, and the pool's hook) live behind this interface, so the payment and burn contracts
///         never touch the pool directly and tests can use a mock.
/// @dev    A real adapter is NOT built yet. It goes in `contracts/src/adapters/UniswapV4SpareAdapter.sol`, takes the
///         Uniswap v4 PoolManager address and the SPARE/ETH PoolKey as constructor parameters ([PLACEHOLDER]: the
///         PoolManager is not in src/lib/addresses.ts yet; the pool id seen on DexScreener is third-party data and
///         must be re-read on-chain before use), and needs its own audit and a fork test against the live pool.
///         Every implementation MUST:
///         - revert when it cannot deliver at least the given minimum output;
///         - pay the output to `to` in the same call (ETH with a plain call, SPARE with `transfer`);
///         - pull no more than `spareIn` SPARE from the caller (sellSpare), and keep no allowance;
///         - never call back into the caller except to pay ETH to `to`.
///         The callers do not trust the return values: they measure their own balance changes.
interface ISpareSwapAdapter {
    /// @notice Buys SPARE with all of `msg.value` and sends at least `minSpareOut` SPARE to `to`.
    function buySpare(uint256 minSpareOut, address to) external payable returns (uint256 spareOut);

    /// @notice Pulls exactly `spareIn` SPARE from the caller (needs allowance) and sends at least `minEthOut` ETH to `to`.
    function sellSpare(uint256 spareIn, uint256 minEthOut, address payable to) external returns (uint256 ethOut);
}

/// @notice A per-epoch SPARE price in wei of ETH per 10^18 SPARE base units (per 1 SPARE when SPARE has 18 decimals).
interface ISparePriceSource {
    /// @notice The price posted for `epochId` if it passed the deviation check, otherwise 0.
    function acceptedSparePrice(uint64 epochId) external view returns (uint256);
}

/// @notice SPARE's own burn function (the brief reads `burn(uint256)` in the bytecode; confirm on verified source).
interface ISpareBurnable {
    function burn(uint256 amount) external;
}

/// @notice What SparecycleJobPaymentsV2 checks on the burner it is deployed with.
interface ISparecycleBurnerConfig {
    function rewards() external view returns (address);
    function spare() external view returns (address);
    function priceSource() external view returns (address);
    function useBurnFunction() external view returns (bool);
}

/// @notice What SparecycleHolderPool calls on SparecycleJobPaymentsV2.
interface IJobPaymentsV2ForHolderPool {
    function holderPool() external view returns (address);
    function rewards() external view returns (address);
    function creditFor(address customer) external payable;
}
