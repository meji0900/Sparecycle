// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RewardsFixture} from "./Base.t.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {SparecycleNodeStake as NS} from "../src/SparecycleNodeStake.sol";
import {MockERC20, FeeOnTransferToken, DoubleEntryToken, DoubleEntryLegacy} from "./mocks/Mocks.sol";
import {MockBurnableERC20, NoopBurnToken, SenderTaxToken, HookToken, ReentrantStaker} from "./mocks/StakeMocks.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Shared fixture: the real SparecycleRewards (ETH mode, 1-day epochs) as the epoch and scheduler source,
///         the reward contract's owner (`admin`) playing the treasury Safe, and a burnable SPARE stand-in.
abstract contract NodeStakeFixture is RewardsFixture {
    /// @dev Stands in for [MIN_STAKE_SPARE] (N3); not a proposed value.
    uint256 internal constant MIN = 1_000e18;
    bytes32 internal constant EVIDENCE = keccak256("evidence bundle v1");
    bytes32 internal constant APPEAL = keccak256("appeal bundle v1");

    address internal safe;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockBurnableERC20 internal spare;
    NS internal st;

    function setUp() public virtual override {
        super.setUp();
        safe = admin; // the reward contract's owner is the treasury Safe in production
        spare = new MockBurnableERC20();
        st = _deploy(address(spare), true);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev The brief §10 defaults; `test_DefaultConfig_MatchesBriefSection10` checks they equal `defaultConfig()`.
    function _defaults() internal pure returns (NS.Config memory) {
        return NS.Config({
            slashBps: 1_000, // N4
            faultWindowEpochs: 8, // N6
            appealWindowEpochs: 4, // N7
            cooldownEpochs: 16, // N8
            decisionWindowEpochs: 12,
            minStakeDelayEpochs: 1
        });
    }

    function _deploy(address tok, bool burnFn) internal returns (NS) {
        return new NS(tok, address(ethR), safe, burnFn, MIN, _defaults());
    }

    function _mintApprove(address who, uint256 amount) internal {
        spare.mint(who, amount);
        vm.prank(who);
        spare.approve(address(st), type(uint256).max);
    }

    function _stake(address who, uint256 amount) internal {
        _mintApprove(who, amount);
        vm.prank(who);
        st.stake(amount);
    }

    function _request(address who, uint256 amount) internal {
        vm.prank(who);
        st.requestUnstake(amount);
    }

    function _propose(address who, uint256 amount) internal returns (uint256 id) {
        vm.prank(sched);
        id = st.proposeSlash(who, amount, EVIDENCE);
    }

    function _proposeMax(address who) internal returns (uint256 id, uint256 amount) {
        amount = st.maxSlashOf(who);
        id = _propose(who, amount);
    }

    function _closeEpochs(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            _closeEmpty(ethR);
        }
    }

    /// @dev Ends a window of `n` epochs that started at (`startEpoch`, `startAt`): closes epochs until
    ///      `startEpoch + n` is open and makes sure `n * epochLength` seconds have passed since `startAt`.
    function _passWindow(uint64 startEpoch, uint64 startAt, uint256 n) internal {
        while (ethR.currentEpoch() < uint256(startEpoch) + n) {
            _closeEmpty(ethR);
        }
        uint256 t = uint256(startAt) + n * EPOCH;
        if (block.timestamp < t) vm.warp(t);
    }

    /// @dev Ends a window of `n` epochs starting now.
    function _passFromNow(uint256 n) internal {
        _passWindow(ethR.currentEpoch(), uint64(block.timestamp), n);
    }

    /// @dev Ends the first `n` epochs of proposal `id`'s life (4 = its appeal window, 16 = its decision window).
    function _passProposal(NS s, uint256 id, uint256 n) internal {
        NS.Proposal memory p = s.getProposal(id);
        _passWindow(p.proposedEpoch, p.proposedAt, n);
    }

    /// @dev Ends `who`'s unstake cooldown on `s`.
    function _passCooldown(NS s, address who) internal {
        (, uint64 e, uint64 at) = s.unstakingOf(who);
        _passWindow(e, at, s.cooldownEpochs());
    }

    function _proposedAt(uint256 id) internal view returns (uint64) {
        return st.getProposal(id).proposedAt;
    }

    function _execute(uint256 id) internal {
        vm.prank(safe);
        st.executeSlash(id);
    }

    function _cancel(uint256 id) internal {
        vm.prank(safe);
        st.cancelSlash(id);
    }
}

