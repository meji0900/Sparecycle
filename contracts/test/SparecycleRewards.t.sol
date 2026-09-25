// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {RewardsFixture} from "./Base.t.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {MockPonsFeeEscrow} from "./mocks/MockPonsFeeEscrow.sol";
import {
    MockERC20,
    FeeOnTransferToken,
    DoubleEntryToken,
    DoubleEntryLegacy,
    EthPusher,
    EthRejecter,
    ReentrantClaimer,
    DoubleCountEscrow
} from "./mocks/Mocks.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

contract SparecycleRewardsTest is RewardsFixture {
    // =================================================================== constructor

    function test_Constructor_SetsStateAndOpensEpoch0() public view {
        assertEq(ethR.owner(), admin);
        assertEq(ethR.pendingOwner(), address(0));
        assertEq(ethR.scheduler(), sched);
        assertEq(ethR.payoutToken(), address(0));
        assertEq(tokR.payoutToken(), address(usdg));
        assertEq(ethR.feeEscrow(), address(escrow));
        assertEq(ethR.epochLength(), EPOCH);
        assertEq(ethR.currentEpoch(), 0);
        assertFalse(ethR.claimsPaused());
        assertEq(ethR.accounted(), 0);
        assertEq(ethR.unaccounted(), 0);
        SparecycleRewards.Epoch memory e = ethR.getEpoch(0);
        assertEq(e.index, 0);
        assertEq(e.startedAt, T0);
        assertEq(e.endedAt, 0);
        assertEq(e.pot, 0);
        assertFalse(e.settled);
        // Not-yet-started epochs read as a zeroed struct.
        assertEq(ethR.getEpoch(1).startedAt, 0);
    }

    function test_Constructor_EmitsEvents() public {
        vm.expectEmit(true, true, true, true);
        emit SparecycleRewards.SchedulerUpdated(address(0), sched);
        vm.expectEmit(true, true, true, true);
        emit SparecycleRewards.EpochStarted(0, uint64(block.timestamp), 0);
        new SparecycleRewards(admin, sched, address(0), address(escrow), EPOCH);
    }

    function test_Constructor_RevertsOnBadArgs() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new SparecycleRewards(address(0), sched, address(0), address(escrow), EPOCH);
        vm.expectRevert(SparecycleRewards.ZeroAddress.selector);
        new SparecycleRewards(admin, address(0), address(0), address(escrow), EPOCH);
        vm.expectRevert(SparecycleRewards.ZeroAddress.selector);
        new SparecycleRewards(admin, sched, address(0), address(0), EPOCH);
        vm.expectRevert(bytes("payoutToken has no code"));
        new SparecycleRewards(admin, sched, makeAddr("eoa"), address(escrow), EPOCH);
        vm.expectRevert(bytes("epochLength out of range"));
        new SparecycleRewards(admin, sched, address(0), address(escrow), 0);
        vm.expectRevert(bytes("epochLength out of range"));
        new SparecycleRewards(admin, sched, address(0), address(escrow), 365 days + 1);
        new SparecycleRewards(admin, sched, address(0), address(escrow), 365 days);
        new SparecycleRewards(admin, sched, address(0), address(escrow), 1);
    }

    // =================================================================== fund

    function test_Fund_Eth_CreditsCurrentEpoch() public {
        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.PotFunded(0, funder, 3 ether);
        _fund(ethR, 3 ether);
        assertEq(ethR.getEpoch(0).pot, 3 ether);
        assertEq(ethR.accounted(), 3 ether);
        assertEq(address(ethR).balance, 3 ether);
        assertEq(ethR.unaccounted(), 0);
        _assertAccounting(ethR);
    }

    function test_Fund_ZeroValueIsNoop() public {
        vm.recordLogs();
        vm.prank(funder);
        ethR.fund{value: 0}();
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(ethR.accounted(), 0);
    }

    function test_Fund_RevertsInTokenMode() public {
        vm.prank(funder);
        vm.expectRevert(SparecycleRewards.WrongPayoutMode.selector);
        tokR.fund{value: 1 ether}();
    }

    function test_FundToken_CreditsCurrentEpoch() public {
        vm.expectEmit(true, true, true, true, address(tokR));
        emit SparecycleRewards.PotFunded(0, funder, 5e6);
        _fund(tokR, 5e6);
        assertEq(tokR.getEpoch(0).pot, 5e6);
        assertEq(tokR.accounted(), 5e6);
        assertEq(usdg.balanceOf(address(tokR)), 5e6);
        _assertAccounting(tokR);
    }

    function test_FundToken_RevertsInEthMode() public {
        vm.prank(funder);
        vm.expectRevert(SparecycleRewards.WrongPayoutMode.selector);
        ethR.fundToken(1);
    }

    function test_FundToken_RevertsWithoutApproval() public {
        usdg.mint(stranger, 10);
        vm.prank(stranger);
        vm.expectRevert();
        tokR.fundToken(10);
    }

    function test_FundToken_FeeOnTransferCreditsOnlyReceived() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        SparecycleRewards r = new SparecycleRewards(admin, sched, address(fot), address(escrow), EPOCH);
        fot.mint(funder, 1000);
        vm.startPrank(funder);
        fot.approve(address(r), 1000);
        r.fundToken(1000);
        vm.stopPrank();
        assertEq(fot.balanceOf(address(r)), 990);
        assertEq(r.getEpoch(0).pot, 990, "credits measured delta, not the requested amount");
        assertEq(r.accounted(), 990);
    }

    // =================================================================== receive + sync

    function test_Receive_Accepts2300GasTransferPush() public {
        EthPusher pusher = new EthPusher();
        pusher.pushTransfer{value: 2 ether}(payable(address(ethR)));
        pusher.pushSend{value: 1 ether}(payable(address(ethR)));
        assertEq(address(ethR).balance, 3 ether);
        assertEq(ethR.accounted(), 0, "receive writes no storage");
        assertEq(ethR.unaccounted(), 3 ether);
    }

    function test_Receive_UsesFarLessThanStipend() public {
        uint256 g = gasleft();
        (bool ok,) = address(ethR).call{value: 1 wei, gas: 2300}("");
        uint256 used = g - gasleft();
        assertTrue(ok);
        assertEq(ethR.unaccounted(), 1);
        emit log_named_uint("gas for a 1-wei push incl. call overhead", used);
    }

    function test_Sync_CreditsPushedEthToOpenEpoch() public {
        new EthPusher().pushTransfer{value: 2 ether}(payable(address(ethR)));
        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.PotFunded(0, address(0), 2 ether);
        vm.prank(stranger);
        assertEq(ethR.sync(), 2 ether);
        assertEq(ethR.getEpoch(0).pot, 2 ether);
        assertEq(ethR.accounted(), 2 ether);
        assertEq(ethR.unaccounted(), 0);
        // Idempotent: nothing more to credit.
        vm.recordLogs();
        assertEq(ethR.sync(), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        _assertAccounting(ethR);
    }

    function test_Sync_CreditsForcedEth() public {
        vm.deal(address(ethR), 7 ether); // e.g. selfdestruct / coinbase: arrives without any call
        assertEq(ethR.sync(), 7 ether);
        assertEq(ethR.getEpoch(0).pot, 7 ether);
    }

    function test_Sync_TokenMode_CreditsDirectTransfer() public {
        vm.prank(funder);
        usdg.transfer(address(tokR), 4e6);
        assertEq(tokR.unaccounted(), 4e6);
        assertEq(tokR.sync(), 4e6);
        assertEq(tokR.getEpoch(0).pot, 4e6);
        _assertAccounting(tokR);
    }

    function test_Sync_TokenMode_IgnoresStrayEth() public {
        vm.deal(address(tokR), 1 ether);
        assertEq(tokR.unaccounted(), 0);
        assertEq(tokR.sync(), 0);
    }

    function test_Sync_CreditsToCurrentEpochAfterClose() public {
        _fund(ethR, 1 ether);
        _closeEmpty(ethR);
        new EthPusher().pushTransfer{value: 1 ether}(payable(address(ethR)));
        ethR.sync();
        assertEq(ethR.getEpoch(0).pot, 1 ether, "settled pot frozen");
        assertEq(ethR.getEpoch(1).pot, 2 ether, "rollover + late inflow go to the open epoch");
    }

    // =================================================================== escrow

    function test_EscrowClaim_Eth_CreditsDelta() public {
        escrow.credit{value: 3 ether}(address(ethR));
        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.FeesClaimedFromEscrow(0, 3 ether);
        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.PotFunded(0, address(escrow), 3 ether);
        vm.prank(stranger); // permissionless
        assertEq(ethR.claimFeesFromEscrow(), 3 ether);
        assertEq(ethR.getEpoch(0).pot, 3 ether);
        assertEq(escrow.balanceOf(address(ethR)), 0);
        _assertAccounting(ethR);
    }

    function test_EscrowClaim_Eth_TransferPushUnderStipend() public {
        escrow.setPushWithTransfer(true);
        escrow.credit{value: 1 ether}(address(ethR));
        assertEq(ethR.claimFeesFromEscrow(), 1 ether);
        assertEq(ethR.getEpoch(0).pot, 1 ether);
    }

    function test_EscrowClaim_Eth_ZeroBalanceReturnsZero() public {
        // The mock (like the real escrow) reverts NoBalance() on claim(); the pre-check avoids calling it.
        vm.expectRevert(MockPonsFeeEscrow.NoBalance.selector);
        escrow.claim();
        vm.recordLogs();
        assertEq(ethR.claimFeesFromEscrow(), 0);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_EscrowClaim_Eth_DoesNotSweepUnaccounted() public {
        new EthPusher().pushTransfer{value: 1 ether}(payable(address(ethR)));
        escrow.credit{value: 2 ether}(address(ethR));
        assertEq(ethR.claimFeesFromEscrow(), 2 ether);
        assertEq(ethR.unaccounted(), 1 ether, "pre-existing unaccounted stays for sync()");
        assertEq(ethR.sync(), 1 ether);
        assertEq(ethR.getEpoch(0).pot, 3 ether);
        _assertAccounting(ethR);
    }

    function test_EscrowClaim_Eth_RevertsInTokenMode() public {
        vm.expectRevert(SparecycleRewards.WrongPayoutMode.selector);
        tokR.claimFeesFromEscrow();
    }

    function test_EscrowClaim_Token_CreditsDelta() public {
        vm.startPrank(funder);
        usdg.approve(address(escrow), 9e6);
        escrow.creditToken(address(tokR), address(usdg), 9e6);
        vm.stopPrank();
        vm.expectEmit(true, true, true, true, address(tokR));
        emit SparecycleRewards.FeesClaimedFromEscrow(0, 9e6);
        vm.expectEmit(true, true, true, true, address(tokR));
        emit SparecycleRewards.PotFunded(0, address(escrow), 9e6);
        assertEq(tokR.claimFeesFromEscrowToken(), 9e6);
        assertEq(tokR.getEpoch(0).pot, 9e6);
        assertEq(tokR.claimFeesFromEscrowToken(), 0, "second call: zero balance, no revert");
        _assertAccounting(tokR);
    }

    function test_EscrowClaim_Token_RevertsInEthMode() public {
        vm.expectRevert(SparecycleRewards.WrongPayoutMode.selector);
        ethR.claimFeesFromEscrowToken();
    }

    function test_EscrowClaim_ReentrantFundCannotDoubleCount() public {
        DoubleCountEscrow bad = new DoubleCountEscrow();
        SparecycleRewards r = new SparecycleRewards(admin, sched, address(0), address(bad), EPOCH);
        bad.credit{value: 1 ether}(address(r));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        r.claimFeesFromEscrow();
        assertEq(r.accounted(), 0);
    }

    // =================================================================== close

    function test_Close_OnlyScheduler() public {
        _warpToEnd(ethR);
        vm.prank(admin);
        vm.expectRevert(SparecycleRewards.NotScheduler.selector);
        ethR.closeEpochAndPostRoot(0, bytes32(0), 0);
        vm.prank(stranger);
        vm.expectRevert(SparecycleRewards.NotScheduler.selector);
        ethR.closeEpochAndPostRoot(0, bytes32(0), 0);
    }

    function test_Close_WrongEpoch() public {
        _warpToEnd(ethR);
        vm.prank(sched);
        vm.expectRevert(SparecycleRewards.WrongEpoch.selector);
        ethR.closeEpochAndPostRoot(1, bytes32(0), 0);
    }

    function test_Close_TooEarly() public {
        vm.warp(T0 + EPOCH - 1);
        assertFalse(ethR.canClose(0));
        vm.prank(sched);
        vm.expectRevert(SparecycleRewards.EpochNotOver.selector);
        ethR.closeEpochAndPostRoot(0, bytes32(0), 0);
        vm.warp(T0 + EPOCH);
        assertTrue(ethR.canClose(0));
        assertFalse(ethR.canClose(1));
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(0, bytes32(0), 0);
        assertFalse(ethR.canClose(0));
        assertFalse(ethR.canClose(1), "epoch 1 just started");
    }

    function test_Close_ReservedExceedsPot() public {
        _fund(ethR, 1 ether);
        _warpToEnd(ethR);
        vm.prank(sched);
        vm.expectRevert(SparecycleRewards.ReservedExceedsPot.selector);
        ethR.closeEpochAndPostRoot(0, keccak256("root"), 1 ether + 1);
    }

    function test_Close_ZeroRootWithReserved() public {
        _fund(ethR, 1 ether);
        _warpToEnd(ethR);
        vm.prank(sched);
        vm.expectRevert(SparecycleRewards.EmptyRootWithReserved.selector);
        ethR.closeEpochAndPostRoot(0, bytes32(0), 1);
    }

    function test_Close_ZeroRootZeroReservedRollsEverything() public {
        _fund(ethR, 1 ether);
        _closeEmpty(ethR);
        SparecycleRewards.Epoch memory e0 = ethR.getEpoch(0);
        assertTrue(e0.settled);
        assertEq(e0.reserved, 0);
        assertEq(ethR.getEpoch(1).pot, 1 ether);
        _assertAccounting(ethR);
    }

    function test_Close_DoublePostReverts() public {
        _closeEmpty(ethR);
        vm.warp(block.timestamp + 10 * EPOCH);
        vm.prank(sched);
        vm.expectRevert(SparecycleRewards.AlreadySettled.selector);
        ethR.closeEpochAndPostRoot(0, keccak256("again"), 0);
    }

    function test_Close_SyncsBeforeReservedCheck() public {
        _fund(ethR, 1 ether);
        new EthPusher().pushTransfer{value: 1 ether}(payable(address(ethR)));
        _warpToEnd(ethR);
        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.PotFunded(0, address(0), 1 ether);
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(0, keccak256("r"), 2 ether); // only fits because of the in-close sync
        assertEq(ethR.getEpoch(0).pot, 2 ether);
        assertEq(ethR.getEpoch(1).pot, 0);
    }

    function test_Close_EmitsAndStartsNextEpoch() public {
        _fund(ethR, 10 ether);
        _warpToEnd(ethR);
        vm.warp(block.timestamp + 123); // late close: next epoch starts at close time
        bytes32 root = keccak256("root");
        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.EpochSettled(0, root, 6 ether, 10 ether);
        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.RolledOver(0, 1, 4 ether);
        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.EpochStarted(1, uint64(block.timestamp), 4 ether);
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(0, root, 6 ether);

        SparecycleRewards.Epoch memory e0 = ethR.getEpoch(0);
        assertEq(e0.endedAt, block.timestamp);
        assertEq(e0.merkleRoot, root);
        assertEq(e0.reserved, 6 ether);
        assertEq(e0.pot, 10 ether);
        assertTrue(e0.settled);
        SparecycleRewards.Epoch memory e1 = ethR.getEpoch(1);
        assertEq(e1.index, 1);
        assertEq(e1.startedAt, block.timestamp);
        assertEq(e1.pot, 4 ether);
        assertFalse(e1.settled);
        assertEq(ethR.currentEpoch(), 1);
        assertEq(ethR.accounted(), 10 ether, "close never changes accounted");
        _assertAccounting(ethR);
    }

    // =================================================================== claim

    function _claimAllOfTree(SparecycleRewards r, uint256 n) internal {
        address[] memory ops = _ops(n);
        uint256[] memory amts = new uint256[](n);
        bool eth = r.payoutToken() == address(0);
        for (uint256 i; i < n; ++i) {
            amts[i] = (i + 1) * (eth ? 0.1 ether : 1e5);
        }
        _fund(r, _sum(amts) + 7);
        (uint64 id, bytes32[] memory leaves, bytes32 root) = _close(r, ops, amts);
        if (n == 1) assertEq(root, leaves[0], "single-leaf root is the leaf");
        for (uint256 i; i < n; ++i) {
            uint256 before = _bal(r, ops[i]);
            vm.expectEmit(true, true, true, true, address(r));
            emit SparecycleRewards.Claimed(id, ops[i], amts[i]);
            _claim(r, id, leaves, ops[i], amts[i]);
            assertEq(_bal(r, ops[i]) - before, amts[i]);
            assertTrue(r.hasClaimed(id, ops[i]));
            _assertAccounting(r);
        }
        SparecycleRewards.Epoch memory e = r.getEpoch(id);
        assertEq(e.claimed, e.reserved);
        assertEq(r.getEpoch(id + 1).pot, 7, "unreserved dust rolled over");
        assertEq(r.accounted(), 7);
        assertEq(_bal(r, address(r)), 7);
    }

    function test_Claim_Tree1() public {
        _claimAllOfTree(ethR, 1);
    }

    function test_Claim_Tree2() public {
        _claimAllOfTree(ethR, 2);
    }

    function test_Claim_Tree3() public {
        _claimAllOfTree(ethR, 3);
    }

    function test_Claim_Tree7() public {
        _claimAllOfTree(ethR, 7);
    }

    function test_Claim_Tree7_Token() public {
        _claimAllOfTree(tokR, 7);
    }

    function test_Claim_Tree3_Token() public {
        _claimAllOfTree(tokR, 3);
    }

    function _setup3()
        internal
        returns (address[] memory ops, uint256[] memory amts, uint64 id, bytes32[] memory leaves)
    {
        ops = _ops(3);
        amts = new uint256[](3);
        amts[0] = 1 ether;
        amts[1] = 2 ether;
        amts[2] = 3 ether;
        _fund(ethR, 6 ether);
        (id, leaves,) = _close(ethR, ops, amts);
    }

    function test_Claim_DoubleClaimReverts() public {
        (address[] memory ops, uint256[] memory amts, uint64 id, bytes32[] memory leaves) = _setup3();
        _claim(ethR, id, leaves, ops[1], amts[1]);
        bytes32[] memory p = MerkleHelper.proof(leaves, ethR.leafOf(id, ops[1], amts[1]));
        vm.prank(ops[1]);
        vm.expectRevert(SparecycleRewards.AlreadyClaimed.selector);
        ethR.claim(id, amts[1], p);
    }

    function test_Claim_BadProofReverts() public {
        (address[] memory ops, uint256[] memory amts, uint64 id, bytes32[] memory leaves) = _setup3();
        bytes32[] memory p = MerkleHelper.proof(leaves, ethR.leafOf(id, ops[0], amts[0]));
        p[0] = keccak256("garbage");
        vm.prank(ops[0]);
        vm.expectRevert(SparecycleRewards.InvalidProof.selector);
        ethR.claim(id, amts[0], p);
        // Empty proof for a multi-leaf tree.
        vm.prank(ops[0]);
        vm.expectRevert(SparecycleRewards.InvalidProof.selector);
        ethR.claim(id, amts[0], new bytes32[](0));
    }

    function test_Claim_WrongAmountReverts() public {
        (address[] memory ops, uint256[] memory amts, uint64 id, bytes32[] memory leaves) = _setup3();
        bytes32[] memory p = MerkleHelper.proof(leaves, ethR.leafOf(id, ops[0], amts[0]));
        vm.prank(ops[0]);
        vm.expectRevert(SparecycleRewards.InvalidProof.selector);
        ethR.claim(id, amts[0] + 1, p);
    }

    function test_Claim_StolenProofReverts() public {
        (address[] memory ops, uint256[] memory amts, uint64 id, bytes32[] memory leaves) = _setup3();
        bytes32[] memory p = MerkleHelper.proof(leaves, ethR.leafOf(id, ops[2], amts[2]));
        vm.prank(stranger);
        vm.expectRevert(SparecycleRewards.InvalidProof.selector);
        ethR.claim(id, amts[2], p);
    }

    function test_Claim_LeafIsBoundToEpoch() public {
        (address[] memory ops, uint256[] memory amts, uint64 id, bytes32[] memory leaves) = _setup3();
        // Epoch 1 gets a tree whose leaves were (wrongly) computed for epoch 0: the same proof cannot be
        // replayed in epoch 1 because the leaf encodes the epoch id.
        _fund(ethR, 6 ether);
        _warpToEnd(ethR);
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(1, MerkleHelper.root(leaves), 6 ether);
        bytes32[] memory p = MerkleHelper.proof(leaves, ethR.leafOf(id, ops[0], amts[0]));
        vm.prank(ops[0]);
        vm.expectRevert(SparecycleRewards.InvalidProof.selector);
        ethR.claim(1, amts[0], p);
    }

    function test_Claim_OverAllocatedTreeCappedByReserved() public {
        // Scheduler bug: leaves sum to 6 ether but only 4 ether reserved. Claims stop at `reserved`.
        address[] memory ops = _ops(3);
        uint256[] memory amts = new uint256[](3);
        amts[0] = 1 ether;
        amts[1] = 2 ether;
        amts[2] = 3 ether;
        _fund(ethR, 10 ether);
        bytes32[] memory leaves = _leaves(ethR, 0, ops, amts);
        _warpToEnd(ethR);
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(0, MerkleHelper.root(leaves), 4 ether);

        _claim(ethR, 0, leaves, ops[2], 3 ether);
        bytes32[] memory p = MerkleHelper.proof(leaves, ethR.leafOf(0, ops[1], 2 ether));
        vm.prank(ops[1]);
        vm.expectRevert(SparecycleRewards.ClaimExceedsReserved.selector);
        ethR.claim(0, 2 ether, p);
        _claim(ethR, 0, leaves, ops[0], 1 ether);
        assertEq(ethR.getEpoch(0).claimed, 4 ether);
        assertEq(ethR.getEpoch(1).pot, 6 ether, "rollover is pot - reserved, untouched by claims");
        _assertAccounting(ethR);
    }

    function test_Claim_PausedReverts() public {
        (address[] memory ops, uint256[] memory amts, uint64 id, bytes32[] memory leaves) = _setup3();
        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.ClaimsPaused(admin);
        vm.prank(admin);
        ethR.pauseClaims();
        assertTrue(ethR.claimsPaused());
        bytes32[] memory p = MerkleHelper.proof(leaves, ethR.leafOf(id, ops[0], amts[0]));
        vm.prank(ops[0]);
        vm.expectRevert(SparecycleRewards.ClaimsArePaused.selector);
        ethR.claim(id, amts[0], p);

        // Funding and closing continue while paused.
        _fund(ethR, 1 ether);
        _closeEmpty(ethR);

        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.ClaimsUnpaused(admin);
        vm.prank(admin);
        ethR.unpauseClaims();
        vm.prank(ops[0]);
        ethR.claim(id, amts[0], p);
        assertEq(ops[0].balance, amts[0]);
    }

    function test_Claim_NotSettledReverts() public {
        address[] memory ops = _ops(1);
        uint256[] memory amts = new uint256[](1);
        amts[0] = 1;
        bytes32[] memory leaves = _leaves(ethR, 0, ops, amts);
        vm.prank(ops[0]);
        vm.expectRevert(SparecycleRewards.NotSettled.selector);
        ethR.claim(0, 1, new bytes32[](0)); // open epoch
        vm.prank(ops[0]);
        vm.expectRevert(SparecycleRewards.NotSettled.selector);
        ethR.claim(5, 1, new bytes32[](0)); // future epoch
        leaves; // silence
    }

    function test_Claim_ZeroRootEpochHasNoClaims() public {
        _closeEmpty(ethR);
        vm.prank(stranger);
        vm.expectRevert(SparecycleRewards.InvalidProof.selector);
        ethR.claim(0, 0, new bytes32[](0));
    }

    function test_Claim_ZeroAmountLeaf() public {
        address[] memory ops = _ops(2);
        uint256[] memory amts = new uint256[](2);
        amts[0] = 0;
        amts[1] = 1 ether;
        _fund(ethR, 1 ether);
        (uint64 id, bytes32[] memory leaves,) = _close(ethR, ops, amts);
        _claim(ethR, id, leaves, ops[0], 0);
        assertTrue(ethR.hasClaimed(id, ops[0]));
        _claim(ethR, id, leaves, ops[1], 1 ether);
        _assertAccounting(ethR);
    }

    function test_Claim_RejectingRecipientRollsBack() public {
        EthRejecter rej = new EthRejecter();
        address[] memory ops = new address[](2);
        ops[0] = address(rej);
        ops[1] = stranger;
        uint256[] memory amts = new uint256[](2);
        amts[0] = 1 ether;
        amts[1] = 1 ether;
        _fund(ethR, 2 ether);
        (uint64 id, bytes32[] memory leaves,) = _close(ethR, ops, amts);
        bytes32[] memory p = MerkleHelper.proof(leaves, ethR.leafOf(id, address(rej), 1 ether));
        vm.expectRevert(SparecycleRewards.TransferFailed.selector);
        rej.doClaim(ethR, id, 1 ether, p);
        assertFalse(ethR.hasClaimed(id, address(rej)));
        assertEq(ethR.getEpoch(id).claimed, 0);
        assertEq(ethR.accounted(), 2 ether);
    }

    function test_Claim_ReentrancyBlocked() public {
        ReentrantClaimer atk = new ReentrantClaimer(ethR);
        address[] memory ops = new address[](2);
        ops[0] = address(atk);
        ops[1] = stranger;
        uint256[] memory amts = new uint256[](2);
        amts[0] = 1 ether;
        amts[1] = 1 ether;
        _fund(ethR, 2 ether);
        (uint64 id, bytes32[] memory leaves,) = _close(ethR, ops, amts);
        bytes32[] memory p = MerkleHelper.proof(leaves, ethR.leafOf(id, address(atk), 1 ether));
        atk.doClaim(id, 1 ether, p);
        assertTrue(atk.reentered());
        assertEq(bytes4(atk.reentryError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(address(atk).balance, 1 ether, "paid exactly once");
        assertEq(ethR.getEpoch(id).claimed, 1 ether);
        _assertAccounting(ethR);
    }

    function test_LeafOf_MatchesSpecEncoding() public view {
        uint64 e = 42;
        address a = address(0xBEEF);
        uint256 amt = 123 ether;
        bytes memory packed = abi.encodePacked(e, a, amt);
        assertEq(packed.length, 60, "60-byte leaf preimage (inner nodes are 64)");
        assertEq(ethR.leafOf(e, a, amt), keccak256(packed));
        assertEq(ethR.leafOf(e, a, amt), keccak256(bytes.concat(bytes8(e), bytes20(a), bytes32(amt))));
    }

    // =================================================================== rollover math

    function test_Rollover_MultiEpochMath() public {
        address[] memory ops = _ops(2);
        uint256[] memory amts = new uint256[](2);

        // Epoch 0: funded 10, reserve 6 → roll 4.
        _fund(ethR, 10 ether);
        amts[0] = 2 ether;
        amts[1] = 4 ether;
        (uint64 e0, bytes32[] memory l0,) = _close(ethR, ops, amts);
        assertEq(ethR.getEpoch(1).pot, 4 ether);

        // Epoch 1: rolled 4 + funded 3 + escrow 1 = 8; reserve 8 → roll 0.
        _fund(ethR, 3 ether);
        escrow.credit{value: 1 ether}(address(ethR));
        ethR.claimFeesFromEscrow();
        assertEq(ethR.getEpoch(1).pot, 8 ether);
        amts[0] = 5 ether;
        amts[1] = 3 ether;
        (uint64 e1, bytes32[] memory l1,) = _close(ethR, ops, amts);
        assertEq(ethR.getEpoch(2).pot, 0);

        // Epoch 2: nothing funded, empty close → roll 0.
        _closeEmpty(ethR);
        assertEq(ethR.getEpoch(3).pot, 0);
        assertEq(ethR.accounted(), 14 ether, "6 + 8 reserved, nothing claimed yet");

        // Claims from old epochs still work later; only e0's op0 claims.
        _claim(ethR, e0, l0, ops[0], 2 ether);
        _claim(ethR, e1, l1, ops[1], 3 ether);
        assertEq(ethR.accounted(), 9 ether);
        assertEq(address(ethR).balance, 9 ether);
        _assertAccounting(ethR);
    }

    // =================================================================== admin

    function test_SetScheduler_AuthAndEffect() public {
        address next = makeAddr("next");
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, sched));
        ethR.setScheduler(next);
        vm.prank(admin);
        vm.expectRevert(SparecycleRewards.ZeroAddress.selector);
        ethR.setScheduler(address(0));

        vm.expectEmit(true, true, true, true, address(ethR));
        emit SparecycleRewards.SchedulerUpdated(sched, next);
        vm.prank(admin);
        ethR.setScheduler(next);
        assertEq(ethR.scheduler(), next);

        _warpToEnd(ethR);
        vm.prank(sched);
        vm.expectRevert(SparecycleRewards.NotScheduler.selector);
        ethR.closeEpochAndPostRoot(0, bytes32(0), 0);
        vm.prank(next);
        ethR.closeEpochAndPostRoot(0, bytes32(0), 0);
    }

    function test_Pause_Auth() public {
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, sched));
        ethR.pauseClaims();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ethR.unpauseClaims();
    }

    // =================================================================== rescue

    function test_Rescue_EthMode_PayoutAssetBlocked() public {
        _fund(ethR, 1 ether);
        vm.prank(admin);
        vm.expectRevert(SparecycleRewards.CannotRescuePayoutToken.selector);
        ethR.rescueToken(address(0), admin, 1 ether);
    }

    function test_Rescue_EthMode_StrayErc20() public {
        MockERC20 stray = new MockERC20("Stray", "STR", 18);
        stray.mint(address(ethR), 5);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ethR.rescueToken(address(stray), stranger, 5);
        vm.prank(admin);
        vm.expectRevert(SparecycleRewards.ZeroAddress.selector);
        ethR.rescueToken(address(stray), address(0), 5);
        vm.prank(admin);
        ethR.rescueToken(address(stray), admin, 5);
        assertEq(stray.balanceOf(admin), 5);
    }

    function test_Rescue_TokenMode_PayoutTokenBlocked() public {
        _fund(tokR, 1e6);
        vm.prank(admin);
        vm.expectRevert(SparecycleRewards.CannotRescuePayoutToken.selector);
        tokR.rescueToken(address(usdg), admin, 1e6);
    }

    function test_Rescue_TokenMode_StrayEthAndErc20() public {
        vm.deal(address(tokR), 1 ether);
        vm.prank(admin);
        tokR.rescueToken(address(0), stranger, 1 ether);
        assertEq(stranger.balance, 1 ether);

        MockERC20 stray = new MockERC20("Stray", "STR", 18);
        stray.mint(address(tokR), 5);
        vm.prank(admin);
        tokR.rescueToken(address(stray), stranger, 5);
        assertEq(stray.balanceOf(stranger), 5);
    }

    function test_Rescue_DoubleEntryPayoutTokenBlocked() public {
        DoubleEntryToken dbl = new DoubleEntryToken();
        DoubleEntryLegacy legacy = new DoubleEntryLegacy(dbl);
        dbl.setLegacy(address(legacy));
        SparecycleRewards r = new SparecycleRewards(admin, sched, address(dbl), address(escrow), EPOCH);
        dbl.mint(funder, 10);
        vm.startPrank(funder);
        dbl.approve(address(r), 10);
        r.fundToken(10);
        vm.stopPrank();
        vm.prank(admin);
        vm.expectRevert(SparecycleRewards.CannotRescuePayoutToken.selector);
        r.rescueToken(address(legacy), admin, 10);
        assertEq(dbl.balanceOf(address(r)), 10);
    }

    // =================================================================== ownership

    function test_Ownership_TwoStep() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ethR.transferOwnership(newAdmin);

        vm.prank(admin);
        ethR.transferOwnership(newAdmin);
        assertEq(ethR.owner(), admin, "owner unchanged until accepted");
        assertEq(ethR.pendingOwner(), newAdmin);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ethR.acceptOwnership();

        vm.prank(newAdmin);
        ethR.acceptOwnership();
        assertEq(ethR.owner(), newAdmin);
        assertEq(ethR.pendingOwner(), address(0));

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        ethR.pauseClaims();
        vm.prank(newAdmin);
        ethR.pauseClaims();
    }

    function test_Ownership_RenounceDisabled() public {
        vm.prank(admin);
        vm.expectRevert(bytes("renounce disabled"));
        ethR.renounceOwnership();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        ethR.renounceOwnership();
        assertEq(ethR.owner(), admin);
    }

    /// @dev No owner-only function moves the payout asset: try every one of them with a funded pot.
    ///      (Funds only ever leave through `claim` against a posted root; see the next test for that trust boundary.)
    function test_Owner_CannotMovePayoutAsset() public {
        _fund(ethR, 5 ether);
        vm.startPrank(admin);
        ethR.pauseClaims();
        ethR.unpauseClaims();
        ethR.setScheduler(makeAddr("other"));
        vm.expectRevert(SparecycleRewards.CannotRescuePayoutToken.selector);
        ethR.rescueToken(address(0), admin, 5 ether);
        vm.expectRevert(bytes("renounce disabled"));
        ethR.renounceOwnership();
        ethR.transferOwnership(admin);
        vm.stopPrank();
        assertEq(address(ethR).balance, 5 ether);
        assertEq(admin.balance, 0);
    }

    /// @dev Trust boundary: a compromised owner can make itself scheduler and post a self-paying root for the
    ///      OPEN pot (centralized-scheduler risk, disclosed), but settled reservations stay untouchable.
    function test_CompromisedOwnerCannotTouchSettledReservations() public {
        (address[] memory ops, uint256[] memory amts, uint64 id, bytes32[] memory leaves) = _setup3(); // 6 ETH settled
        _fund(ethR, 4 ether); // epoch 1 open pot

        vm.startPrank(admin);
        ethR.setScheduler(admin);
        _warpToEnd(ethR);
        vm.expectRevert(SparecycleRewards.AlreadySettled.selector);
        ethR.closeEpochAndPostRoot(id, keccak256("rewrite"), 0); // epoch 0 cannot be re-posted
        address[] memory me = new address[](1);
        me[0] = admin;
        uint256[] memory all = new uint256[](1);
        all[0] = 10 ether; // tries to reach the settled 6 ETH as well
        bytes32[] memory l1 = _leaves(ethR, 1, me, all);
        vm.expectRevert(SparecycleRewards.ReservedExceedsPot.selector);
        ethR.closeEpochAndPostRoot(1, MerkleHelper.root(l1), 10 ether);
        vm.stopPrank();

        for (uint256 i; i < 3; ++i) {
            _claim(ethR, id, leaves, ops[i], amts[i]);
        }
        assertEq(ethR.getEpoch(id).claimed, 6 ether, "operators still get every settled wei");
        _assertAccounting(ethR);
    }
}
