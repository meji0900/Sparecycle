// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
// R = the reward contract type; short alias keeps the tables readable.
import {SparecycleRewards as R} from "../src/SparecycleRewards.sol";

/// @notice Forge-side half of the ABI sync check (the full structural diff is `npm run contracts:abi-check`).
///         Each row pins one interface entry three ways: the exact human-readable line must appear in
///         `src/contracts/sparecycleRewards.ts`, its canonical signature hash must equal the selector the
///         compiler derives from the Solidity declaration, and (implicitly) the declaration must exist.
contract AbiSyncTest is Test {
    string internal ts;
    /// @dev Never called; only used to take selectors (public getters need an instance).
    R internal r;

    function setUp() public {
        ts = vm.readFile("../src/contracts/sparecycleRewards.ts");
    }

    function _has(string memory line) internal view {
        assertTrue(vm.indexOf(ts, string.concat('"', line, '"')) != type(uint256).max, line);
    }

    function _fn(string memory line, string memory canonical, bytes4 sel) internal view {
        _has(line);
        assertEq(bytes4(keccak256(bytes(canonical))), sel, canonical);
    }

    function _ev(string memory line, string memory canonical, bytes32 topic) internal view {
        _has(line);
        assertEq(keccak256(bytes(canonical)), topic, canonical);
    }

    function test_Functions() public view {
        _fn("function currentEpoch() view returns (uint64)", "currentEpoch()", r.currentEpoch.selector);
        _fn("function getEpoch(uint64 epochId) view returns (Epoch)", "getEpoch(uint64)", r.getEpoch.selector);
        _fn("function epochLength() view returns (uint64)", "epochLength()", r.epochLength.selector);
        _fn("function payoutToken() view returns (address)", "payoutToken()", r.payoutToken.selector);
        _fn("function feeEscrow() view returns (address)", "feeEscrow()", r.feeEscrow.selector);
        _fn("function scheduler() view returns (address)", "scheduler()", r.scheduler.selector);
        _fn("function owner() view returns (address)", "owner()", r.owner.selector);
        _fn("function claimsPaused() view returns (bool)", "claimsPaused()", r.claimsPaused.selector);
        _fn(
            "function hasClaimed(uint64 epochId, address account) view returns (bool)",
            "hasClaimed(uint64,address)",
            r.hasClaimed.selector
        );
        _fn("function accounted() view returns (uint256)", "accounted()", r.accounted.selector);
        _fn("function unaccounted() view returns (uint256)", "unaccounted()", r.unaccounted.selector);
        _fn("function canClose(uint64 epochId) view returns (bool)", "canClose(uint64)", r.canClose.selector);
        _fn(
            "function leafOf(uint64 epochId, address account, uint256 amount) pure returns (bytes32)",
            "leafOf(uint64,address,uint256)",
            r.leafOf.selector
        );
        _fn("function fund() payable", "fund()", r.fund.selector);
        _fn("function fundToken(uint256 amount)", "fundToken(uint256)", r.fundToken.selector);
        _fn("function sync() returns (uint256 credited)", "sync()", r.sync.selector);
        _fn(
            "function claimFeesFromEscrow() returns (uint256 credited)",
            "claimFeesFromEscrow()",
            r.claimFeesFromEscrow.selector
        );
        _fn(
            "function claimFeesFromEscrowToken() returns (uint256 credited)",
            "claimFeesFromEscrowToken()",
            r.claimFeesFromEscrowToken.selector
        );
        _fn(
            "function closeEpochAndPostRoot(uint64 epochId, bytes32 merkleRoot, uint256 reserved)",
            "closeEpochAndPostRoot(uint64,bytes32,uint256)",
            r.closeEpochAndPostRoot.selector
        );
        _fn(
            "function claim(uint64 epochId, uint256 amount, bytes32[] proof)",
            "claim(uint64,uint256,bytes32[])",
            r.claim.selector
        );
        _fn("function setScheduler(address newScheduler)", "setScheduler(address)", r.setScheduler.selector);
        _fn("function pauseClaims()", "pauseClaims()", r.pauseClaims.selector);
        _fn("function unpauseClaims()", "unpauseClaims()", r.unpauseClaims.selector);
        _fn(
            "function rescueToken(address token, address to, uint256 amount)",
            "rescueToken(address,address,uint256)",
            r.rescueToken.selector
        );
        _has(
            "struct Epoch { uint64 index; uint64 startedAt; uint64 endedAt; uint256 pot; uint256 reserved; uint256 claimed; bytes32 merkleRoot; bool settled; }"
        );
    }

    function test_Events() public view {
        _ev(
            "event PotFunded(uint64 indexed epochId, address indexed from, uint256 amount)",
            "PotFunded(uint64,address,uint256)",
            R.PotFunded.selector
        );
        _ev(
            "event FeesClaimedFromEscrow(uint64 indexed epochId, uint256 amount)",
            "FeesClaimedFromEscrow(uint64,uint256)",
            R.FeesClaimedFromEscrow.selector
        );
        _ev(
            "event EpochStarted(uint64 indexed epochId, uint64 startedAt, uint256 rolledIn)",
            "EpochStarted(uint64,uint64,uint256)",
            R.EpochStarted.selector
        );
        _ev(
            "event EpochSettled(uint64 indexed epochId, bytes32 merkleRoot, uint256 reserved, uint256 pot)",
            "EpochSettled(uint64,bytes32,uint256,uint256)",
            R.EpochSettled.selector
        );
        _ev(
            "event RolledOver(uint64 indexed fromEpoch, uint64 indexed toEpoch, uint256 amount)",
            "RolledOver(uint64,uint64,uint256)",
            R.RolledOver.selector
        );
        _ev(
            "event Claimed(uint64 indexed epochId, address indexed account, uint256 amount)",
            "Claimed(uint64,address,uint256)",
            R.Claimed.selector
        );
        _ev(
            "event SchedulerUpdated(address indexed previousScheduler, address indexed newScheduler)",
            "SchedulerUpdated(address,address)",
            R.SchedulerUpdated.selector
        );
        _ev("event ClaimsPaused(address indexed by)", "ClaimsPaused(address)", R.ClaimsPaused.selector);
        _ev("event ClaimsUnpaused(address indexed by)", "ClaimsUnpaused(address)", R.ClaimsUnpaused.selector);
    }

    function test_Errors() public view {
        _fn("error NotScheduler()", "NotScheduler()", R.NotScheduler.selector);
        _fn("error WrongEpoch()", "WrongEpoch()", R.WrongEpoch.selector);
        _fn("error EpochNotOver()", "EpochNotOver()", R.EpochNotOver.selector);
        _fn("error AlreadySettled()", "AlreadySettled()", R.AlreadySettled.selector);
        _fn("error ReservedExceedsPot()", "ReservedExceedsPot()", R.ReservedExceedsPot.selector);
        _fn("error EmptyRootWithReserved()", "EmptyRootWithReserved()", R.EmptyRootWithReserved.selector);
        _fn("error NotSettled()", "NotSettled()", R.NotSettled.selector);
        _fn("error AlreadyClaimed()", "AlreadyClaimed()", R.AlreadyClaimed.selector);
        _fn("error InvalidProof()", "InvalidProof()", R.InvalidProof.selector);
        _fn("error ClaimExceedsReserved()", "ClaimExceedsReserved()", R.ClaimExceedsReserved.selector);
        _fn("error ClaimsArePaused()", "ClaimsArePaused()", R.ClaimsArePaused.selector);
        _fn("error WrongPayoutMode()", "WrongPayoutMode()", R.WrongPayoutMode.selector);
        _fn("error CannotRescuePayoutToken()", "CannotRescuePayoutToken()", R.CannotRescuePayoutToken.selector);
        _fn("error ZeroAddress()", "ZeroAddress()", R.ZeroAddress.selector);
        _fn("error TransferFailed()", "TransferFailed()", R.TransferFailed.selector);
    }
}