contract SparecycleNodeStakeTest is NodeStakeFixture {
    // ================================================================ construction

    function test_Constructor_SetsEverything() public view {
        assertEq(address(st.token()), address(spare));
        assertEq(address(st.rewards()), address(ethR));
        assertEq(st.safe(), safe);
        assertTrue(st.burnWithBurnFunction());
        assertEq(st.epochLength(), ethR.epochLength(), "epochs follow the reward contract");
        assertEq(st.slashBps(), 1_000);
        assertEq(st.faultWindowEpochs(), 8);
        assertEq(st.appealWindowEpochs(), 4);
        assertEq(st.cooldownEpochs(), 16);
        assertEq(st.decisionWindowEpochs(), 12);
        assertEq(st.minStakeDelayEpochs(), 1);
        assertEq(st.minStakePerNode(), MIN, "initial minimum in force at once");
        assertEq(st.totalStaked(), 0);
        assertEq(st.proposalCount(), 0);
    }

    function test_DefaultConfig_MatchesBriefSection10() public view {
        NS.Config memory c = st.defaultConfig();
        assertEq(c.slashBps, 1_000, "N4 10%");
        assertEq(c.faultWindowEpochs, 8, "N6 W");
        assertEq(c.appealWindowEpochs, 4, "N7 A");
        assertEq(c.cooldownEpochs, 16, "N8 C");
        assertGt(c.cooldownEpochs, c.faultWindowEpochs + c.appealWindowEpochs, "C > W + A");
        assertEq(c.minStakeDelayEpochs, 1, "at least one epoch");
        assertEq(c.decisionWindowEpochs, 12);
        assertEq(abi.encode(c), abi.encode(_defaults()), "fixture uses the defaults");
        assertEq(st.DEFAULT_SLASH_BPS(), c.slashBps);
        assertEq(st.DEFAULT_FAULT_WINDOW_EPOCHS(), c.faultWindowEpochs);
        assertEq(st.DEFAULT_APPEAL_WINDOW_EPOCHS(), c.appealWindowEpochs);
        assertEq(st.DEFAULT_COOLDOWN_EPOCHS(), c.cooldownEpochs);
        assertEq(st.DEFAULT_DECISION_WINDOW_EPOCHS(), c.decisionWindowEpochs);
        assertEq(st.DEFAULT_MIN_STAKE_DELAY_EPOCHS(), c.minStakeDelayEpochs);
    }

    function test_Constructor_RejectsZeroAndCodeless() public {
        NS.Config memory c = _defaults();
        vm.expectRevert(NS.ZeroAddress.selector);
        new NS(address(0), address(ethR), safe, true, MIN, c);
        vm.expectRevert(NS.ZeroAddress.selector);
        new NS(address(spare), address(0), safe, true, MIN, c);
        vm.expectRevert(NS.ZeroAddress.selector);
        new NS(address(spare), address(ethR), address(0), true, MIN, c);
        vm.expectRevert(NS.NoCode.selector);
        new NS(stranger, address(ethR), safe, true, MIN, c);
        vm.expectRevert(NS.NoCode.selector);
        new NS(address(spare), stranger, safe, true, MIN, c);
    }

    function test_Constructor_RejectsSafeAsScheduler() public {
        NS.Config memory c = _defaults();
        vm.expectRevert(NS.SafeIsScheduler.selector);
        new NS(address(spare), address(ethR), sched, true, MIN, c);
    }

    function test_Constructor_CooldownMustOutlastFaultPlusAppealWindow() public {
        NS.Config memory c = _defaults();
        c.cooldownEpochs = c.faultWindowEpochs + c.appealWindowEpochs; // equal is not enough
        vm.expectRevert(NS.CooldownTooShort.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c.cooldownEpochs = 3;
        vm.expectRevert(NS.CooldownTooShort.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c.cooldownEpochs = c.faultWindowEpochs + c.appealWindowEpochs + 1;
        NS ok = new NS(address(spare), address(ethR), safe, true, MIN, c);
        assertEq(ok.cooldownEpochs(), 13);
    }

    function test_Constructor_RejectsSlashBpsOutOfRange() public {
        NS.Config memory c = _defaults();
        c.slashBps = 0;
        vm.expectRevert(NS.SlashBpsOutOfRange.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c.slashBps = 5_001;
        vm.expectRevert(NS.SlashBpsOutOfRange.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c.slashBps = 10_000;
        vm.expectRevert(NS.SlashBpsOutOfRange.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c.slashBps = 5_000;
        new NS(address(spare), address(ethR), safe, true, MIN, c);
    }

    function test_Constructor_RejectsZeroWindows() public {
        NS.Config memory c = _defaults();
        c.faultWindowEpochs = 0;
        vm.expectRevert(NS.ZeroWindow.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c = _defaults();
        c.appealWindowEpochs = 0;
        vm.expectRevert(NS.ZeroWindow.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c = _defaults();
        c.decisionWindowEpochs = 0;
        vm.expectRevert(NS.ZeroWindow.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c = _defaults();
        c.minStakeDelayEpochs = 0;
        vm.expectRevert(NS.ZeroWindow.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
    }

    function test_Constructor_RejectsWindowsLongerThanAYear() public {
        NS.Config memory c = _defaults();
        c.cooldownEpochs = 366; // 1-day epochs
        vm.expectRevert(NS.WindowTooLong.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c = _defaults();
        c.decisionWindowEpochs = 362; // 4 + 362 = 366 days
        vm.expectRevert(NS.WindowTooLong.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c = _defaults();
        c.minStakeDelayEpochs = 366;
        vm.expectRevert(NS.WindowTooLong.selector);
        new NS(address(spare), address(ethR), safe, true, MIN, c);
        c = _defaults();
        c.cooldownEpochs = 365;
        new NS(address(spare), address(ethR), safe, true, MIN, c);
    }

    // ================================================================ stake

    function test_Stake_CreditsCallerAndTotal() public {
        _mintApprove(alice, 5_000e18);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.Staked(alice, 2_000e18, 2_000e18);
        vm.prank(alice);
        uint256 got = st.stake(2_000e18);
        assertEq(got, 2_000e18);
        assertEq(st.stakedOf(alice), 2_000e18);
        assertEq(st.slashableOf(alice), 2_000e18);
        assertEq(st.totalStaked(), 2_000e18);
        assertEq(spare.balanceOf(address(st)), 2_000e18);
        assertEq(spare.balanceOf(alice), 3_000e18);
        _stake(bob, 1e18);
        assertEq(st.totalStaked(), 2_001e18);
    }

    function test_Stake_ZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(NS.ZeroAmount.selector);
        st.stake(0);
    }

    function test_Stake_WithoutApprovalReverts() public {
        spare.mint(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert();
        st.stake(1e18);
        assertEq(st.totalStaked(), 0);
    }

    // ================================================================ minimum stake (N3)

    function test_MeetsMinimum_GatesOnActiveStakeTimesNodes() public {
        assertTrue(st.meetsMinimum(alice, 0), "no nodes, nothing needed");
        assertFalse(st.meetsMinimum(alice, 1), "no stake, no lease");
        _stake(alice, 2 * MIN);
        assertTrue(st.meetsMinimum(alice, 1));
        assertTrue(st.meetsMinimum(alice, 2));
        assertFalse(st.meetsMinimum(alice, 3));
        assertEq(st.nodesCovered(alice), 2);
        // Topping up restores the third node.
        _stake(alice, MIN - 1);
        assertFalse(st.meetsMinimum(alice, 3), "one short");
        _stake(alice, 1);
        assertTrue(st.meetsMinimum(alice, 3));
        assertEq(st.nodesCovered(alice), 3);
    }

    function test_MeetsMinimum_CooldownBucketDoesNotCount() public {
        _stake(alice, 2 * MIN);
        _request(alice, 1);
        assertFalse(st.meetsMinimum(alice, 2), "an owner on the way out loses the lease");
        assertTrue(st.meetsMinimum(alice, 1));
        assertEq(st.slashableOf(alice), 2 * MIN, "but stays slashable");
    }

    function test_MeetsMinimum_NoOverflowOnHugeNodeCount() public {
        _stake(alice, MIN);
        assertFalse(st.meetsMinimum(alice, type(uint256).max));
        vm.prank(safe);
        st.scheduleMinStakePerNode(type(uint256).max);
        _passFromNow(1);
        assertFalse(st.meetsMinimum(alice, 1));
        assertEq(st.nodesCovered(alice), 0);
    }

    function test_MinStake_ZeroMeansEveryoneQualifies() public {
        vm.prank(safe);
        st.scheduleMinStakePerNode(0);
        _passFromNow(1);
        assertEq(st.minStakePerNode(), 0);
        assertTrue(st.meetsMinimum(alice, 100));
        assertEq(st.nodesCovered(alice), type(uint256).max);
    }

    function test_MinStake_OnlySafe() public {
        vm.prank(sched);
        vm.expectRevert(NS.NotSafe.selector);
        st.scheduleMinStakePerNode(1);
        vm.prank(alice);
        vm.expectRevert(NS.NotSafe.selector);
        st.scheduleMinStakePerNode(1);
        vm.prank(alice);
        vm.expectRevert(NS.NotSafe.selector);
        st.cancelMinStakeChange();
    }

    function test_MinStake_ChangeWaitsAtLeastOneEpochAndItsLength() public {
        // Schedule halfway through epoch 0.
        vm.warp(block.timestamp + EPOCH / 2);
        uint64 at = uint64(block.timestamp);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.MinStakeChangeScheduled(MIN, 3 * MIN, 0, at);
        vm.prank(safe);
        st.scheduleMinStakePerNode(3 * MIN);
        (bool scheduled, uint256 next, uint64 epoch,) = st.scheduledMinStakeChange();
        assertTrue(scheduled);
        assertEq(next, 3 * MIN);
        assertEq(epoch, 0);
        assertEq(st.minStakePerNode(), MIN, "not yet");

        // Epoch 0 closes half an epoch later: one epoch boundary, but not one epoch of time.
        _closeEmpty(ethR);
        assertEq(st.minStakePerNode(), MIN, "a boundary alone is not enough");
        // A full epoch of time has passed now.
        vm.warp(uint256(at) + EPOCH);
        assertEq(st.minStakePerNode(), 3 * MIN, "in force after one epoch");
        (scheduled,,,) = st.scheduledMinStakeChange();
        assertFalse(scheduled);
    }

    function test_MinStake_TimeAloneIsNotEnoughWhileEpochsRun() public {
        vm.prank(safe);
        st.scheduleMinStakePerNode(3 * MIN);
        vm.warp(block.timestamp + EPOCH + 1); // time passed, epoch 0 not closed
        assertEq(st.minStakePerNode(), MIN);
        vm.warp(block.timestamp + EPOCH); // stall fallback: 2 * 1 epoch of time
        assertEq(st.minStakePerNode(), 3 * MIN);
    }

    function test_MinStake_CancelAndReschedule() public {
        vm.prank(safe);
        st.scheduleMinStakePerNode(3 * MIN);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.MinStakeChangeCancelled(3 * MIN);
        vm.prank(safe);
        st.cancelMinStakeChange();
        _passFromNow(1);
        assertEq(st.minStakePerNode(), MIN, "cancelled change never applies");
        vm.prank(safe);
        vm.expectRevert(NS.NoScheduledMinStakeChange.selector);
        st.cancelMinStakeChange();

        // A second schedule replaces the first (announcing the drop) and restarts the delay.
        vm.prank(safe);
        st.scheduleMinStakePerNode(2 * MIN);
        vm.warp(block.timestamp + EPOCH / 2);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.MinStakeChangeCancelled(2 * MIN);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.MinStakeChangeScheduled(MIN, 5 * MIN, ethR.currentEpoch(), uint64(block.timestamp));
        vm.prank(safe);
        st.scheduleMinStakePerNode(5 * MIN);
        _passFromNow(1);
        assertEq(st.minStakePerNode(), 5 * MIN);

        // Once in force it cannot be cancelled; the next schedule starts from the value in force and announces no
        // cancellation (nothing was pending).
        vm.prank(safe);
        vm.expectRevert(NS.NoScheduledMinStakeChange.selector);
        st.cancelMinStakeChange();
        vm.recordLogs();
        vm.prank(safe);
        st.scheduleMinStakePerNode(1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "only MinStakeChangeScheduled");
        assertEq(logs[0].topics[0], NS.MinStakeChangeScheduled.selector);
        assertEq(st.minStakePerNode(), 5 * MIN);
    }

    // ================================================================ unstake (N8)

    function test_RequestUnstake_MovesToCooldownBucket() public {
        _stake(alice, 10e18);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.UnstakeRequested(alice, 4e18, 4e18, 0);
        _request(alice, 4e18);
        assertEq(st.stakedOf(alice), 6e18);
        (uint256 amt, uint64 e, uint64 at) = st.unstakingOf(alice);
        assertEq(amt, 4e18);
        assertEq(e, 0);
        assertEq(at, block.timestamp);
        assertEq(st.totalStaked(), 10e18, "nothing left the contract");
        assertEq(spare.balanceOf(address(st)), 10e18);
    }

    function test_RequestUnstake_Reverts() public {
        _stake(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(NS.ZeroAmount.selector);
        st.requestUnstake(0);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NS.InsufficientStake.selector, 10e18, 10e18 + 1));
        st.requestUnstake(10e18 + 1);
    }

    function test_Unstake_AfterCooldownPaysOwner() public {
        _stake(alice, 10e18);
        _request(alice, 10e18);
        _closeEpochs(15);
        assertFalse(st.canUnstake(alice));
        vm.prank(alice);
        vm.expectRevert(NS.CooldownNotOver.selector);
        st.unstake();

        _passCooldown(st, alice); // 16th close
        assertTrue(st.canUnstake(alice));
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.Unstaked(alice, 10e18);
        vm.prank(alice);
        assertEq(st.unstake(), 10e18);
        assertEq(spare.balanceOf(alice), 10e18);
        assertEq(st.totalStaked(), 0);
        assertEq(st.slashableOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(NS.NothingToUnstake.selector);
        st.unstake();
    }

    function test_Unstake_CooldownNeedsTimeAsWellAsEpochs() public {
        _stake(alice, 10e18);
        vm.warp(block.timestamp + EPOCH / 2); // request halfway through epoch 0
        _request(alice, 10e18);
        uint64 at = uint64(block.timestamp);
        _closeEpochs(16); // 16 boundaries, but only 15.5 epochs of time
        assertEq(ethR.currentEpoch(), 16);
        assertFalse(st.canUnstake(alice));
        vm.prank(alice);
        vm.expectRevert(NS.CooldownNotOver.selector);
        st.unstake();
        vm.warp(uint256(at) + 16 * EPOCH);
        vm.prank(alice);
        st.unstake();
        assertEq(spare.balanceOf(alice), 10e18);
    }

    function test_Unstake_StallFallbackWhenEpochsStopClosing() public {
        _stake(alice, 10e18);
        _request(alice, 10e18);
        uint64 at = uint64(block.timestamp);
        vm.warp(uint256(at) + 2 * 16 * EPOCH - 1); // no epoch closed at all
        assertFalse(st.canUnstake(alice));
        vm.warp(uint256(at) + 2 * 16 * EPOCH);
        assertTrue(st.canUnstake(alice), "owners can leave if the scheduler stops closing epochs");
        vm.prank(alice);
        st.unstake();
    }

    function test_RequestUnstake_AgainRestartsCooldownForWholeBucket() public {
        _stake(alice, 10e18);
        _request(alice, 4e18);
        _closeEpochs(10);
        _request(alice, 1e18);
        (uint256 amt, uint64 e,) = st.unstakingOf(alice);
        assertEq(amt, 5e18);
        assertEq(e, 10);
        _closeEpochs(6); // 16 since the first request, 6 since the second
        assertFalse(st.canUnstake(alice));
        _passCooldown(st, alice);
        vm.prank(alice);
        assertEq(st.unstake(), 5e18);
        assertEq(st.stakedOf(alice), 5e18);
    }

    function test_CancelUnstake_RestoresActiveStake() public {
        _stake(alice, 10e18);
        _request(alice, 4e18);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.UnstakeCancelled(alice, 4e18, 10e18);
        vm.prank(alice);
        st.cancelUnstake();
        assertEq(st.stakedOf(alice), 10e18);
        (uint256 amt,,) = st.unstakingOf(alice);
        assertEq(amt, 0);
        vm.prank(alice);
        vm.expectRevert(NS.NothingToUnstake.selector);
        st.cancelUnstake();
    }

    function test_Unstake_OnlyPaysTheCaller() public {
        _stake(alice, 10e18);
        _request(alice, 10e18);
        _passFromNow(16);
        vm.prank(bob);
        vm.expectRevert(NS.NothingToUnstake.selector);
        st.unstake();
        assertEq(spare.balanceOf(bob), 0);
    }

    // ================================================================ proposals

    function test_ProposeSlash_OnlyScheduler() public {
        _stake(alice, 100e18);
        vm.prank(stranger);
        vm.expectRevert(NS.NotScheduler.selector);
        st.proposeSlash(alice, 1e18, EVIDENCE);
        vm.prank(safe);
        vm.expectRevert(NS.NotScheduler.selector);
        st.proposeSlash(alice, 1e18, EVIDENCE);
        vm.prank(alice);
        vm.expectRevert(NS.NotScheduler.selector);
        st.proposeSlash(alice, 1e18, EVIDENCE);
    }

    function test_ProposeSlash_FollowsSchedulerRotationInRewards() public {
        _stake(alice, 100e18);
        address newSched = makeAddr("newScheduler");
        vm.prank(admin);
        ethR.setScheduler(newSched);
        vm.prank(sched);
        vm.expectRevert(NS.NotScheduler.selector);
        st.proposeSlash(alice, 1e18, EVIDENCE);
        vm.prank(newSched);
        assertEq(st.proposeSlash(alice, 1e18, EVIDENCE), 1);
    }

    function test_ProposeSlash_SafeAsSchedulerCannotPropose() public {
        _stake(alice, 100e18);
        vm.prank(admin);
        ethR.setScheduler(safe);
        vm.prank(safe);
        vm.expectRevert(NS.SafeIsScheduler.selector);
        st.proposeSlash(alice, 1e18, EVIDENCE);
    }

    function test_ProposeSlash_CapIsSlashBpsOfStake() public {
        _stake(alice, 1_000e18);
        assertEq(st.maxSlashOf(alice), 100e18, "10% (N4)");
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(NS.SlashAboveCap.selector, 100e18 + 1, 100e18));
        st.proposeSlash(alice, 100e18 + 1, EVIDENCE);

        vm.expectEmit(true, true, true, true, address(st));
        emit NS.SlashProposed(1, alice, 100e18, EVIDENCE, 0);
        uint256 id = _propose(alice, 100e18);
        assertEq(id, 1);
        NS.Proposal memory p = st.getProposal(id);
        assertEq(p.owner, alice);
        assertEq(uint8(p.status), uint8(NS.Status.Open));
        assertEq(p.amount, 100e18);
        assertEq(p.evidenceHash, EVIDENCE);
        assertEq(p.appealHash, bytes32(0));
        assertEq(p.proposedEpoch, 0);
        assertEq(p.proposedAt, block.timestamp);
        assertEq(st.openProposalOf(alice), id);
        assertEq(st.proposalCount(), 1);
    }

    function test_ProposeSlash_CapCountsCooldownBucket() public {
        _stake(alice, 1_000e18);
        _request(alice, 1_000e18);
        assertEq(st.stakedOf(alice), 0);
        assertEq(st.maxSlashOf(alice), 100e18, "leaving does not escape the cap base");
        _propose(alice, 100e18);
    }

    function test_ProposeSlash_Reverts() public {
        _stake(alice, 1_000e18);
        vm.startPrank(sched);
        vm.expectRevert(NS.ZeroEvidence.selector);
        st.proposeSlash(alice, 1e18, bytes32(0));
        vm.expectRevert(NS.ZeroAmount.selector);
        st.proposeSlash(alice, 0, EVIDENCE);
        vm.expectRevert(abi.encodeWithSelector(NS.SlashAboveCap.selector, 1, 0));
        st.proposeSlash(bob, 1, EVIDENCE); // bob has no stake
        vm.stopPrank();
    }

    function test_ProposeSlash_OneOpenProposalPerOwner() public {
        _stake(alice, 1_000e18);
        _stake(bob, 1_000e18);
        uint256 id = _propose(alice, 10e18);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(NS.ProposalAlreadyOpen.selector, id));
        st.proposeSlash(alice, 10e18, EVIDENCE);
        assertEq(_propose(bob, 10e18), 2, "other owners are independent");
        _cancel(id);
        _passFromNow(2); // grace period after the cancel
        assertEq(_propose(alice, 10e18), 3, "a new one after resolution and grace");
    }

    // ================================================================ freeze during the appeal window (N7)

    function test_AppealWindow_StakeFrozenAndNothingMoves() public {
        _stake(alice, 1_000e18);
        _request(alice, 400e18);
        _closeEpochs(10); // propose late in the cooldown: it ends (epoch 16) before the proposal expires (26)
        (uint256 id,) = _proposeMax(alice);
        uint256 contractBal = spare.balanceOf(address(st));
        uint256 supply = spare.totalSupply();

        _closeEpochs(2);
        // The owner cannot start or finish leaving.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NS.StakeFrozen.selector, id));
        st.requestUnstake(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NS.StakeFrozen.selector, id));
        st.unstake();
        // The Safe cannot execute early.
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(NS.AppealWindowNotOver.selector, id));
        st.executeSlash(id);
        assertFalse(st.canExecute(id));
        assertTrue(st.canAppeal(id));

        // The cooldown has run out and the appeal window is over, but the proposal is still open (undecided):
        // unstake still fails.
        _passCooldown(st, alice);
        assertFalse(st.canAppeal(id));
        assertEq(st.openProposalOf(alice), id);
        assertFalse(st.canUnstake(alice));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NS.StakeFrozen.selector, id));
        st.unstake();

        assertEq(spare.balanceOf(address(st)), contractBal, "nothing moved");
        assertEq(spare.totalSupply(), supply, "nothing burned");
        assertEq(spare.balanceOf(alice), 0);
        assertEq(st.slashableOf(alice), 1_000e18);
    }

    function test_AppealWindow_TopUpAndCancelUnstakeStillAllowed() public {
        _stake(alice, 1_000e18);
        _request(alice, 400e18);
        (uint256 id,) = _proposeMax(alice);
        _stake(alice, 500e18); // topping up keeps leases; nothing leaves
        vm.prank(alice);
        st.cancelUnstake(); // back into active stake; nothing leaves
        assertEq(st.stakedOf(alice), 1_500e18);
        assertEq(st.openProposalOf(alice), id);
        assertEq(st.getProposal(id).amount, 100e18, "amount fixed at proposal time");
    }

    function test_CancelSlash_ReleasesTheStake() public {
        _stake(alice, 1_000e18);
        _request(alice, 1_000e18);
        (uint256 id,) = _proposeMax(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NS.StakeFrozen.selector, id));
        st.unstake();

        vm.expectEmit(true, true, true, true, address(st));
        emit NS.SlashCancelled(id, alice);
        _cancel(id);
        assertEq(uint8(st.proposalStatus(id)), uint8(NS.Status.Cancelled));
        assertEq(st.openProposalOf(alice), 0);
        assertEq(st.slashableOf(alice), 1_000e18, "nothing taken");

        _passCooldown(st, alice);
        vm.prank(alice);
        st.unstake();
        assertEq(spare.balanceOf(alice), 1_000e18, "all of it back");
    }

    function test_CancelSlash_OnlySafeAndOnlyOpen() public {
        _stake(alice, 1_000e18);
        (uint256 id,) = _proposeMax(alice);
        vm.prank(sched);
        vm.expectRevert(NS.NotSafe.selector);
        st.cancelSlash(id);
        vm.prank(alice);
        vm.expectRevert(NS.NotSafe.selector);
        st.cancelSlash(id);
        _cancel(id);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(NS.NotOpen.selector, id));
        st.cancelSlash(id);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(NS.NotOpen.selector, 99));
        st.cancelSlash(99);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(NS.NotOpen.selector, id));
        st.executeSlash(id);
    }

    // ================================================================ appeal

    function test_Appeal_OwnerDuringWindow() public {
        _stake(alice, 1_000e18);
        (uint256 id,) = _proposeMax(alice);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.SlashAppealed(id, alice, APPEAL);
        vm.prank(alice);
        st.appeal(id, APPEAL);
        assertEq(st.getProposal(id).appealHash, APPEAL);
        // More evidence: the latest hash is kept.
        bytes32 more = keccak256("appeal bundle v2");
        vm.prank(alice);
        st.appeal(id, more);
        assertEq(st.getProposal(id).appealHash, more);
    }

    function test_Appeal_Reverts() public {
        _stake(alice, 1_000e18);
        (uint256 id,) = _proposeMax(alice);
        vm.prank(bob);
        vm.expectRevert(NS.NotProposalOwner.selector);
        st.appeal(id, APPEAL);
        vm.prank(sched);
        vm.expectRevert(NS.NotProposalOwner.selector);
        st.appeal(id, APPEAL);
        vm.prank(alice);
        vm.expectRevert(NS.ZeroEvidence.selector);
        st.appeal(id, bytes32(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NS.NotOpen.selector, 7));
        st.appeal(7, APPEAL);

        _passProposal(st, id, 4);
        assertFalse(st.canAppeal(id));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(NS.AppealWindowOver.selector, id));
        st.appeal(id, APPEAL);
    }

    function test_Appeal_DoesNotStopTheSafeFromDeciding() public {
        _stake(alice, 1_000e18);
        (uint256 id, uint256 amount) = _proposeMax(alice);
        vm.prank(alice);
        st.appeal(id, APPEAL);
        _passProposal(st, id, 4);
        _execute(id); // the Safe judged the appeal and rejected it
        assertEq(st.totalSlashed(), amount);
    }

    // ================================================================ execute (N4, N9)

    function test_ExecuteSlash_BurnsAtMostSlashBpsAndEmits() public {
        _stake(alice, 1_000e18);
        (uint256 id, uint256 amount) = _proposeMax(alice);
        assertEq(amount, 100e18);
        uint256 supply = spare.totalSupply();

        _passProposal(st, id, 4);
        assertTrue(st.canExecute(id));
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.Slashed(alice, 100e18, id, EVIDENCE);
        _execute(id);

        assertEq(spare.totalSupply(), supply - 100e18, "burned");
        assertEq(spare.balanceOf(address(st)), 900e18);
        assertEq(spare.balanceOf(safe), 0, "the judge gains nothing");
        assertEq(spare.balanceOf(sched), 0, "the accuser gains nothing");
        assertEq(st.stakedOf(alice), 900e18);
        assertEq(st.totalStaked(), 900e18);
        assertEq(st.totalSlashed(), 100e18);
        assertEq(uint8(st.proposalStatus(id)), uint8(NS.Status.Executed));
        assertEq(st.openProposalOf(alice), 0);
        assertGe(st.slashableOf(alice) * 10_000, 1_000e18 * (10_000 - 1_000), "lost at most 10%");
    }

    function test_ExecuteSlash_DeadAddressMode() public {
        MockERC20 plain = new MockERC20("SpareCycle", "SPARE", 18);
        NS dst = new NS(address(plain), address(ethR), safe, false, MIN, _defaults());
        assertFalse(dst.burnWithBurnFunction());
        plain.mint(alice, 1_000e18);
        vm.startPrank(alice);
        plain.approve(address(dst), type(uint256).max);
        dst.stake(1_000e18);
        vm.stopPrank();
        uint256 amount = dst.maxSlashOf(alice);
        vm.prank(sched);
        uint256 id = dst.proposeSlash(alice, amount, EVIDENCE);
        _passFromNow(4);
        vm.expectEmit(true, true, true, true, address(dst));
        emit NS.Slashed(alice, amount, id, EVIDENCE);
        vm.prank(safe);
        dst.executeSlash(id);
        assertEq(plain.balanceOf(dst.DEAD()), 100e18);
        assertEq(plain.balanceOf(address(dst)), 900e18);
        assertEq(dst.totalStaked(), 900e18);
    }

    function test_ExecuteSlash_OnlySafe() public {
        _stake(alice, 1_000e18);
        (uint256 id,) = _proposeMax(alice);
        _passProposal(st, id, 4);
        vm.prank(sched);
        vm.expectRevert(NS.NotSafe.selector);
        st.executeSlash(id);
        vm.prank(alice);
        vm.expectRevert(NS.NotSafe.selector);
        st.executeSlash(id);
        _execute(id);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(NS.NotOpen.selector, id));
        st.executeSlash(id);
    }

    function test_ExecuteSlash_TakesActiveStakeFirstThenCooldownBucket() public {
        _stake(alice, 1_000e18);
        _request(alice, 950e18); // 50 active, 950 in cooldown
        (uint256 id, uint256 amount) = _proposeMax(alice);
        assertEq(amount, 100e18);
        _passProposal(st, id, 4);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.Slashed(alice, 100e18, id, EVIDENCE);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.SlashSplit(id, alice, 50e18, 50e18);
        _execute(id);
        assertEq(st.stakedOf(alice), 0);
        (uint256 u,,) = st.unstakingOf(alice);
        assertEq(u, 900e18);
        assertEq(st.slashableOf(alice), 900e18);
        // The cooldown clock was not reset by the slash.
        _passCooldown(st, alice);
        vm.prank(alice);
        assertEq(st.unstake(), 900e18);
    }

    function test_ExecuteSlash_RemainderCanLeaveAfterwards() public {
        _stake(alice, 1_000e18);
        _request(alice, 1_000e18);
        (uint256 id,) = _proposeMax(alice);
        _passProposal(st, id, 4);
        _execute(id);
        _passCooldown(st, alice);
        vm.prank(alice);
        assertEq(st.unstake(), 900e18);
        assertEq(spare.balanceOf(alice), 900e18);
        assertEq(st.totalStaked(), 0);
        assertEq(spare.balanceOf(address(st)), 0);
    }

    function test_ExecuteSlash_NeedsTimeAsWellAsEpochs() public {
        _stake(alice, 1_000e18);
        vm.warp(block.timestamp + EPOCH / 2);
        (uint256 id,) = _proposeMax(alice);
        _closeEpochs(4); // 4 boundaries, 3.5 epochs of time
        assertFalse(st.canExecute(id));
        assertTrue(st.canAppeal(id), "the owner still has time");
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(NS.AppealWindowNotOver.selector, id));
        st.executeSlash(id);
        vm.warp(uint256(_proposedAt(id)) + 4 * EPOCH);
        assertFalse(st.canAppeal(id));
        _execute(id);
    }

    function test_ExecuteSlash_StallFallback() public {
        _stake(alice, 1_000e18);
        (uint256 id,) = _proposeMax(alice);
        vm.warp(block.timestamp + 4 * EPOCH); // no epoch closed
        assertFalse(st.canExecute(id), "epochs must close, or twice the time pass");
        vm.warp(block.timestamp + 4 * EPOCH);
        assertTrue(st.canExecute(id));
        _execute(id);
    }

    function test_ExecuteSlash_RepeatedProposalsEscalate() public {
        _stake(alice, 1_000e18);
        (uint256 id1,) = _proposeMax(alice);
        _passProposal(st, id1, 4);
        _execute(id1);
        _passFromNow(2); // grace period after the execution
        (uint256 id2, uint256 a2) = _proposeMax(alice);
        assertEq(a2, 90e18, "10% of what is left");
        _passProposal(st, id2, 4);
        _execute(id2);
        assertEq(st.slashableOf(alice), 810e18);
        assertEq(st.totalSlashed(), 190e18);
    }

    function test_ExecuteSlash_BurnThatDoesNotBurnReverts() public {
        NoopBurnToken noop = new NoopBurnToken();
        NS nst = new NS(address(noop), address(ethR), safe, true, MIN, _defaults());
        noop.mint(alice, 1_000e18);
        vm.startPrank(alice);
        noop.approve(address(nst), type(uint256).max);
        nst.stake(1_000e18);
        vm.stopPrank();
        vm.prank(sched);
        uint256 id = nst.proposeSlash(alice, 100e18, EVIDENCE);
        _passFromNow(4);
        vm.prank(safe);
        vm.expectRevert(NS.UnexpectedBalanceChange.selector);
        nst.executeSlash(id);
        assertEq(nst.totalStaked(), 1_000e18, "rolled back");
    }

    // ================================================================ expiry of undecided proposals

    function test_Proposal_ExpiresIfTheSafeNeverDecides() public {
        _stake(alice, 1_000e18);
        _request(alice, 1_000e18);
        (uint256 id,) = _proposeMax(alice);

        _passProposal(st, id, 15); // appeal (4) + decision (12) = 16: one short
        assertTrue(st.canExecute(id));
        assertEq(st.openProposalOf(alice), id);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(NS.NotExpired.selector, id));
        st.expireSlash(id);

        _passProposal(st, id, 16);
        assertFalse(st.canExecute(id));
        assertEq(uint8(st.proposalStatus(id)), uint8(NS.Status.Expired));
        assertEq(st.openProposalOf(alice), 0, "freeze ends at expiry");
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(NS.ProposalExpired.selector, id));
        st.executeSlash(id);

        // Unstake works without anyone calling expireSlash; it records the expiry on the way.
        _passCooldown(st, alice);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.SlashExpired(id, alice);
        vm.prank(alice);
        st.unstake();
        assertEq(spare.balanceOf(alice), 1_000e18);
        assertEq(uint8(st.getProposal(id).status), uint8(NS.Status.Expired));
    }

    function test_ExpireSlash_AnyoneCanRecordIt() public {
        _stake(alice, 1_000e18);
        (uint256 id,) = _proposeMax(alice);
        _passProposal(st, id, 16);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.SlashExpired(id, alice);
        vm.prank(stranger);
        st.expireSlash(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(NS.NotOpen.selector, id));
        st.expireSlash(id);
    }

    function test_Proposal_StaleExpiredIsClosedByTheNextProposal() public {
        _stake(alice, 1_000e18);
        (uint256 id1,) = _proposeMax(alice);
        _passProposal(st, id1, 16); // expired, not recorded; the grace period after it is still running
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(NS.ProposalGraceActive.selector, id1));
        st.proposeSlash(alice, 1e18, EVIDENCE);
        assertEq(uint8(st.getProposal(id1).status), uint8(NS.Status.Open), "the revert recorded nothing");

        _passProposal(st, id1, 18); // appeal 4 + decision 12 + grace 2
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.SlashExpired(id1, alice);
        uint256 id2 = _propose(alice, 1e18);
        assertEq(id2, 2);
        assertEq(uint8(st.getProposal(id1).status), uint8(NS.Status.Expired));
        assertEq(st.openProposalOf(alice), id2);
        assertEq(st.getAccount(alice).lastProposal, id2);
    }

    function test_Proposal_ExpiryRecordedLateDoesNotBlockTheScheduler() public {
        _stake(alice, 1_000e18);
        (uint256 id1,) = _proposeMax(alice);
        _passProposal(st, id1, 40); // long past expiry + grace; nobody recorded the expiry
        assertTrue(st.canPropose(alice));
        uint256 id2 = _propose(alice, 1e18); // records the old expiry and proposes in one call
        assertEq(uint8(st.getProposal(id1).status), uint8(NS.Status.Expired));
        assertEq(st.openProposalOf(alice), id2);
    }

    function test_CancelSlash_AfterExpiryRecordsTheExpiry() public {
        _stake(alice, 1_000e18);
        (uint256 id,) = _proposeMax(alice);
        _passProposal(st, id, 16);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.SlashExpired(id, alice);
        _cancel(id); // does not revert
        assertEq(uint8(st.getProposal(id).status), uint8(NS.Status.Expired), "recorded as expired, not cancelled");
        assertEq(st.getProposal(id).closedAt, block.timestamp);
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(NS.NotOpen.selector, id));
        st.cancelSlash(id);
    }

    // ================================================================ grace period between proposals

    function test_Grace_SchedulerAloneCannotBlockAFinishedCooldown_AfterCancel() public {
        _stake(alice, 1_000e18);
        _request(alice, 1_000e18);
        _passCooldown(st, alice);
        uint256 id = _propose(alice, 1); // 1 wei, just to freeze
        assertFalse(st.canUnstake(alice));
        _cancel(id);
        // The scheduler re-proposes in the same block: refused.
        assertFalse(st.canPropose(alice));
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(NS.ProposalGraceActive.selector, id));
        st.proposeSlash(alice, 1, EVIDENCE);
        // The owner leaves in the grace window.
        assertTrue(st.canUnstake(alice));
        vm.prank(alice);
        assertEq(st.unstake(), 1_000e18);
        assertEq(spare.balanceOf(alice), 1_000e18);
    }

    function test_Grace_SchedulerAloneCannotBlockAFinishedCooldown_AfterExpiry() public {
        _stake(alice, 1_000e18);
        _request(alice, 1_000e18);
        uint256 id = _propose(alice, 1); // the Safe never decides
        _passProposal(st, id, 16); // expired; the cooldown (16) has finished too
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(NS.ProposalGraceActive.selector, id));
        st.proposeSlash(alice, 1, EVIDENCE);
        vm.prank(alice);
        assertEq(st.unstake(), 1_000e18);
    }

    function test_Grace_RepeatedReproposalsByTheSchedulerAloneAlwaysLeaveAnExit() public {
        _stake(alice, 1_000e18);
        _request(alice, 1_000e18);
        // Every epoch the scheduler moves first and re-freezes the stake whenever the contract lets it; the owner
        // then tries to leave; one epoch later the Safe rejects whatever is open.
        uint256 freezes;
        bool exited;
        for (uint256 step; step < 40; ++step) {
            if (st.canPropose(alice)) {
                _propose(alice, 1);
                ++freezes;
            }
            if (st.canUnstake(alice)) {
                vm.prank(alice);
                assertEq(st.unstake(), 1_000e18, "nothing taken, all back");
                exited = true;
                break;
            }
            _passFromNow(1);
            uint256 open = st.openProposalOf(alice);
            if (open != 0) _cancel(open);
        }
        assertTrue(exited, "the scheduler alone cannot keep the owner in");
        assertEq(ethR.currentEpoch(), 16, "out as soon as the cooldown ended");
        assertEq(freezes, 6, "re-proposed every 3 epochs");
        assertEq(spare.balanceOf(alice), 1_000e18);
    }

    function test_Grace_ChainedSlashesLeaveExitWindows() public {
        _stake(alice, 1_000e18);
        _request(alice, 1_000e18);
        // Scheduler and Safe together slash back to back for the whole cooldown.
        uint256 executed;
        while (!st.canUnstake(alice)) {
            (uint256 id,) = _proposeMax(alice);
            _passProposal(st, id, 4);
            _execute(id);
            ++executed;
            // Right after every execution the next proposal is refused for the grace period...
            vm.prank(sched);
            vm.expectRevert(abi.encodeWithSelector(NS.ProposalGraceActive.selector, id));
            st.proposeSlash(alice, 1, EVIDENCE);
            if (st.canUnstake(alice)) break;
            _passFromNow(2); // ...and then allowed again.
            assertTrue(st.canPropose(alice));
        }
        // ...so once the cooldown is over, the owner leaves in that grace window.
        uint256 rest = st.slashableOf(alice);
        vm.prank(alice);
        assertEq(st.unstake(), rest);
        assertEq(executed, 3, "epochs 0-4, 6-10, 12-16");
        assertEq(rest, 729e18, "three 10% slashes, then out");
    }

    function test_Grace_EndsAfterTwoEpochsOfTimeAndCloses() public {
        _stake(alice, 1_000e18);
        uint256 id = _propose(alice, 1);
        vm.warp(block.timestamp + EPOCH / 2);
        _cancel(id);
        uint64 at = uint64(block.timestamp);
        _closeEpochs(2); // two boundaries, only 1.5 epochs of time
        assertFalse(st.canPropose(alice));
        vm.warp(uint256(at) + 2 * EPOCH);
        assertTrue(st.canPropose(alice));
        _propose(alice, 1);
    }

    function test_Grace_StallFallback() public {
        _stake(alice, 1_000e18);
        uint256 id = _propose(alice, 1);
        _cancel(id);
        vm.warp(block.timestamp + 4 * EPOCH - 1); // no epoch closed
        assertFalse(st.canPropose(alice));
        vm.warp(block.timestamp + 1);
        assertTrue(st.canPropose(alice));
        _propose(alice, 1);
    }

    function test_Grace_IsPerOwner() public {
        _stake(alice, 1_000e18);
        _stake(bob, 1_000e18);
        uint256 id = _propose(alice, 1);
        _cancel(id);
        assertFalse(st.canPropose(alice));
        assertTrue(st.canPropose(bob));
        _propose(bob, 1);
    }

    // ================================================================ fuzz

    /// @notice Whatever the stake and amount, a proposal above slashBps of the stake reverts, and an executed one
    ///         takes exactly its amount (<= slashBps) and burns it.
    function testFuzz_SlashNeverExceedsSlashBps(uint256 stakeAmt, uint256 amount, uint256 requested) public {
        stakeAmt = bound(stakeAmt, 1, 1e36);
        requested = bound(requested, 0, stakeAmt);
        _stake(alice, stakeAmt);
        if (requested != 0) _request(alice, requested);
        uint256 cap = (stakeAmt * 1_000) / 10_000;
        assertEq(st.maxSlashOf(alice), cap);
        amount = bound(amount, 1, stakeAmt);
        if (amount > cap) {
            vm.prank(sched);
            vm.expectRevert(abi.encodeWithSelector(NS.SlashAboveCap.selector, amount, cap));
            st.proposeSlash(alice, amount, EVIDENCE);
            return;
        }
        uint256 id = _propose(alice, amount);
        uint256 supply = spare.totalSupply();
        _passProposal(st, id, 4);
        _execute(id);
        assertEq(st.slashableOf(alice), stakeAmt - amount);
        assertEq(spare.totalSupply(), supply - amount);
        assertEq(spare.balanceOf(address(st)), st.totalStaked());
        assertLe(amount * 10_000, stakeAmt * 1_000);
    }

    // ================================================================ rescue

    function test_Rescue_OtherTokenBySafe() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        other.mint(address(st), 5e6);
        _stake(alice, 1_000e18);
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.TokenRescued(address(other), bob, 5e6);
        vm.prank(safe);
        st.rescueToken(address(other), bob, 5e6);
        assertEq(other.balanceOf(bob), 5e6);
        assertEq(spare.balanceOf(address(st)), 1_000e18);
    }

    function test_Rescue_NeverTheStakeToken() public {
        _stake(alice, 1_000e18);
        spare.mint(address(st), 7e18); // even SPARE sent here by mistake stays
        vm.prank(safe);
        vm.expectRevert(NS.CannotRescueStakeToken.selector);
        st.rescueToken(address(spare), safe, 1);
        assertEq(spare.balanceOf(address(st)), 1_007e18);
    }

    function test_Rescue_OnlySafeAndNonZeroRecipient() public {
        MockERC20 other = new MockERC20("Other", "OTH", 6);
        other.mint(address(st), 5e6);
        vm.prank(sched);
        vm.expectRevert(NS.NotSafe.selector);
        st.rescueToken(address(other), sched, 1);
        vm.prank(alice);
        vm.expectRevert(NS.NotSafe.selector);
        st.rescueToken(address(other), alice, 1);
        vm.prank(safe);
        vm.expectRevert(NS.ZeroAddress.selector);
        st.rescueToken(address(other), address(0), 1);
    }

    function test_Rescue_ForcedEth() public {
        vm.deal(address(st), 1 ether);
        vm.prank(safe);
        st.rescueToken(address(0), bob, 1 ether);
        assertEq(bob.balance, 1 ether);
    }

    function test_Rescue_DoubleEntryTokenCannotDrainStake() public {
        DoubleEntryToken dbl = new DoubleEntryToken();
        DoubleEntryLegacy legacy = new DoubleEntryLegacy(dbl);
        dbl.setLegacy(address(legacy));
        NS dst = new NS(address(dbl), address(ethR), safe, false, MIN, _defaults());
        dbl.mint(alice, 1_000e18);
        vm.startPrank(alice);
        dbl.approve(address(dst), type(uint256).max);
        dst.stake(1_000e18);
        vm.stopPrank();
        vm.prank(safe);
        vm.expectRevert(NS.CannotRescueStakeToken.selector);
        dst.rescueToken(address(legacy), safe, 1_000e18);
        assertEq(dbl.balanceOf(address(dst)), 1_000e18);
    }

    // ================================================================ fee-on-transfer

    function test_FeeOnTransfer_CreditsWhatArrived() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        NS fst = new NS(address(fot), address(ethR), safe, false, MIN, _defaults());
        fot.mint(alice, 100e18);
        vm.startPrank(alice);
        fot.approve(address(fst), type(uint256).max);
        vm.expectEmit(true, true, true, true, address(fst));
        emit NS.Staked(alice, 99e18, 99e18);
        uint256 got = fst.stake(100e18);
        vm.stopPrank();
        assertEq(got, 99e18, "1% fee never credited");
        assertEq(fst.stakedOf(alice), 99e18);
        assertEq(fst.totalStaked(), 99e18);
        assertEq(fot.balanceOf(address(fst)), fst.totalStaked());

        // Slash, then unstake the rest: the books stay exact.
        uint256 amount = fst.maxSlashOf(alice);
        vm.prank(sched);
        uint256 id = fst.proposeSlash(alice, amount, EVIDENCE);
        _passFromNow(4);
        vm.prank(safe);
        fst.executeSlash(id);
        assertEq(fot.balanceOf(address(fst)), fst.totalStaked());

        uint256 activeLeft = fst.stakedOf(alice);
        vm.prank(alice);
        fst.requestUnstake(activeLeft);
        _passFromNow(16);
        uint256 rest = fst.slashableOf(alice);
        vm.prank(alice);
        assertEq(fst.unstake(), rest);
        assertEq(fot.balanceOf(address(fst)), 0);
        assertEq(fst.totalStaked(), 0);
        assertEq(fot.balanceOf(alice), rest - rest / 100, "the token's own fee on the way out");
    }

    function test_FeeOnTransfer_SecondStakerUnaffected() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        NS fst = new NS(address(fot), address(ethR), safe, false, MIN, _defaults());
        address[2] memory who = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            fot.mint(who[i], 100e18);
            vm.startPrank(who[i]);
            fot.approve(address(fst), type(uint256).max);
            fst.stake(100e18);
            fst.requestUnstake(99e18);
            vm.stopPrank();
        }
        _passFromNow(16);
        vm.prank(alice);
        fst.unstake();
        assertEq(fot.balanceOf(address(fst)), 99e18, "bob's full credit is still here");
        vm.prank(bob);
        fst.unstake();
        assertEq(fot.balanceOf(address(fst)), 0);
    }

    function test_SenderTaxToken_OutflowThatSpendsOthersStakeReverts() public {
        SenderTaxToken tax = new SenderTaxToken();
        NS tst = new NS(address(tax), address(ethR), safe, false, MIN, _defaults());
        tax.setTaxed(address(tst));
        address[2] memory who = [alice, bob];
        for (uint256 i; i < 2; ++i) {
            tax.mint(who[i], 100e18);
            vm.startPrank(who[i]);
            tax.approve(address(tst), type(uint256).max);
            tst.stake(100e18);
            vm.stopPrank();
        }
        vm.prank(alice);
        tst.requestUnstake(100e18);
        _passFromNow(16);
        vm.prank(alice);
        vm.expectRevert(NS.UnexpectedBalanceChange.selector);
        tst.unstake();
        assertEq(tax.balanceOf(address(tst)), 200e18, "bob's stake untouched");
    }

    // ================================================================ reentrancy

    function _hooked() internal returns (HookToken tok, NS hst, ReentrantStaker att) {
        tok = new HookToken();
        hst = new NS(address(tok), address(ethR), safe, false, MIN, _defaults());
        att = new ReentrantStaker(hst, tok);
        tok.mint(address(att), 100e18);
        tok.setHooked(address(att), true);
    }

    function _assertReentrancyError(bytes memory err) internal pure {
        assertEq(bytes4(err), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "reentry blocked");
    }

    function test_Reentrancy_StakeCannotDoubleCount() public {
        (HookToken tok, NS hst, ReentrantStaker att) = _hooked();
        att.setMode(ReentrantStaker.Mode.StakeOnSend);
        att.doStake(10e18);
        assertTrue(att.tried());
        _assertReentrancyError(att.err());
        assertEq(hst.stakedOf(address(att)), 10e18, "credited once");
        assertEq(hst.totalStaked(), 10e18);
        assertEq(tok.balanceOf(address(hst)), 10e18);
    }

    function test_Reentrancy_UnstakeCannotPayTwice() public {
        (HookToken tok, NS hst, ReentrantStaker att) = _hooked();
        att.doStake(10e18);
        att.doRequest(10e18);
        _passFromNow(16);
        att.setMode(ReentrantStaker.Mode.UnstakeOnReceive);
        att.doUnstake();
        assertTrue(att.tried());
        _assertReentrancyError(att.err());
        assertEq(tok.balanceOf(address(att)), 100e18, "paid once");
        assertEq(hst.totalStaked(), 0);
    }

    function test_Reentrancy_CrossFunctionDuringUnstakeBlocked() public {
        (HookToken tok, NS hst, ReentrantStaker att) = _hooked();
        att.doStake(10e18);
        att.doRequest(5e18);
        _passFromNow(16);
        att.setMode(ReentrantStaker.Mode.RequestOnReceive);
        att.doUnstake();
        _assertReentrancyError(att.err());
        att.doRequest(5e18);
        _passFromNow(16);
        att.setMode(ReentrantStaker.Mode.StakeOnReceive);
        att.doUnstake();
        _assertReentrancyError(att.err());
        assertEq(hst.totalStaked(), 0);
        assertEq(tok.balanceOf(address(hst)), 0);
        assertEq(tok.balanceOf(address(att)), 100e18);
    }

    // ================================================================ no other way out

    function test_NoPathForSafeOrSchedulerToTakeStake() public {
        _stake(alice, 1_000e18);
        // Neither role can unstake someone else's stake, and the only Safe outflow (rescue) refuses SPARE.
        vm.prank(safe);
        vm.expectRevert(NS.NothingToUnstake.selector);
        st.unstake();
        vm.prank(sched);
        vm.expectRevert(NS.NothingToUnstake.selector);
        st.unstake();
        vm.prank(safe);
        vm.expectRevert(NS.CannotRescueStakeToken.selector);
        st.rescueToken(address(spare), safe, 1_000e18);
        assertEq(spare.balanceOf(address(st)), 1_000e18);
    }

    function test_EpochsAreTheRewardContractsEpochs() public {
        _stake(alice, 10e18);
        _closeEpochs(3);
        _request(alice, 10e18);
        (, uint64 e,) = st.unstakingOf(alice);
        assertEq(e, ethR.currentEpoch());
        assertEq(e, 3);
        SparecycleRewards.Epoch memory ep = ethR.getEpoch(3);
        assertTrue(ep.startedAt != 0);
    }

    /// @notice The names and shapes the brief (§3) and the scheduler wiring rely on.
    function test_Interface_MatchesBrief() public pure {
        assertEq(NS.stake.selector, bytes4(keccak256("stake(uint256)")));
        assertEq(NS.requestUnstake.selector, bytes4(keccak256("requestUnstake(uint256)")));
        assertEq(NS.unstake.selector, bytes4(keccak256("unstake()")));
        assertEq(NS.proposeSlash.selector, bytes4(keccak256("proposeSlash(address,uint256,bytes32)")));
        assertEq(NS.appeal.selector, bytes4(keccak256("appeal(uint256,bytes32)")));
        assertEq(NS.cancelSlash.selector, bytes4(keccak256("cancelSlash(uint256)")));
        assertEq(NS.executeSlash.selector, bytes4(keccak256("executeSlash(uint256)")));
        assertEq(NS.stakedOf.selector, bytes4(keccak256("stakedOf(address)")));
        assertEq(NS.minStakePerNode.selector, bytes4(keccak256("minStakePerNode()")));
        assertEq(NS.meetsMinimum.selector, bytes4(keccak256("meetsMinimum(address,uint256)")));
        assertEq(NS.Slashed.selector, keccak256("Slashed(address,uint256,uint256,bytes32)"));
        assertEq(NS.SlashSplit.selector, keccak256("SlashSplit(uint256,address,uint256,uint256)"));
        assertEq(NS.canPropose.selector, bytes4(keccak256("canPropose(address)")));
    }
}
