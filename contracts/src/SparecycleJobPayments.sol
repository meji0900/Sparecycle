// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The parts of SparecycleRewards this contract relies on.
interface ISparecycleRewardsForPayments {
    function currentEpoch() external view returns (uint64);
    function scheduler() external view returns (address);
    function payoutToken() external view returns (address);
    function fund() external payable;
}

/// @title SparecycleJobPayments
/// @notice Non-custodial prepaid balances for Sparecycle jobs, paid in ETH.
///
///         Customers `deposit` ETH; their balance is held here, not by any server wallet, and only they can
///         withdraw it. Once per epoch the scheduler of the live reward contract calls `charge` with the
///         amounts owed for that epoch's verified jobs. A charge can go to exactly two places: 95% into the
///         reward contract's open-epoch pot (through its public `fund()`, so it is paid to node operators by
///         the same Merkle root as the Pons fees) and 5% to a fixed treasury address (a multisig). There is no
///         owner, no admin function and no other way for anyone to move a customer's balance.
///
///         Protections for customers against a faulty or compromised scheduler key:
///         - an optional per-epoch spend limit each customer sets for themselves (`setSpendLimit`);
///         - charges only for the reward contract's open epoch, so the money lands in that epoch's pot;
///         - every charge emits the hash of the published charge list and one event per customer.
///
///         Withdrawals are two-step so that jobs already run can still be charged: `requestWithdraw`, then
///         `withdraw` once the reward contract has closed both the request's epoch and the next one (a job has
///         at most one epoch to reach a verdict), or after `WITHDRAW_TIMEOUT` if epochs stop closing. The
///         requested amount stops being spendable on new jobs (enforced by the scheduler off-chain); the
///         withdrawal pays out min(requested, balance at withdrawal).
contract SparecycleJobPayments is ReentrancyGuard {
    /// @notice Share of every charge sent to the treasury, in basis points (5%). Fixed.
    uint16 public constant TREASURY_BPS = 500;
    /// @notice A withdrawal request becomes executable after this long even if no epoch closes.
    uint64 public constant WITHDRAW_TIMEOUT = 2 days;

    /// @notice The live reward contract (ETH payout mode). Its scheduler is the only charger.
    ISparecycleRewardsForPayments public immutable rewards;
    /// @notice Receives TREASURY_BPS of every charge. Intended: a Safe multisig.
    address public immutable treasury;

    struct WithdrawRequest {
        uint128 amount;
        uint64 epoch; // reward-contract epoch when requested
        uint64 requestedAt; // timestamp
    }

    mapping(address => uint256) public balanceOf;
    /// @notice Max a customer can be charged per epoch; 0 = no limit.
    mapping(address => uint256) public spendLimitPerEpoch;
    mapping(address => mapping(uint64 => uint256)) public chargedInEpoch;
    mapping(address => WithdrawRequest) public withdrawRequestOf;
    /// @notice Sum of all customer balances. `address(this).balance >= totalBalance` always holds.
    uint256 public totalBalance;

    event Deposited(address indexed customer, uint256 amount, uint256 balance);
    event SpendLimitSet(address indexed customer, uint256 limit);
    event WithdrawRequested(address indexed customer, uint256 amount, uint64 epoch, uint64 requestedAt);
    event WithdrawCancelled(address indexed customer);
    event Withdrawn(address indexed customer, uint256 amount);
    event CustomerCharged(uint64 indexed epochId, address indexed customer, uint256 amount);
    event Charged(uint64 indexed epochId, bytes32 indexed listHash, uint256 total, uint256 toPot, uint256 toTreasury);

    error ZeroAddress();
    error NotEthRewards();
    error ZeroAmount();
    error NotScheduler();
    error WrongEpoch(uint64 given, uint64 open);
    error LengthMismatch();
    error InsufficientBalance(address customer, uint256 balance, uint256 amount);
    error SpendLimitExceeded(address customer, uint256 limit, uint256 wouldBe);
    error NoWithdrawRequest();
    error WithdrawLocked(uint64 openEpoch, uint64 unlocksAtEpoch, uint64 unlocksAt);
    error TransferFailed();

    constructor(address rewards_, address treasury_) {
        if (rewards_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (ISparecycleRewardsForPayments(rewards_).payoutToken() != address(0)) revert NotEthRewards();
        rewards = ISparecycleRewardsForPayments(rewards_);
        treasury = treasury_;
    }

    // ------------------------------------------------------------------------------------------------
    // Customers
    // ------------------------------------------------------------------------------------------------

    /// @notice Adds ETH to the caller's balance.
    function deposit() external payable {
        _deposit(msg.sender, msg.value);
    }

    /// @notice Plain ETH transfers are deposits for the sender.
    receive() external payable {
        _deposit(msg.sender, msg.value);
    }

    /// @notice Caps what the scheduler may charge the caller per epoch. 0 removes the cap.
    function setSpendLimit(uint256 limit) external {
        spendLimitPerEpoch[msg.sender] = limit;
        emit SpendLimitSet(msg.sender, limit);
    }

    /// @notice Starts a withdrawal of `amount` (replaces any earlier request and restarts its wait).
    function requestWithdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientBalance(msg.sender, bal, amount);
        uint64 epoch = rewards.currentEpoch();
        withdrawRequestOf[msg.sender] = WithdrawRequest(uint128(amount), epoch, uint64(block.timestamp));
        emit WithdrawRequested(msg.sender, amount, epoch, uint64(block.timestamp));
    }

    /// @notice Drops the caller's pending withdrawal request.
    function cancelWithdraw() external {
        if (withdrawRequestOf[msg.sender].amount == 0) revert NoWithdrawRequest();
        delete withdrawRequestOf[msg.sender];
        emit WithdrawCancelled(msg.sender);
    }

    /// @notice Whether `customer`'s request can be executed now.
    function canWithdraw(address customer) public view returns (bool) {
        WithdrawRequest memory r = withdrawRequestOf[customer];
        if (r.amount == 0) return false;
        return rewards.currentEpoch() >= r.epoch + 2 || block.timestamp >= uint256(r.requestedAt) + WITHDRAW_TIMEOUT;
    }

    /// @notice Pays out the caller's request: min(requested, current balance).
    function withdraw() external nonReentrant {
        WithdrawRequest memory r = withdrawRequestOf[msg.sender];
        if (r.amount == 0) revert NoWithdrawRequest();
        if (!canWithdraw(msg.sender)) {
            revert WithdrawLocked(rewards.currentEpoch(), r.epoch + 2, r.requestedAt + WITHDRAW_TIMEOUT);
        }
        uint256 bal = balanceOf[msg.sender];
        uint256 amount = r.amount < bal ? r.amount : bal;
        delete withdrawRequestOf[msg.sender];
        balanceOf[msg.sender] = bal - amount;
        totalBalance -= amount;
        emit Withdrawn(msg.sender, amount);
        if (amount > 0) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
    }

    // ------------------------------------------------------------------------------------------------
    // Scheduler
    // ------------------------------------------------------------------------------------------------

    /// @notice Charges customers for the verified jobs of the open epoch `epochId`: 95% to the reward
    ///         contract's pot, 5% to the treasury. `listHash` commits to the published per-job charge list.
    function charge(uint64 epochId, address[] calldata customers, uint256[] calldata amounts, bytes32 listHash)
        external
        nonReentrant
    {
        if (msg.sender != rewards.scheduler()) revert NotScheduler();
        uint64 open = rewards.currentEpoch();
        if (epochId != open) revert WrongEpoch(epochId, open);
        if (customers.length != amounts.length || customers.length == 0) revert LengthMismatch();

        uint256 total;
        for (uint256 i; i < customers.length; ++i) {
            _chargeOne(epochId, customers[i], amounts[i]);
            total += amounts[i];
        }
        totalBalance -= total;

        uint256 toTreasury = (total * TREASURY_BPS) / 10_000;
        uint256 toPot = total - toTreasury;
        emit Charged(epochId, listHash, total, toPot, toTreasury);

        rewards.fund{value: toPot}();
        if (toTreasury > 0) {
            (bool ok,) = treasury.call{value: toTreasury}("");
            if (!ok) revert TransferFailed();
        }
    }

    // ------------------------------------------------------------------------------------------------

    function _chargeOne(uint64 epochId, address c, uint256 a) internal {
        if (a == 0) revert ZeroAmount();
        uint256 bal = balanceOf[c];
        if (a > bal) revert InsufficientBalance(c, bal, a);
        uint256 spent = chargedInEpoch[c][epochId] + a;
        uint256 limit = spendLimitPerEpoch[c];
        if (limit != 0 && spent > limit) revert SpendLimitExceeded(c, limit, spent);
        chargedInEpoch[c][epochId] = spent;
        balanceOf[c] = bal - a;
        emit CustomerCharged(epochId, c, a);
    }

    function _deposit(address customer, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[customer] + amount;
        balanceOf[customer] = bal;
        totalBalance += amount;
        emit Deposited(customer, amount, bal);
    }
}
