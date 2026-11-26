// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// =====================================================================================================================
// AUDIT REQUIRED BEFORE MAINNET. Written and tested only; NOT deployed. Values marked "Decided by the owner on 26-27 Nov
// 2026" are approved numbers. Values still marked "Default, not yet confirmed by Fabio" come from section 10 of the
// next-update brief and are a starting point, not an approved number.
// =====================================================================================================================

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    ISparecycleRewardsForV2,
    ISpareSwapAdapter,
    ISparePriceSource,
    ISparecycleBurnerConfig
} from "./interfaces/ISparecycleV2.sol";
import {SpareBurn} from "./libraries/SpareBurn.sol";

/// @title SparecycleJobPaymentsV2
/// @notice Non-custodial prepaid balances for Sparecycle jobs, in ETH and in SPARE, plus spend-only compute credits.
///
///         Same guarantees as SparecycleJobPayments (V1):
///         - only the live reward contract's `scheduler()` can charge, and only for its open epoch;
///         - 95% of every ETH-paid charge goes to the reward contract's open pot through `fund()`;
///         - each customer can cap what they are charged per epoch (`setSpendLimit`, and `setSpareSpendLimit`);
///         - withdrawals are two-step (`requestWithdraw`, then `withdraw` after two epoch closes or WITHDRAW_TIMEOUT);
///         - nobody but the customer can move a withdrawable balance out of the contract.
///
///         New in V2:
///         - `depositFor(customer)`: anyone can fund a customer's withdrawable balance (unblocks x402 option X2).
///         - `creditFor(customer)`: only the immutable holder pool. Adds spend-only credits that can pay for jobs but
///           can never be withdrawn (N20). Charges spend credits first, then deposits (N21).
///         - The 5% fee is split into treasury / burner / holder pool. The parts always sum to 500 bps; only the
///           treasury Safe can change them, and a change takes effect SPLIT_CHANGE_DELAY_EPOCHS epochs later.
///         - SPARE balances and SPARE-paid jobs (brief section 5) at SPARE_DISCOUNT_BPS (0: decided by the owner on
///           26-27 Nov 2026). The scheduler posts one SPARE price per epoch; a price outside the Safe-set band around
///           the reference price pauses SPARE charges for that epoch while ETH charges go on. A SPARE-paid job gives
///           the node pot at least what an ETH-paid job of the same size gives; any shortfall of the SPARE sale is
///           covered from the ETH treasury share, then the Safe-funded discount reserve, then the ETH burn share; if
///           that is not enough the SPARE leg reverts (the scheduler leaves those jobs for a later epoch: deferred,
///           never underpaid). At 0% discount with the default slippage the sale floor alone covers the pot.
///
///         ETH can leave this contract only to: the reward contract (`fund`), the treasury Safe, the burner, the
///         holder pool, or a customer's own withdrawal (the swap adapter is only ever given SPARE, never ETH).
///         Credits leave only as part of a charge. The discount reserve leaves only as part of a charge (to the
///         pot) or, unused, back to the treasury Safe.
///
/// @dev    Epoch clock and scheduler come from the reward contract. The holder pool's address is fixed at deploy
///         before the pool exists (predicted CREATE address); the pool checks `holderPool() == address(this)` in its
///         own constructor. The burner is deployed first and must point its price source at this contract.
///         The `Charged` and `CustomerCharged` events have the same signatures (topics) as in V1, so the receipt
///         verifier (`src/lib/job-receipt.ts`) reads both; `listHash` is passed through untouched (v2 jobs root).
contract SparecycleJobPaymentsV2 is ReentrancyGuard, ISparePriceSource {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------------------------------------------------

    uint16 public constant BPS = 10_000;
    /// @notice The fee share of every charge in bps (5%); the node pot keeps the rest (95%). Fixed, as in V1.
    uint16 public constant FEE_BPS = 500;
    /// @notice A withdrawal request becomes executable after this long even if no epoch closes (same as V1).
    uint64 public constant WITHDRAW_TIMEOUT = 2 days;
    /// @notice Unit of the SPARE price: wei of ETH per 10^18 SPARE base units.
    uint256 public constant PRICE_UNIT = 1e18;

    /// @notice N1: initial treasury part of the 5% fee, in bps of the charge (3.5%). Decided by the owner on
    ///         26-27 Nov 2026: the burn is postponed, so the treasury takes the burner's former 150 bps.
    uint16 public constant DEFAULT_TREASURY_BPS = 350;
    /// @notice N1: initial burner part of the 5% fee, in bps of the charge: 0. Decided by the owner on 26-27 Nov 2026
    ///         (burn postponed). The Burner is still deployed and receives nothing until the treasury Safe proposes a
    ///         new split (`proposeSplit`, effective SPLIT_CHANGE_DELAY_EPOCHS later). Every path works with 0: no ETH
    ///         is sent to the burner, no SPARE is burned, and the events report 0.
    uint16 public constant DEFAULT_BURNER_BPS = 0;
    /// @notice N1: initial holder-pool part of the 5% fee, in bps of the charge (1.5%). Decided by the owner on
    ///         26-27 Nov 2026.
    uint16 public constant DEFAULT_HOLDER_POOL_BPS = 150;
    /// @notice N1: a split change takes effect this many epochs after it is proposed ("at least 4 epochs").
    ///         Default, not yet confirmed by Fabio.
    uint64 public constant SPLIT_CHANGE_DELAY_EPOCHS = 4;
    /// @notice N2: discount on the ETH price for SPARE-paid jobs, in bps: 0 (no discount). Decided by the owner on
    ///         26-27 Nov 2026. The Pons hook takes 2.90% of every swap's output (docs/uniswap-v4-adapter.md), so a SPARE
    ///         job's sale brings in about 97% of its ETH price: at 0% discount (and burner part 0) the slippage floor
    ///         alone (100% - DEFAULT_MAX_SWAP_SLIPPAGE_BPS = 96%) is above the node pot's 95%, so the pot gets its full
    ///         95% without the discount reserve or any other subsidy. The reserve mechanism stays for later use.
    ///         N2b (share of the SPARE received that is burned) has no number of its own: it is the burner part of
    ///         the current split applied to the discounted value (`burnerBps / 10_000` of the SPARE received; 0 now).
    uint16 public constant SPARE_DISCOUNT_BPS = 0;
    /// @notice N13: initial max deviation of a posted SPARE price from the reference price, in bps (20%).
    ///         Default, not yet confirmed by Fabio.
    uint16 public constant DEFAULT_MAX_PRICE_DEVIATION_BPS = 2_000;
    /// @notice N12: initial max slippage of the SPARE -> ETH sale against the epoch price, in bps (4%). Decided by the
    ///         owner on 26-27 Nov 2026: room for the Pons hook's 2.90% cut plus price impact (about size / ETH side)
    ///         and movement since the posted price. The Safe can change it (`setMaxSwapSlippageBps`, at most 10%).
    uint16 public constant DEFAULT_MAX_SWAP_SLIPPAGE_BPS = 400;

    /// @notice Hard upper bound the Safe cannot exceed for the price band (design bound, not from the brief).
    uint16 public constant MAX_PRICE_DEVIATION_BPS_LIMIT = 5_000;
    /// @notice Hard upper bound the Safe cannot exceed for the swap slippage (design bound, not from the brief).
    uint16 public constant MAX_SWAP_SLIPPAGE_BPS_LIMIT = 1_000;

    // ------------------------------------------------------------------------------------------------------------
    // Immutables
    // ------------------------------------------------------------------------------------------------------------

    /// @notice The live reward contract (ETH payout). Its scheduler is the only charger; its epoch is the clock.
    ISparecycleRewardsForV2 public immutable rewards;
    /// @notice The treasury Safe: receives the treasury part and is the only admin (split, SPARE risk settings).
    address public immutable treasury;
    /// @notice SparecycleBurner: receives the burner part in ETH.
    address public immutable burner;
    /// @notice SparecycleHolderPool: receives the holder-pool part and is the only caller of `creditFor`.
    address public immutable holderPool;
    /// @notice SPARE (N16: SPARE only, `ADDR.spareToken`; CYCLE is excluded). Constructor parameter.
    IERC20 public immutable spare;
    /// @notice Sells SPARE for ETH for the node-pot part of SPARE-paid jobs.
    ISpareSwapAdapter public immutable swapAdapter;
    /// @notice True: burn SPARE with its `burn()`; false: send it to 0x...dEaD. Copied from the burner at deploy.
    bool public immutable spareHasBurn;

    // ------------------------------------------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------------------------------------------

    /// @notice A split of the 5% fee, in bps of the charge. treasuryBps + burnerBps + holderPoolBps == FEE_BPS.
    struct Split {
        uint16 treasuryBps;
        uint16 burnerBps;
        uint16 holderPoolBps;
    }

    struct WithdrawRequest {
        uint128 amount;
        uint64 epoch; // reward-contract epoch when requested
        uint64 requestedAt; // timestamp
    }

    /// @notice The SPARE price record of one epoch.
    struct EpochPrice {
        uint256 price; // as posted, wei per PRICE_UNIT SPARE base units
        uint256 referencePrice; // the reference it was checked against (0 = none set)
        bool posted;
        bool accepted;
    }

    /// @notice Outcome of `previewSpareLeg`.
    enum SpareStatus {
        Ok,
        NoPrice,
        Paused,
        CapExceeded,
        MinOutTooLow,
        ShortfallNotCovered
    }

    Split private _split;
    Split private _pendingSplit;
    /// @notice Epoch from which the pending split applies; 0 = no pending split.
    uint64 public pendingSplitEpoch;

    /// @notice Withdrawable ETH per customer.
    mapping(address => uint256) public balanceOf;
    /// @notice Spend-only ETH credits per customer (from the holder pool). Never withdrawable.
    mapping(address => uint256) public creditOf;
    /// @notice SPARE per customer (withdrawable, two-step).
    mapping(address => uint256) public spareBalanceOf;

    uint256 public totalBalance;
    uint256 public totalCredits;
    uint256 public totalSpareBalance;
    /// @notice ETH the Safe (or anyone) put aside to cover SPARE-sale shortfalls. Leaves only to the pot (in a
    ///         charge) or back to the treasury (`withdrawDiscountReserve`).
    uint256 public discountReserve;

    /// @notice Max ETH value a customer can be charged per epoch (credits + deposits + SPARE at its ETH value); 0 = none.
    mapping(address => uint256) public spendLimitPerEpoch;
    /// @notice Max SPARE a customer can be charged per epoch; 0 = none.
    mapping(address => uint256) public spareSpendLimitPerEpoch;
    mapping(address => mapping(uint64 => uint256)) public chargedInEpoch;
    mapping(address => mapping(uint64 => uint256)) public spareChargedInEpoch;

    mapping(address => WithdrawRequest) public withdrawRequestOf;
    mapping(address => WithdrawRequest) public spareWithdrawRequestOf;

    /// @notice The last accepted SPARE price (or the Safe's anchor). A posted price is checked against it.
    uint256 public referenceSparePrice;
    mapping(uint64 => EpochPrice) private _prices;
    /// @notice N13: max deviation of a posted price from `referenceSparePrice`, in bps.
    uint16 public maxPriceDeviationBps;
    /// @notice N12: the SPARE -> ETH sale must ask at least (1 - this) of the value at the epoch price.
    uint16 public maxSwapSlippageBps;
    /// @notice N13: max ETH value (undiscounted job prices) of SPARE-paid jobs per epoch. [SPARE_PAY_CAP_ETH]
    uint256 public spareCapEthPerEpoch;
    mapping(uint64 => uint256) public spareEthChargedInEpoch;

    /// @dev True only while the swap adapter is paying ETH into this contract during a SPARE sale.
    bool private _swapping;

    // ------------------------------------------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------------------------------------------

    event Deposited(address indexed customer, uint256 amount, uint256 balance);
    event DepositedBy(address indexed payer, address indexed customer, uint256 amount);
    event CreditAdded(address indexed customer, uint256 amount, uint256 credit);
    event SpendLimitSet(address indexed customer, uint256 limit);
    event SpareSpendLimitSet(address indexed customer, uint256 limit);
    event WithdrawRequested(address indexed customer, uint256 amount, uint64 epoch, uint64 requestedAt);
    event WithdrawCancelled(address indexed customer);
    event Withdrawn(address indexed customer, uint256 amount);
    event SpareDeposited(address indexed customer, uint256 amount, uint256 balance);
    event SpareWithdrawRequested(address indexed customer, uint256 amount, uint64 epoch, uint64 requestedAt);
    event SpareWithdrawCancelled(address indexed customer);
    event SpareWithdrawn(address indexed customer, uint256 amount);

    /// @notice Same signature as V1. `amount` is the ETH charged (credits + deposits).
    event CustomerCharged(uint64 indexed epochId, address indexed customer, uint256 amount);
    /// @notice The part of a customer's ETH charge paid from credits.
    event CreditsSpent(uint64 indexed epochId, address indexed customer, uint256 amount);
    /// @notice A SPARE-paid charge: `ethValue` = the jobs' ETH price (undiscounted), `spareAmount` = SPARE debited.
    event CustomerChargedSpare(uint64 indexed epochId, address indexed customer, uint256 ethValue, uint256 spareAmount);
    /// @notice Same signature (topic) as V1's Charged, for the ETH leg: total = ETH charged, toPot = 95%,
    ///         toFee = the 5% (split in `Distributed`). Emitted on every charge, also with an empty ETH leg, so the
    ///         jobs root in `listHash` is always anchored.
    event Charged(uint64 indexed epochId, bytes32 indexed listHash, uint256 total, uint256 toPot, uint256 toFee);
    /// @notice The SPARE leg of a charge.
    event SpareCharged(
        uint64 indexed epochId,
        bytes32 indexed listHash,
        uint256 ethValue,
        uint256 spareIn,
        uint256 spareBurned,
        uint256 spareSold,
        uint256 ethOut,
        uint256 toPot,
        uint256 shortfallCovered
    );
    /// @notice SPARE burned directly from a SPARE-paid charge (N2b).
    event SpareBurned(uint64 indexed epochId, uint256 amount);
    /// @notice Where the ETH of one charge went, after both legs.
    event Distributed(
        uint64 indexed epochId,
        bytes32 indexed listHash,
        uint256 toPot,
        uint256 toTreasury,
        uint256 toBurner,
        uint256 toHolderPool,
        uint256 fromReserve
    );

    event SplitProposed(uint16 treasuryBps, uint16 burnerBps, uint16 holderPoolBps, uint64 effectiveEpoch);
    event SplitCancelled();
    event SplitApplied(uint16 treasuryBps, uint16 burnerBps, uint16 holderPoolBps, uint64 epoch);
    event SparePricePosted(uint64 indexed epochId, uint256 price, uint256 referencePrice, bool accepted);
    event ReferenceSparePriceSet(uint256 price);
    event MaxPriceDeviationSet(uint16 bps);
    event MaxSwapSlippageSet(uint16 bps);
    event SpareCapSet(uint256 capEthPerEpoch);
    event DiscountReserveFunded(address indexed from, uint256 amount, uint256 reserve);
    event DiscountReserveWithdrawn(uint256 amount, uint256 reserve);
    event TokenRescued(address indexed token, uint256 amount);

    // ------------------------------------------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------------------------------------------

    error ZeroAddress();
    error NoCode(address account);
    error NotEthRewards();
    error BurnerMismatch();
    error ZeroAmount();
    error NotScheduler();
    error NotTreasury();
    error NotHolderPool();
    error WrongEpoch(uint64 given, uint64 open);
    error LengthMismatch();
    error InsufficientBalance(address customer, uint256 balance, uint256 amount);
    error InsufficientSpareBalance(address customer, uint256 balance, uint256 amount);
    error SpendLimitExceeded(address customer, uint256 limit, uint256 wouldBe);
    error SpareSpendLimitExceeded(address customer, uint256 limit, uint256 wouldBe);
    error NoWithdrawRequest();
    error WithdrawLocked(uint64 openEpoch, uint64 unlocksAtEpoch, uint64 unlocksAt);
    error TransferFailed();
    error UnexpectedEth();
    error BadSplit();
    error NoPendingSplit();
    error SplitNotDue(uint64 effectiveEpoch);
    error PriceAlreadyPosted(uint64 epochId);
    error OutOfRange();
    error SparePriceNotPosted(uint64 epochId);
    error SpareChargesPaused(uint64 epochId);
    error SpareCapExceeded(uint256 cap, uint256 wouldBe);
    error MinOutTooLow(uint256 minEthOut, uint256 floor);
    error SpareShortfallNotCovered(uint256 potRequired, uint256 minEthOut, uint256 coverAvailable);
    error SwapOutputTooLow(uint256 ethOut, uint256 minEthOut);
    error SwapSpentWrongAmount(uint256 expected, uint256 spent);
    error AccountingBroken();
    error CannotRescueSpare();
    error HolderPoolNotDeployed();

    // ------------------------------------------------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------------------------------------------------

    /// @param rewards_ The live SparecycleRewards (ETH payout mode).
    /// @param treasury_ The treasury Safe (`ADDR.treasurySafe`): treasury part and admin.
    /// @param burner_ SparecycleBurner, already deployed, with `priceSource() == address(this)`.
    /// @param holderPool_ SparecycleHolderPool's address, predicted (deployed right after this contract).
    /// @param spare_ SPARE (`ADDR.spareToken`).
    /// @param swapAdapter_ ISpareSwapAdapter for the SPARE -> ETH sale.
    /// @param spareCapEthPerEpoch_ N13 per-epoch cap on SPARE-paid volume ([SPARE_PAY_CAP_ETH]; 0 = no SPARE charges
    ///        until the Safe sets one). Default, not yet confirmed by Fabio.
    constructor(
        address rewards_,
        address treasury_,
        address burner_,
        address holderPool_,
        address spare_,
        address swapAdapter_,
        uint256 spareCapEthPerEpoch_
    ) {
        if (
            rewards_ == address(0) || treasury_ == address(0) || burner_ == address(0) || holderPool_ == address(0)
                || spare_ == address(0) || swapAdapter_ == address(0)
        ) revert ZeroAddress();
        if (spare_.code.length == 0) revert NoCode(spare_);
        if (swapAdapter_.code.length == 0) revert NoCode(swapAdapter_);
        if (burner_.code.length == 0) revert NoCode(burner_);
        if (ISparecycleRewardsForV2(rewards_).payoutToken() != address(0)) revert NotEthRewards();
        ISparecycleBurnerConfig b = ISparecycleBurnerConfig(burner_);
        if (b.priceSource() != address(this) || b.spare() != spare_ || b.rewards() != rewards_) {
            revert BurnerMismatch();
        }

        rewards = ISparecycleRewardsForV2(rewards_);
        treasury = treasury_;
        burner = burner_;
        holderPool = holderPool_;
        spare = IERC20(spare_);
        swapAdapter = ISpareSwapAdapter(swapAdapter_);
        spareHasBurn = b.useBurnFunction();

        _split = Split(DEFAULT_TREASURY_BPS, DEFAULT_BURNER_BPS, DEFAULT_HOLDER_POOL_BPS);
        maxPriceDeviationBps = DEFAULT_MAX_PRICE_DEVIATION_BPS;
        maxSwapSlippageBps = DEFAULT_MAX_SWAP_SLIPPAGE_BPS;
        spareCapEthPerEpoch = spareCapEthPerEpoch_;
        emit SplitApplied(
            DEFAULT_TREASURY_BPS,
            DEFAULT_BURNER_BPS,
            DEFAULT_HOLDER_POOL_BPS,
            ISparecycleRewardsForV2(rewards_).currentEpoch()
        );
        emit SpareCapSet(spareCapEthPerEpoch_);
    }

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury();
        _;
    }

    modifier onlyScheduler() {
        if (msg.sender != rewards.scheduler()) revert NotScheduler();
        _;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Customers: ETH
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Adds ETH to the caller's withdrawable balance.
    function deposit() external payable nonReentrant {
        _deposit(msg.sender, msg.value);
    }

    /// @notice Adds ETH to `customer`'s withdrawable balance. Only `customer` can withdraw it.
    function depositFor(address customer) external payable nonReentrant {
        if (customer == address(0)) revert ZeroAddress();
        _deposit(customer, msg.value);
        emit DepositedBy(msg.sender, customer, msg.value);
    }

    /// @notice Plain ETH transfers are deposits for the sender. During a SPARE sale only the swap adapter may pay
    ///         in, and that ETH is not a deposit.
    receive() external payable {
        if (_swapping) {
            if (msg.sender != address(swapAdapter)) revert UnexpectedEth();
            return;
        }
        _depositGuarded(msg.sender, msg.value);
    }

    /// @notice Caps what the scheduler may charge the caller per epoch, in ETH value. 0 removes the cap.
    function setSpendLimit(uint256 limit) external {
        spendLimitPerEpoch[msg.sender] = limit;
        emit SpendLimitSet(msg.sender, limit);
    }

    /// @notice Caps the SPARE the scheduler may charge the caller per epoch. 0 removes the cap.
    function setSpareSpendLimit(uint256 limit) external {
        spareSpendLimitPerEpoch[msg.sender] = limit;
        emit SpareSpendLimitSet(msg.sender, limit);
    }

    /// @notice Starts a withdrawal of `amount` ETH (replaces any earlier request and restarts its wait).
    ///         Credits are not part of the withdrawable balance and can never be requested.
    function requestWithdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientBalance(msg.sender, bal, amount);
        uint64 epoch = rewards.currentEpoch();
        withdrawRequestOf[msg.sender] = WithdrawRequest(uint128(amount), epoch, uint64(block.timestamp));
        emit WithdrawRequested(msg.sender, amount, epoch, uint64(block.timestamp));
    }

    /// @notice Drops the caller's pending ETH withdrawal request.
    function cancelWithdraw() external {
        if (withdrawRequestOf[msg.sender].amount == 0) revert NoWithdrawRequest();
        delete withdrawRequestOf[msg.sender];
        emit WithdrawCancelled(msg.sender);
    }

    /// @notice Whether `customer`'s ETH request can be executed now.
    function canWithdraw(address customer) public view returns (bool) {
        return _unlocked(withdrawRequestOf[customer]);
    }

    /// @notice Pays out the caller's ETH request: min(requested, current withdrawable balance). Never credits.
    function withdraw() external nonReentrant {
        WithdrawRequest memory r = withdrawRequestOf[msg.sender];
        _checkUnlocked(r);
        uint256 bal = balanceOf[msg.sender];
        uint256 amount = r.amount < bal ? r.amount : bal;
        delete withdrawRequestOf[msg.sender];
        balanceOf[msg.sender] = bal - amount;
        totalBalance -= amount;
        emit Withdrawn(msg.sender, amount);
        _sendEth(msg.sender, amount);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Customers: SPARE
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Pulls `amount` SPARE from the caller (needs approval) and credits what actually arrived.
    function depositSpare(uint256 amount) external nonReentrant {
        uint256 before = spare.balanceOf(address(this));
        spare.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = spare.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        uint256 bal = spareBalanceOf[msg.sender] + received;
        spareBalanceOf[msg.sender] = bal;
        totalSpareBalance += received;
        emit SpareDeposited(msg.sender, received, bal);
    }

    /// @notice Starts a withdrawal of `amount` SPARE (same two-step rule as ETH).
    function requestWithdrawSpare(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = spareBalanceOf[msg.sender];
        if (amount > bal) revert InsufficientSpareBalance(msg.sender, bal, amount);
        uint64 epoch = rewards.currentEpoch();
        spareWithdrawRequestOf[msg.sender] = WithdrawRequest(uint128(amount), epoch, uint64(block.timestamp));
        emit SpareWithdrawRequested(msg.sender, amount, epoch, uint64(block.timestamp));
    }

    /// @notice Drops the caller's pending SPARE withdrawal request.
    function cancelWithdrawSpare() external {
        if (spareWithdrawRequestOf[msg.sender].amount == 0) revert NoWithdrawRequest();
        delete spareWithdrawRequestOf[msg.sender];
        emit SpareWithdrawCancelled(msg.sender);
    }

    /// @notice Whether `customer`'s SPARE request can be executed now.
    function canWithdrawSpare(address customer) public view returns (bool) {
        return _unlocked(spareWithdrawRequestOf[customer]);
    }

    /// @notice Pays out the caller's SPARE request: min(requested, current SPARE balance).
    function withdrawSpare() external nonReentrant {
        WithdrawRequest memory r = spareWithdrawRequestOf[msg.sender];
        _checkUnlocked(r);
        uint256 bal = spareBalanceOf[msg.sender];
        uint256 amount = r.amount < bal ? r.amount : bal;
        delete spareWithdrawRequestOf[msg.sender];
        spareBalanceOf[msg.sender] = bal - amount;
        totalSpareBalance -= amount;
        emit SpareWithdrawn(msg.sender, amount);
        if (amount > 0) spare.safeTransfer(msg.sender, amount);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Holder pool
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Adds `msg.value` as spend-only credits for `customer`. Only the holder pool, inside a claim.
    ///         Credits pay for jobs before deposits and can never be withdrawn (N20, N21).
    function creditFor(address customer) external payable nonReentrant {
        if (msg.sender != holderPool) revert NotHolderPool();
        if (customer == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert ZeroAmount();
        uint256 c = creditOf[customer] + msg.value;
        creditOf[customer] = c;
        totalCredits += msg.value;
        emit CreditAdded(customer, msg.value, c);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Scheduler
    // ------------------------------------------------------------------------------------------------------------

    /// @notice ETH-only charge with V1's signature: credits first, then deposits; 95% to the open pot, 5% split.
    function charge(uint64 epochId, address[] calldata customers, uint256[] calldata amounts, bytes32 listHash)
        external
        nonReentrant
        onlyScheduler
    {
        if (customers.length != amounts.length || customers.length == 0) revert LengthMismatch();
        _checkOpen(epochId);
        Split memory s = _applyPendingSplit();
        Flows memory f = _ethLeg(epochId, customers, amounts, s, listHash);
        _distribute(epochId, listHash, f);
    }

    /// @notice Charge with an ETH leg and a SPARE leg in one transaction, committed to one `listHash`.
    ///         SPARE leg: `spareEthAmounts` are the jobs' ETH prices (undiscounted). Each customer is debited
    ///         `ethAmount * (1 - SPARE_DISCOUNT_BPS) / price` SPARE (rounded up). The burner part of the split is
    ///         burned as SPARE, the rest is sold for ETH with at least `minEthOut`. The node pot then gets exactly
    ///         what an ETH-paid charge of the same size gives; any surplus goes to the treasury; any shortfall comes
    ///         from this charge's ETH treasury part, then the discount reserve, then this charge's ETH burner part.
    ///         Reverts (the SPARE jobs stay uncharged: deferred) when the epoch has no accepted price, the cap
    ///         would be exceeded, `minEthOut` is below the slippage floor, or the shortfall could not be covered
    ///         even at `minEthOut`. Use `previewSpareLeg` first; ETH-only `charge` keeps working meanwhile.
    function chargeWithSpare(
        uint64 epochId,
        address[] calldata customers,
        uint256[] calldata amounts,
        address[] calldata spareCustomers,
        uint256[] calldata spareEthAmounts,
        uint256 minEthOut,
        bytes32 listHash
    ) external nonReentrant onlyScheduler {
        if (customers.length != amounts.length || spareCustomers.length != spareEthAmounts.length) {
            revert LengthMismatch();
        }
        if (spareCustomers.length == 0 && customers.length == 0) revert LengthMismatch();
        _checkOpen(epochId);
        Split memory s = _applyPendingSplit();
        Flows memory f = _ethLeg(epochId, customers, amounts, s, listHash);
        if (spareCustomers.length != 0) _spareLeg(epochId, spareCustomers, spareEthAmounts, minEthOut, listHash, s, f);
        _distribute(epochId, listHash, f);
    }

    /// @notice Posts the SPARE price for the open epoch, once. Accepted only within `maxPriceDeviationBps` of the
    ///         reference price; an accepted price becomes the new reference. A price outside the band (or with no
    ///         reference set yet) pauses SPARE charges for this epoch; ETH charges are not affected.
    /// @param price Wei of ETH per PRICE_UNIT SPARE base units, from an epoch-long time-weighted average.
    function postSparePrice(uint64 epochId, uint256 price) external onlyScheduler {
        _checkOpen(epochId);
        if (price == 0) revert ZeroAmount();
        EpochPrice storage p = _prices[epochId];
        if (p.posted) revert PriceAlreadyPosted(epochId);
        uint256 ref = referenceSparePrice;
        bool ok = ref != 0 && _withinBand(price, ref, maxPriceDeviationBps);
        p.price = price;
        p.referencePrice = ref;
        p.posted = true;
        p.accepted = ok;
        if (ok) referenceSparePrice = price;
        emit SparePricePosted(epochId, price, ref, ok);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Treasury Safe
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Proposes a new split of the 5% fee. It applies from epoch `currentEpoch + SPLIT_CHANGE_DELAY_EPOCHS`.
    ///         A new proposal replaces a pending one and restarts the delay.
    function proposeSplit(uint16 treasuryBps, uint16 burnerBps, uint16 holderPoolBps) external onlyTreasury {
        if (uint256(treasuryBps) + burnerBps + holderPoolBps != FEE_BPS) revert BadSplit();
        _applyPendingSplit(); // a due earlier proposal takes effect first, it is not silently dropped
        uint64 eff = rewards.currentEpoch() + SPLIT_CHANGE_DELAY_EPOCHS;
        _pendingSplit = Split(treasuryBps, burnerBps, holderPoolBps);
        pendingSplitEpoch = eff;
        emit SplitProposed(treasuryBps, burnerBps, holderPoolBps, eff);
    }

    /// @notice Drops the pending split before it applies.
    function cancelSplit() external onlyTreasury {
        _applyPendingSplit();
        if (pendingSplitEpoch == 0) revert NoPendingSplit();
        delete _pendingSplit;
        pendingSplitEpoch = 0;
        emit SplitCancelled();
    }

    /// @notice Anchors the reference SPARE price (needed once before the first SPARE charge, and to resume after
    ///         a real move outside the band). Affects prices posted after this call only.
    function setReferenceSparePrice(uint256 price) external onlyTreasury {
        if (price == 0) revert ZeroAmount();
        referenceSparePrice = price;
        emit ReferenceSparePriceSet(price);
    }

    function setMaxPriceDeviationBps(uint16 bps) external onlyTreasury {
        if (bps == 0 || bps > MAX_PRICE_DEVIATION_BPS_LIMIT) revert OutOfRange();
        maxPriceDeviationBps = bps;
        emit MaxPriceDeviationSet(bps);
    }

    function setMaxSwapSlippageBps(uint16 bps) external onlyTreasury {
        if (bps > MAX_SWAP_SLIPPAGE_BPS_LIMIT) revert OutOfRange();
        maxSwapSlippageBps = bps;
        emit MaxSwapSlippageSet(bps);
    }

    /// @notice N13 per-epoch cap on SPARE-paid volume (ETH value). 0 stops SPARE charges.
    function setSpareCapEthPerEpoch(uint256 cap) external onlyTreasury {
        spareCapEthPerEpoch = cap;
        emit SpareCapSet(cap);
    }

    /// @notice Adds ETH to the discount reserve (covers SPARE-sale shortfalls). Anyone may fund it.
    function fundDiscountReserve() external payable nonReentrant {
        if (msg.value == 0) revert ZeroAmount();
        discountReserve += msg.value;
        emit DiscountReserveFunded(msg.sender, msg.value, discountReserve);
    }

    /// @notice Returns unused reserve to the treasury Safe (the only destination).
    function withdrawDiscountReserve(uint256 amount) external nonReentrant onlyTreasury {
        if (amount == 0) revert ZeroAmount();
        discountReserve -= amount; // reverts on underflow
        emit DiscountReserveWithdrawn(amount, discountReserve);
        _sendEth(treasury, amount);
    }

    /// @notice Sends an ERC-20 sent here by mistake to the treasury. Never SPARE, never ETH.
    function rescueToken(address token, uint256 amount) external nonReentrant onlyTreasury {
        if (token == address(spare)) revert CannotRescueSpare();
        uint256 spareBefore = spare.balanceOf(address(this));
        IERC20(token).safeTransfer(treasury, amount);
        if (spare.balanceOf(address(this)) < spareBefore) revert CannotRescueSpare(); // double-entry tokens
        emit TokenRescued(token, amount);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------------------------------------------

    /// @notice The split that applies to a charge made now (a due pending split counts).
    function currentSplit() public view returns (uint16 treasuryBps, uint16 burnerBps, uint16 holderPoolBps) {
        Split memory s = _isPendingDue() ? _pendingSplit : _split;
        return (s.treasuryBps, s.burnerBps, s.holderPoolBps);
    }

    /// @notice The pending split and the epoch it applies from (all zero when none).
    function pendingSplit()
        external
        view
        returns (uint16 treasuryBps, uint16 burnerBps, uint16 holderPoolBps, uint64 effectiveEpoch)
    {
        Split memory s = _pendingSplit;
        return (s.treasuryBps, s.burnerBps, s.holderPoolBps, pendingSplitEpoch);
    }

    /// @notice The SPARE price record of `epochId`.
    function sparePriceOf(uint64 epochId) external view returns (EpochPrice memory) {
        return _prices[epochId];
    }

    /// @inheritdoc ISparePriceSource
    function acceptedSparePrice(uint64 epochId) public view returns (uint256) {
        EpochPrice storage p = _prices[epochId];
        return p.accepted ? p.price : 0;
    }

    /// @notice SPARE owed for a job priced `ethAmount` in `epochId` (0 when the epoch has no accepted price).
    function spareOwed(uint64 epochId, uint256 ethAmount) public view returns (uint256) {
        uint256 price = acceptedSparePrice(epochId);
        if (price == 0) return 0;
        return _spareFor(ethAmount, price);
    }

    /// @notice What `chargeWithSpare` would decide for a SPARE leg worth `spareEthValue` (undiscounted) next to an
    ///         ETH leg of `ethLegTotal`, with `minEthOut` for the sale. Per-customer balances and limits are not
    ///         checked here.
    function previewSpareLeg(uint64 epochId, uint256 ethLegTotal, uint256 spareEthValue, uint256 minEthOut)
        external
        view
        returns (SpareStatus status, uint256 spareIn, uint256 floor, uint256 potRequired, uint256 coverAvailable)
    {
        EpochPrice storage p = _prices[epochId];
        if (!p.posted) return (SpareStatus.NoPrice, 0, 0, 0, 0);
        if (!p.accepted) return (SpareStatus.Paused, 0, 0, 0, 0);
        if (spareEthChargedInEpoch[epochId] + spareEthValue > spareCapEthPerEpoch) {
            return (SpareStatus.CapExceeded, 0, 0, 0, 0);
        }
        (uint16 t, uint16 b, uint16 h) = currentSplit();
        Flows memory f = _feeFlows(ethLegTotal, Split(t, b, h));
        spareIn = _spareFor(spareEthValue, p.price);
        uint256 sold = spareIn - (spareIn * b) / BPS;
        floor = _saleFloor(sold, p.price);
        potRequired = _potShare(spareEthValue);
        coverAvailable = f.toTreasury + discountReserve + f.toBurner;
        if (minEthOut < floor) return (SpareStatus.MinOutTooLow, spareIn, floor, potRequired, coverAvailable);
        if (minEthOut + coverAvailable < potRequired) {
            return (SpareStatus.ShortfallNotCovered, spareIn, floor, potRequired, coverAvailable);
        }
        status = SpareStatus.Ok;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internal: charging
    // ------------------------------------------------------------------------------------------------------------

    /// @dev ETH that one charge sends out. toPot + toTreasury + toBurner + toHolderPool ==
    ///      ETH-leg total + SPARE-sale output + fromReserve.
    struct Flows {
        uint256 toPot;
        uint256 toTreasury;
        uint256 toBurner;
        uint256 toHolderPool;
        uint256 fromReserve;
    }

    struct SpareTotals {
        uint256 ethValue;
        uint256 spareIn;
        uint256 spareBurned;
        uint256 spareSold;
        uint256 ethOut;
        uint256 potRequired;
        uint256 shortfall;
        uint256 price;
    }

    function _ethLeg(
        uint64 epochId,
        address[] calldata customers,
        uint256[] calldata amounts,
        Split memory s,
        bytes32 listHash
    ) internal returns (Flows memory f) {
        uint256 total;
        uint256 fromCreditsTotal;
        for (uint256 i; i < customers.length; ++i) {
            fromCreditsTotal += _chargeOne(epochId, customers[i], amounts[i]);
            total += amounts[i];
        }
        totalCredits -= fromCreditsTotal;
        totalBalance -= total - fromCreditsTotal;
        f = _feeFlows(total, s);
        emit Charged(epochId, listHash, total, f.toPot, total - f.toPot);
    }

    /// @dev Credits first, then deposits (N21). Returns the part paid from credits.
    function _chargeOne(uint64 epochId, address c, uint256 a) internal returns (uint256 fromCredits) {
        if (a == 0) revert ZeroAmount();
        uint256 cr = creditOf[c];
        uint256 bal = balanceOf[c];
        if (a > cr + bal) revert InsufficientBalance(c, cr + bal, a);
        _checkSpendLimit(c, epochId, a);
        fromCredits = a < cr ? a : cr;
        creditOf[c] = cr - fromCredits;
        balanceOf[c] = bal - (a - fromCredits);
        emit CustomerCharged(epochId, c, a);
        if (fromCredits != 0) emit CreditsSpent(epochId, c, fromCredits);
    }

    function _spareLeg(
        uint64 epochId,
        address[] calldata cs,
        uint256[] calldata ethAmounts,
        uint256 minEthOut,
        bytes32 listHash,
        Split memory s,
        Flows memory f
    ) internal {
        SpareTotals memory t;
        EpochPrice storage p = _prices[epochId];
        if (!p.posted) revert SparePriceNotPosted(epochId);
        if (!p.accepted) revert SpareChargesPaused(epochId);
        t.price = p.price;

        for (uint256 i; i < cs.length; ++i) {
            t.spareIn += _chargeOneSpare(epochId, cs[i], ethAmounts[i], t.price);
            t.ethValue += ethAmounts[i];
        }
        uint256 capUsed = spareEthChargedInEpoch[epochId] + t.ethValue;
        if (capUsed > spareCapEthPerEpoch) revert SpareCapExceeded(spareCapEthPerEpoch, capUsed);
        spareEthChargedInEpoch[epochId] = capUsed;
        totalSpareBalance -= t.spareIn;

        t.spareBurned = (t.spareIn * s.burnerBps) / BPS; // N2b
        t.spareSold = t.spareIn - t.spareBurned;
        t.potRequired = _potShare(t.ethValue); // what an ETH-paid charge of the same size gives the pot

        uint256 floor = _saleFloor(t.spareSold, t.price);
        if (minEthOut < floor) revert MinOutTooLow(minEthOut, floor);
        uint256 cover = f.toTreasury + discountReserve + f.toBurner;
        if (minEthOut + cover < t.potRequired) revert SpareShortfallNotCovered(t.potRequired, minEthOut, cover);

        t.ethOut = _sellSpare(t.spareSold, minEthOut);

        if (t.ethOut >= t.potRequired) {
            f.toTreasury += t.ethOut - t.potRequired;
        } else {
            uint256 need = t.potRequired - t.ethOut;
            t.shortfall = need;
            uint256 take = need < f.toTreasury ? need : f.toTreasury;
            f.toTreasury -= take;
            need -= take;
            take = need < discountReserve ? need : discountReserve;
            discountReserve -= take;
            f.fromReserve += take;
            need -= take;
            // Cannot underflow: ethOut >= minEthOut and minEthOut + cover >= potRequired.
            f.toBurner -= need;
        }
        f.toPot += t.potRequired;

        SpareBurn.burn(spare, t.spareBurned, spareHasBurn);
        if (t.spareBurned != 0) emit SpareBurned(epochId, t.spareBurned);
        if (spare.balanceOf(address(this)) < totalSpareBalance) revert AccountingBroken();

        emit SpareCharged(
            epochId, listHash, t.ethValue, t.spareIn, t.spareBurned, t.spareSold, t.ethOut, t.potRequired, t.shortfall
        );
    }

    function _chargeOneSpare(uint64 epochId, address c, uint256 ethAmount, uint256 price)
        internal
        returns (uint256 owed)
    {
        if (ethAmount == 0) revert ZeroAmount();
        owed = _spareFor(ethAmount, price);
        uint256 bal = spareBalanceOf[c];
        if (owed > bal) revert InsufficientSpareBalance(c, bal, owed);
        // The ETH spend limit counts what the customer actually pays: the discounted ETH value.
        _checkSpendLimit(c, epochId, (ethAmount * (BPS - SPARE_DISCOUNT_BPS)) / BPS);
        uint256 spent = spareChargedInEpoch[c][epochId] + owed;
        uint256 limit = spareSpendLimitPerEpoch[c];
        if (limit != 0 && spent > limit) revert SpareSpendLimitExceeded(c, limit, spent);
        spareChargedInEpoch[c][epochId] = spent;
        spareBalanceOf[c] = bal - owed;
        emit CustomerChargedSpare(epochId, c, ethAmount, owed);
    }

    function _checkSpendLimit(address c, uint64 epochId, uint256 add) internal {
        uint256 spent = chargedInEpoch[c][epochId] + add;
        uint256 limit = spendLimitPerEpoch[c];
        if (limit != 0 && spent > limit) revert SpendLimitExceeded(c, limit, spent);
        chargedInEpoch[c][epochId] = spent;
    }

    /// @dev Sells exactly `amount` SPARE through the adapter; returns the measured ETH received (>= minOut).
    function _sellSpare(uint256 amount, uint256 minOut) internal returns (uint256 ethOut) {
        if (amount == 0) {
            if (minOut != 0) revert SwapOutputTooLow(0, minOut);
            return 0;
        }
        uint256 ethBefore = address(this).balance;
        uint256 spareBefore = spare.balanceOf(address(this));
        address adapter = address(swapAdapter);
        spare.forceApprove(adapter, amount);
        _swapping = true;
        swapAdapter.sellSpare(amount, minOut, payable(address(this)));
        _swapping = false;
        spare.forceApprove(adapter, 0);
        uint256 spent = spareBefore - spare.balanceOf(address(this));
        if (spent != amount) revert SwapSpentWrongAmount(amount, spent);
        ethOut = address(this).balance - ethBefore;
        if (ethOut < minOut) revert SwapOutputTooLow(ethOut, minOut);
    }

    function _distribute(uint64 epochId, bytes32 listHash, Flows memory f) internal {
        emit Distributed(epochId, listHash, f.toPot, f.toTreasury, f.toBurner, f.toHolderPool, f.fromReserve);
        if (f.toPot != 0) rewards.fund{value: f.toPot}();
        // The pool's address was predicted at deploy; never push its share to an address with nothing there.
        if (f.toHolderPool != 0 && holderPool.code.length == 0) revert HolderPoolNotDeployed();
        _sendEth(treasury, f.toTreasury);
        _sendEth(burner, f.toBurner);
        _sendEth(holderPool, f.toHolderPool);
        if (address(this).balance < totalBalance + totalCredits + discountReserve) revert AccountingBroken();
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internal: helpers
    // ------------------------------------------------------------------------------------------------------------

    /// @dev 95% to the pot (it keeps the rounding, as in V1); the 5% split by `s` (the treasury keeps its dust).
    function _feeFlows(uint256 total, Split memory s) internal pure returns (Flows memory f) {
        uint256 fee = (total * FEE_BPS) / BPS;
        f.toPot = total - fee;
        f.toBurner = (total * s.burnerBps) / BPS;
        f.toHolderPool = (total * s.holderPoolBps) / BPS;
        f.toTreasury = fee - f.toBurner - f.toHolderPool;
    }

    function _potShare(uint256 total) internal pure returns (uint256) {
        return total - (total * FEE_BPS) / BPS;
    }

    function _spareFor(uint256 ethAmount, uint256 price) internal pure returns (uint256) {
        return Math.mulDiv(
            ethAmount, uint256(BPS - SPARE_DISCOUNT_BPS) * PRICE_UNIT, uint256(BPS) * price, Math.Rounding.Ceil
        );
    }

    /// @dev Lowest acceptable ETH for selling `sold` SPARE at `price`: value minus the max slippage.
    function _saleFloor(uint256 sold, uint256 price) internal view returns (uint256) {
        uint256 value = Math.mulDiv(sold, price, PRICE_UNIT);
        return (value * (BPS - maxSwapSlippageBps)) / BPS;
    }

    function _withinBand(uint256 price, uint256 ref, uint16 bps) internal pure returns (bool) {
        uint256 diff = price > ref ? price - ref : ref - price;
        return diff * BPS <= ref * bps;
    }

    function _checkOpen(uint64 epochId) internal view {
        uint64 open = rewards.currentEpoch();
        if (epochId != open) revert WrongEpoch(epochId, open);
    }

    function _isPendingDue() internal view returns (bool) {
        uint64 eff = pendingSplitEpoch;
        return eff != 0 && rewards.currentEpoch() >= eff;
    }

    function _applyPendingSplit() internal returns (Split memory s) {
        if (_isPendingDue()) {
            s = _pendingSplit;
            _split = s;
            delete _pendingSplit;
            pendingSplitEpoch = 0;
            emit SplitApplied(s.treasuryBps, s.burnerBps, s.holderPoolBps, rewards.currentEpoch());
        } else {
            s = _split;
        }
    }

    function _unlocked(WithdrawRequest memory r) internal view returns (bool) {
        if (r.amount == 0) return false;
        return rewards.currentEpoch() >= r.epoch + 2 || block.timestamp >= uint256(r.requestedAt) + WITHDRAW_TIMEOUT;
    }

    function _checkUnlocked(WithdrawRequest memory r) internal view {
        if (r.amount == 0) revert NoWithdrawRequest();
        if (!_unlocked(r)) {
            revert WithdrawLocked(rewards.currentEpoch(), r.epoch + 2, r.requestedAt + WITHDRAW_TIMEOUT);
        }
    }

    function _deposit(address customer, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[customer] + amount;
        balanceOf[customer] = bal;
        totalBalance += amount;
        emit Deposited(customer, amount, bal);
    }

    function _depositGuarded(address customer, uint256 amount) private nonReentrant {
        _deposit(customer, amount);
    }

    function _sendEth(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
