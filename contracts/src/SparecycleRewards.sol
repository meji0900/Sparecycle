// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IPonsFeeEscrow} from "./interfaces/IPonsFeeEscrow.sol";

/// @title SparecycleRewards
/// @notice Holds the Sparecycle node-reward pot, funded only by real inflows (Pons creator fees and public
///         `fund` calls), and pays node operators from per-epoch Merkle roots posted by the scheduler.
///
///         Lifecycle: epoch 0 starts at deploy. Every inflow is credited to the current open epoch's pot.
///         After `epochLength` seconds the scheduler calls `closeEpochAndPostRoot`, which settles the epoch
///         with a root whose leaves sum to `reserved <= pot`, rolls `pot - reserved` into the next epoch and
///         opens it. Operators then `claim` their leaf; unclaimed reserved amounts stay claimable forever.
///
///         Accounting: `accounted` = open epoch pot + sum over settled epochs of (reserved - claimed).
///         `receive()` is empty so 2300-gas ETH pushes succeed; such value is "unaccounted" until `sync()`
///         (or the `sync()` inside close) credits it to the open epoch. Nothing ever credits more than the
///         contract's measured balance, so `accounted <= balance` always holds.
///
///         Trust model (disclosed in the UI): the scheduler is a centralized key in the MVP and decides the
///         split of each pot; the owner (multisig) can rotate the scheduler, pause claims and rescue
///         non-payout tokens. There is no withdraw, mint, setPot or any other path for the owner or scheduler
///         to move the payout asset. Leaves: `keccak256(abi.encodePacked(uint64 epochId, address account,
///         uint256 amount))` (60 bytes), OpenZeppelin sorted-pair Merkle tree.
/// @dev Payout asset is native ETH (`payoutToken == address(0)`) or one standard ERC-20 (intended: USDG).
///      Fee-on-transfer, rebasing and double-entry-point tokens are not supported as the payout token
///      (inflows are credited by measured balance delta, which keeps fee-on-transfer tokens safe but not
///      useful; a rebasing-down token would break `accounted <= balance`).
contract SparecycleRewards is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice One reward epoch.
    /// @param index Epoch id (equal to its key once the epoch exists; 0 for epochs not started yet).
    /// @param startedAt Timestamp the epoch opened (0 = not started yet).
    /// @param endedAt Timestamp the epoch was settled (0 while open).
    /// @param pot Assets assigned to this epoch: rolled-in amount plus inflows while open. Frozen at close.
    /// @param reserved Sum of the amounts in the posted Merkle tree (`<= pot`).
    /// @param claimed Sum actually claimed so far (`<= reserved`).
    /// @param merkleRoot Posted root, `bytes32(0)` until posted (and for an empty settlement).
    /// @param settled True once the root is posted; claims open.
    struct Epoch {
        uint64 index;
        uint64 startedAt;
        uint64 endedAt;
        uint256 pot;
        uint256 reserved;
        uint256 claimed;
        bytes32 merkleRoot;
        bool settled;
    }

    /// @dev Upper bound for `epochLength`, so a typo cannot lock the first pot for centuries.
    uint64 private constant MAX_EPOCH_LENGTH = 365 days;

    /// @notice Payout asset: `address(0)` = native ETH, otherwise the ERC-20 paid to operators.
    address public immutable payoutToken;
    /// @notice Pons v2 fee escrow this contract claims creator fees from.
    address public immutable feeEscrow;
    /// @notice Minimum duration of an epoch in seconds before it can be closed.
    uint64 public immutable epochLength;

    /// @notice Key allowed to close epochs and post Merkle roots.
    address public scheduler;
    /// @notice Id of the current open epoch.
    uint64 public currentEpoch;
    /// @notice True while the owner has paused claims (emergency only; disclosed in the UI).
    bool public claimsPaused;
    /// @notice Open epoch pot plus the sum of (reserved - claimed) over settled epochs.
    uint256 public accounted;

    mapping(uint64 epochId => Epoch) private _epochs;
    mapping(uint64 epochId => mapping(address account => bool)) private _claimed;

    /// @notice An inflow was credited to `epochId`'s pot. `from` is the sender for `fund`/`fundToken`,
    ///         the escrow for escrow claims and `address(0)` for value credited by `sync()`.
    event PotFunded(uint64 indexed epochId, address indexed from, uint256 amount);
    /// @notice `amount` was withdrawn from the Pons fee escrow into this contract.
    event FeesClaimedFromEscrow(uint64 indexed epochId, uint256 amount);
    /// @notice A new epoch opened with `rolledIn` carried over from the previous one.
    event EpochStarted(uint64 indexed epochId, uint64 startedAt, uint256 rolledIn);
    /// @notice An epoch was closed with `merkleRoot`; `reserved` of its `pot` is now claimable.
    event EpochSettled(uint64 indexed epochId, bytes32 merkleRoot, uint256 reserved, uint256 pot);
    /// @notice `amount` (= pot - reserved) moved from `fromEpoch` to `toEpoch`.
    event RolledOver(uint64 indexed fromEpoch, uint64 indexed toEpoch, uint256 amount);
    /// @notice `account` claimed `amount` from `epochId`.
    event Claimed(uint64 indexed epochId, address indexed account, uint256 amount);
    /// @notice The scheduler key changed.
    event SchedulerUpdated(address indexed previousScheduler, address indexed newScheduler);
    /// @notice Claims were paused by the owner.
    event ClaimsPaused(address indexed by);
    /// @notice Claims were unpaused by the owner.
    event ClaimsUnpaused(address indexed by);

    /// @notice Caller is not the scheduler.
    error NotScheduler();
    /// @notice `epochId` is not the current open epoch.
    error WrongEpoch();
    /// @notice The epoch has not lasted `epochLength` seconds yet.
    error EpochNotOver();
    /// @notice The epoch was already settled; roots cannot be re-posted or corrected.
    error AlreadySettled();
    /// @notice `reserved` is larger than the epoch pot.
    error ReservedExceedsPot();
    /// @notice A zero root was posted with a non-zero `reserved`.
    error EmptyRootWithReserved();
    /// @notice The epoch has no posted root yet.
    error NotSettled();
    /// @notice The caller already claimed this epoch.
    error AlreadyClaimed();
    /// @notice The proof does not prove (epochId, caller, amount) against the epoch root.
    error InvalidProof();
    /// @notice The claim would push the epoch's claimed total above its reserved amount.
    error ClaimExceedsReserved();
    /// @notice Claims are paused by the owner.
    error ClaimsArePaused();
    /// @notice The function is for the other payout mode (ETH vs ERC-20).
    error WrongPayoutMode();
    /// @notice The payout asset can never be rescued.
    error CannotRescuePayoutToken();
    /// @notice A required address was zero.
    error ZeroAddress();
    /// @notice A native ETH transfer failed.
    error TransferFailed();

    /// @dev Restricts a function to the scheduler key.
    modifier onlyScheduler() {
        if (msg.sender != scheduler) revert NotScheduler();
        _;
    }

    /// @notice Deploys the reward contract and opens epoch 0.
    /// @param admin Owner (intended: the multisig). Two-step ownership transfers.
    /// @param scheduler_ Key allowed to close epochs and post roots.
    /// @param payoutToken_ `address(0)` for native ETH, otherwise the ERC-20 payout token (must have code).
    /// @param feeEscrow_ Pons v2 fee escrow (`0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e` on mainnet).
    /// @param epochLength_ Minimum epoch duration in seconds, 1 second to 365 days.
    constructor(address admin, address scheduler_, address payoutToken_, address feeEscrow_, uint64 epochLength_)
        Ownable(admin)
    {
        if (scheduler_ == address(0) || feeEscrow_ == address(0)) revert ZeroAddress();
        require(payoutToken_ == address(0) || payoutToken_.code.length != 0, "payoutToken has no code");
        require(epochLength_ != 0 && epochLength_ <= MAX_EPOCH_LENGTH, "epochLength out of range");

        payoutToken = payoutToken_;
        feeEscrow = feeEscrow_;
        epochLength = epochLength_;
        scheduler = scheduler_;

        _epochs[0].startedAt = uint64(block.timestamp);
        emit SchedulerUpdated(address(0), scheduler_);
        emit EpochStarted(0, uint64(block.timestamp), 0);
    }

    /// @notice Accepts native ETH with no storage writes, so 2300-gas `transfer`/`send` pushes succeed.
    ///         The value is credited to the open epoch by the next `sync()` (also run inside every close).
    ///         In ERC-20 mode ETH is not the payout asset; the owner can return it with `rescueToken(0, …)`.
    receive() external payable {}

    // ------------------------------------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------------------------------------

    /// @notice Returns epoch `epochId`. Epochs that have not started return a zeroed struct.
    /// @param epochId Epoch id.
    /// @return The epoch record.
    function getEpoch(uint64 epochId) external view returns (Epoch memory) {
        return _epochs[epochId];
    }

    /// @notice Whether `account` already claimed epoch `epochId`.
    /// @param epochId Epoch id.
    /// @param account Leaf account.
    /// @return True if claimed.
    function hasClaimed(uint64 epochId, address account) external view returns (bool) {
        return _claimed[epochId][account];
    }

    /// @notice Payout-asset balance not yet credited to any epoch (e.g. ETH pushed to `receive()`).
    /// @return Balance minus `accounted`, floored at zero.
    function unaccounted() public view returns (uint256) {
        uint256 bal = _balance();
        uint256 acc = accounted;
        return bal > acc ? bal - acc : 0;
    }

    /// @notice Whether `closeEpochAndPostRoot(epochId, …)` would pass its epoch and time checks now.
    /// @param epochId Epoch id.
    /// @return True if `epochId` is the open epoch and it has lasted at least `epochLength` seconds.
    function canClose(uint64 epochId) external view returns (bool) {
        return epochId == currentEpoch && block.timestamp >= uint256(_epochs[epochId].startedAt) + epochLength;
    }

    /// @notice The Merkle leaf for (`epochId`, `account`, `amount`):
    ///         `keccak256(abi.encodePacked(uint64 epochId, address account, uint256 amount))`.
    /// @param epochId Epoch id (encoded as 8 bytes).
    /// @param account Operator wallet (20 bytes).
    /// @param amount Payout in the payout asset's base units (32 bytes).
    /// @return The 32-byte leaf.
    function leafOf(uint64 epochId, address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(epochId, account, amount));
    }

    // ------------------------------------------------------------------------------------------------
    // Inflows (permissionless)
    // ------------------------------------------------------------------------------------------------

    /// @notice Adds `msg.value` ETH to the current epoch's pot. ETH mode only.
    function fund() external payable nonReentrant {
        if (payoutToken != address(0)) revert WrongPayoutMode();
        _credit(msg.sender, msg.value);
    }

    /// @notice Pulls `amount` of the payout token from the caller (needs prior approval) into the current
    ///         epoch's pot. ERC-20 mode only. Credits the measured balance increase.
    /// @param amount Amount to transfer in.
    function fundToken(uint256 amount) external nonReentrant {
        address token = payoutToken;
        if (token == address(0)) revert WrongPayoutMode();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _credit(msg.sender, IERC20(token).balanceOf(address(this)) - before);
    }

    /// @notice Credits any unaccounted payout-asset balance to the current epoch's pot. Anyone can call it;
    ///         it can only credit value the contract really holds.
    /// @return credited Amount credited.
    function sync() external nonReentrant returns (uint256 credited) {
        credited = _sync();
    }

    /// @notice Withdraws this contract's native balance from the Pons fee escrow and credits the received
    ///         amount to the current epoch. ETH mode only. Permissionless. Returns 0 without calling the
    ///         escrow when the escrow reports a zero balance (the real escrow reverts `NoBalance()` then).
    /// @return credited Amount received from the escrow (measured balance delta).
    function claimFeesFromEscrow() external nonReentrant returns (uint256 credited) {
        if (payoutToken != address(0)) revert WrongPayoutMode();
        IPonsFeeEscrow escrow = IPonsFeeEscrow(feeEscrow);
        if (escrow.balanceOf(address(this)) == 0) return 0;
        uint256 before = address(this).balance;
        escrow.claim();
        credited = address(this).balance - before;
        _creditFromEscrow(credited);
    }

    /// @notice Withdraws this contract's payout-token balance from the Pons fee escrow and credits the
    ///         received amount to the current epoch. ERC-20 mode only. Permissionless. Returns 0 without
    ///         calling the escrow when the escrow reports a zero balance.
    /// @return credited Amount received from the escrow (measured balance delta).
    function claimFeesFromEscrowToken() external nonReentrant returns (uint256 credited) {
        address token = payoutToken;
        if (token == address(0)) revert WrongPayoutMode();
        IPonsFeeEscrow escrow = IPonsFeeEscrow(feeEscrow);
        if (escrow.balanceOfToken(address(this), token) == 0) return 0;
        uint256 before = IERC20(token).balanceOf(address(this));
        escrow.claimToken(token);
        credited = IERC20(token).balanceOf(address(this)) - before;
        _creditFromEscrow(credited);
    }

    // ------------------------------------------------------------------------------------------------
    // Scheduler
    // ------------------------------------------------------------------------------------------------

    /// @notice Closes the open epoch: credits unaccounted inflows, posts `merkleRoot` with `reserved`
    ///         (sum of its leaves), rolls `pot - reserved` into the next epoch and opens it.
    ///         There is no second post and no correction function: a wrong root is final for that epoch
    ///         (claims are capped by `reserved`, so an over-allocating tree cannot pay more than `reserved`).
    /// @param epochId Must equal `currentEpoch`.
    /// @param merkleRoot Root of the payout tree; zero only together with `reserved == 0`.
    /// @param reserved Sum of all leaf amounts; must not exceed the pot after `sync()`.
    function closeEpochAndPostRoot(uint64 epochId, bytes32 merkleRoot, uint256 reserved)
        external
        nonReentrant
        onlyScheduler
    {
        uint64 id = currentEpoch;
        if (epochId != id) {
            if (epochId < id) revert AlreadySettled();
            revert WrongEpoch();
        }
        Epoch storage e = _epochs[id];
        if (block.timestamp < uint256(e.startedAt) + epochLength) revert EpochNotOver();

        _sync();
        uint256 pot = e.pot;
        if (reserved > pot) revert ReservedExceedsPot();
        if (merkleRoot == bytes32(0) && reserved != 0) revert EmptyRootWithReserved();

        uint64 nowTs = uint64(block.timestamp);
        e.endedAt = nowTs;
        e.merkleRoot = merkleRoot;
        e.reserved = reserved;
        e.settled = true;
        emit EpochSettled(id, merkleRoot, reserved, pot);

        // `accounted` is unchanged: the open pot becomes (reserved, outstanding) + (rollover, new open pot).
        uint256 rollover = pot - reserved;
        uint64 next = id + 1;
        Epoch storage n = _epochs[next];
        n.index = next;
        n.startedAt = nowTs;
        n.pot = rollover;
        currentEpoch = next;
        emit RolledOver(id, next, rollover);
        emit EpochStarted(next, nowTs, rollover);
    }

    // ------------------------------------------------------------------------------------------------
    // Claims
    // ------------------------------------------------------------------------------------------------

    /// @notice Pays `amount` to the caller if (epochId, caller, amount) is a leaf of the epoch's root.
    ///         One claim per account per epoch; the epoch's claimed total can never exceed `reserved`.
    /// @param epochId Settled epoch id.
    /// @param amount Leaf amount.
    /// @param proof Sorted-pair Merkle proof for the leaf.
    function claim(uint64 epochId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        if (claimsPaused) revert ClaimsArePaused();
        Epoch storage e = _epochs[epochId];
        if (!e.settled) revert NotSettled();
        if (_claimed[epochId][msg.sender]) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(proof, e.merkleRoot, leafOf(epochId, msg.sender, amount))) {
            revert InvalidProof();
        }
        uint256 newClaimed = e.claimed + amount;
        if (newClaimed > e.reserved) revert ClaimExceedsReserved();

        _claimed[epochId][msg.sender] = true;
        e.claimed = newClaimed;
        accounted -= amount;
        emit Claimed(epochId, msg.sender, amount);

        _pay(msg.sender, amount);
    }

    // ------------------------------------------------------------------------------------------------
    // Owner (multisig)
    // ------------------------------------------------------------------------------------------------

    /// @notice Replaces the scheduler key.
    /// @param newScheduler New scheduler, non-zero.
    function setScheduler(address newScheduler) external onlyOwner {
        if (newScheduler == address(0)) revert ZeroAddress();
        address previous = scheduler;
        scheduler = newScheduler;
        emit SchedulerUpdated(previous, newScheduler);
    }

    /// @notice Pauses claims (emergency only). Funding and closing continue; no funds can move to the owner.
    function pauseClaims() external onlyOwner {
        claimsPaused = true;
        emit ClaimsPaused(msg.sender);
    }

    /// @notice Unpauses claims.
    function unpauseClaims() external onlyOwner {
        claimsPaused = false;
        emit ClaimsUnpaused(msg.sender);
    }

    /// @notice Returns an asset sent here by mistake. Never the payout asset: reverts for `payoutToken`
    ///         (in ETH mode `token == address(0)` is the payout asset, so only ERC-20s can be rescued; in
    ///         ERC-20 mode `token == address(0)` rescues stray ETH). Also reverts if the payout balance
    ///         drops during the transfer (double-entry-point tokens).
    /// @param token ERC-20 to rescue, or `address(0)` for ETH in ERC-20 mode.
    /// @param to Recipient, non-zero.
    /// @param amount Amount.
    function rescueToken(address token, address to, uint256 amount) external nonReentrant onlyOwner {
        if (token == payoutToken) revert CannotRescuePayoutToken();
        if (to == address(0)) revert ZeroAddress();
        uint256 payoutBefore = _balance();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        if (_balance() < payoutBefore) revert CannotRescuePayoutToken();
    }

    // ------------------------------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------------------------------

    /// @dev Blocks `renounceOwnership()` (the only path to a zero owner): an ownerless contract could never
    ///      rotate a lost scheduler key or unpause claims, which would strand the pot. Ownership can only
    ///      move to a new owner through the two-step transfer.
    function _transferOwnership(address newOwner) internal override {
        if (newOwner == address(0)) revert("renounce disabled");
        super._transferOwnership(newOwner);
    }

    /// @dev Payout-asset balance held by this contract.
    function _balance() internal view returns (uint256) {
        address token = payoutToken;
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    /// @dev Credits `amount` to the open epoch and to `accounted`; emits `PotFunded` when non-zero.
    function _credit(address from, uint256 amount) internal {
        if (amount == 0) return;
        uint64 id = currentEpoch;
        _epochs[id].pot += amount;
        accounted += amount;
        emit PotFunded(id, from, amount);
    }

    /// @dev Credits all unaccounted balance to the open epoch.
    function _sync() internal returns (uint256 credited) {
        credited = unaccounted();
        _credit(address(0), credited);
    }

    /// @dev Emits the escrow events and credits `amount` received from the escrow.
    function _creditFromEscrow(uint256 amount) internal {
        if (amount == 0) return;
        emit FeesClaimedFromEscrow(currentEpoch, amount);
        _credit(feeEscrow, amount);
    }

    /// @dev Sends `amount` of the payout asset to `to`.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        address token = payoutToken;
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
