// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {V2Fixture} from "./V2Fixture.sol";
import {SparecycleJobPayments} from "../../src/SparecycleJobPayments.sol";
import {SparecycleJobPaymentsV2} from "../../src/SparecycleJobPaymentsV2.sol";
import {SparecycleBurner} from "../../src/SparecycleBurner.sol";
import {SparecycleHolderPool} from "../../src/SparecycleHolderPool.sol";
import {SpareBurn} from "../../src/libraries/SpareBurn.sol";
import {MockSpare, MockSwapAdapter, FeeOnTransferSpare, FakeBurnSpare, EthSender} from "../mocks/V2Mocks.sol";

contract RejectEthV2 {
    receive() external payable {
        revert("no");
    }
}

/// @notice Customer that tries to re-enter withdraw() when paid.
contract ReentrantCustomerV2 {
    SparecycleJobPaymentsV2 internal p;
    uint256 public reentered;

    constructor(SparecycleJobPaymentsV2 p_) {
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

contract SparecycleJobPaymentsV2Test is V2Fixture {
    // ================================================================ construction

    function test_Constructor_WiringAndDefaults() public view {
        assertEq(address(pay.rewards()), address(ethR));
        assertEq(pay.treasury(), treasury);
        assertEq(pay.burner(), address(burner));
        assertEq(pay.holderPool(), address(pool));
        assertEq(address(pay.spare()), address(spareTok));
        assertEq(address(pay.swapAdapter()), address(adapter));
        assertTrue(pay.spareHasBurn());
        (uint16 t, uint16 b, uint16 h) = pay.currentSplit();
        assertEq(t, 200, "N1 treasury");
        assertEq(b, 150, "N1 burner");
        assertEq(h, 150, "N1 holder pool");
        assertEq(uint256(t) + b + h, 500);
        assertEq(pay.SPLIT_CHANGE_DELAY_EPOCHS(), 4);
        assertEq(pay.SPARE_DISCOUNT_BPS(), 1_000, "N2");
        assertEq(pay.maxPriceDeviationBps(), 2_000, "N13");
        assertEq(pay.maxSwapSlippageBps(), 200, "N12");
        assertEq(pay.spareCapEthPerEpoch(), CAP);
        assertEq(pay.referenceSparePrice(), 0);
    }

    function test_Constructor_Rejects() public {
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAddress.selector);
        new SparecycleJobPaymentsV2(
            address(0), treasury, address(burner), alice, address(spareTok), address(adapter), 1
        );
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAddress.selector);
        new SparecycleJobPaymentsV2(
            address(ethR), address(0), address(burner), alice, address(spareTok), address(adapter), 1
        );
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.NoCode.selector, alice));
        new SparecycleJobPaymentsV2(address(ethR), treasury, address(burner), alice, alice, address(adapter), 1);
        // a token-payout reward contract is refused (node pay stays ETH)
        vm.expectRevert(SparecycleJobPaymentsV2.NotEthRewards.selector);
        new SparecycleJobPaymentsV2(
            address(tokR), treasury, address(burner), alice, address(spareTok), address(adapter), 1
        );
        // the burner was deployed for another price source (the live `pay`), not for this new contract
        vm.expectRevert(SparecycleJobPaymentsV2.BurnerMismatch.selector);
        new SparecycleJobPaymentsV2(
            address(ethR), treasury, address(burner), alice, address(spareTok), address(adapter), 1
        );
    }

    function test_HolderPoolConstructor_RequiresPaymentsPointingAtIt() public {
        vm.expectRevert(SparecycleHolderPool.WrongPayments.selector);
        new SparecycleHolderPool(address(ethR), address(pay), treasury); // pay.holderPool() is the live pool
    }

    function test_Charge_RefusesToPayAMissingHolderPool() public {
        // V2 deployed with a predicted pool address where the pool was never deployed
        uint64 n = vm.getNonce(address(this));
        address v2At = vm.computeCreateAddress(address(this), n + 1);
        address poolAt = vm.computeCreateAddress(address(this), n + 2);
        SparecycleBurner b =
            new SparecycleBurner(address(ethR), treasury, address(spareTok), address(adapter), v2At, true, 1);
        SparecycleJobPaymentsV2 p = new SparecycleJobPaymentsV2(
            address(ethR), treasury, address(b), poolAt, address(spareTok), address(adapter), 0
        );
        assertEq(poolAt.code.length, 0);
        vm.prank(alice);
        p.deposit{value: 1 ether}();
        (address[] memory cs, uint256[] memory as_) = _one(alice, 1 ether);
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPaymentsV2.HolderPoolNotDeployed.selector);
        p.charge(0, cs, as_, bytes32(0));
        assertEq(poolAt.balance, 0);
    }

    function test_EventsKeepV1Topics() public pure {
        // The receipt verifier (src/lib/job-receipt.ts) reads Charged / CustomerCharged by V1's ABI.
        assertEq(SparecycleJobPaymentsV2.Charged.selector, SparecycleJobPayments.Charged.selector);
        assertEq(SparecycleJobPaymentsV2.CustomerCharged.selector, SparecycleJobPayments.CustomerCharged.selector);
        assertEq(SparecycleJobPaymentsV2.Deposited.selector, SparecycleJobPayments.Deposited.selector);
        assertEq(SparecycleJobPaymentsV2.Withdrawn.selector, SparecycleJobPayments.Withdrawn.selector);
    }

    // ================================================================ deposits

    function test_Deposit_ReceiveAndDepositFor() public {
        _deposit(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(pay).call{value: 0.5 ether}("");
        assertTrue(ok);
        vm.expectEmit(address(pay));
        emit SparecycleJobPaymentsV2.DepositedBy(bob, alice, 0.25 ether);
        vm.prank(bob);
        pay.depositFor{value: 0.25 ether}(alice);
        assertEq(pay.balanceOf(alice), 1.75 ether);
        assertEq(pay.balanceOf(bob), 0);
        assertEq(pay.totalBalance(), 1.75 ether);
        _assertV2Accounting();
    }

    function test_DepositFor_OnlyCustomerCanWithdraw() public {
        vm.prank(bob);
        pay.depositFor{value: 1 ether}(alice);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.InsufficientBalance.selector, bob, 0, 1 ether));
        pay.requestWithdraw(1 ether);
        vm.prank(alice);
        pay.requestWithdraw(1 ether);
        vm.warp(block.timestamp + 2 days);
        uint256 before = alice.balance;
        vm.prank(alice);
        pay.withdraw();
        assertEq(alice.balance - before, 1 ether);
    }

    function test_Deposit_ZeroAndZeroAddressRevert() public {
        vm.prank(alice);
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAmount.selector);
        pay.deposit{value: 0}();
        vm.prank(alice);
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAddress.selector);
        pay.depositFor{value: 1}(address(0));
    }

    // ================================================================ credits (N20, N21)

    function _credit(address c, uint256 a) internal {
        vm.deal(address(pool), address(pool).balance + a);
        vm.prank(address(pool));
        pay.creditFor{value: a}(c);
    }

    function test_CreditFor_OnlyHolderPool() public {
        address[4] memory callers = [stranger, sched, treasury, alice];
        for (uint256 i; i < callers.length; ++i) {
            vm.deal(callers[i], 1 ether);
            vm.prank(callers[i]);
            vm.expectRevert(SparecycleJobPaymentsV2.NotHolderPool.selector);
            pay.creditFor{value: 1 ether}(alice);
        }
        _credit(alice, 1 ether);
        assertEq(pay.creditOf(alice), 1 ether);
        assertEq(pay.totalCredits(), 1 ether);
        assertEq(pay.balanceOf(alice), 0, "credits are not a withdrawable balance");
        _assertV2Accounting();
    }

    function test_CreditFor_ZeroChecks() public {
        vm.prank(address(pool));
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAmount.selector);
        pay.creditFor{value: 0}(alice);
        vm.deal(address(pool), 1);
        vm.prank(address(pool));
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAddress.selector);
        pay.creditFor{value: 1}(address(0));
    }

    function test_Credits_CannotBeWithdrawn() public {
        _credit(alice, 1 ether);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.InsufficientBalance.selector, alice, 0, 1));
        pay.requestWithdraw(1);
        pay.deposit{value: 0.4 ether}();
        vm.expectRevert(
            abi.encodeWithSelector(
                SparecycleJobPaymentsV2.InsufficientBalance.selector, alice, 0.4 ether, 0.4 ether + 1
            )
        );
        pay.requestWithdraw(0.4 ether + 1);
        pay.requestWithdraw(0.4 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days);
        uint256 before = alice.balance;
        vm.prank(alice);
        pay.withdraw();
        assertEq(alice.balance - before, 0.4 ether, "only the deposit leaves");
        assertEq(pay.creditOf(alice), 1 ether, "credits stay");
        _assertV2Accounting();
    }

    function test_Charge_SpendsCreditsFirst() public {
        _deposit(alice, 1 ether);
        _credit(alice, 0.3 ether);
        uint64 id = _open();
        vm.expectEmit(address(pay));
        emit SparecycleJobPaymentsV2.CustomerCharged(id, alice, 0.5 ether);
        vm.expectEmit(address(pay));
        emit SparecycleJobPaymentsV2.CreditsSpent(id, alice, 0.3 ether);
        _charge(alice, 0.5 ether);
        assertEq(pay.creditOf(alice), 0, "credits used first");
        assertEq(pay.balanceOf(alice), 0.8 ether, "then 0.2 from the deposit");
        assertEq(pay.totalCredits(), 0);
        assertEq(pay.totalBalance(), 0.8 ether);
        _assertV2Accounting();
    }

    function test_Charge_CreditsAlonePayForAJob() public {
        _credit(alice, 1 ether);
        uint64 id = _open();
        uint256 potBefore = ethR.getEpoch(id).pot;
        _charge(alice, 0.6 ether);
        assertEq(pay.creditOf(alice), 0.4 ether);
        assertEq(ethR.getEpoch(id).pot - potBefore, 0.57 ether, "95% of a credit-paid job reaches the pot");
        _assertV2Accounting();
    }

    function test_Charge_CreditsPlusDepositInsufficient() public {
        _deposit(alice, 0.2 ether);
        _credit(alice, 0.3 ether);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 0.5 ether + 1);
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(
                SparecycleJobPaymentsV2.InsufficientBalance.selector, alice, 0.5 ether, 0.5 ether + 1
            )
        );
        pay.charge(0, cs, as_, bytes32(0));
    }

    // ================================================================ ETH charges and the split

    function test_Charge_SplitsFeeThreeWays() public {
        _deposit(alice, 2 ether);
        uint64 id = _open();
        bytes32 lh = keccak256("v2-jobs-root");
        (address[] memory cs, uint256[] memory as_) = _one(alice, 1 ether);
        vm.expectEmit(address(pay));
        emit SparecycleJobPaymentsV2.Charged(id, lh, 1 ether, 0.95 ether, 0.05 ether);
        vm.expectEmit(address(pay));
        emit SparecycleJobPaymentsV2.Distributed(id, lh, 0.95 ether, 0.02 ether, 0.015 ether, 0.015 ether, 0);
        vm.prank(sched);
        pay.charge(id, cs, as_, lh);

        assertEq(ethR.getEpoch(id).pot, 0.95 ether, "95% to the node pot");
        assertEq(treasury.balance, 0.02 ether, "N1 treasury 200 bps");
        assertEq(address(burner).balance, 0.015 ether, "N1 burner 150 bps");
        assertEq(address(pool).balance, 0.015 ether, "N1 holder pool 150 bps");
        assertEq(pay.balanceOf(alice), 1 ether);
        _assertV2Accounting();
    }

    function test_Charge_OnlySchedulerAndFollowsRotation() public {
        _deposit(alice, 1 ether);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 0.1 ether);
        address[3] memory bad = [stranger, admin, treasury];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(SparecycleJobPaymentsV2.NotScheduler.selector);
            pay.charge(0, cs, as_, bytes32(0));
        }
        address next = makeAddr("nextScheduler");
        vm.prank(admin);
        ethR.setScheduler(next);
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPaymentsV2.NotScheduler.selector);
        pay.charge(0, cs, as_, bytes32(0));
        vm.prank(next);
        pay.charge(0, cs, as_, bytes32(0));
        assertEq(pay.balanceOf(alice), 0.9 ether);
    }

    function test_Charge_OnlyOpenEpoch() public {
        _deposit(alice, 1 ether);
        _closeEmpty(ethR);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 0.1 ether);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.WrongEpoch.selector, uint64(0), uint64(1)));
        pay.charge(0, cs, as_, bytes32(0));
    }

    function test_Charge_InputChecks() public {
        address[] memory cs = new address[](2);
        uint256[] memory as_ = new uint256[](1);
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPaymentsV2.LengthMismatch.selector);
        pay.charge(0, cs, as_, bytes32(0));
        (address[] memory e1, uint256[] memory e2) = _none();
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPaymentsV2.LengthMismatch.selector);
        pay.charge(0, e1, e2, bytes32(0));
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPaymentsV2.LengthMismatch.selector);
        pay.chargeWithSpare(0, e1, e2, e1, e2, 0, bytes32(0));
        (address[] memory c1, uint256[] memory a1) = _one(alice, 0);
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAmount.selector);
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
            abi.encodeWithSelector(SparecycleJobPaymentsV2.SpendLimitExceeded.selector, alice, 0.3 ether, 0.4 ether)
        );
        pay.charge(0, cs, as_, bytes32(0));
        _closeEmpty(ethR);
        _charge(alice, 0.3 ether);
        assertEq(pay.balanceOf(alice), 0.5 ether);
    }

    function test_Charge_RecipientRejectingEthRevertsWholeCharge() public {
        // a treasury that rejects ETH: nothing moves (same as V1)
        RejectEthV2 bad = new RejectEthV2();
        address saved = treasury;
        treasury = address(bad);
        (, SparecycleJobPaymentsV2 p2,) = _deploySystem(address(spareTok), address(adapter), true);
        treasury = saved;
        vm.prank(alice);
        p2.deposit{value: 1 ether}();
        (address[] memory cs, uint256[] memory as_) = _one(alice, 0.1 ether);
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPaymentsV2.TransferFailed.selector);
        p2.charge(0, cs, as_, bytes32(0));
        assertEq(p2.balanceOf(alice), 1 ether);
    }

    function testFuzz_Charge_SplitConserves(uint96 amount, uint16 tSeed, uint16 bSeed) public {
        uint256 a = bound(uint256(amount), 1, 500 ether);
        uint16 t = uint16(bound(tSeed, 0, 500));
        uint16 b = uint16(bound(bSeed, 0, 500 - t));
        uint16 h = 500 - t - b;
        vm.prank(treasury);
        pay.proposeSplit(t, b, h);
        for (uint256 i; i < 4; ++i) {
            _closeEmpty(ethR);
        }
        vm.deal(alice, a);
        _deposit(alice, a);
        uint64 id = _open();
        uint256 potBefore = ethR.getEpoch(id).pot;
        _charge(alice, a);
        uint256 toPot = ethR.getEpoch(id).pot - potBefore;
        assertEq(toPot + treasury.balance + address(burner).balance + address(pool).balance, a, "conserved");
        assertGe(toPot * BPS, a * 9_500, "pot >= 95%");
        assertEq(address(burner).balance, a * b / BPS);
        assertEq(address(pool).balance, a * h / BPS);
        _assertV2Accounting();
    }

    // ================================================================ split changes (N1)

    function test_Split_OnlyTreasuryAndSumsTo500() public {
        address[2] memory bad = [sched, stranger];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(bad[i]);
            vm.expectRevert(SparecycleJobPaymentsV2.NotTreasury.selector);
            pay.proposeSplit(300, 100, 100);
        }
        vm.startPrank(treasury);
        vm.expectRevert(SparecycleJobPaymentsV2.BadSplit.selector);
        pay.proposeSplit(300, 100, 99);
        vm.expectRevert(SparecycleJobPaymentsV2.BadSplit.selector);
        pay.proposeSplit(300, 100, 101);
        vm.expectRevert(SparecycleJobPaymentsV2.BadSplit.selector);
        pay.proposeSplit(type(uint16).max, 0, 0);
        pay.proposeSplit(500, 0, 0);
        vm.stopPrank();
    }

    function test_Split_TakesEffectAfterFourEpochs() public {
        uint64 start = _open();
        vm.expectEmit(address(pay));
        emit SparecycleJobPaymentsV2.SplitProposed(100, 300, 100, start + 4);
        vm.prank(treasury);
        pay.proposeSplit(100, 300, 100);

        _deposit(alice, 10 ether);
        for (uint256 i; i < 4; ++i) {
            (uint16 t,,) = pay.currentSplit();
            assertEq(t, 200, "old split before the delay");
            uint256 tb = treasury.balance;
            _charge(alice, 1 ether);
            assertEq(treasury.balance - tb, 0.02 ether, "old split charged");
            _closeEmpty(ethR);
        }
        assertEq(_open(), start + 4);
        (uint16 t2, uint16 b2, uint16 h2) = pay.currentSplit();
        assertEq(t2, 100);
        assertEq(b2, 300);
        assertEq(h2, 100);
        uint256 tb2 = treasury.balance;
        uint256 bb2 = address(burner).balance;
        _charge(alice, 1 ether);
        assertEq(treasury.balance - tb2, 0.01 ether);
        assertEq(address(burner).balance - bb2, 0.03 ether);
        (,,, uint64 eff) = pay.pendingSplit();
        assertEq(eff, 0, "applied");
    }

    function test_Split_CancelAndReproposeRestartsDelay() public {
        vm.prank(treasury);
        pay.proposeSplit(0, 500, 0);
        _closeEmpty(ethR);
        _closeEmpty(ethR);
        vm.prank(treasury);
        pay.cancelSplit();
        (,,, uint64 eff) = pay.pendingSplit();
        assertEq(eff, 0);
        vm.prank(treasury);
        vm.expectRevert(SparecycleJobPaymentsV2.NoPendingSplit.selector);
        pay.cancelSplit();

        vm.prank(treasury);
        pay.proposeSplit(0, 500, 0); // at epoch 2
        _closeEmpty(ethR);
        _closeEmpty(ethR);
        vm.prank(treasury);
        pay.proposeSplit(0, 0, 500); // replaces it at epoch 4: due at 8, not 6
        (,,, eff) = pay.pendingSplit();
        assertEq(eff, 8);
        _closeEmpty(ethR);
        _closeEmpty(ethR);
        (uint16 t,,) = pay.currentSplit();
        assertEq(t, 200, "still the default at epoch 6");
    }

    function testFuzz_Split_NeverBeforeFourEpochs(uint8 closesBefore, uint8 closesAfter) public {
        uint256 cb = bound(closesBefore, 0, 6);
        for (uint256 i; i < cb; ++i) {
            _closeEmpty(ethR);
        }
        uint64 proposedAt = _open();
        vm.prank(treasury);
        pay.proposeSplit(500, 0, 0);
        uint256 ca = bound(closesAfter, 0, 8);
        for (uint256 i; i < ca; ++i) {
            _closeEmpty(ethR);
        }
        (uint16 t,,) = pay.currentSplit();
        if (_open() < proposedAt + 4) assertEq(t, 200, "unchanged before 4 epochs");
        else assertEq(t, 500, "applies from proposal epoch + 4");
    }

    // ================================================================ withdrawals (same rules as V1)

    function test_Withdraw_WaitsTwoEpochClosesOrTimeout() public {
        vm.startPrank(alice);
        pay.deposit{value: 1 ether}();
        pay.requestWithdraw(1 ether);
        vm.stopPrank();
        assertFalse(pay.canWithdraw(alice));
        _closeEmpty(ethR);
        assertFalse(pay.canWithdraw(alice));
        _closeEmpty(ethR);
        assertTrue(pay.canWithdraw(alice));

        vm.startPrank(bob);
        pay.deposit{value: 1 ether}();
        pay.requestWithdraw(0.4 ether);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days - 1);
        assertFalse(pay.canWithdraw(bob));
        vm.warp(block.timestamp + 1);
        assertTrue(pay.canWithdraw(bob));
    }

    function test_Withdraw_PaysWhatIsLeftAfterCharges() public {
        vm.startPrank(alice);
        pay.deposit{value: 1 ether}();
        pay.requestWithdraw(1 ether);
        vm.stopPrank();
        _charge(alice, 0.3 ether);
        _closeEmpty(ethR);
        _closeEmpty(ethR);
        uint256 before = alice.balance;
        vm.prank(alice);
        pay.withdraw();
        assertEq(alice.balance - before, 0.7 ether);
        _assertV2Accounting();
    }

    function test_Withdraw_RequestChecks() public {
        vm.startPrank(alice);
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAmount.selector);
        pay.requestWithdraw(0);
        vm.expectRevert(SparecycleJobPaymentsV2.NoWithdrawRequest.selector);
        pay.withdraw();
        vm.expectRevert(SparecycleJobPaymentsV2.NoWithdrawRequest.selector);
        pay.cancelWithdraw();
        pay.deposit{value: 1 ether}();
        pay.requestWithdraw(1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(
                SparecycleJobPaymentsV2.WithdrawLocked.selector, uint64(0), uint64(2), uint64(T0 + 2 days)
            )
        );
        pay.withdraw();
        pay.cancelWithdraw();
        vm.stopPrank();
    }

    function test_Withdraw_ReentrancyBlocked() public {
        ReentrantCustomerV2 c = new ReentrantCustomerV2(pay);
        c.fundAndRequest{value: 1 ether}(1 ether);
        _closeEmpty(ethR);
        _closeEmpty(ethR);
        c.pull();
        assertEq(address(c).balance, 1 ether);
        assertEq(c.reentered(), 1, "nested withdraw reverted");
        assertEq(pay.totalBalance(), 0);
    }

    // ================================================================ SPARE balance

    function test_Spare_DepositAndTwoStepWithdraw() public {
        _spareDeposit(alice, 1_000 ether);
        assertEq(pay.spareBalanceOf(alice), 1_000 ether);
        vm.prank(alice);
        pay.requestWithdrawSpare(600 ether);
        assertFalse(pay.canWithdrawSpare(alice));
        vm.prank(alice);
        vm.expectRevert();
        pay.withdrawSpare();
        _closeEmpty(ethR);
        _closeEmpty(ethR);
        vm.prank(alice);
        pay.withdrawSpare();
        assertEq(spareTok.balanceOf(alice), 600 ether);
        assertEq(pay.spareBalanceOf(alice), 400 ether);
        _assertV2Accounting();
    }

    function test_Spare_RequestChecks() public {
        vm.startPrank(alice);
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAmount.selector);
        pay.requestWithdrawSpare(0);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.InsufficientSpareBalance.selector, alice, 0, 1));
        pay.requestWithdrawSpare(1);
        vm.expectRevert(SparecycleJobPaymentsV2.NoWithdrawRequest.selector);
        pay.cancelWithdrawSpare();
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAmount.selector);
        pay.depositSpare(0);
        vm.stopPrank();
    }

    function test_Spare_FeeOnTransferCreditsWhatArrived() public {
        FeeOnTransferSpare fot = new FeeOnTransferSpare();
        MockSwapAdapter ad = new MockSwapAdapter(IERC20(address(fot)), PRICE);
        (, SparecycleJobPaymentsV2 p2,) = _deploySystem(address(fot), address(ad), false);
        fot.mint(alice, 100 ether);
        vm.startPrank(alice);
        fot.approve(address(p2), 100 ether);
        p2.depositSpare(100 ether);
        vm.stopPrank();
        assertEq(p2.spareBalanceOf(alice), 99 ether, "1% fee not credited");
        assertEq(fot.balanceOf(address(p2)), p2.totalSpareBalance());
    }

    // ================================================================ SPARE price (N13)

    function test_Price_PostRules() public {
        vm.prank(stranger);
        vm.expectRevert(SparecycleJobPaymentsV2.NotScheduler.selector);
        pay.postSparePrice(0, PRICE);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.WrongEpoch.selector, uint64(1), uint64(0)));
        pay.postSparePrice(1, PRICE);
        vm.prank(sched);
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAmount.selector);
        pay.postSparePrice(0, 0);
        _anchorAndPost(PRICE);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.PriceAlreadyPosted.selector, uint64(0)));
        pay.postSparePrice(0, PRICE);
        assertEq(pay.acceptedSparePrice(0), PRICE);
    }

    function test_Price_NoReferenceMeansPaused() public {
        _post(PRICE); // the Safe never anchored a reference
        SparecycleJobPaymentsV2.EpochPrice memory p = pay.sparePriceOf(0);
        assertTrue(p.posted);
        assertFalse(p.accepted);
        assertEq(pay.acceptedSparePrice(0), 0);
    }

    function test_Price_BandEdges() public {
        vm.prank(treasury);
        pay.setReferenceSparePrice(PRICE);
        _post(PRICE * 12 / 10); // exactly +20%
        assertEq(pay.acceptedSparePrice(0), PRICE * 12 / 10, "+20% accepted");
        assertEq(pay.referenceSparePrice(), PRICE * 12 / 10, "becomes the reference");
        _closeEmpty(ethR);
        uint256 ref = PRICE * 12 / 10;
        _post(ref * 8 / 10 - 1); // just over -20%
        assertEq(pay.acceptedSparePrice(1), 0, "outside the band");
        assertEq(pay.referenceSparePrice(), ref, "reference unchanged");
    }

    /// @notice Brief 5: a price move larger than the deviation limit pauses SPARE charges for that epoch, and ETH
    ///         charges still go through.
    function test_Price_DeviationPausesSpareButNotEth() public {
        _deposit(alice, 20 ether);
        _spareDeposit(bob, 1_000_000 ether);
        _anchorAndPost(PRICE);
        _chargeSpare(alice, 5 ether, bob, 1 ether); // epoch 0 works
        _closeEmpty(ethR);

        _post(PRICE * 13 / 10); // +30% in epoch 1
        assertEq(pay.acceptedSparePrice(1), 0);
        (SparecycleJobPaymentsV2.SpareStatus st,,,,) = pay.previewSpareLeg(1, 5 ether, 1 ether, 1 ether);
        assertEq(uint256(st), uint256(SparecycleJobPaymentsV2.SpareStatus.Paused));
        (address[] memory cs, uint256[] memory as_) = _one(alice, 1 ether);
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.SpareChargesPaused.selector, uint64(1)));
        pay.chargeWithSpare(1, cs, as_, ss, sa, 1 ether, bytes32(0));

        uint256 spareBefore = pay.spareBalanceOf(bob);
        uint256 potBefore = ethR.getEpoch(1).pot;
        _charge(alice, 1 ether); // ETH still charges in the paused epoch
        assertEq(ethR.getEpoch(1).pot - potBefore, 0.95 ether);
        assertEq(pay.spareBalanceOf(bob), spareBefore, "no SPARE taken");
        // an ETH-only chargeWithSpare call also works while SPARE is paused
        (address[] memory e1, uint256[] memory e2) = _none();
        vm.prank(sched);
        pay.chargeWithSpare(1, cs, as_, e1, e2, 0, bytes32(0));

        _closeEmpty(ethR);
        _post(PRICE * 11 / 10); // epoch 2: back inside the band of the old reference
        adapter.setPrice(PRICE * 11 / 10);
        _chargeSpare(alice, 5 ether, bob, 1 ether);
        assertLt(pay.spareBalanceOf(bob), spareBefore);
    }

    function test_Price_SafeReanchorsAfterRealMove() public {
        vm.prank(treasury);
        pay.setReferenceSparePrice(PRICE);
        _post(PRICE * 2);
        assertEq(pay.acceptedSparePrice(0), 0);
        _closeEmpty(ethR);
        vm.prank(treasury);
        pay.setReferenceSparePrice(PRICE * 2);
        _post(PRICE * 2);
        assertEq(pay.acceptedSparePrice(1), PRICE * 2);
    }

    function test_Price_SafeSettersAndBounds() public {
        vm.startPrank(treasury);
        vm.expectRevert(SparecycleJobPaymentsV2.OutOfRange.selector);
        pay.setMaxPriceDeviationBps(0);
        vm.expectRevert(SparecycleJobPaymentsV2.OutOfRange.selector);
        pay.setMaxPriceDeviationBps(5_001);
        pay.setMaxPriceDeviationBps(1_000);
        vm.expectRevert(SparecycleJobPaymentsV2.OutOfRange.selector);
        pay.setMaxSwapSlippageBps(1_001);
        pay.setMaxSwapSlippageBps(100);
        pay.setSpareCapEthPerEpoch(5 ether);
        vm.expectRevert(SparecycleJobPaymentsV2.ZeroAmount.selector);
        pay.setReferenceSparePrice(0);
        vm.stopPrank();
        assertEq(pay.maxPriceDeviationBps(), 1_000);
        assertEq(pay.maxSwapSlippageBps(), 100);
        assertEq(pay.spareCapEthPerEpoch(), 5 ether);
        vm.startPrank(sched);
        vm.expectRevert(SparecycleJobPaymentsV2.NotTreasury.selector);
        pay.setMaxPriceDeviationBps(1_000);
        vm.expectRevert(SparecycleJobPaymentsV2.NotTreasury.selector);
        pay.setSpareCapEthPerEpoch(1);
        vm.expectRevert(SparecycleJobPaymentsV2.NotTreasury.selector);
        pay.setReferenceSparePrice(1);
        vm.stopPrank();
    }

    // ================================================================ SPARE-paid charges (brief 5)

    /// @notice Brief 5: a SPARE-paid agreed job gives the node pot at least the ETH an ETH-paid job of the same size
    ///         gives (here exactly 95%), the discount coming out of the treasury share.
    function test_Spare_PotGetsWhatAnEthJobGives() public {
        _deposit(alice, 10 ether);
        _spareDeposit(bob, 1_000_000 ether);
        _anchorAndPost(PRICE);
        uint64 id = _open();

        // reference: an ETH-paid job of 1 ETH gives the pot 0.95 ETH
        uint256 p0 = ethR.getEpoch(id).pot;
        _charge(alice, 1 ether);
        uint256 ethJobPot = ethR.getEpoch(id).pot - p0;
        assertEq(ethJobPot, 0.95 ether);

        uint256 owed = pay.spareOwed(id, 1 ether);
        assertEq(owed, 9_000 ether, "1 ETH at 0.0001 ETH/SPARE with 10% off = 9,000 SPARE");
        uint256 supply0 = spareTok.totalSupply();
        uint256 t0 = treasury.balance;
        uint256 p1 = ethR.getEpoch(id).pot;
        _chargeSpare(alice, 5 ether, bob, 1 ether);
        uint256 potIn = ethR.getEpoch(id).pot - p1;

        assertEq(potIn, 4.75 ether + ethJobPot, "ETH leg 95% + SPARE leg exactly an ETH job's pot share");
        assertEq(pay.spareBalanceOf(bob), 1_000_000 ether - 9_000 ether);
        uint256 burned = 9_000 ether * 150 / BPS; // N2b: the burner part of the split, on the discounted value
        assertEq(supply0 - spareTok.totalSupply(), burned, "SPARE burned directly");
        // sale: 8,865 SPARE -> 0.8865 ETH; shortfall 0.0635 ETH from the ETH leg's treasury part (0.1 ETH)
        assertEq(treasury.balance - t0, 0.1 ether - 0.0635 ether);
        assertEq(spareTok.allowance(address(pay), address(adapter)), 0, "no allowance left");
        _assertV2Accounting();
    }

    /// @notice Brief 5 acceptance with a moved pool price (mocked; the fork variant needs a real v4 adapter).
    function test_Spare_MovedPoolPriceStillPaysThePot() public {
        _deposit(alice, 10 ether);
        _spareDeposit(bob, 1_000_000 ether);
        _anchorAndPost(PRICE);
        adapter.setPrice(PRICE * 99 / 100); // the pool moved 1% down after the price was posted (inside slippage)
        uint64 id = _open();
        uint256 p1 = ethR.getEpoch(id).pot;
        _chargeSpare(alice, 5 ether, bob, 1 ether);
        assertEq(ethR.getEpoch(id).pot - p1, 4.75 ether + 0.95 ether, "pot unchanged by the move");

        adapter.setPrice(PRICE * 97 / 100); // 3% down: below the 2% slippage floor -> the adapter cannot fill
        (address[] memory cs, uint256[] memory as_) = _one(alice, 5 ether);
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        uint256 floor = _floor(1 ether);
        vm.prank(sched);
        vm.expectRevert(bytes("adapter: min out"));
        pay.chargeWithSpare(id, cs, as_, ss, sa, floor, bytes32(0));
    }

    function test_Spare_SurplusGoesToTreasury() public {
        _spareDeposit(bob, 1_000_000 ether);
        _anchorAndPost(PRICE);
        adapter.setPrice(PRICE * 12 / 10);
        uint64 id = _open();
        // sale value at the posted price is 0.8865 ETH; the adapter pays 1.0638 ETH; the pot needs 0.95
        _chargeSpareMin(alice, 0, bob, 1 ether, 0.95 ether);
        assertEq(ethR.getEpoch(id).pot, 0.95 ether);
        assertEq(treasury.balance, 1.0638 ether - 0.95 ether, "surplus to the treasury");
        assertEq(address(burner).balance, 0, "no ETH leg, no ETH burner part");
        _assertV2Accounting();
    }

    function test_Spare_ShortfallOrder_TreasuryThenReserveThenBurner() public {
        _deposit(alice, 10 ether);
        _spareDeposit(bob, 1_000_000 ether);
        _anchorAndPost(PRICE);
        vm.prank(funder); // anyone may fund the reserve
        pay.fundDiscountReserve{value: 0.03 ether}();
        uint64 id = _open();
        // ETH leg 1 ETH: treasury 0.02, burner 0.015, holder 0.015. Shortfall 0.0635:
        // 0.02 from the treasury part, 0.03 from the reserve, 0.0135 from the burner part.
        vm.expectEmit(address(pay));
        emit SparecycleJobPaymentsV2.Distributed(
            id, keccak256("spare-list"), 0.95 ether + 0.95 ether, 0, 0.0015 ether, 0.015 ether, 0.03 ether
        );
        _chargeSpareMin(alice, 1 ether, bob, 1 ether, 0.8865 ether);
        assertEq(treasury.balance, 0);
        assertEq(pay.discountReserve(), 0);
        assertEq(address(burner).balance, 0.0015 ether);
        assertEq(address(pool).balance, 0.015 ether, "the holder part is never used for the discount");
        assertEq(ethR.getEpoch(id).pot, 1.9 ether);
        _assertV2Accounting();
    }

    function test_Spare_NotCoveredIsDeferredNotUnderpaid() public {
        _spareDeposit(bob, 1_000_000 ether);
        _anchorAndPost(PRICE);
        uint64 id = _open();
        (SparecycleJobPaymentsV2.SpareStatus st,, uint256 floor, uint256 req, uint256 cover) =
            pay.previewSpareLeg(id, 0, 1 ether, _floor(1 ether));
        assertEq(uint256(st), uint256(SparecycleJobPaymentsV2.SpareStatus.ShortfallNotCovered));
        assertEq(req, 0.95 ether);
        assertEq(cover, 0);
        (address[] memory e1, uint256[] memory e2) = _none();
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(SparecycleJobPaymentsV2.SpareShortfallNotCovered.selector, 0.95 ether, floor, 0)
        );
        pay.chargeWithSpare(id, e1, e2, ss, sa, floor, bytes32(0));
        assertEq(pay.spareBalanceOf(bob), 1_000_000 ether, "nothing taken");
        assertEq(ethR.getEpoch(id).pot, 0, "and nothing underpaid");

        // the Safe funds the reserve: the same SPARE-only charge now goes through
        vm.prank(funder);
        pay.fundDiscountReserve{value: 0.1 ether}();
        _chargeSpare(alice, 0, bob, 1 ether);
        assertEq(ethR.getEpoch(id).pot, 0.95 ether);
        assertEq(pay.discountReserve(), 0.1 ether - 0.0635 ether);
        _assertV2Accounting();
    }

    function test_Spare_MinOutFloor() public {
        _deposit(alice, 10 ether);
        _spareDeposit(bob, 1_000_000 ether);
        _anchorAndPost(PRICE);
        uint256 floor = _floor(1 ether);
        assertEq(floor, 0.8865 ether * 98 / 100, "sale value minus 2% (N12)");
        (address[] memory cs, uint256[] memory as_) = _one(alice, 5 ether);
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.MinOutTooLow.selector, floor - 1, floor));
        pay.chargeWithSpare(0, cs, as_, ss, sa, floor - 1, bytes32(0));
    }

    function test_Spare_CapPerEpoch() public {
        _deposit(alice, 1_000 ether);
        _spareDeposit(bob, 100_000_000 ether);
        _anchorAndPost(PRICE);
        vm.prank(treasury);
        pay.setSpareCapEthPerEpoch(2 ether);
        _chargeSpare(alice, 10 ether, bob, 1.5 ether);
        assertEq(pay.spareEthChargedInEpoch(0), 1.5 ether);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 10 ether);
        (address[] memory ss, uint256[] memory sa) = _one(bob, 0.6 ether);
        uint256 floor = _floor(0.6 ether);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.SpareCapExceeded.selector, 2 ether, 2.1 ether));
        pay.chargeWithSpare(0, cs, as_, ss, sa, floor, bytes32(0));
        // next epoch the cap starts again
        _closeEmpty(ethR);
        _post(PRICE);
        _chargeSpare(alice, 10 ether, bob, 2 ether);
        // cap 0 stops SPARE charges
        vm.prank(treasury);
        pay.setSpareCapEthPerEpoch(0);
        _closeEmpty(ethR);
        _post(PRICE);
        (SparecycleJobPaymentsV2.SpareStatus st,,,,) = pay.previewSpareLeg(2, 10 ether, 1, 1 ether);
        assertEq(uint256(st), uint256(SparecycleJobPaymentsV2.SpareStatus.CapExceeded));
    }

    function test_Spare_NoPricePosted() public {
        _spareDeposit(bob, 1_000_000 ether);
        (address[] memory e1, uint256[] memory e2) = _none();
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.SparePriceNotPosted.selector, uint64(0)));
        pay.chargeWithSpare(0, e1, e2, ss, sa, 1 ether, bytes32(0));
    }

    function test_Spare_CustomerChecks() public {
        _deposit(alice, 10 ether);
        _spareDeposit(bob, 1_000 ether); // far too little for a 1 ETH job (9,000 SPARE)
        _anchorAndPost(PRICE);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 5 ether);
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(
                SparecycleJobPaymentsV2.InsufficientSpareBalance.selector, bob, 1_000 ether, 9_000 ether
            )
        );
        pay.chargeWithSpare(0, cs, as_, ss, sa, 1 ether, bytes32(0));

        _spareDeposit(bob, 100_000 ether);
        vm.prank(bob);
        pay.setSpareSpendLimit(5_000 ether);
        uint256 floor = _floor(1 ether);
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(
                SparecycleJobPaymentsV2.SpareSpendLimitExceeded.selector, bob, 5_000 ether, 9_000 ether
            )
        );
        pay.chargeWithSpare(0, cs, as_, ss, sa, floor, bytes32(0));

        vm.startPrank(bob);
        pay.setSpareSpendLimit(0);
        pay.setSpendLimit(0.5 ether); // ETH-value limit counts the discounted value: 0.9 ETH
        vm.stopPrank();
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(SparecycleJobPaymentsV2.SpendLimitExceeded.selector, bob, 0.5 ether, 0.9 ether)
        );
        pay.chargeWithSpare(0, cs, as_, ss, sa, floor, bytes32(0));
    }

    function test_Spare_BurnToDeadWhenNoBurnFunction() public {
        MockSpare tok = new MockSpare();
        MockSwapAdapter ad = new MockSwapAdapter(IERC20(address(tok)), PRICE);
        vm.deal(address(ad), 100 ether);
        (, SparecycleJobPaymentsV2 p2,) = _deploySystem(address(tok), address(ad), false);
        assertFalse(p2.spareHasBurn());
        tok.mint(bob, 1_000_000 ether);
        vm.startPrank(bob);
        tok.approve(address(p2), type(uint256).max);
        p2.depositSpare(1_000_000 ether);
        vm.stopPrank();
        vm.prank(alice);
        p2.deposit{value: 10 ether}();
        vm.prank(treasury);
        p2.setReferenceSparePrice(PRICE);
        vm.prank(sched);
        p2.postSparePrice(0, PRICE);
        uint256 supply = tok.totalSupply();
        (address[] memory cs, uint256[] memory as_) = _one(alice, 5 ether);
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        vm.prank(sched);
        p2.chargeWithSpare(0, cs, as_, ss, sa, 0.8865 ether, bytes32(0));
        assertEq(tok.balanceOf(SpareBurn.DEAD), 135 ether, "sent to 0x...dEaD");
        assertEq(tok.totalSupply(), supply, "supply unchanged in dead mode");
    }

    function test_Spare_FeeOnTransferSaleAndBurnKeepAccounting() public {
        FeeOnTransferSpare fot = new FeeOnTransferSpare();
        MockSwapAdapter ad = new MockSwapAdapter(IERC20(address(fot)), PRICE);
        vm.deal(address(ad), 100 ether);
        (, SparecycleJobPaymentsV2 p2,) = _deploySystem(address(fot), address(ad), false);
        fot.mint(bob, 2_000_000 ether);
        vm.startPrank(bob);
        fot.approve(address(p2), type(uint256).max);
        p2.depositSpare(2_000_000 ether);
        vm.stopPrank();
        vm.prank(alice);
        p2.deposit{value: 10 ether}();
        vm.prank(treasury);
        p2.setReferenceSparePrice(PRICE);
        vm.prank(sched);
        p2.postSparePrice(0, PRICE);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 5 ether);
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        // the adapter receives 1% less SPARE than V2 sends and pays for what it received
        uint256 minOut = 0.8865 ether * 99 / 100;
        vm.prank(sched);
        p2.chargeWithSpare(0, cs, as_, ss, sa, minOut, bytes32(0));
        assertEq(fot.balanceOf(address(p2)), p2.totalSpareBalance(), "V2 lost exactly what it debited");
        assertGe(ethR.getEpoch(0).pot, 4.75 ether + 0.95 ether, "pot still whole");
    }

    function test_Spare_FakeBurnFunctionIsCaught() public {
        FakeBurnSpare fake = new FakeBurnSpare();
        MockSwapAdapter ad = new MockSwapAdapter(IERC20(address(fake)), PRICE);
        vm.deal(address(ad), 100 ether);
        (, SparecycleJobPaymentsV2 p2,) = _deploySystem(address(fake), address(ad), true);
        fake.mint(bob, 1_000_000 ether);
        vm.startPrank(bob);
        fake.approve(address(p2), type(uint256).max);
        p2.depositSpare(1_000_000 ether);
        vm.stopPrank();
        vm.prank(alice);
        p2.deposit{value: 10 ether}();
        vm.prank(treasury);
        p2.setReferenceSparePrice(PRICE);
        vm.prank(sched);
        p2.postSparePrice(0, PRICE);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 5 ether);
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SpareBurn.BurnMismatch.selector, 135 ether, 0));
        p2.chargeWithSpare(0, cs, as_, ss, sa, 0.8865 ether, bytes32(0));
    }

    // ================================================================ adapter misbehaviour and reentrancy

    function _spareSetup() internal {
        _deposit(alice, 10 ether);
        _spareDeposit(bob, 1_000_000 ether);
        _anchorAndPost(PRICE);
    }

    function test_Adapter_ShortOutputCaught() public {
        _spareSetup();
        adapter.setIgnoreMinOut(true);
        adapter.setShortBps(500); // pays 5% less than the floor allows
        uint256 floor = _floor(1 ether);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 5 ether);
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(SparecycleJobPaymentsV2.SwapOutputTooLow.selector, 0.8865 ether * 95 / 100, floor)
        );
        pay.chargeWithSpare(0, cs, as_, ss, sa, floor, bytes32(0));
    }

    function test_Adapter_PullingLessSpareCaught() public {
        _spareSetup();
        adapter.setPullLessBy(1);
        uint256 floor = _floor(1 ether);
        (address[] memory cs, uint256[] memory as_) = _one(alice, 5 ether);
        (address[] memory ss, uint256[] memory sa) = _one(bob, 1 ether);
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(SparecycleJobPaymentsV2.SwapSpentWrongAmount.selector, 8_865 ether, 8_865 ether - 1)
        );
        pay.chargeWithSpare(0, cs, as_, ss, sa, floor, bytes32(0));
    }

    function test_Adapter_ReentrantDepositBlocked() public {
        _spareSetup();
        adapter.setHook(address(pay), abi.encodeCall(SparecycleJobPaymentsV2.deposit, ()), 1 ether);
        _chargeSpare(alice, 5 ether, bob, 1 ether);
        assertEq(adapter.hookCalls(), 1);
        assertFalse(adapter.hookOk());
        assertEq(bytes4(adapter.hookErr()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(pay.balanceOf(address(adapter)), 0, "the adapter got no deposit in the middle of a charge");
        _assertV2Accounting();
    }

    function test_Adapter_ReentrantChargeAndWithdrawBlocked() public {
        _spareSetup();
        (address[] memory cs, uint256[] memory as_) = _one(alice, 1 ether);
        adapter.setHook(address(pay), abi.encodeCall(SparecycleJobPaymentsV2.charge, (0, cs, as_, bytes32(0))), 0);
        _chargeSpare(alice, 5 ether, bob, 1 ether);
        assertEq(bytes4(adapter.hookErr()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        adapter.setHook(address(pay), abi.encodeCall(SparecycleJobPaymentsV2.withdraw, ()), 0);
        _chargeSpare(alice, 1 ether, bob, 0.1 ether);
        assertEq(bytes4(adapter.hookErr()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        _assertV2Accounting();
    }

    function test_Adapter_ThirdPartyEthDuringSwapRejected() public {
        _spareSetup();
        EthSender s = new EthSender();
        vm.deal(address(s), 1 ether);
        adapter.setHook(address(s), abi.encodeCall(EthSender.send, (address(pay), 1 ether)), 0);
        _chargeSpare(alice, 5 ether, bob, 1 ether);
        assertFalse(adapter.hookOk());
        assertEq(bytes4(adapter.hookErr()), SparecycleJobPaymentsV2.UnexpectedEth.selector);
        assertEq(address(s).balance, 1 ether);
        _assertV2Accounting();
    }

    // ================================================================ discount reserve and rescue

    function test_Reserve_FundAndWithdrawOnlyToTreasury() public {
        vm.prank(alice);
        pay.fundDiscountReserve{value: 1 ether}();
        assertEq(pay.discountReserve(), 1 ether);
        vm.prank(alice);
        vm.expectRevert(SparecycleJobPaymentsV2.NotTreasury.selector);
        pay.withdrawDiscountReserve(1 ether);
        vm.prank(treasury);
        vm.expectRevert(); // underflow
        pay.withdrawDiscountReserve(1 ether + 1);
        vm.prank(treasury);
        pay.withdrawDiscountReserve(0.4 ether);
        assertEq(treasury.balance, 0.4 ether);
        assertEq(pay.discountReserve(), 0.6 ether);
        _assertV2Accounting();
    }

    function test_RescueToken_NeverSpare() public {
        MockSpare other = new MockSpare();
        other.mint(address(pay), 5 ether);
        vm.prank(treasury);
        vm.expectRevert(SparecycleJobPaymentsV2.CannotRescueSpare.selector);
        pay.rescueToken(address(spareTok), 1);
        vm.prank(stranger);
        vm.expectRevert(SparecycleJobPaymentsV2.NotTreasury.selector);
        pay.rescueToken(address(other), 1);
        vm.prank(treasury);
        pay.rescueToken(address(other), 5 ether);
        assertEq(other.balanceOf(treasury), 5 ether);
    }

    // ================================================================ fuzz: credits never leave as cash

    function testFuzz_CreditsNeverWithdrawable(uint96 dep, uint96 cred, uint96 ch, uint96 req) public {
        uint256 d = bound(uint256(dep), 0, 50 ether);
        uint256 c = bound(uint256(cred), 1, 50 ether);
        if (d > 0) _deposit(alice, d);
        _credit(alice, c);
        uint256 charged = bound(uint256(ch), 0, d + c);
        if (charged > 0) _charge(alice, charged);
        uint256 bal = pay.balanceOf(alice);
        assertEq(bal, charged > c ? d - (charged - c) : d, "credits were spent first");
        uint256 r = bound(uint256(req), 1, type(uint96).max);
        vm.prank(alice);
        if (r > bal) {
            vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.InsufficientBalance.selector, alice, bal, r));
            pay.requestWithdraw(r);
        } else {
            pay.requestWithdraw(r);
            vm.warp(block.timestamp + 2 days);
            uint256 before = alice.balance;
            vm.prank(alice);
            pay.withdraw();
            assertLe(alice.balance - before, d, "never more than was deposited");
        }
        _assertV2Accounting();
    }
}
