// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// =====================================================================================================================
// AUDIT REQUIRED BEFORE MAINNET. Written and tested only; NOT deployed. Every value marked "Default, not yet confirmed
// by Fabio" comes from section 10 of the next-update brief and is a starting point, not an approved number.
// =====================================================================================================================

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {ISparecycleRewardsForV2, IJobPaymentsV2ForHolderPool} from "./interfaces/ISparecycleV2.sol";

/// @title SparecycleHolderPool
/// @notice Holder share of the 5% fee (brief section 6), credit mode only. Modelled on SparecycleRewards.
///
///         - Inflows: the holder-pool part of every SparecycleJobPaymentsV2 charge (and, before V2, the Safe's
///           transfers). Everything held and not reserved for a posted root is `available()` for the next root.
///         - `postRoot(epochId, root, totalEth)`: scheduler only, for a closed epoch, epochs strictly increasing (an
///           epoch that is skipped can never be posted later). `totalEth` (the sum of the leaves) must fit in
///           `available()`. Claims for it are open for UNCLAIMED_ROLLOVER_EPOCHS epochs after posting (N19).
///         - `claim(epochId, mode, amount, proof)`: leaf = keccak256(abi.encodePacked(uint64 epochId, address holder,
///           uint8 mode, uint256 amount)), OpenZeppelin sorted-pair tree (same as the reward contract). Mode 1
///           (credits) calls `creditFor(holder)` on V2 with the amount in the same transaction, so nothing is held in
///           between and the result is spend-only credit. Mode 2 (tokenized NVDA) is part of the leaf format but NOT
///           available: it reverts `NvdaModeNotAvailable` (gates G1-G3 of brief 6.6 have not passed).
///         - `setMode(mode)`: stored per holder, effective from the next epoch, `ModeSet(holder, mode, effectiveEpoch)`.
///           Holders who never chose get DEFAULT_MODE (credits, N18). Only credits can be chosen today.
///         - Unclaimed shares roll back into `available()` once their claim window ends (`rollExpired`, also run
///           inside every `postRoot`). They never go to the treasury: the only way ETH leaves is `creditFor`.
/// @dev    No owner functions over ETH. The treasury Safe can only rescue ERC-20s sent here by mistake.
contract SparecycleHolderPool is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;

    /// @notice Mode 1: compute credits in SparecycleJobPaymentsV2 (spend-only).
    uint8 public constant MODE_CREDITS = 1;
    /// @notice Mode 2: tokenized NVDA. Reserved in the leaf format; claims and `setMode` revert (not built).
    uint8 public constant MODE_NVDA = 2;
    /// @notice N18: mode of holders who never chose. Default, not yet confirmed by Fabio.
    uint8 public constant DEFAULT_MODE = MODE_CREDITS;
    /// @notice N19: a root's unclaimed shares roll back into the pool this many epochs after it is posted.
    ///         Default, not yet confirmed by Fabio.
    uint64 public constant UNCLAIMED_ROLLOVER_EPOCHS = 8;
    /// @notice Most expired roots `postRoot` rolls over on its own (`rollExpired` does the rest).
    uint256 public constant MAX_ROLLS_PER_POST = 16;

    ISparecycleRewardsForV2 public immutable rewards;
    IJobPaymentsV2ForHolderPool public immutable payments;
    /// @notice The treasury Safe: only for rescuing ERC-20s sent here by mistake.
    address public immutable treasury;

    /// @notice One posted root.
    struct RootInfo {
        bytes32 root;
        uint256 total; // sum of the leaves, reserved out of the pool
        uint256 claimed;
        uint64 postedInEpoch; // reward-contract epoch at posting
        uint64 claimableUntilEpoch; // last epoch in which claims are accepted
        bool posted;
        bool rolledOver;
    }

    mapping(uint64 epochId => RootInfo) private _roots;
    mapping(uint64 epochId => mapping(address holder => bool)) private _claimed;
    mapping(address holder => Checkpoints.Trace208) private _modes;
    /// @notice Posted epoch ids in posting order (strictly increasing).
    uint64[] public postedEpochs;
    /// @notice Index into `postedEpochs` of the next root to check for rollover.
    uint256 public nextRollIndex;
    /// @notice The lowest epoch id `postRoot` accepts.
    uint64 public nextPostableEpoch;
    /// @notice Sum over posted, not rolled-over roots of (total - claimed).
    uint256 public outstanding;

    event Funded(address indexed from, uint256 amount);
    event RootPosted(uint64 indexed epochId, bytes32 root, uint256 totalEth, uint64 claimableUntilEpoch);
    event Claimed(uint64 indexed epochId, address indexed holder, uint8 mode, uint256 amount);
    event RolledOver(uint64 indexed epochId, uint256 unclaimed);
    event ModeSet(address indexed holder, uint8 mode, uint64 effectiveEpoch);
    event TokenRescued(address indexed token, uint256 amount);

    error ZeroAddress();
    error WrongPayments();
    error NotScheduler();
    error NotTreasury();
    error EpochNotClosed(uint64 epochId, uint64 open);
    error EpochNotPostable(uint64 epochId, uint64 nextPostable);
    error EmptyRootWithTotal();
    error TotalExceedsAvailable(uint256 total, uint256 available);
    error NotPosted(uint64 epochId);
    error ClaimWindowClosed(uint64 epochId, uint64 claimableUntilEpoch);
    error AlreadyClaimed();
    error InvalidProof();
    error ClaimExceedsTotal();
    error NvdaModeNotAvailable();
    error UnknownMode(uint8 mode);

    /// @param rewards_ The live SparecycleRewards (epoch clock, scheduler).
    /// @param payments_ SparecycleJobPaymentsV2, which must have been deployed with `holderPool == address(this)`.
    /// @param treasury_ The treasury Safe (`ADDR.treasurySafe`).
    constructor(address rewards_, address payments_, address treasury_) {
        if (rewards_ == address(0) || payments_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        IJobPaymentsV2ForHolderPool p = IJobPaymentsV2ForHolderPool(payments_);
        if (p.holderPool() != address(this) || p.rewards() != rewards_) revert WrongPayments();
        rewards = ISparecycleRewardsForV2(rewards_);
        payments = p;
        treasury = treasury_;
        nextPostableEpoch = ISparecycleRewardsForV2(rewards_).currentEpoch();
    }

    /// @notice Accepts ETH with no storage writes (V2 pushes the holder part here inside its charge).
    receive() external payable {}

    /// @notice Adds `msg.value` to the pool with an event (for transfers that should show on the holder page).
    function fund() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------------------------------------------------

    /// @notice ETH not reserved for any open root: what the next root can distribute.
    function available() public view returns (uint256) {
        uint256 bal = address(this).balance;
        return bal > outstanding ? bal - outstanding : 0;
    }

    function getRoot(uint64 epochId) external view returns (RootInfo memory) {
        return _roots[epochId];
    }

    function hasClaimed(uint64 epochId, address holder) external view returns (bool) {
        return _claimed[epochId][holder];
    }

    function postedCount() external view returns (uint256) {
        return postedEpochs.length;
    }

    /// @notice The mode that applies to `holder` in `epochId` (DEFAULT_MODE when never chosen).
    function modeOf(address holder, uint64 epochId) public view returns (uint8) {
        uint208 m = _modes[holder].upperLookupRecent(uint48(epochId));
        return m == 0 ? DEFAULT_MODE : uint8(m);
    }

    /// @notice The mode that applies to `holder` in the open epoch.
    function currentModeOf(address holder) external view returns (uint8) {
        return modeOf(holder, rewards.currentEpoch());
    }

    /// @notice The Merkle leaf for (epochId, holder, mode, amount).
    function leafOf(uint64 epochId, address holder, uint8 mode, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(epochId, holder, mode, amount));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Holders
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Chooses how the caller receives future shares, from the next epoch on. Only credits today.
    function setMode(uint8 mode) external {
        _checkSelectableMode(mode);
        uint64 eff = rewards.currentEpoch() + 1;
        _modes[msg.sender].push(uint48(eff), mode);
        emit ModeSet(msg.sender, mode, eff);
    }

    /// @notice Claims the caller's share of `epochId`. Credit mode adds it as spend-only credit in V2 at once.
    function claim(uint64 epochId, uint8 mode, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        RootInfo storage r = _roots[epochId];
        if (!r.posted) revert NotPosted(epochId);
        if (r.rolledOver || rewards.currentEpoch() > r.claimableUntilEpoch) {
            revert ClaimWindowClosed(epochId, r.claimableUntilEpoch);
        }
        if (_claimed[epochId][msg.sender]) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(proof, r.root, leafOf(epochId, msg.sender, mode, amount))) {
            revert InvalidProof();
        }
        _checkMode(mode);
        uint256 newClaimed = r.claimed + amount;
        if (newClaimed > r.total) revert ClaimExceedsTotal();

        _claimed[epochId][msg.sender] = true;
        r.claimed = newClaimed;
        outstanding -= amount;
        emit Claimed(epochId, msg.sender, mode, amount);

        if (amount != 0) payments.creditFor{value: amount}(msg.sender);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Scheduler
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Posts the holder tree of the closed epoch `epochId`. Rolls expired roots over first, so their
    ///         unclaimed shares are in `available()` for this root.
    function postRoot(uint64 epochId, bytes32 root, uint256 totalEth) external nonReentrant {
        if (msg.sender != rewards.scheduler()) revert NotScheduler();
        uint64 open = rewards.currentEpoch();
        if (epochId >= open) revert EpochNotClosed(epochId, open);
        if (epochId < nextPostableEpoch) revert EpochNotPostable(epochId, nextPostableEpoch);
        if (root == bytes32(0) && totalEth != 0) revert EmptyRootWithTotal();
        _rollExpired(MAX_ROLLS_PER_POST);
        uint256 avail = available();
        if (totalEth > avail) revert TotalExceedsAvailable(totalEth, avail);

        uint64 until = open + UNCLAIMED_ROLLOVER_EPOCHS;
        _roots[epochId] = RootInfo({
            root: root,
            total: totalEth,
            claimed: 0,
            postedInEpoch: open,
            claimableUntilEpoch: until,
            posted: true,
            rolledOver: false
        });
        postedEpochs.push(epochId);
        nextPostableEpoch = epochId + 1;
        outstanding += totalEth;
        emit RootPosted(epochId, root, totalEth, until);
    }

    /// @notice Rolls the unclaimed shares of up to `maxRoots` expired roots back into the pool. Anyone can call it.
    function rollExpired(uint256 maxRoots) external nonReentrant returns (uint256 rolled) {
        rolled = _rollExpired(maxRoots);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Treasury Safe
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Sends an ERC-20 sent here by mistake to the treasury. There is no way to move ETH.
    function rescueToken(address token, uint256 amount) external nonReentrant {
        if (msg.sender != treasury) revert NotTreasury();
        IERC20(token).safeTransfer(treasury, amount);
        emit TokenRescued(token, amount);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------------------------

    function _checkMode(uint8 mode) internal pure {
        if (mode == MODE_NVDA) revert NvdaModeNotAvailable();
        if (mode != MODE_CREDITS) revert UnknownMode(mode);
    }

    /// @dev Modes `setMode` accepts. Same as the claimable modes; virtual only so a test harness can exercise the
    ///      next-epoch timing with two modes (with one selectable mode the timing is not observable).
    function _checkSelectableMode(uint8 mode) internal view virtual {
        _checkMode(mode);
    }

    /// @dev Roots are posted with non-decreasing `claimableUntilEpoch`, so the expired ones are a prefix.
    function _rollExpired(uint256 maxRoots) internal returns (uint256 rolled) {
        uint64 cur = rewards.currentEpoch();
        uint256 i = nextRollIndex;
        uint256 n = postedEpochs.length;
        while (i < n && rolled < maxRoots) {
            uint64 e = postedEpochs[i];
            RootInfo storage r = _roots[e];
            if (cur <= r.claimableUntilEpoch) break;
            uint256 unclaimed = r.total - r.claimed;
            r.rolledOver = true;
            outstanding -= unclaimed;
            emit RolledOver(e, unclaimed);
            ++i;
            ++rolled;
        }
        nextRollIndex = i;
    }
}
