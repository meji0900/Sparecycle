// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// =====================================================================================================================
//  INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED.
//  x402 pay-per-job, option X1 (docs/x402-decision.md). Launched capped: per-job, total and per-payer-per-epoch limits,
//  all adjustable by the owner Safe. Not deployed by this repository; see contracts/script/DeployX402Escrow.s.sol.
// =====================================================================================================================

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice EIP-3009 signed transfers (the `exact` x402 scheme's default transfer method on EVM).
interface IEIP3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @notice The parts of SparecycleRewards this contract relies on.
interface ISparecycleRewardsForEscrow {
    function scheduler() external view returns (address);
    function currentEpoch() external view returns (uint64);
    function payoutToken() external view returns (address);
    function fundToken(uint256 amount) external;
}

/// @title SparecycleX402Escrow
/// @notice Non-custodial per-job escrow for x402 pay-per-job (option X1). One escrow per job, keyed by
///         `escrowId = keccak256(abi.encode(jobId, salt))` so the public events do not name the job.
///
///         fund     The scheduler of the live reward contract submits the payer's signed EIP-3009 authorization
///                  (to = this contract, value = the quoted price). The token moves from the payer into this contract
///                  and the escrow records payer, amount and a deadline (now + `settleWindow`). The job is queued only
///                  after this transaction succeeds.
///         forward  Two nodes agreed: the scheduler forwards. `TREASURY_BPS` (5%) goes to the treasury; the rest goes
///                  into the reward contract's open-epoch pot when the pot is paid in this asset (`fundToken`), or
///                  else to `forwardTo` (set by the owner Safe) for conversion into the pot's asset, with an event.
///                  Nothing reaches the pot or the conversion address before agreement.
///         refund   The results did not match, the job expired or was rejected: the scheduler refunds the payer. After
///                  the deadline anyone can refund, so a stuck or lost scheduler key cannot keep a payment.
///
///         Every escrow ends exactly once, forwarded or refunded. There is no other way out for escrowed funds: the
///         owner (the treasury Safe) can only set `forwardTo`, set the launch caps, pause new escrows, and recover
///         tokens that are in no escrow (a direct transfer, or an authorization submitted to the token directly).
///
///         Capped launch (internal review only, not externally audited): `maxPerJob`, `maxTotalHeld` and
///         `maxPerPayerPerEpoch` (funded per payer per reward-contract epoch, refunds included) limit the exposure.
///
///         Known limits (see docs/x402-decision.md): fee-on-transfer tokens are refused (`AmountMismatch`); a payer
///         address frozen by the token issuer cannot be refunded until it is unfrozen; if the issuer freezes or wipes
///         this contract's own balance, escrows cannot settle.
contract SparecycleX402Escrow is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Share of every forwarded payment sent to the treasury, in basis points (5%), as in SparecycleJobPayments.
    uint16 public constant TREASURY_BPS = 500;
    /// @notice Bounds of `settleWindow` (job TTL plus a margin for the settlement transaction).
    uint64 public constant MIN_SETTLE_WINDOW = 1 hours;
    uint64 public constant MAX_SETTLE_WINDOW = 7 days;

    enum State {
        None,
        Held,
        Forwarded,
        Refunded
    }

    struct Escrow {
        address payer;
        uint64 deadline; // after this, anyone can refund and the scheduler can no longer forward
        State state;
        uint256 amount;
    }

    /// @notice The live reward contract. Its `scheduler()` is the only key that funds, forwards or refunds early.
    ISparecycleRewardsForEscrow public immutable rewards;
    /// @notice The one payment asset of this escrow (an EIP-3009 token).
    IERC20 public immutable asset;
    /// @notice Receives TREASURY_BPS of every forwarded payment. Intended: the treasury Safe.
    address public immutable treasury;
    /// @notice Seconds from funding to the refund deadline.
    uint64 public immutable settleWindow;
    /// @notice True when the reward pot is paid in `asset` (forward funds the pot directly); false when the pot is
    ///         paid in another asset (ETH today), so forward sends the pot share to `forwardTo` for conversion.
    bool public immutable potPaysInAsset;

    /// @notice Receives the pot share of forwarded payments for conversion when `potPaysInAsset` is false.
    address public forwardTo;
    uint256 public maxPerJob;
    uint256 public maxTotalHeld;
    /// @notice Most a payer can fund per reward-contract epoch (every funded escrow counts, also one refunded later).
    uint256 public maxPerPayerPerEpoch;
    /// @notice Funded per payer per reward-contract epoch.
    mapping(address => mapping(uint64 => uint256)) public fundedInEpoch;
    /// @notice True: no new escrow can be funded. Forward and refund always work.
    bool public fundingPaused;
    /// @notice Sum of all held escrows. `asset.balanceOf(this) >= totalHeld` always holds.
    uint256 public totalHeld;

    mapping(bytes32 => Escrow) public escrows;

    event Funded(bytes32 indexed escrowId, address indexed payer, uint256 amount, uint64 deadline, bytes32 authorizationNonce);
    /// @param potRecipient The reward contract (pot paid in this asset) or `forwardTo` (sent for conversion).
    event Forwarded(
        bytes32 indexed escrowId,
        address indexed payer,
        uint256 amount,
        uint256 toPot,
        uint256 toTreasury,
        address potRecipient,
        bool forConversion
    );
    event Refunded(bytes32 indexed escrowId, address indexed payer, uint256 amount, bool byScheduler);
    event ForwardToSet(address indexed previous, address indexed next);
    event CapsSet(uint256 maxPerJob, uint256 maxTotalHeld, uint256 maxPerPayerPerEpoch);
    event FundingPausedSet(bool paused);
    event SurplusRecovered(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroEscrowId();
    error NotAContract();
    error BadSettleWindow();
    error BadCaps();
    error NotScheduler();
    error FundingIsPaused();
    error EscrowExists(bytes32 escrowId);
    error OverJobCap(uint256 amount, uint256 maxPerJob);
    error OverTotalCap(uint256 wouldHold, uint256 maxTotalHeld);
    error OverPayerEpochCap(address payer, uint256 wouldBe, uint256 maxPerPayerPerEpoch);
    error AmountMismatch(uint256 expected, uint256 received);
    error NotHeld(bytes32 escrowId);
    error DeadlinePassed(bytes32 escrowId, uint64 deadline);
    error TooEarly(bytes32 escrowId, uint64 deadline);
    error PotFundingMismatch(uint256 expected, uint256 sent);
    error NothingToRecover();
    error RenounceDisabled();

    /// @param admin Owner: the treasury Safe. Sets `forwardTo` and the caps; never moves escrowed funds.
    /// @param rewards_ The live SparecycleRewards.
    /// @param asset_ The EIP-3009 payment asset (must have code).
    /// @param treasury_ Receives 5% of forwarded payments.
    /// @param forwardTo_ Receives the pot share for conversion when the pot is not paid in `asset_`.
    /// @param settleWindow_ Seconds from funding to the refund deadline, in [MIN_SETTLE_WINDOW, MAX_SETTLE_WINDOW].
    /// @param caps [maxPerJob, maxTotalHeld, maxPerPayerPerEpoch], all non-zero, maxTotalHeld >= maxPerJob.
    constructor(
        address admin,
        address rewards_,
        address asset_,
        address treasury_,
        address forwardTo_,
        uint64 settleWindow_,
        uint256[3] memory caps
    ) Ownable(admin) {
        if (rewards_ == address(0) || asset_ == address(0) || treasury_ == address(0) || forwardTo_ == address(0)) {
            revert ZeroAddress();
        }
        if (asset_.code.length == 0 || rewards_.code.length == 0) revert NotAContract();
        if (settleWindow_ < MIN_SETTLE_WINDOW || settleWindow_ > MAX_SETTLE_WINDOW) revert BadSettleWindow();
        rewards = ISparecycleRewardsForEscrow(rewards_);
        asset = IERC20(asset_);
        treasury = treasury_;
        settleWindow = settleWindow_;
        potPaysInAsset = ISparecycleRewardsForEscrow(rewards_).payoutToken() == asset_;
        forwardTo = forwardTo_;
        emit ForwardToSet(address(0), forwardTo_);
        _setCaps(caps[0], caps[1], caps[2]);
    }

    modifier onlyScheduler() {
        if (msg.sender != rewards.scheduler()) revert NotScheduler();
        _;
    }

    // ------------------------------------------------------------------------------------------------
    // Scheduler
    // ------------------------------------------------------------------------------------------------

    /// @notice Pulls the payer's signed authorization into a new escrow `escrowId`.
    /// @dev The authorization must name this contract as `to` and `amount` as `value`; the token checks the signature,
    ///      the validity window and that the nonce is unused. The measured balance increase must equal `amount`.
    function fund(
        bytes32 escrowId,
        address payer,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 authorizationNonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant onlyScheduler {
        if (fundingPaused) revert FundingIsPaused();
        if (escrowId == bytes32(0)) revert ZeroEscrowId();
        if (payer == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (escrows[escrowId].state != State.None) revert EscrowExists(escrowId);
        if (amount > maxPerJob) revert OverJobCap(amount, maxPerJob);
        uint256 held = totalHeld + amount;
        if (held > maxTotalHeld) revert OverTotalCap(held, maxTotalHeld);
        uint64 epoch = rewards.currentEpoch();
        uint256 payerEpoch = fundedInEpoch[payer][epoch] + amount;
        if (payerEpoch > maxPerPayerPerEpoch) revert OverPayerEpochCap(payer, payerEpoch, maxPerPayerPerEpoch);

        uint64 deadline = uint64(block.timestamp) + settleWindow;
        escrows[escrowId] = Escrow({payer: payer, deadline: deadline, state: State.Held, amount: amount});
        totalHeld = held;
        fundedInEpoch[payer][epoch] = payerEpoch;

        uint256 before = asset.balanceOf(address(this));
        _pull(payer, amount, validAfter, validBefore, authorizationNonce, v, r, s);
        uint256 received = asset.balanceOf(address(this)) - before;
        if (received != amount) revert AmountMismatch(amount, received);

        emit Funded(escrowId, payer, amount, deadline, authorizationNonce);
    }

    /// @notice Two nodes agreed: 95% to the pot (directly, or to `forwardTo` for conversion), 5% to the treasury.
    function forward(bytes32 escrowId) external nonReentrant onlyScheduler {
        Escrow storage e = escrows[escrowId];
        if (e.state != State.Held) revert NotHeld(escrowId);
        if (block.timestamp > e.deadline) revert DeadlinePassed(escrowId, e.deadline);
        uint256 amount = e.amount;
        e.state = State.Forwarded;
        totalHeld -= amount;

        uint256 toTreasury = (amount * TREASURY_BPS) / 10_000;
        uint256 toPot = amount - toTreasury;
        bool direct = potPaysInAsset;
        address potRecipient = direct ? address(rewards) : forwardTo;
        emit Forwarded(escrowId, e.payer, amount, toPot, toTreasury, potRecipient, !direct);

        if (toPot > 0) {
            if (direct) {
                uint256 before = asset.balanceOf(address(this));
                asset.forceApprove(address(rewards), toPot);
                rewards.fundToken(toPot);
                asset.forceApprove(address(rewards), 0);
                uint256 sent = before - asset.balanceOf(address(this));
                if (sent != toPot) revert PotFundingMismatch(toPot, sent);
            } else {
                asset.safeTransfer(potRecipient, toPot);
            }
        }
        if (toTreasury > 0) asset.safeTransfer(treasury, toTreasury);
    }

    /// @notice Gives the payment back to the payer. The scheduler can refund at any time while the escrow is held
    ///         (results did not match, expired, rejected, or the job could not be queued); anyone can after the deadline.
    function refund(bytes32 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];
        if (e.state != State.Held) revert NotHeld(escrowId);
        bool byScheduler = msg.sender == rewards.scheduler();
        if (!byScheduler && block.timestamp <= e.deadline) revert TooEarly(escrowId, e.deadline);
        uint256 amount = e.amount;
        address payer = e.payer;
        e.state = State.Refunded;
        totalHeld -= amount;
        emit Refunded(escrowId, payer, amount, byScheduler);
        asset.safeTransfer(payer, amount);
    }

    // ------------------------------------------------------------------------------------------------
    // Owner (the treasury Safe): configuration only, never escrowed funds
    // ------------------------------------------------------------------------------------------------

    /// @notice Sets the address that receives the pot share for conversion (used when `potPaysInAsset` is false).
    function setForwardTo(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit ForwardToSet(forwardTo, next);
        forwardTo = next;
    }

    /// @notice Sets the launch caps. Lowering a cap never touches escrows already held.
    function setCaps(uint256 maxPerJob_, uint256 maxTotalHeld_, uint256 maxPerPayerPerEpoch_) external onlyOwner {
        _setCaps(maxPerJob_, maxTotalHeld_, maxPerPayerPerEpoch_);
    }

    /// @notice Stops (or resumes) new escrows. Forward and refund are never paused.
    function setFundingPaused(bool paused) external onlyOwner {
        fundingPaused = paused;
        emit FundingPausedSet(paused);
    }

    /// @notice Sends tokens that are in no escrow to `to`: for `asset` only the balance above `totalHeld`, for any
    ///         other token the whole balance. Escrowed funds can never be recovered this way.
    function recoverSurplus(address token, address to) external nonReentrant onlyOwner returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        amount = token == address(asset) ? bal - totalHeld : bal;
        if (amount == 0) revert NothingToRecover();
        emit SurplusRecovered(token, to, amount);
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Asset balance that belongs to no escrow.
    function surplus() external view returns (uint256) {
        return asset.balanceOf(address(this)) - totalHeld;
    }

    // ------------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------------

    function _setCaps(uint256 maxPerJob_, uint256 maxTotalHeld_, uint256 maxPerPayerPerEpoch_) internal {
        if (maxPerJob_ == 0 || maxTotalHeld_ < maxPerJob_ || maxPerPayerPerEpoch_ == 0) revert BadCaps();
        maxPerJob = maxPerJob_;
        maxTotalHeld = maxTotalHeld_;
        maxPerPayerPerEpoch = maxPerPayerPerEpoch_;
        emit CapsSet(maxPerJob_, maxTotalHeld_, maxPerPayerPerEpoch_);
    }

    /// @dev The token pull, kept apart so another transfer method (for example Permit2's
    ///      `permitWitnessTransferFrom`) can replace EIP-3009 without touching the escrow logic.
    function _pull(
        address payer,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 authorizationNonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal virtual {
        IEIP3009(address(asset)).transferWithAuthorization(
            payer, address(this), amount, validAfter, validBefore, authorizationNonce, v, r, s
        );
    }

    /// @dev Blocks `renounceOwnership()`: without an owner, a lost `forwardTo` could never be replaced.
    function _transferOwnership(address newOwner) internal override {
        if (newOwner == address(0)) revert RenounceDisabled();
        super._transferOwnership(newOwner);
    }
}
