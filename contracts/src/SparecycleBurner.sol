// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// =====================================================================================================================
// AUDIT REQUIRED BEFORE MAINNET. Written and tested only; NOT deployed. Every value marked "Default, not yet confirmed
// by Fabio" comes from section 10 of the next-update brief and is a starting point, not an approved number.
// =====================================================================================================================

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISparecycleRewardsForV2, ISpareSwapAdapter, ISparePriceSource} from "./interfaces/ISparecycleV2.sol";
import {SpareBurn} from "./libraries/SpareBurn.sol";

/// @title SparecycleBurner
/// @notice Usage burn, phase 2b (brief section 4). Receives the burner part of every charge in ETH from
///         SparecycleJobPaymentsV2 and, once per epoch, buys SPARE with it through the swap adapter and burns the
///         SPARE in the same transaction.
///
///         - `burnEpoch(epochId, minOut)`: scheduler only, for the epoch that closed last, once per epoch. It spends
///           at most `maxEthPerBurn` (N12 cap); what is left carries over to the next epoch instead of being bought at
///           any price. `minOut` must be at least the value at the epoch's accepted SPARE price minus the Safe-set
///           max slippage (N12). If the epoch has no accepted price (SPARE price paused), nothing is bought and the
///           whole balance carries over. Every outcome is an event with a transaction hash: `Burned` or `CarriedOver`.
///         - One buy per epoch, never split into small buys: an epoch that is skipped is not burnable later (its ETH
///           simply carries over into the next burn, which is capped again).
///         - The ETH has no other way out. The only exit is a Safe-only rescue to the treasury Safe, and only after
///           RESCUE_DELAY with no successful burn since the rescue was requested (the case where the pool is gone).
/// @dev    The scheduler and the epoch clock come from the reward contract. The price source is
///         SparecycleJobPaymentsV2 (its address is predicted at deploy; V2 checks `priceSource() == address(this)`).
contract SparecycleBurner is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    /// @notice Unit of the SPARE price: wei of ETH per 10^18 SPARE base units (same as the price source).
    uint256 public constant PRICE_UNIT = 1e18;
    /// @notice N12: initial max slippage of a buy against the epoch price, in bps (2%).
    ///         Default, not yet confirmed by Fabio.
    uint16 public constant DEFAULT_MAX_SLIPPAGE_BPS = 200;
    /// @notice Hard upper bound the Safe cannot exceed for the slippage (design bound, not from the brief).
    uint16 public constant MAX_SLIPPAGE_BPS_LIMIT = 1_000;
    /// @notice Wait between a rescue request and its execution. Design value ("a long delay" in the brief, no
    ///         number given there); to be confirmed by Fabio and the audit.
    uint64 public constant RESCUE_DELAY = 30 days;

    /// @notice Why ETH was carried over instead of (all) being bought.
    enum CarryReason {
        Cap,
        NoPrice
    }

    ISparecycleRewardsForV2 public immutable rewards;
    /// @notice The treasury Safe: admin of the risk settings and the only rescue destination.
    address public immutable treasury;
    /// @notice SPARE (N16: `ADDR.spareToken` only).
    IERC20 public immutable spare;
    ISpareSwapAdapter public immutable swapAdapter;
    /// @notice SparecycleJobPaymentsV2 (accepted per-epoch SPARE price).
    ISparePriceSource public immutable priceSource;
    /// @notice True: SPARE's `burn()`; false: transfer to 0x...dEaD. Fixed at deploy.
    bool public immutable useBurnFunction;

    /// @notice N12 per-burn cap in wei: "1% of the pool's quote-side liquidity at epoch close". Set by the Safe
    ///         from a live read ([PLACEHOLDER] at deploy). Default, not yet confirmed by Fabio.
    uint256 public maxEthPerBurn;
    /// @notice N12 max slippage in bps, Safe-set.
    uint16 public maxSlippageBps;
    /// @notice Whether `burnEpoch` already ran for an epoch.
    mapping(uint64 => bool) public epochHandled;
    uint256 public burnCount;
    uint256 public totalEthSpent;
    uint256 public totalSpareBurned;
    /// @notice Timestamp of the pending rescue request (0 = none) and the burn count at that time.
    uint64 public rescueRequestedAt;
    uint256 public burnCountAtRescueRequest;

    event Burned(uint64 indexed epochId, uint256 ethIn, uint256 spareBurned);
    event CarriedOver(uint64 indexed epochId, uint256 ethCarried, CarryReason reason);
    event MaxEthPerBurnSet(uint256 amount);
    event MaxSlippageSet(uint16 bps);
    event RescueRequested(uint64 executableAt);
    event RescueCancelled();
    event Rescued(uint256 amount);
    event TokenRescued(address indexed token, uint256 amount);

    error ZeroAddress();
    error NoCode(address account);
    error NotEthRewards();
    error NotScheduler();
    error NotTreasury();
    error NotLastClosedEpoch(uint64 given, uint64 lastClosed);
    error EpochAlreadyHandled(uint64 epochId);
    error NothingToBurn();
    error MinOutBelowFloor(uint256 minOut, uint256 floor);
    error InsufficientOutput(uint256 received, uint256 minOut);
    error AdapterTookTooMuch(uint256 sent, uint256 spent);
    error OutOfRange();
    error NoRescueRequest();
    error RescueNotReady(uint64 executableAt);
    error BurnedSinceRescueRequest();
    error CannotRescueSpare();
    error TransferFailed();

    /// @param rewards_ The live SparecycleRewards (epoch clock, scheduler).
    /// @param treasury_ The treasury Safe (`ADDR.treasurySafe`).
    /// @param spare_ SPARE (`ADDR.spareToken`).
    /// @param swapAdapter_ ISpareSwapAdapter used to buy SPARE.
    /// @param priceSource_ SparecycleJobPaymentsV2's predicted address.
    /// @param useBurnFunction_ True to call SPARE's `burn()`; false to send to 0x...dEaD. Confirm `burn()` on SPARE's
    ///        verified source before choosing true.
    /// @param maxEthPerBurn_ N12 cap ([PLACEHOLDER]: 1% of the pool's quote-side liquidity, read live at deploy).
    ///        Default, not yet confirmed by Fabio.
    constructor(
        address rewards_,
        address treasury_,
        address spare_,
        address swapAdapter_,
        address priceSource_,
        bool useBurnFunction_,
        uint256 maxEthPerBurn_
    ) {
        if (
            rewards_ == address(0) || treasury_ == address(0) || spare_ == address(0) || swapAdapter_ == address(0)
                || priceSource_ == address(0)
        ) revert ZeroAddress();
        if (spare_.code.length == 0) revert NoCode(spare_);
        if (swapAdapter_.code.length == 0) revert NoCode(swapAdapter_);
        if (ISparecycleRewardsForV2(rewards_).payoutToken() != address(0)) revert NotEthRewards();
        if (maxEthPerBurn_ == 0) revert OutOfRange();
        rewards = ISparecycleRewardsForV2(rewards_);
        treasury = treasury_;
        spare = IERC20(spare_);
        swapAdapter = ISpareSwapAdapter(swapAdapter_);
        priceSource = ISparePriceSource(priceSource_);
        useBurnFunction = useBurnFunction_;
        maxEthPerBurn = maxEthPerBurn_;
        maxSlippageBps = DEFAULT_MAX_SLIPPAGE_BPS;
        emit MaxEthPerBurnSet(maxEthPerBurn_);
        emit MaxSlippageSet(DEFAULT_MAX_SLIPPAGE_BPS);
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury();
        _;
    }

    /// @notice Accepts ETH from anyone (V2's burner part; in phase 2a the Safe; adapter refunds). No storage writes.
    receive() external payable {}

    // ------------------------------------------------------------------------------------------------------------
    // Scheduler
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Buys SPARE with up to `maxEthPerBurn` of the balance and burns it, for the epoch that closed last.
    /// @param epochId Must be `rewards.currentEpoch() - 1`; once per epoch.
    /// @param minOut Least SPARE to receive; must be >= the slippage floor at the epoch's accepted price.
    /// @return ethIn ETH spent on the buy (0 when carried over for lack of a price).
    /// @return spareBurned SPARE burned.
    function burnEpoch(uint64 epochId, uint256 minOut)
        external
        nonReentrant
        returns (uint256 ethIn, uint256 spareBurned)
    {
        if (msg.sender != rewards.scheduler()) revert NotScheduler();
        uint64 cur = rewards.currentEpoch();
        uint64 lastClosed = cur == 0 ? type(uint64).max : cur - 1;
        if (cur == 0 || epochId != lastClosed) revert NotLastClosedEpoch(epochId, lastClosed);
        if (epochHandled[epochId]) revert EpochAlreadyHandled(epochId);
        uint256 bal = address(this).balance;
        if (bal == 0) revert NothingToBurn();
        epochHandled[epochId] = true;

        uint256 price = priceSource.acceptedSparePrice(epochId);
        if (price == 0) {
            emit CarriedOver(epochId, bal, CarryReason.NoPrice);
            return (0, 0);
        }

        uint256 send = bal < maxEthPerBurn ? bal : maxEthPerBurn;
        uint256 floor = minOutFloor(send, price);
        if (minOut == 0 || minOut < floor) revert MinOutBelowFloor(minOut, floor);

        uint256 spareBefore = spare.balanceOf(address(this));
        swapAdapter.buySpare{value: send}(minOut, address(this));
        spareBurned = spare.balanceOf(address(this)) - spareBefore;
        if (spareBurned < minOut) revert InsufficientOutput(spareBurned, minOut);
        uint256 after_ = address(this).balance;
        if (after_ + send < bal) revert AdapterTookTooMuch(send, bal - after_);
        ethIn = bal - after_; // a refund from the adapter lowers the ETH actually spent

        SpareBurn.burn(spare, spareBurned, useBurnFunction);
        burnCount += 1;
        totalEthSpent += ethIn;
        totalSpareBurned += spareBurned;
        emit Burned(epochId, ethIn, spareBurned);
        if (after_ != 0) emit CarriedOver(epochId, after_, CarryReason.Cap);
    }

    /// @notice Least SPARE a buy of `ethIn` may ask for at `price`: value minus `maxSlippageBps`.
    function minOutFloor(uint256 ethIn, uint256 price) public view returns (uint256) {
        uint256 value = Math.mulDiv(ethIn, PRICE_UNIT, price);
        return (value * (BPS - maxSlippageBps)) / BPS;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Treasury Safe
    // ------------------------------------------------------------------------------------------------------------

    /// @notice N12 per-burn cap. Must be > 0.
    function setMaxEthPerBurn(uint256 amount) external onlyTreasury {
        if (amount == 0) revert OutOfRange();
        maxEthPerBurn = amount;
        emit MaxEthPerBurnSet(amount);
    }

    /// @notice N12 max slippage, at most MAX_SLIPPAGE_BPS_LIMIT.
    function setMaxSlippageBps(uint16 bps) external onlyTreasury {
        if (bps > MAX_SLIPPAGE_BPS_LIMIT) revert OutOfRange();
        maxSlippageBps = bps;
        emit MaxSlippageSet(bps);
    }

    /// @notice Starts the rescue clock (for the case where the pool is gone).
    function requestRescue() external onlyTreasury {
        rescueRequestedAt = uint64(block.timestamp);
        burnCountAtRescueRequest = burnCount;
        emit RescueRequested(uint64(block.timestamp) + RESCUE_DELAY);
    }

    function cancelRescue() external onlyTreasury {
        if (rescueRequestedAt == 0) revert NoRescueRequest();
        rescueRequestedAt = 0;
        emit RescueCancelled();
    }

    /// @notice Sends the whole ETH balance to the treasury Safe, only RESCUE_DELAY after the request and only if no
    ///         burn succeeded since the request.
    function executeRescue() external nonReentrant onlyTreasury {
        uint64 at = rescueRequestedAt;
        if (at == 0) revert NoRescueRequest();
        if (block.timestamp < uint256(at) + RESCUE_DELAY) revert RescueNotReady(at + RESCUE_DELAY);
        if (burnCount != burnCountAtRescueRequest) revert BurnedSinceRescueRequest();
        rescueRequestedAt = 0;
        uint256 amount = address(this).balance;
        emit Rescued(amount);
        if (amount != 0) {
            (bool ok,) = treasury.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
    }

    /// @notice Sends an ERC-20 sent here by mistake to the treasury. Never SPARE (it is only ever burned).
    function rescueToken(address token, uint256 amount) external nonReentrant onlyTreasury {
        if (token == address(spare)) revert CannotRescueSpare();
        uint256 spareBefore = spare.balanceOf(address(this));
        IERC20(token).safeTransfer(treasury, amount);
        if (spare.balanceOf(address(this)) < spareBefore) revert CannotRescueSpare();
        emit TokenRescued(token, amount);
    }
}
