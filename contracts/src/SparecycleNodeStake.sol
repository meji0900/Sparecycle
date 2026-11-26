// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// =====================================================================================================================
//  INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED. An external audit is still recommended before it holds
//  meaningful value. Launched with minStakePerNode = 0 (staking is voluntary).
//  Every default below is "Default, not yet confirmed by Fabio".
// =====================================================================================================================

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The parts of SparecycleRewards this contract reads. All three are views (called with STATICCALL).
interface ISparecycleRewardsForStake {
    function currentEpoch() external view returns (uint64);
    function epochLength() external view returns (uint64);
    function scheduler() external view returns (address);
}

/// @notice `burn(uint256)` of an ERC20Burnable-style token: burns from the caller's own balance.
interface IERC20BurnForStake {
    function burn(uint256 amount) external;
}

/// @title SparecycleNodeStake
/// @notice Node owners lock SPARE here to receive jobs. Repeated *proven* wrong results can cost part of the stake.
///
///         Stake. `stake(amount)` locks SPARE for the calling owner wallet. The scheduler leases jobs only to owners
///         with `stakedOf(owner) >= minStakePerNode() * activeNodes(owner)` (`meetsMinimum`); the node count is
///         off-chain. Leaving is two-step: `requestUnstake(amount)` moves SPARE into a cooldown bucket (it stops
///         counting toward the minimum but can still be slashed), and `unstake()` pays it back to the owner after
///         `cooldownEpochs`; a new request restarts the cooldown for the whole bucket. Nothing can leave while the
///         owner has an open slash proposal. There is no cap on the total stake.
///
///         Slashing (not trustless: the scheduler proposes, the treasury Safe judges). The scheduler of the live
///         SparecycleRewards contract calls `proposeSlash(owner, amount, evidenceHash)` once its off-chain rule has
///         attributed enough faults (brief §3; evidence format in docs/node-staking.md). `amount` is at most
///         `slashBps` of the owner's stake. That opens an appeal window of `appealWindowEpochs`, during which the
///         stake is frozen and nothing moves; the owner may `appeal(proposalId, evidenceHash)`. The Safe can
///         `cancelSlash` at any time while the proposal is open, and can `executeSlash` once the appeal window is
///         over. Execution burns the amount (N9): nobody, including the project and the other node, gains from an
///         accusation. A proposal the Safe neither executes nor cancels within `decisionWindowEpochs` after the
///         appeal window expires. After every cancelled, expired or executed proposal, no new proposal against the
///         same owner is accepted for `PROPOSAL_GRACE_EPOCHS`, so an owner whose cooldown has finished always gets
///         a window to `unstake()`: the scheduler key alone cannot keep a stake frozen by re-proposing. The scheduler
///         and the Safe together can still burn up to `slashBps` per proposal, with a grace window between
///         proposals.
///
///         Epochs are the reward contract's epochs (`rewards.currentEpoch()`), so every window lines up with the
///         payout epochs. A window of `n` epochs ends when (a) `n * epochLength` seconds have passed AND (b) the
///         reward contract has closed `n` epochs since the window started, or, if epochs stop closing,
///         `STALL_FACTOR * n * epochLength` seconds have passed. (a) makes every window at least its nominal length;
///         the stall fallback keeps owners able to leave if the scheduler stops closing epochs.
///
///         What this contract never does: pay rewards (staking earns nothing by itself), let the Safe or the
///         scheduler move staked SPARE anywhere except to the burn, or rescue SPARE (only other tokens sent here by
///         mistake can be rescued, by the Safe). SPARE sent here without `stake` is stuck for good.
///
///         Token assumptions: a standard ERC-20. Fee-on-transfer tokens are handled by crediting the measured
///         balance increase on `stake`; every outflow must lower this contract's balance by exactly the amount sent
///         or it reverts. Rebasing tokens are not supported.
contract SparecycleNodeStake is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------------------------------------------
    // Defaults (brief §10). The constructor takes a `Config`; `defaultConfig()` returns these values.
    // ------------------------------------------------------------------------------------------------------------

    /// @notice N4: the most one executed proposal can take, in basis points of the owner's stake (10%).
    ///         Default, not yet confirmed by Fabio.
    uint16 public constant DEFAULT_SLASH_BPS = 1_000;
    /// @notice N6: fault window W in epochs (48 h at 6 h epochs). Faults are counted off-chain by the scheduler; the
    ///         contract only uses W to check that the cooldown outlasts it. Default, not yet confirmed by Fabio.
    uint64 public constant DEFAULT_FAULT_WINDOW_EPOCHS = 8;
    /// @notice N7: appeal window A in epochs (24 h at 6 h epochs). Default, not yet confirmed by Fabio.
    uint64 public constant DEFAULT_APPEAL_WINDOW_EPOCHS = 4;
    /// @notice N8: unstake cooldown C in epochs (4 days at 6 h epochs). Default, not yet confirmed by Fabio.
    uint64 public constant DEFAULT_COOLDOWN_EPOCHS = 16;
    /// @notice Not a brief §10 value: epochs the Safe has after the appeal window to execute or cancel a proposal
    ///         before it expires (72 h at 6 h epochs). Default, not yet confirmed by Fabio.
    uint64 public constant DEFAULT_DECISION_WINDOW_EPOCHS = 12;
    /// @notice Brief §3: a `minStakePerNode` change takes effect after at least one epoch.
    ///         Default, not yet confirmed by Fabio.
    uint64 public constant DEFAULT_MIN_STAKE_DELAY_EPOCHS = 1;
    /// @notice Not a brief §10 value: after a proposal against an owner is cancelled, expired or executed, no new
    ///         proposal against that owner for this many epochs (12 h at 6 h epochs; same epoch-and-time rule and
    ///         stall fallback as every other window). Gives an owner whose cooldown has finished a window to leave.
    ///         Fixed in code. Default, not yet confirmed by Fabio.
    uint64 public constant PROPOSAL_GRACE_EPOCHS = 2;

    // ------------------------------------------------------------------------------------------------------------
    // Hard limits (fixed in code, not configurable)
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Ceiling for `slashBps` (50%), so a deploy typo can never make slashing total.
    uint16 public constant MAX_SLASH_BPS = 5_000;
    /// @notice Upper bound for any window's nominal length in seconds (same bound as the reward contract's epoch).
    uint256 public constant MAX_WINDOW = 365 days;
    /// @notice If the reward contract stops closing epochs, a window of n epochs also ends after
    ///         STALL_FACTOR * n * epochLength seconds.
    uint256 public constant STALL_FACTOR = 2;
    /// @notice Where slashed SPARE goes when the token has no `burn(uint256)` (N9).
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ------------------------------------------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Deployment parameters. All windows are in reward-contract epochs.
    /// @param slashBps N4: max share of the stake one proposal can take, 1..MAX_SLASH_BPS.
    /// @param faultWindowEpochs N6 (W): off-chain fault window, >= 1. Only used for the cooldown check.
    /// @param appealWindowEpochs N7 (A): appeal window, >= 1.
    /// @param cooldownEpochs N8 (C): unstake cooldown, must be > W + A.
    /// @param decisionWindowEpochs Epochs after the appeal window before an undecided proposal expires, >= 1.
    /// @param minStakeDelayEpochs Delay before a `minStakePerNode` change takes effect, >= 1.
    struct Config {
        uint16 slashBps;
        uint64 faultWindowEpochs;
        uint64 appealWindowEpochs;
        uint64 cooldownEpochs;
        uint64 decisionWindowEpochs;
        uint64 minStakeDelayEpochs;
    }

    /// @notice Stored proposal status. `Open` proposals past their decision window read as `Expired` through
    ///         `proposalStatus` even before anyone calls `expireSlash`.
    enum Status {
        None,
        Open,
        Cancelled,
        Executed,
        Expired
    }

    /// @notice One slash proposal.
    /// @param owner Owner wallet whose stake is frozen.
    /// @param status Stored status (see `Status`).
    /// @param proposedEpoch Reward-contract epoch when proposed (start of the appeal window).
    /// @param proposedAt Timestamp when proposed.
    /// @param closedEpoch Reward-contract epoch when it was cancelled, executed or recorded as expired (0 while open).
    ///        The grace period after a cancel or execute starts here; after an expiry it starts at the expiry itself.
    /// @param closedAt Timestamp matching `closedEpoch` (0 while open).
    /// @param amount SPARE to burn if executed (<= slashBps of the stake at proposal time).
    /// @param evidenceHash keccak256 of the scheduler's evidence bundle (docs/node-staking.md).
    /// @param appealHash keccak256 of the owner's latest appeal bundle; zero if no appeal.
    struct Proposal {
        address owner;
        Status status;
        uint64 proposedEpoch;
        uint64 proposedAt;
        uint64 closedEpoch;
        uint64 closedAt;
        uint256 amount;
        bytes32 evidenceHash;
        bytes32 appealHash;
    }

    /// @notice One owner wallet's stake.
    /// @param staked Active stake: counts toward the minimum.
    /// @param unstaking Requested for unstake, in cooldown: does not count toward the minimum, still slashable.
    /// @param requestEpoch Reward-contract epoch of the latest `requestUnstake` (start of the cooldown).
    /// @param requestedAt Timestamp of the latest `requestUnstake`.
    /// @param lastProposal Id of the latest proposal against this owner, 0 if none. Only this one can be open; it may
    ///        have expired without a transaction (`openProposalOf` filters that out).
    struct Account {
        uint256 staked;
        uint256 unstaking;
        uint64 requestEpoch;
        uint64 requestedAt;
        uint256 lastProposal;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------------------------------------------------

    /// @notice The staked token (SPARE, `ADDR.spareToken`). Fixed.
    IERC20 public immutable token;
    /// @notice The live SparecycleRewards: source of epochs and of the scheduler key.
    ISparecycleRewardsForStake public immutable rewards;
    /// @notice The treasury Safe: judges proposals, sets the minimum, rescues non-SPARE tokens.
    address public immutable safe;
    /// @notice N9: true = `token.burn(amount)`; false = transfer to `DEAD`. Fixed at deploy.
    bool public immutable burnWithBurnFunction;
    /// @notice The reward contract's minimum epoch length in seconds (immutable there, copied here).
    uint64 public immutable epochLength;

    uint16 public immutable slashBps;
    uint64 public immutable faultWindowEpochs;
    uint64 public immutable appealWindowEpochs;
    uint64 public immutable cooldownEpochs;
    uint64 public immutable decisionWindowEpochs;
    uint64 public immutable minStakeDelayEpochs;

    /// @notice Sum of every owner's `staked + unstaking`. `token.balanceOf(this) >= totalStaked` always holds.
    uint256 public totalStaked;
    /// @notice Sum of all executed slashes (all burned).
    uint256 public totalSlashed;
    /// @notice Number of proposals ever made; ids run from 1 to proposalCount.
    uint256 public proposalCount;

    mapping(address owner => Account) private _accounts;
    mapping(uint256 proposalId => Proposal) private _proposals;

    uint256 private _minStake;
    uint256 private _nextMinStake;
    uint64 private _nextMinStakeEpoch;
    uint64 private _nextMinStakeAt;
    bool private _minStakeChangeScheduled;

    // ------------------------------------------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------------------------------------------

    /// @notice `amount` (what actually arrived) was added to `owner`'s active stake, now `staked`.
    event Staked(address indexed owner, uint256 amount, uint256 staked);
    /// @notice `amount` moved from active stake into the cooldown bucket, now `unstaking`; cooldown restarts at `epoch`.
    event UnstakeRequested(address indexed owner, uint256 amount, uint256 unstaking, uint64 epoch);
    /// @notice The cooldown bucket (`amount`) went back to active stake, now `staked`.
    event UnstakeCancelled(address indexed owner, uint256 amount, uint256 staked);
    /// @notice `amount` was paid back to `owner`.
    event Unstaked(address indexed owner, uint256 amount);
    /// @notice The scheduler proposed burning `amount` of `owner`'s stake; the appeal window starts at `epoch`.
    event SlashProposed(
        uint256 indexed proposalId, address indexed owner, uint256 amount, bytes32 evidenceHash, uint64 epoch
    );
    /// @notice `owner` appealed with the bundle hashing to `evidenceHash`.
    event SlashAppealed(uint256 indexed proposalId, address indexed owner, bytes32 evidenceHash);
    /// @notice The Safe cancelled the proposal; the stake is released.
    event SlashCancelled(uint256 indexed proposalId, address indexed owner);
    /// @notice Nobody decided within the decision window; the stake is released.
    event SlashExpired(uint256 indexed proposalId, address indexed owner);
    /// @notice The Safe executed the proposal: `amount` of `owner`'s stake was burned.
    event Slashed(address indexed owner, uint256 amount, uint256 indexed proposalId, bytes32 evidenceHash);
    /// @notice Emitted with `Slashed`: how much of the burned amount came from active stake and how much from the
    ///         cooldown bucket (`fromStaked + fromUnstaking == amount`).
    event SlashSplit(uint256 indexed proposalId, address indexed owner, uint256 fromStaked, uint256 fromUnstaking);
    /// @notice The Safe scheduled `next` as the minimum per node; `current` stays in force until the delay passes.
    event MinStakeChangeScheduled(uint256 current, uint256 next, uint64 epoch, uint64 scheduledAt);
    /// @notice The Safe dropped the scheduled change to `next` before it took effect.
    event MinStakeChangeCancelled(uint256 next);
    /// @notice The Safe returned `amount` of a non-SPARE `token` (address(0) = ETH) sent here by mistake.
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    // ------------------------------------------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------------------------------------------

    error ZeroAddress();
    error NoCode();
    error SafeIsScheduler();
    error SlashBpsOutOfRange();
    error ZeroWindow();
    error CooldownTooShort();
    error WindowTooLong();
    error ZeroAmount();
    error ZeroEvidence();
    error NotScheduler();
    error NotSafe();
    error NotProposalOwner();
    error InsufficientStake(uint256 staked, uint256 amount);
    error NothingToUnstake();
    error CooldownNotOver();
    error StakeFrozen(uint256 proposalId);
    error ProposalAlreadyOpen(uint256 proposalId);
    error ProposalGraceActive(uint256 lastProposalId);
    error SlashAboveCap(uint256 amount, uint256 cap);
    error NotOpen(uint256 proposalId);
    error AppealWindowOver(uint256 proposalId);
    error AppealWindowNotOver(uint256 proposalId);
    error ProposalExpired(uint256 proposalId);
    error NotExpired(uint256 proposalId);
    error NoScheduledMinStakeChange();
    error CannotRescueStakeToken();
    error UnexpectedBalanceChange();
    error TransferFailed();

    modifier onlySafe() {
        if (msg.sender != safe) revert NotSafe();
        _;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Construction
    // ------------------------------------------------------------------------------------------------------------

    /// @param token_ SPARE (`ADDR.spareToken` in src/lib/addresses.ts). Must have code.
    /// @param rewards_ The live SparecycleRewards (`ADDR.rewards`). Must have code.
    /// @param safe_ The treasury Safe (`ADDR.treasurySafe`). Must not be the current scheduler.
    /// @param burnWithBurnFunction_ N9: true if SPARE's verified source has `burn(uint256)` burning from the caller.
    /// @param minStakePerNode_ N3: initial minimum per active node ([MIN_STAKE_SPARE]); in force at once.
    /// @param c Windows and slash cap; see `Config` and `defaultConfig()`.
    constructor(
        address token_,
        address rewards_,
        address safe_,
        bool burnWithBurnFunction_,
        uint256 minStakePerNode_,
        Config memory c
    ) {
        if (token_ == address(0) || rewards_ == address(0) || safe_ == address(0)) {
            revert ZeroAddress();
        }
        if (token_.code.length == 0 || rewards_.code.length == 0) revert NoCode();
        ISparecycleRewardsForStake r = ISparecycleRewardsForStake(rewards_);
        // The judge must not be the accuser.
        if (safe_ == r.scheduler()) revert SafeIsScheduler();
        uint64 len = r.epochLength();
        if (len == 0) revert ZeroWindow();

        if (c.slashBps == 0 || c.slashBps > MAX_SLASH_BPS) revert SlashBpsOutOfRange();
        if (
            c.faultWindowEpochs == 0 || c.appealWindowEpochs == 0 || c.decisionWindowEpochs == 0
                || c.minStakeDelayEpochs == 0
        ) revert ZeroWindow();
        // N8: the cooldown outlasts the fault window plus the appeal window, so an owner who starts to leave while
        // faulting is still staked when the scheduler proposes, and stays frozen while the proposal is judged.
        if (uint256(c.cooldownEpochs) <= uint256(c.faultWindowEpochs) + c.appealWindowEpochs) {
            revert CooldownTooShort();
        }
        if (
            uint256(c.cooldownEpochs) * len > MAX_WINDOW
                || (uint256(c.appealWindowEpochs) + c.decisionWindowEpochs) * len > MAX_WINDOW
                || uint256(c.minStakeDelayEpochs) * len > MAX_WINDOW
        ) revert WindowTooLong();

        token = IERC20(token_);
        rewards = r;
        safe = safe_;
        burnWithBurnFunction = burnWithBurnFunction_;
        epochLength = len;
        slashBps = c.slashBps;
        faultWindowEpochs = c.faultWindowEpochs;
        appealWindowEpochs = c.appealWindowEpochs;
        cooldownEpochs = c.cooldownEpochs;
        decisionWindowEpochs = c.decisionWindowEpochs;
        minStakeDelayEpochs = c.minStakeDelayEpochs;
        _minStake = minStakePerNode_;
    }

    /// @notice The brief §10 defaults (Default, not yet confirmed by Fabio).
    function defaultConfig() external pure returns (Config memory) {
        return Config({
            slashBps: DEFAULT_SLASH_BPS,
            faultWindowEpochs: DEFAULT_FAULT_WINDOW_EPOCHS,
            appealWindowEpochs: DEFAULT_APPEAL_WINDOW_EPOCHS,
            cooldownEpochs: DEFAULT_COOLDOWN_EPOCHS,
            decisionWindowEpochs: DEFAULT_DECISION_WINDOW_EPOCHS,
            minStakeDelayEpochs: DEFAULT_MIN_STAKE_DELAY_EPOCHS
        });
    }

    // ------------------------------------------------------------------------------------------------------------
    // Owners
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Locks `amount` SPARE (needs prior approval) as the caller's active stake. Credits what actually
    ///         arrived (fee-on-transfer safe). Allowed while frozen: topping up never moves stake out.
    /// @param amount Amount to transfer in.
    /// @return received Amount credited.
    function stake(uint256 amount) external nonReentrant returns (uint256 received) {
        if (amount == 0) revert ZeroAmount();
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        received = token.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        Account storage a = _accounts[msg.sender];
        uint256 s = a.staked + received;
        a.staked = s;
        totalStaked += received;
        emit Staked(msg.sender, received, s);
    }

    /// @notice Moves `amount` of active stake into the cooldown bucket and restarts the cooldown for the whole bucket.
    ///         The bucket no longer counts toward the minimum but can still be slashed. Fails while frozen.
    /// @param amount Amount of active stake to start unstaking.
    function requestUnstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 open = _liveProposal(msg.sender);
        if (open != 0) revert StakeFrozen(open);
        Account storage a = _accounts[msg.sender];
        uint256 s = a.staked;
        if (amount > s) revert InsufficientStake(s, amount);
        a.staked = s - amount;
        uint256 u = a.unstaking + amount;
        a.unstaking = u;
        uint64 e = rewards.currentEpoch();
        a.requestEpoch = e;
        a.requestedAt = uint64(block.timestamp);
        emit UnstakeRequested(msg.sender, amount, u, e);
    }

    /// @notice Returns the whole cooldown bucket to active stake. Allowed while frozen (nothing leaves).
    function cancelUnstake() external nonReentrant {
        Account storage a = _accounts[msg.sender];
        uint256 u = a.unstaking;
        if (u == 0) revert NothingToUnstake();
        a.unstaking = 0;
        a.requestEpoch = 0;
        a.requestedAt = 0;
        uint256 s = a.staked + u;
        a.staked = s;
        emit UnstakeCancelled(msg.sender, u, s);
    }

    /// @notice Pays the caller's cooldown bucket back to the caller once the cooldown is over and no proposal is open.
    /// @return amount Amount paid.
    function unstake() external nonReentrant returns (uint256 amount) {
        Account storage a = _accounts[msg.sender];
        amount = a.unstaking;
        if (amount == 0) revert NothingToUnstake();
        uint256 open = _liveProposal(msg.sender);
        if (open != 0) revert StakeFrozen(open);
        if (!_windowOver(a.requestEpoch, a.requestedAt, cooldownEpochs)) revert CooldownNotOver();
        a.unstaking = 0;
        a.requestEpoch = 0;
        a.requestedAt = 0;
        totalStaked -= amount;
        emit Unstaked(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @notice The owner contests proposal `proposalId` during its appeal window. Can be repeated to add evidence;
    ///         the latest hash is stored. An appeal does not stop the clock: the Safe decides.
    /// @param proposalId Proposal against the caller.
    /// @param evidenceHash keccak256 of the appeal bundle (docs/node-staking.md), non-zero.
    function appeal(uint256 proposalId, bytes32 evidenceHash) external nonReentrant {
        Proposal storage p = _proposals[proposalId];
        if (p.status != Status.Open) revert NotOpen(proposalId);
        if (msg.sender != p.owner) revert NotProposalOwner();
        if (evidenceHash == bytes32(0)) revert ZeroEvidence();
        if (_windowOver(p.proposedEpoch, p.proposedAt, appealWindowEpochs)) revert AppealWindowOver(proposalId);
        p.appealHash = evidenceHash;
        emit SlashAppealed(proposalId, msg.sender, evidenceHash);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Scheduler (rewards.scheduler(), read live so a Safe rotation in the reward contract applies here too)
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Proposes burning `amount` of `owner`'s stake, backed by the evidence bundle hashing to `evidenceHash`.
    ///         `amount <= slashBps * (staked + unstaking) / 10_000`. One open proposal per owner, and none during the
    ///         grace period after the owner's previous proposal was cancelled, expired or executed. Freezes the stake.
    /// @param owner Owner wallet.
    /// @param amount SPARE to burn if executed.
    /// @param evidenceHash keccak256 of the published evidence bundle, non-zero.
    /// @return proposalId New proposal id.
    function proposeSlash(address owner, uint256 amount, bytes32 evidenceHash)
        external
        nonReentrant
        returns (uint256 proposalId)
    {
        if (msg.sender != rewards.scheduler()) revert NotScheduler();
        if (msg.sender == safe) revert SafeIsScheduler();
        if (evidenceHash == bytes32(0)) revert ZeroEvidence();
        if (amount == 0) revert ZeroAmount();
        Account storage a = _accounts[owner];
        uint256 last = a.lastProposal;
        if (last != 0) {
            Proposal storage lp = _proposals[last];
            bool stillOpen = lp.status == Status.Open;
            if (stillOpen && !_expired(lp)) revert ProposalAlreadyOpen(last);
            // Checked before any write, so a revert here never loses the expiry record below.
            if (!_graceOver(lp)) revert ProposalGraceActive(last);
            if (stillOpen) _expire(last, lp);
        }
        uint256 cap = maxSlashOf(owner);
        if (amount > cap) revert SlashAboveCap(amount, cap);

        proposalId = ++proposalCount;
        uint64 e = rewards.currentEpoch();
        _proposals[proposalId] = Proposal({
            owner: owner,
            status: Status.Open,
            proposedEpoch: e,
            proposedAt: uint64(block.timestamp),
            closedEpoch: 0,
            closedAt: 0,
            amount: amount,
            evidenceHash: evidenceHash,
            appealHash: bytes32(0)
        });
        a.lastProposal = proposalId;
        emit SlashProposed(proposalId, owner, amount, evidenceHash, e);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Safe
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Rejects proposal `proposalId` (the appeal succeeded or the evidence is wrong) and releases the stake.
    ///         Allowed at any time while the proposal is open. A proposal already past its decision window is
    ///         recorded as expired instead (`SlashExpired`), without reverting.
    /// @param proposalId Open proposal.
    function cancelSlash(uint256 proposalId) external onlySafe nonReentrant {
        Proposal storage p = _proposals[proposalId];
        if (p.status != Status.Open) revert NotOpen(proposalId);
        if (_expired(p)) {
            _expire(proposalId, p);
            return;
        }
        p.status = Status.Cancelled;
        _close(p);
        emit SlashCancelled(proposalId, p.owner);
    }

    /// @notice Executes proposal `proposalId` after its appeal window: burns its amount, taken from active stake
    ///         first and then from the cooldown bucket. Not possible once the decision window has passed.
    /// @param proposalId Open proposal.
    function executeSlash(uint256 proposalId) external onlySafe nonReentrant {
        Proposal storage p = _proposals[proposalId];
        if (p.status != Status.Open) revert NotOpen(proposalId);
        if (!_windowOver(p.proposedEpoch, p.proposedAt, appealWindowEpochs)) revert AppealWindowNotOver(proposalId);
        if (_expired(p)) revert ProposalExpired(proposalId);

        address owner = p.owner;
        uint256 amount = p.amount;
        p.status = Status.Executed;
        _close(p);
        Account storage a = _accounts[owner];
        // Nothing could leave while the proposal was open, so staked + unstaking >= amount (checked arithmetic).
        uint256 s = a.staked;
        uint256 fromStaked = amount < s ? amount : s;
        uint256 fromUnstaking = amount - fromStaked;
        a.staked = s - fromStaked;
        a.unstaking -= fromUnstaking;
        totalStaked -= amount;
        totalSlashed += amount;
        emit Slashed(owner, amount, proposalId, p.evidenceHash);
        emit SlashSplit(proposalId, owner, fromStaked, fromUnstaking);
        _burn(amount);
    }

    /// @notice Schedules a new minimum stake per active node (N3). It takes effect after `minStakeDelayEpochs`
    ///         (epochs and time, see the contract notes). Replaces a change that has not taken effect yet, and emits
    ///         `MinStakeChangeCancelled` for it first.
    /// @param newMinStakePerNode New minimum, in SPARE base units.
    function scheduleMinStakePerNode(uint256 newMinStakePerNode) external onlySafe nonReentrant {
        if (_minStakeChangeScheduled && !_minStakeChangeDue()) emit MinStakeChangeCancelled(_nextMinStake);
        uint256 current = minStakePerNode();
        _minStake = current;
        _nextMinStake = newMinStakePerNode;
        uint64 e = rewards.currentEpoch();
        _nextMinStakeEpoch = e;
        _nextMinStakeAt = uint64(block.timestamp);
        _minStakeChangeScheduled = true;
        emit MinStakeChangeScheduled(current, newMinStakePerNode, e, uint64(block.timestamp));
    }

    /// @notice Drops a scheduled minimum-stake change that has not taken effect yet.
    function cancelMinStakeChange() external onlySafe nonReentrant {
        if (!_minStakeChangeScheduled || _minStakeChangeDue()) revert NoScheduledMinStakeChange();
        _minStakeChangeScheduled = false;
        emit MinStakeChangeCancelled(_nextMinStake);
    }

    /// @notice Returns a token other than SPARE (or ETH, `otherToken == address(0)`) sent here by mistake. Never
    ///         SPARE, and reverts if this contract's SPARE balance drops during the call (double-entry tokens).
    /// @param otherToken Token to return; address(0) for ETH.
    /// @param to Recipient, non-zero.
    /// @param amount Amount.
    function rescueToken(address otherToken, address to, uint256 amount) external onlySafe nonReentrant {
        if (otherToken == address(token)) revert CannotRescueStakeToken();
        if (to == address(0)) revert ZeroAddress();
        uint256 stakeBefore = token.balanceOf(address(this));
        if (otherToken == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(otherToken).safeTransfer(to, amount);
        }
        if (token.balanceOf(address(this)) < stakeBefore) revert CannotRescueStakeToken();
        emit TokenRescued(otherToken, to, amount);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Anyone
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Records that proposal `proposalId` expired undecided (for indexers). The freeze already ends at
    ///         expiry without this call.
    /// @param proposalId Open proposal past its decision window.
    function expireSlash(uint256 proposalId) external nonReentrant {
        Proposal storage p = _proposals[proposalId];
        if (p.status != Status.Open) revert NotOpen(proposalId);
        if (!_expired(p)) revert NotExpired(proposalId);
        _expire(proposalId, p);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Reads (for the scheduler, the node page and the holder page)
    // ------------------------------------------------------------------------------------------------------------

    /// @notice Active stake of `owner`: what counts toward the minimum. Excludes the cooldown bucket.
    function stakedOf(address owner) public view returns (uint256) {
        return _accounts[owner].staked;
    }

    /// @notice `owner`'s cooldown bucket and when its cooldown started.
    function unstakingOf(address owner)
        external
        view
        returns (uint256 amount, uint64 requestEpoch, uint64 requestedAt)
    {
        Account storage a = _accounts[owner];
        return (a.unstaking, a.requestEpoch, a.requestedAt);
    }

    /// @notice Everything of `owner`'s that can still be slashed: active stake plus the cooldown bucket.
    function slashableOf(address owner) public view returns (uint256) {
        Account storage a = _accounts[owner];
        return a.staked + a.unstaking;
    }

    /// @notice The largest `amount` a new proposal against `owner` may carry now: slashBps of `slashableOf(owner)`.
    function maxSlashOf(address owner) public view returns (uint256) {
        return Math.mulDiv(slashableOf(owner), slashBps, 10_000);
    }

    /// @notice The whole account record of `owner` (raw; `lastProposal` may be closed, or open but expired).
    function getAccount(address owner) external view returns (Account memory) {
        return _accounts[owner];
    }

    /// @notice The minimum stake per active node in force now (N3).
    function minStakePerNode() public view returns (uint256) {
        return _minStakeChangeDue() ? _nextMinStake : _minStake;
    }

    /// @notice A scheduled minimum-stake change that has not taken effect yet, if any.
    /// @return scheduled True if a change is waiting.
    /// @return next The value it will set.
    /// @return epoch Reward-contract epoch it was scheduled in.
    /// @return scheduledAt Timestamp it was scheduled at.
    function scheduledMinStakeChange()
        external
        view
        returns (bool scheduled, uint256 next, uint64 epoch, uint64 scheduledAt)
    {
        if (!_minStakeChangeScheduled || _minStakeChangeDue()) return (false, 0, 0, 0);
        return (true, _nextMinStake, _nextMinStakeEpoch, _nextMinStakeAt);
    }

    /// @notice Whether `owner`'s active stake covers `activeNodes` nodes: `stakedOf(owner) >= minStakePerNode() *
    ///         activeNodes` (computed without overflow).
    /// @param owner Owner wallet.
    /// @param activeNodes Number of the owner's active nodes (known off-chain).
    function meetsMinimum(address owner, uint256 activeNodes) external view returns (bool) {
        if (activeNodes == 0) return true;
        // For integers, s >= m * n  <=>  floor(s / n) >= m.
        return stakedOf(owner) / activeNodes >= minStakePerNode();
    }

    /// @notice How many active nodes `owner`'s active stake covers (type(uint256).max when the minimum is 0).
    function nodesCovered(address owner) external view returns (uint256) {
        uint256 m = minStakePerNode();
        return m == 0 ? type(uint256).max : stakedOf(owner) / m;
    }

    /// @notice Id of `owner`'s open, unexpired proposal; 0 if none. While non-zero the stake is frozen.
    function openProposalOf(address owner) public view returns (uint256) {
        uint256 id = _accounts[owner].lastProposal;
        if (id == 0) return 0;
        Proposal storage p = _proposals[id];
        if (p.status != Status.Open || _expired(p)) return 0;
        return id;
    }

    /// @notice Whether the scheduler could propose against `owner` now as far as timing goes: no open proposal and
    ///         the grace period after the previous one is over. (The amount must still be within `maxSlashOf`.)
    function canPropose(address owner) external view returns (bool) {
        uint256 id = _accounts[owner].lastProposal;
        if (id == 0) return true;
        Proposal storage p = _proposals[id];
        if (p.status == Status.Open && !_expired(p)) return false;
        return _graceOver(p);
    }

    /// @notice Whether `owner` can call `unstake()` successfully now.
    function canUnstake(address owner) external view returns (bool) {
        Account storage a = _accounts[owner];
        return
            a.unstaking != 0 && openProposalOf(owner) == 0 && _windowOver(a.requestEpoch, a.requestedAt, cooldownEpochs);
    }

    /// @notice Proposal `proposalId` as stored.
    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    /// @notice Effective status of `proposalId`: an `Open` proposal past its decision window reads `Expired`.
    function proposalStatus(uint256 proposalId) external view returns (Status) {
        Proposal storage p = _proposals[proposalId];
        if (p.status == Status.Open && _expired(p)) return Status.Expired;
        return p.status;
    }

    /// @notice Whether the owner can still appeal `proposalId`.
    function canAppeal(uint256 proposalId) external view returns (bool) {
        Proposal storage p = _proposals[proposalId];
        return p.status == Status.Open && !_windowOver(p.proposedEpoch, p.proposedAt, appealWindowEpochs);
    }

    /// @notice Whether the Safe can execute `proposalId` now.
    function canExecute(uint256 proposalId) external view returns (bool) {
        Proposal storage p = _proposals[proposalId];
        return p.status == Status.Open && _windowOver(p.proposedEpoch, p.proposedAt, appealWindowEpochs) && !_expired(p);
    }

    // ------------------------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------------------------

    /// @dev A window of `epochs` that started at (`startEpoch`, `startAt`) is over when at least `epochs *
    ///      epochLength` seconds have passed and either the reward contract has closed `epochs` epochs since, or (if
    ///      epochs stopped closing) STALL_FACTOR times that many seconds have passed.
    function _windowOver(uint64 startEpoch, uint64 startAt, uint256 epochs) internal view returns (bool) {
        uint256 span = epochs * epochLength;
        if (block.timestamp < uint256(startAt) + span) return false;
        if (uint256(rewards.currentEpoch()) >= uint256(startEpoch) + epochs) return true;
        return block.timestamp >= uint256(startAt) + STALL_FACTOR * span;
    }

    /// @dev The decision window (appeal window + decisionWindowEpochs) of `p` is over.
    function _expired(Proposal storage p) internal view returns (bool) {
        return _windowOver(p.proposedEpoch, p.proposedAt, uint256(appealWindowEpochs) + decisionWindowEpochs);
    }

    /// @dev The grace period after `p` (the owner's latest proposal, no longer live) is over. After a cancel or an
    ///      execute it runs PROPOSAL_GRACE_EPOCHS from the decision. After an expiry it runs PROPOSAL_GRACE_EPOCHS past
    ///      the expiry itself, measured from the proposal (appeal + decision + grace), so it never depends on when, or
    ///      whether, anyone recorded the expiry.
    function _graceOver(Proposal storage p) internal view returns (bool) {
        if (p.status == Status.Cancelled || p.status == Status.Executed) {
            return _windowOver(p.closedEpoch, p.closedAt, PROPOSAL_GRACE_EPOCHS);
        }
        return _windowOver(
            p.proposedEpoch, p.proposedAt, uint256(appealWindowEpochs) + decisionWindowEpochs + PROPOSAL_GRACE_EPOCHS
        );
    }

    /// @dev Id of `owner`'s live open proposal (0 if none). Records an expired one as such on the way.
    function _liveProposal(address owner) internal returns (uint256 id) {
        id = _accounts[owner].lastProposal;
        if (id == 0) return 0;
        Proposal storage p = _proposals[id];
        if (p.status != Status.Open) return 0;
        if (_expired(p)) {
            _expire(id, p);
            return 0;
        }
    }

    /// @dev Stamps the epoch and time a proposal was closed (cancelled, executed or recorded as expired).
    function _close(Proposal storage p) internal {
        p.closedEpoch = rewards.currentEpoch();
        p.closedAt = uint64(block.timestamp);
    }

    function _expire(uint256 id, Proposal storage p) internal {
        p.status = Status.Expired;
        _close(p);
        emit SlashExpired(id, p.owner);
    }

    function _minStakeChangeDue() internal view returns (bool) {
        return _minStakeChangeScheduled && _windowOver(_nextMinStakeEpoch, _nextMinStakeAt, minStakeDelayEpochs);
    }

    /// @dev Sends `amount` SPARE to `to`; this contract's balance must drop by exactly `amount`.
    function _send(address to, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        token.safeTransfer(to, amount);
        if (token.balanceOf(address(this)) + amount != before) revert UnexpectedBalanceChange();
    }

    /// @dev Burns `amount` SPARE (N9); this contract's balance must drop by exactly `amount`.
    function _burn(uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        if (burnWithBurnFunction) IERC20BurnForStake(address(token)).burn(amount);
        else token.safeTransfer(DEAD, amount);
        if (token.balanceOf(address(this)) + amount != before) revert UnexpectedBalanceChange();
    }
}
