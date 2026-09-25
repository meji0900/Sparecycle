// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPonsFeeEscrow} from "../../src/interfaces/IPonsFeeEscrow.sol";

/// @title MockPonsFeeEscrow
/// @notice Local/test stand-in for the Pons v2 fee escrow. Mirrors the behaviour observed on the deployed
///         escrow (`0xd3AF…Ac9e`): permissionless `credit(recipient)` / `creditToken(recipient, token, amount)`,
///         pull-based `claim()` / `claimToken(token)` paying the caller's whole balance, `NoBalance()` revert
///         on a zero balance. `pushWithTransfer` switches the native payout to a 2300-gas `transfer` so tests
///         can prove the reward contract's `receive()` works under the stipend. Never deploy to a live chain.
contract MockPonsFeeEscrow is IPonsFeeEscrow {
    using SafeERC20 for IERC20;

    error NoBalance();
    error TransferFailed();

    event Credited(address indexed recipient, address indexed from, uint256 amount);
    event CreditedToken(address indexed recipient, address indexed token, address indexed from, uint256 amount);
    event Claimed(address indexed recipient, uint256 amount);
    event ClaimedToken(address indexed recipient, address indexed token, uint256 amount);

    mapping(address => uint256) private _native;
    mapping(address => mapping(address => uint256)) private _tokens;

    /// @notice When true, native claims use `payable(msg.sender).transfer` (2300 gas) instead of a full-gas call.
    bool public pushWithTransfer;

    /// @notice Sets the native push style.
    function setPushWithTransfer(bool v) external {
        pushWithTransfer = v;
    }

    /// @notice Credits `msg.value` to `recipient` (what a Pons curve/hook does on a sweep).
    function credit(address recipient) external payable {
        require(recipient != address(0), "recipient=0");
        if (msg.value == 0) return;
        _native[recipient] += msg.value;
        emit Credited(recipient, msg.sender, msg.value);
    }

    /// @notice Pulls `amount` of `token` from the caller and credits it to `recipient`.
    function creditToken(address recipient, address token, uint256 amount) external {
        require(recipient != address(0), "recipient=0");
        if (amount == 0) return;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _tokens[recipient][token] += amount;
        emit CreditedToken(recipient, token, msg.sender, amount);
    }

    /// @inheritdoc IPonsFeeEscrow
    function claim() external {
        uint256 amount = _native[msg.sender];
        if (amount == 0) revert NoBalance();
        _native[msg.sender] = 0;
        if (pushWithTransfer) {
            payable(msg.sender).transfer(amount);
        } else {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
        emit Claimed(msg.sender, amount);
    }

    /// @inheritdoc IPonsFeeEscrow
    function claimToken(address token) external {
        uint256 amount = _tokens[msg.sender][token];
        if (amount == 0) revert NoBalance();
        _tokens[msg.sender][token] = 0;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit ClaimedToken(msg.sender, token, amount);
    }

    /// @inheritdoc IPonsFeeEscrow
    function balanceOf(address recipient) external view returns (uint256) {
        return _native[recipient];
    }

    /// @inheritdoc IPonsFeeEscrow
    function balanceOfToken(address recipient, address token) external view returns (uint256) {
        return _tokens[recipient][token];
    }
}
