// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// AUDIT REQUIRED BEFORE MAINNET. Written and tested only; not deployed. See docs/contracts-v2.md.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISpareBurnable} from "../interfaces/ISparecycleV2.sol";

/// @title SpareBurn
/// @notice Burns SPARE held by the calling contract, in one of two ways fixed at deploy:
///         - `useBurnFunction == true`: SPARE's own `burn(uint256)`. The total supply must drop by exactly `amount`,
///           so a token whose `burn` turns out to be something else makes the burn revert instead of passing.
///         - `useBurnFunction == false`: a transfer to 0x000000000000000000000000000000000000dEaD.
///         Either way the caller's balance must drop by exactly `amount`.
library SpareBurn {
    using SafeERC20 for IERC20;

    /// @notice The conventional dead address (named in the brief, section 4).
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice The burn moved a different amount than asked (balance or total supply).
    error BurnMismatch(uint256 expected, uint256 actual);

    function burn(IERC20 token, uint256 amount, bool useBurnFunction) internal {
        if (amount == 0) return;
        uint256 balBefore = token.balanceOf(address(this));
        if (useBurnFunction) {
            uint256 supplyBefore = token.totalSupply();
            ISpareBurnable(address(token)).burn(amount);
            uint256 supplyDrop = supplyBefore - token.totalSupply();
            if (supplyDrop != amount) revert BurnMismatch(amount, supplyDrop);
        } else {
            token.safeTransfer(DEAD, amount);
        }
        uint256 balDrop = balBefore - token.balanceOf(address(this));
        if (balDrop != amount) revert BurnMismatch(amount, balDrop);
    }
}
