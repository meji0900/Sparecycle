// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPonsFeeEscrow
/// @notice Minimal interface of the Pons v2 fee escrow on Robinhood Chain
///         (`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e`). Pons is an external protocol: this file only
///         declares the functions Sparecycle calls. Every selector below was checked against the deployed
///         bytecode (claim 0x4e71d92d, claimToken 0x32f289cf, balanceOf 0x70a08231, balanceOfToken 0xf59e38b7).
/// @dev Observed behaviour of the deployed escrow (bytecode + read-only simulation, 20 Nov 2026):
///      - `claim()` pays the caller's whole native balance with a full-gas `CALL` (not a 2300-gas `transfer`)
///        and reverts with `NoBalance()` (0xc2caa2a6) when the caller's balance is zero.
///      - `claimToken(token)` behaves the same for ERC-20 balances.
///      - Both are guarded by a reentrancy lock and pay `msg.sender` only (pull-based).
interface IPonsFeeEscrow {
    /// @notice Withdraws the caller's entire native (ETH) fee balance to the caller.
    function claim() external;

    /// @notice Withdraws the caller's entire balance of `token` to the caller.
    /// @param token The ERC-20 to withdraw.
    function claimToken(address token) external;

    /// @notice Native fee balance credited to `recipient` and not yet claimed.
    /// @param recipient The creator fee recipient.
    /// @return The claimable native balance in wei.
    function balanceOf(address recipient) external view returns (uint256);

    /// @notice ERC-20 fee balance credited to `recipient` in `token` and not yet claimed.
    /// @param recipient The creator fee recipient.
    /// @param token The ERC-20.
    /// @return The claimable token balance in the token's base units.
    function balanceOfToken(address recipient, address token) external view returns (uint256);
}
