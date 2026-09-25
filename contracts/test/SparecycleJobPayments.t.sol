// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RewardsFixture} from "./Base.t.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {SparecycleJobPayments} from "../src/SparecycleJobPayments.sol";

contract RejectEth {
    receive() external payable {
        revert("no");
    }
}

/// @notice Customer that tries to re-enter withdraw() when paid.
contract ReentrantCustomer {
    SparecycleJobPayments internal p;
    uint256 public reentered;

    constructor(SparecycleJobPayments p_) {
        p = p_;
    }

    function fundAndRequest(uint256 amount) external payable {
        p.deposit{value: msg.value}();
        p.requestWithdraw(amount);
    }

    function pull() external {
        p.withdraw();
    }

    receive() external payable {
        if (reentered == 0) {
            reentered = 1;
            try p.withdraw() {
                reentered = 2;
            } catch {}
        }
    }
}

contract SparecycleJobPaymentsTest is RewardsFixture {
    SparecycleJobPayments internal pay;
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        pay = new SparecycleJobPayments(address(ethR), treasury);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _one(address c, uint256 a) internal pure returns (address[] memory cs, uint256[] memory as_) {
        cs = new address[](1);
        as_ = new uint256[](1);
        cs[0] = c;
        as_[0] = a;
    }

    function _charge(address c, uint256 a) internal {
        (address[] memory cs, uint256[] memory as_) = _one(c, a);
        uint64 id = ethR.currentEpoch();
        vm.prank(sched);
        pay.charge(id, cs, as_, keccak256("list"));
    }

    // ---------------------------------------------------------------- construction

    function test_Constructor_RejectsTokenRewardsAndZero() public {
        vm.expectRevert(SparecycleJobPayments.NotEthRewards.selector);
        new SparecycleJobPayments(address(tokR), treasury);
        vm.expectRevert(SparecycleJobPayments.ZeroAddress.selector);
        new SparecycleJobPayments(address(ethR), address(0));
        vm.expectRevert(SparecycleJobPayments.ZeroAddress.selector);
        new SparecycleJobPayments(address(0), treasury);
    }

    // ---------------------------------------------------------------- deposits

    function test_Deposit_AndPlainTransfer() public {
        vm.prank(alice);
        pay.deposit{value: 1 ether}();
        vm.prank(alice);
        (bool ok,) = address(pay).call{value: 0.5 ether}("");
        assertTrue(ok);
        assertEq(pay.balanceOf(alice), 1.5 ether);
        assertEq(pay.totalBalance(), 1.5 ether);
        assertEq(address(pay).balance, 1.5 ether);
    }

    function test_Deposit_ZeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(SparecycleJobPayments.ZeroAmount.selector);
        pay.deposit{value: 0}();
    }

    // ---------------------------------------------------------------- charges

    function test_Charge_SplitsToPotAndTreasury() public {
        vm.prank(alice);
        pay.deposit{value: 1 ether}();
        uint64 id = ethR.currentEpoch();
        uint256 potBefore = ethR.getEpoch(id).pot;

        _charge(alice, 0.2 ether);

        assertEq(pay.balanceOf(alice), 0.8 ether);
        assertEq(pay.totalBalance(), 0.8 ether);
        assertEq(treasury.balance, 0.01 ether); // 5%
        assertEq(ethR.getEpoch(id).pot - potBefore, 0.19 ether); // 95% into the open epoch's pot
        assertEq(address(ethR).balance, 0.19 ether);
        assertEq(address(pay).balance, 0.8 ether);
        assertEq(pay.chargedInEpoch(alice, id), 0.2 ether);
    }

    function test_Charge_PaidOutByTheSameRootAsFees() public {
        vm.prank(alice);
        pay.deposit{value: 1 ether}();
        _fund(ethR, 0.05 ether); // stands in for Pons fees
        _charge(alice, 1 ether); // 0.95 to the pot
        uint64 id = ethR.currentEpoch();
        assertEq(ethR.getEpoch(id).pot, 1 ether);

        address[] memory ops = _ops(2);
        uint256[] memory amts = new uint256[](2);
        amts[0] = 0.6 ether;
        amts[1] = 0.4 ether;
        (uint64 closed, bytes32[] memory leaves,) = _close(ethR, ops, amts);
        assertEq(closed, id);
        _claim(ethR, id, leaves, ops[0], amts[0]);
        assertEq(ops[0].balance, 0.6 ether);
    }

    function test_Charge_OnlyScheduler() public {
        vm.prank(alice);
        pay.deposit{value: 1 ether}();
        (address[] memory cs, uint256[] memory as_) = _one(alice, 0.1 ether);
        vm.prank(stranger);
        vm.expectRevert(SparecycleJobPayments.NotScheduler.selector);
        pay.charge(0, cs, as_, bytes32(0));
        vm.prank(admin); // the reward contract's owner can't charge either
        vm.expectRevert(SparecycleJobPayments.NotScheduler.selector);
        pay.charge(0, cs, as_, bytes32(0));
    }

    function test_Charge_FollowsSchedulerRotation() public {
        vm.prank(alice);
        pay.deposit{value: 1 ether}();
        address next = makeAddr("nextScheduler");
        vm.prank(admin);
        ethR.setScheduler(next);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 0.1 ether);
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPayments.NotScheduler.selector);
        pay.charge(0, cs, as_, bytes32(0));
        vm.prank(next);
        pay.charge(0, cs, as_, bytes32(0));
        assertEq(pay.balanceOf(alice), 0.9 ether);
    }

    function test_Charge_OnlyOpenEpoch() public {
        vm.prank(alice);
        pay.deposit{value: 1 ether}();
        _closeEmpty(ethR); // open epoch is now 1
        (address[] memory cs, uint256[] memory as_) = _one(alice, 0.1 ether);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPayments.WrongEpoch.selector, uint64(0), uint64(1)));
        pay.charge(0, cs, as_, bytes32(0));
    }

    function test_Charge_OverBalanceReverts() public {
        vm.prank(alice);
        pay.deposit{value: 1 ether}();
        (address[] memory cs, uint256[] memory as_) = _one(alice, 1 ether + 1);
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(SparecycleJobPayments.InsufficientBalance.selector, alice, 1 ether, 1 ether + 1)
        );
        pay.charge(0, cs, as_, bytes32(0));
    }

    function test_Charge_ZeroAndLengthMismatchRevert() public {
        address[] memory cs = new address[](2);
        uint256[] memory as_ = new uint256[](1);
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPayments.LengthMismatch.selector);
        pay.charge(0, cs, as_, bytes32(0));
        (address[] memory c1, uint256[] memory a1) = _one(alice, 0);
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPayments.ZeroAmount.selector);
        pay.charge(0, c1, a1, bytes32(0));
    }

    function test_Charge_SpendLimitPerEpoch() public {
        vm.startPrank(alice);
        pay.deposit{value: 1 ether}();
        pay.setSpendLimit(0.3 ether);
        vm.stopPrank();
        _charge(alice, 0.2 ether);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 0.2 ether);
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(SparecycleJobPayments.SpendLimitExceeded.selector, alice, 0.3 ether, 0.4 ether)
        );
        pay.charge(0, cs, as_, bytes32(0));
        // the limit is per epoch: the next epoch starts at zero again
        _closeEmpty(ethR);
        _charge(alice, 0.3 ether);
        assertEq(pay.balanceOf(alice), 0.5 ether);
    }

    function test_Charge_DuplicateCustomerCountsTowardLimit() public {
        vm.startPrank(alice);
        pay.deposit{value: 1 ether}();
        pay.setSpendLimit(0.3 ether);
        vm.stopPrank();
        address[] memory cs = new address[](2);
        uint256[] memory as_ = new uint256[](2);
        cs[0] = alice;
        cs[1] = alice;
        as_[0] = 0.2 ether;
        as_[1] = 0.2 ether;
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(SparecycleJobPayments.SpendLimitExceeded.selector, alice, 0.3 ether, 0.4 ether)
        );
        pay.charge(0, cs, as_, bytes32(0));
    }

    function test_Charge_TreasuryRejectingEthRevertsWholeCharge() public {
        RejectEth bad = new RejectEth();
        SparecycleJobPayments p2 = new SparecycleJobPayments(address(ethR), address(bad));
        vm.prank(alice);
        p2.deposit{value: 1 ether}();
        (address[] memory cs, uint256[] memory as_) = _one(alice, 0.1 ether);
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPayments.TransferFailed.selector);
        p2.charge(0, cs, as_, bytes32(0));
        assertEq(p2.balanceOf(alice), 1 ether);
    }

    // ---------------------------------------------------------------- withdrawals

    function test_Withdraw_WaitsTwoEpochCloses() public {
        vm.startPrank(alice);
        pay.deposit{value: 1 ether}();
        pay.requestWithdraw(1 ether);
        vm.stopPrank();
        assertFalse(pay.canWithdraw(alice));
        vm.prank(alice);
        vm.expectRevert();
        pay.withdraw();

        _closeEmpty(ethR); // epoch 0 closed: a job from epoch 0 may still get its verdict in epoch 1
        assertFalse(pay.canWithdraw(alice));
        _closeEmpty(ethR); // epoch 1 closed
        assertTrue(pay.canWithdraw(alice));

        uint256 before = alice.balance;
        vm.prank(alice);
        pay.withdraw();
        assertEq(alice.balance - before, 1 ether);
        assertEq(pay.balanceOf(alice), 0);
        assertEq(pay.totalBalance(), 0);
        assertEq(address(pay).balance, 0);
    }

    function test_Withdraw_TimeoutWhenEpochsStop() public {
        vm.startPrank(alice);
        pay.deposit{value: 1 ether}();
        pay.requestWithdraw(0.4 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days - 1);
        assertFalse(pay.canWithdraw(alice));
        vm.warp(block.timestamp + 1);
        assertTrue(pay.canWithdraw(alice));
        vm.prank(alice);
        pay.withdraw();
        assertEq(pay.balanceOf(alice), 0.6 ether);
    }

    function test_Withdraw_PaysWhatIsLeftAfterCharges() public {
        vm.startPrank(alice);
        pay.deposit{value: 1 ether}();
        pay.requestWithdraw(1 ether);
        vm.stopPrank();
        _charge(alice, 0.3 ether); // a job submitted before the request is still charged
        _closeEmpty(ethR);
        _closeEmpty(ethR);
        uint256 before = alice.balance;
        vm.prank(alice);
        pay.withdraw();
        assertEq(alice.balance - before, 0.7 ether);
        assertEq(pay.balanceOf(alice), 0);
    }

    function test_Withdraw_RequestChecks() public {
        vm.startPrank(alice);
        vm.expectRevert(SparecycleJobPayments.ZeroAmount.selector);
        pay.requestWithdraw(0);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPayments.InsufficientBalance.selector, alice, 0, 1));
        pay.requestWithdraw(1);
        vm.expectRevert(SparecycleJobPayments.NoWithdrawRequest.selector);
        pay.withdraw();
        vm.expectRevert(SparecycleJobPayments.NoWithdrawRequest.selector);
        pay.cancelWithdraw();
        pay.deposit{value: 1 ether}();
        pay.requestWithdraw(1 ether);
        pay.cancelWithdraw();
        vm.stopPrank();
        _closeEmpty(ethR);
        _closeEmpty(ethR);
        assertFalse(pay.canWithdraw(alice));
    }

    function test_Withdraw_OnlyOwnBalance() public {
        vm.prank(alice);
        pay.deposit{value: 1 ether}();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPayments.InsufficientBalance.selector, bob, 0, 1 ether));
        pay.requestWithdraw(1 ether);
    }

    function test_Withdraw_ReentrancyBlocked() public {
        ReentrantCustomer c = new ReentrantCustomer(pay);
        c.fundAndRequest{value: 1 ether}(1 ether);
        _closeEmpty(ethR);
        _closeEmpty(ethR);
        c.pull();
        assertEq(address(c).balance, 1 ether);
        assertEq(c.reentered(), 1); // the nested withdraw() reverted
        assertEq(pay.totalBalance(), 0);
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_Accounting(uint96 dA, uint96 dB, uint96 cA, uint96 cB, uint96 wA) public {
        uint256 depA = bound(uint256(dA), 1, 50 ether);
        uint256 depB = bound(uint256(dB), 1, 50 ether);
        vm.prank(alice);
        pay.deposit{value: depA}();
        vm.prank(bob);
        pay.deposit{value: depB}();
        uint256 chA = bound(uint256(cA), 1, depA);
        uint256 chB = bound(uint256(cB), 1, depB);

        address[] memory cs = new address[](2);
        uint256[] memory as_ = new uint256[](2);
        cs[0] = alice;
        cs[1] = bob;
        as_[0] = chA;
        as_[1] = chB;
        uint64 id = ethR.currentEpoch();
        vm.prank(sched);
        pay.charge(id, cs, as_, bytes32(0));

        uint256 total = chA + chB;
        uint256 toTreasury = total * 500 / 10_000;
        assertEq(treasury.balance, toTreasury);
        assertEq(ethR.getEpoch(id).pot, total - toTreasury);
        assertEq(pay.totalBalance(), depA + depB - total);
        assertEq(address(pay).balance, pay.totalBalance());

        uint256 rem = depA - chA;
        if (rem > 0) {
            uint256 w = bound(uint256(wA), 1, rem);
            vm.prank(alice);
            pay.requestWithdraw(w);
            vm.warp(block.timestamp + 2 days);
            uint256 before = alice.balance;
            vm.prank(alice);
            pay.withdraw();
            assertEq(alice.balance - before, w);
        }
        assertEq(address(pay).balance, pay.totalBalance());
        assertEq(pay.totalBalance(), pay.balanceOf(alice) + pay.balanceOf(bob));
    }
}
