// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {SparecycleX402Escrow} from "../src/SparecycleX402Escrow.sol";
import {MockPonsFeeEscrow} from "./mocks/MockPonsFeeEscrow.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MockEIP3009Token} from "./mocks/MockEIP3009.sol";

/// @notice Shared fixture: an EIP-3009 asset, an ETH-pot reward contract (forward = conversion path) and an
///         asset-pot reward contract (forward = fundToken path), one escrow on each.
abstract contract X402Fixture is Test {
    uint64 internal constant EPOCH = 1 days;
    uint64 internal constant WINDOW = 12 hours;
    uint256 internal constant PER_JOB = 1_000e6;
    uint256 internal constant TOTAL = 5_000e6;
    uint256 internal constant PER_PAYER = 4_000e6;
    uint256 internal constant T0 = 1_750_000_000;

    address internal admin = makeAddr("safe");
    address internal sched = makeAddr("scheduler");
    address internal treasury = makeAddr("treasury");
    address internal conv = makeAddr("forwardTo");
    address internal stranger = makeAddr("stranger");
    uint256 internal payerKey = 0xA11CE;
    address internal payer;

    MockEIP3009Token internal usdg;
    SparecycleRewards internal ethR;
    SparecycleRewards internal tokR;
    SparecycleX402Escrow internal esc; // pot in ETH: forward sends the pot share to `conv`
    SparecycleX402Escrow internal escT; // pot in the asset: forward funds the pot directly

    uint256 internal nonceSeq;

    function setUp() public virtual {
        vm.warp(T0);
        payer = vm.addr(payerKey);
        MockPonsFeeEscrow fees = new MockPonsFeeEscrow();
        usdg = new MockEIP3009Token("Global Dollar", "1", 6);
        ethR = new SparecycleRewards(admin, sched, address(0), address(fees), EPOCH);
        tokR = new SparecycleRewards(admin, sched, address(usdg), address(fees), EPOCH);
        esc = new SparecycleX402Escrow(admin, address(ethR), address(usdg), treasury, conv, WINDOW, [PER_JOB, TOTAL, PER_PAYER]);
        escT = new SparecycleX402Escrow(admin, address(tokR), address(usdg), treasury, conv, WINDOW, [PER_JOB, TOTAL, PER_PAYER]);
        usdg.mint(payer, 1_000_000e6);
    }

    struct Auth {
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /// @dev A TransferWithAuthorization signed by `key` for `to`.
    function _auth(uint256 key, address to, uint256 value) internal returns (Auth memory a) {
        a.value = value;
        a.validAfter = 0;
        a.validBefore = block.timestamp + 300;
        a.nonce = keccak256(abi.encode("nonce", ++nonceSeq));
        bytes32 structHash = keccak256(
            abi.encode(usdg.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), vm.addr(key), to, value, a.validAfter, a.validBefore, a.nonce)
        );
        (a.v, a.r, a.s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash)));
    }

    function _fund(SparecycleX402Escrow e, bytes32 id, uint256 amount) internal returns (Auth memory a) {
        a = _auth(payerKey, address(e), amount);
        vm.prank(sched);
        e.fund(id, payer, amount, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
    }

    function _state(SparecycleX402Escrow e, bytes32 id) internal view returns (SparecycleX402Escrow.State s) {
        (,, s,) = e.escrows(id);
    }

    function _id(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("job", i, "salt"));
    }
}

contract SparecycleX402EscrowTest is X402Fixture {
    // ------------------------------------------------------------------ construction

    function test_constructor_setsEverything() public view {
        assertEq(address(esc.rewards()), address(ethR));
        assertEq(address(esc.asset()), address(usdg));
        assertEq(esc.treasury(), treasury);
        assertEq(esc.forwardTo(), conv);
        assertEq(esc.settleWindow(), WINDOW);
        assertEq(esc.maxPerJob(), PER_JOB);
        assertEq(esc.maxTotalHeld(), TOTAL);
        assertEq(esc.maxPerPayerPerEpoch(), PER_PAYER);
        assertEq(esc.owner(), admin);
        assertFalse(esc.potPaysInAsset(), "ETH pot: forward goes to conversion");
        assertTrue(escT.potPaysInAsset(), "asset pot: forward funds the pot");
        assertEq(esc.TREASURY_BPS(), 500);
    }

    function test_constructor_rejectsBadArguments() public {
        vm.expectRevert(SparecycleX402Escrow.ZeroAddress.selector);
        new SparecycleX402Escrow(admin, address(0), address(usdg), treasury, conv, WINDOW, [PER_JOB, TOTAL, PER_PAYER]);
        vm.expectRevert(SparecycleX402Escrow.ZeroAddress.selector);
        new SparecycleX402Escrow(admin, address(ethR), address(usdg), address(0), conv, WINDOW, [PER_JOB, TOTAL, PER_PAYER]);
        vm.expectRevert(SparecycleX402Escrow.ZeroAddress.selector);
        new SparecycleX402Escrow(admin, address(ethR), address(usdg), treasury, address(0), WINDOW, [PER_JOB, TOTAL, PER_PAYER]);
        vm.expectRevert(SparecycleX402Escrow.NotAContract.selector);
        new SparecycleX402Escrow(admin, address(ethR), makeAddr("eoa"), treasury, conv, WINDOW, [PER_JOB, TOTAL, PER_PAYER]);
        vm.expectRevert(SparecycleX402Escrow.BadSettleWindow.selector);
        new SparecycleX402Escrow(admin, address(ethR), address(usdg), treasury, conv, 59 minutes, [PER_JOB, TOTAL, PER_PAYER]);
        vm.expectRevert(SparecycleX402Escrow.BadSettleWindow.selector);
        new SparecycleX402Escrow(admin, address(ethR), address(usdg), treasury, conv, 7 days + 1, [PER_JOB, TOTAL, PER_PAYER]);
        vm.expectRevert(SparecycleX402Escrow.BadCaps.selector);
        new SparecycleX402Escrow(admin, address(ethR), address(usdg), treasury, conv, WINDOW, [uint256(0), TOTAL, PER_PAYER]);
        vm.expectRevert(SparecycleX402Escrow.BadCaps.selector);
        new SparecycleX402Escrow(admin, address(ethR), address(usdg), treasury, conv, WINDOW, [PER_JOB, PER_JOB - 1, PER_PAYER]);
        vm.expectRevert(SparecycleX402Escrow.BadCaps.selector);
        new SparecycleX402Escrow(admin, address(ethR), address(usdg), treasury, conv, WINDOW, [PER_JOB, TOTAL, uint256(0)]);
    }

    // ------------------------------------------------------------------ fund

    function test_fund_pullsTheSignedPaymentIntoAHeldEscrow() public {
        Auth memory a = _auth(payerKey, address(esc), 25e6);
        vm.expectEmit(address(esc));
        emit SparecycleX402Escrow.Funded(_id(1), payer, 25e6, uint64(block.timestamp) + WINDOW, a.nonce);
        vm.prank(sched);
        esc.fund(_id(1), payer, 25e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        (address p, uint64 deadline, SparecycleX402Escrow.State s, uint256 amount) = esc.escrows(_id(1));
        assertEq(p, payer);
        assertEq(deadline, uint64(block.timestamp) + WINDOW);
        assertEq(uint8(s), uint8(SparecycleX402Escrow.State.Held));
        assertEq(amount, 25e6);
        assertEq(esc.totalHeld(), 25e6);
        assertEq(usdg.balanceOf(address(esc)), 25e6);
        assertEq(usdg.balanceOf(payer), 1_000_000e6 - 25e6);
        assertTrue(usdg.authorizationState(payer, a.nonce), "authorization used");
        assertEq(esc.surplus(), 0);
        // Nothing reaches the pot, the conversion address or the treasury before agreement.
        assertEq(usdg.balanceOf(conv), 0);
        assertEq(usdg.balanceOf(treasury), 0);
    }

    function test_fund_onlyScheduler() public {
        Auth memory a = _auth(payerKey, address(esc), 1e6);
        vm.prank(stranger);
        vm.expectRevert(SparecycleX402Escrow.NotScheduler.selector);
        esc.fund(_id(1), payer, 1e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        vm.prank(payer); // not even the payer: binding a payment to an escrow id is the scheduler's job
        vm.expectRevert(SparecycleX402Escrow.NotScheduler.selector);
        esc.fund(_id(1), payer, 1e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
    }

    function test_fund_rejectsReuseAndBadInput() public {
        Auth memory a = _fund(esc, _id(1), 1e6);
        // Same escrow id again.
        Auth memory b = _auth(payerKey, address(esc), 1e6);
        vm.startPrank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.EscrowExists.selector, _id(1)));
        esc.fund(_id(1), payer, 1e6, b.validAfter, b.validBefore, b.nonce, b.v, b.r, b.s);
        // The same authorization for another escrow id: the token refuses a used nonce.
        vm.expectRevert("authorization is used or canceled");
        esc.fund(_id(2), payer, 1e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        // An amount other than the signed value: the signature does not match.
        vm.expectRevert("invalid signature");
        esc.fund(_id(3), payer, 2e6, b.validAfter, b.validBefore, b.nonce, b.v, b.r, b.s);
        // Signed for another recipient (a different escrow).
        Auth memory c = _auth(payerKey, address(escT), 1e6);
        vm.expectRevert("invalid signature");
        esc.fund(_id(4), payer, 1e6, c.validAfter, c.validBefore, c.nonce, c.v, c.r, c.s);
        // Payer named wrongly.
        vm.expectRevert("invalid signature");
        esc.fund(_id(5), stranger, 1e6, b.validAfter, b.validBefore, b.nonce, b.v, b.r, b.s);
        vm.expectRevert(SparecycleX402Escrow.ZeroEscrowId.selector);
        esc.fund(bytes32(0), payer, 1e6, b.validAfter, b.validBefore, b.nonce, b.v, b.r, b.s);
        vm.expectRevert(SparecycleX402Escrow.ZeroAmount.selector);
        esc.fund(_id(6), payer, 0, b.validAfter, b.validBefore, b.nonce, b.v, b.r, b.s);
        vm.expectRevert(SparecycleX402Escrow.ZeroAddress.selector);
        esc.fund(_id(6), address(0), 1e6, b.validAfter, b.validBefore, b.nonce, b.v, b.r, b.s);
        vm.stopPrank();
        assertEq(esc.totalHeld(), 1e6, "only the first escrow is held");
        assertFalse(usdg.authorizationState(payer, b.nonce), "a failed fund leaves the authorization unused");
    }

    function test_fund_expiredOrNotYetValidAuthorization() public {
        Auth memory a = _auth(payerKey, address(esc), 1e6);
        vm.warp(a.validBefore);
        vm.prank(sched);
        vm.expectRevert("authorization is expired");
        esc.fund(_id(1), payer, 1e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        assertEq(uint8(_state(esc, _id(1))), uint8(SparecycleX402Escrow.State.None));
    }

    function test_fund_caps() public {
        Auth memory a = _auth(payerKey, address(esc), PER_JOB + 1);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.OverJobCap.selector, PER_JOB + 1, PER_JOB));
        esc.fund(_id(1), payer, PER_JOB + 1, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        vm.prank(admin);
        esc.setCaps(PER_JOB, TOTAL, 2 * TOTAL); // this test is about the total cap only
        for (uint256 i; i < 5; ++i) {
            _fund(esc, _id(10 + i), PER_JOB);
        }
        assertEq(esc.totalHeld(), TOTAL);
        Auth memory b = _auth(payerKey, address(esc), 1);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.OverTotalCap.selector, TOTAL + 1, TOTAL));
        esc.fund(_id(99), payer, 1, b.validAfter, b.validBefore, b.nonce, b.v, b.r, b.s);
        // Settling frees room under the total cap.
        vm.prank(sched);
        esc.refund(_id(10));
        _fund(esc, _id(99), 1);
        assertEq(esc.totalHeld(), TOTAL - PER_JOB + 1);
    }

    function test_fund_perPayerPerEpochCap_resetsWithTheRewardEpoch() public {
        for (uint256 i; i < 4; ++i) {
            _fund(esc, _id(i), PER_JOB);
        }
        assertEq(esc.fundedInEpoch(payer, 0), PER_PAYER);
        Auth memory a = _auth(payerKey, address(esc), 1);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.OverPayerEpochCap.selector, payer, PER_PAYER + 1, PER_PAYER));
        esc.fund(_id(9), payer, 1, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        // A refund does not give the room back within the epoch (the cap counts what was funded).
        vm.prank(sched);
        esc.refund(_id(0));
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.OverPayerEpochCap.selector, payer, PER_PAYER + 1, PER_PAYER));
        esc.fund(_id(9), payer, 1, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        // Another payer has its own room.
        uint256 otherKey = 0xB0B;
        usdg.mint(vm.addr(otherKey), 10e6);
        Auth memory o = _auth(otherKey, address(esc), 10e6);
        vm.prank(sched);
        esc.fund(_id(10), vm.addr(otherKey), 10e6, o.validAfter, o.validBefore, o.nonce, o.v, o.r, o.s);
        // The reward contract's next epoch resets the payer's room.
        vm.warp(block.timestamp + EPOCH);
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(0, bytes32(0), 0);
        assertEq(ethR.currentEpoch(), 1);
        Auth memory b = _auth(payerKey, address(esc), 1);
        vm.prank(sched);
        esc.fund(_id(11), payer, 1, b.validAfter, b.validBefore, b.nonce, b.v, b.r, b.s);
        assertEq(esc.fundedInEpoch(payer, 1), 1);
    }

    function test_fund_pausedBlocksNewEscrowsButNeverSettlement() public {
        _fund(esc, _id(1), 1e6);
        _fund(esc, _id(2), 1e6);
        vm.prank(admin);
        esc.setFundingPaused(true);
        Auth memory a = _auth(payerKey, address(esc), 1e6);
        vm.prank(sched);
        vm.expectRevert(SparecycleX402Escrow.FundingIsPaused.selector);
        esc.fund(_id(3), payer, 1e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        vm.startPrank(sched);
        esc.forward(_id(1));
        esc.refund(_id(2));
        vm.stopPrank();
        vm.prank(admin);
        esc.setFundingPaused(false);
        vm.prank(sched);
        esc.fund(_id(3), payer, 1e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
    }

    function test_fund_feeOnTransferAssetIsRefused() public {
        usdg.setFeeBps(100); // 1% burnt on every transfer
        Auth memory a = _auth(payerKey, address(esc), 10e6);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.AmountMismatch.selector, 10e6, 9.9e6));
        esc.fund(_id(1), payer, 10e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        assertEq(uint8(_state(esc, _id(1))), uint8(SparecycleX402Escrow.State.None));
        assertEq(esc.totalHeld(), 0);
        assertEq(usdg.balanceOf(address(esc)), 0);
        assertFalse(usdg.authorizationState(payer, a.nonce), "the whole fund rolled back");
    }

    // ------------------------------------------------------------------ forward

    function test_forward_conversionPath_splits95to5() public {
        _fund(esc, _id(1), 100e6);
        vm.expectEmit(address(esc));
        emit SparecycleX402Escrow.Forwarded(_id(1), payer, 100e6, 95e6, 5e6, conv, true);
        vm.prank(sched);
        esc.forward(_id(1));
        assertEq(uint8(_state(esc, _id(1))), uint8(SparecycleX402Escrow.State.Forwarded));
        assertEq(usdg.balanceOf(conv), 95e6);
        assertEq(usdg.balanceOf(treasury), 5e6);
        assertEq(usdg.balanceOf(address(esc)), 0);
        assertEq(esc.totalHeld(), 0);
        assertEq(ethR.getEpoch(0).pot, 0, "the ETH pot is untouched: conversion is a separate step");
    }

    function test_forward_directPath_fundsTheOpenEpochPot() public {
        _fund(escT, _id(1), 100e6);
        vm.expectEmit(address(escT));
        emit SparecycleX402Escrow.Forwarded(_id(1), payer, 100e6, 95e6, 5e6, address(tokR), false);
        vm.prank(sched);
        escT.forward(_id(1));
        assertEq(tokR.getEpoch(0).pot, 95e6, "95% credited to the open epoch");
        assertEq(usdg.balanceOf(address(tokR)), 95e6);
        assertEq(usdg.balanceOf(treasury), 5e6);
        assertEq(usdg.balanceOf(conv), 0);
        assertEq(usdg.allowance(address(escT), address(tokR)), 0, "no allowance left behind");
        assertEq(usdg.balanceOf(address(escT)), 0);
    }

    function test_forward_onlySchedulerOnceAndBeforeTheDeadline() public {
        _fund(esc, _id(1), 1e6);
        vm.prank(stranger);
        vm.expectRevert(SparecycleX402Escrow.NotScheduler.selector);
        esc.forward(_id(1));
        vm.prank(admin); // the owner Safe cannot settle either
        vm.expectRevert(SparecycleX402Escrow.NotScheduler.selector);
        esc.forward(_id(1));
        vm.startPrank(sched);
        esc.forward(_id(1));
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.NotHeld.selector, _id(1)));
        esc.forward(_id(1));
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.NotHeld.selector, _id(1)));
        esc.refund(_id(1));
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.NotHeld.selector, _id(7)));
        esc.forward(_id(7));
        vm.stopPrank();

        _fund(esc, _id(2), 1e6);
        (, uint64 deadline,,) = esc.escrows(_id(2));
        vm.warp(deadline); // the last second the scheduler may forward
        vm.prank(sched);
        esc.forward(_id(2));
        _fund(esc, _id(3), 1e6);
        (, deadline,,) = esc.escrows(_id(3));
        vm.warp(uint256(deadline) + 1);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.DeadlinePassed.selector, _id(3), deadline));
        esc.forward(_id(3));
    }

    function testFuzz_forward_splitAddsUp(uint256 amount) public {
        amount = bound(amount, 1, PER_JOB);
        _fund(esc, _id(1), amount);
        vm.prank(sched);
        esc.forward(_id(1));
        assertEq(usdg.balanceOf(conv) + usdg.balanceOf(treasury), amount);
        assertEq(usdg.balanceOf(treasury), (amount * 500) / 10_000);
    }

    // ------------------------------------------------------------------ refund

    function test_refund_bySchedulerAnytime() public {
        _fund(esc, _id(1), 7e6);
        uint256 before = usdg.balanceOf(payer);
        vm.expectEmit(address(esc));
        emit SparecycleX402Escrow.Refunded(_id(1), payer, 7e6, true);
        vm.prank(sched);
        esc.refund(_id(1));
        assertEq(uint8(_state(esc, _id(1))), uint8(SparecycleX402Escrow.State.Refunded));
        assertEq(usdg.balanceOf(payer), before + 7e6);
        assertEq(esc.totalHeld(), 0);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.NotHeld.selector, _id(1)));
        esc.refund(_id(1));
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.NotHeld.selector, _id(1)));
        esc.forward(_id(1));
    }

    function test_refund_byAnyoneAfterTheDeadline_withoutTheScheduler() public {
        _fund(esc, _id(1), 7e6);
        (, uint64 deadline,,) = esc.escrows(_id(1));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.TooEarly.selector, _id(1), deadline));
        esc.refund(_id(1));
        vm.warp(deadline);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(SparecycleX402Escrow.TooEarly.selector, _id(1), deadline));
        esc.refund(_id(1));
        vm.warp(uint256(deadline) + 1);
        uint256 before = usdg.balanceOf(payer);
        vm.expectEmit(address(esc));
        emit SparecycleX402Escrow.Refunded(_id(1), payer, 7e6, false);
        vm.prank(stranger); // a stranger pays the gas; the money still goes to the payer
        esc.refund(_id(1));
        assertEq(usdg.balanceOf(payer), before + 7e6);
        assertEq(usdg.balanceOf(stranger), 0);
    }

    function test_settlementFollowsSchedulerRotation() public {
        _fund(esc, _id(1), 1e6);
        _fund(esc, _id(2), 1e6);
        address next = makeAddr("newScheduler");
        vm.prank(admin);
        ethR.setScheduler(next);
        vm.prank(sched);
        vm.expectRevert(SparecycleX402Escrow.NotScheduler.selector);
        esc.forward(_id(1));
        vm.prank(sched); // the old key is a stranger now: no early refund
        vm.expectRevert();
        esc.refund(_id(1));
        vm.startPrank(next);
        esc.forward(_id(1));
        esc.refund(_id(2));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ reentrancy

    function test_reentrancy_duringRefund_isBlocked() public {
        _fund(esc, _id(1), 5e6);
        _fund(esc, _id(2), 5e6);
        // While the refund transfer of escrow 1 runs, the token calls back into the escrow to refund escrow 2.
        usdg.setHook(address(esc), address(esc), abi.encodeCall(SparecycleX402Escrow.refund, (_id(2))));
        vm.prank(sched);
        esc.refund(_id(1));
        assertTrue(usdg.hookCalled());
        assertFalse(usdg.hookSucceeded(), "re-entered refund reverted");
        assertEq(bytes4(usdg.hookReturn()), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(uint8(_state(esc, _id(1))), uint8(SparecycleX402Escrow.State.Refunded));
        assertEq(uint8(_state(esc, _id(2))), uint8(SparecycleX402Escrow.State.Held));
        assertEq(esc.totalHeld(), 5e6);
        assertEq(usdg.balanceOf(address(esc)), 5e6);
    }

    function test_reentrancy_duringForward_isBlocked() public {
        _fund(esc, _id(1), 5e6);
        usdg.setHook(address(esc), address(esc), abi.encodeCall(SparecycleX402Escrow.forward, (_id(1))));
        vm.prank(sched);
        esc.forward(_id(1));
        assertTrue(usdg.hookCalled());
        assertFalse(usdg.hookSucceeded());
        assertEq(usdg.balanceOf(conv) + usdg.balanceOf(treasury), 5e6, "paid out exactly once");
        assertEq(usdg.balanceOf(address(esc)), 0);
    }

    function test_reentrancy_duringFund_isBlocked() public {
        _fund(esc, _id(1), 5e6);
        Auth memory a = _auth(payerKey, address(esc), 3e6);
        // While the payer's tokens move in, the token calls back to refund escrow 1.
        usdg.setHook(payer, address(esc), abi.encodeCall(SparecycleX402Escrow.refund, (_id(1))));
        vm.prank(sched);
        esc.fund(_id(2), payer, 3e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        assertTrue(usdg.hookCalled());
        assertFalse(usdg.hookSucceeded());
        assertEq(uint8(_state(esc, _id(1))), uint8(SparecycleX402Escrow.State.Held));
        assertEq(esc.totalHeld(), 8e6);
        assertEq(usdg.balanceOf(address(esc)), 8e6);
    }

    // ------------------------------------------------------------------ owner powers stop at configuration

    function test_owner_setters() public {
        vm.prank(stranger);
        vm.expectRevert();
        esc.setForwardTo(stranger);
        vm.prank(stranger);
        vm.expectRevert();
        esc.setCaps(1, 1, 1);
        vm.prank(stranger);
        vm.expectRevert();
        esc.setFundingPaused(true);
        vm.startPrank(admin);
        vm.expectRevert(SparecycleX402Escrow.ZeroAddress.selector);
        esc.setForwardTo(address(0));
        address next = makeAddr("nextConv");
        esc.setForwardTo(next);
        assertEq(esc.forwardTo(), next);
        vm.expectRevert(SparecycleX402Escrow.BadCaps.selector);
        esc.setCaps(0, 1, 1);
        vm.expectRevert(SparecycleX402Escrow.BadCaps.selector);
        esc.setCaps(2, 1, 1);
        vm.expectRevert(SparecycleX402Escrow.BadCaps.selector);
        esc.setCaps(1, 10, 0);
        vm.expectEmit(address(esc));
        emit SparecycleX402Escrow.CapsSet(1, 10, 3);
        esc.setCaps(1, 10, 3);
        assertEq(esc.maxPerJob(), 1);
        assertEq(esc.maxPerPayerPerEpoch(), 3);
        vm.expectRevert(SparecycleX402Escrow.RenounceDisabled.selector);
        esc.renounceOwnership();
        vm.stopPrank();
    }

    function test_owner_lowerCapsNeverTouchHeldEscrows() public {
        _fund(esc, _id(1), 900e6);
        vm.prank(admin);
        esc.setCaps(1, 1, 1);
        vm.prank(sched);
        esc.forward(_id(1));
        assertEq(usdg.balanceOf(conv), 855e6);
    }

    function test_recoverSurplus_neverTakesEscrowedFunds() public {
        _fund(esc, _id(1), 40e6);
        vm.prank(admin);
        vm.expectRevert(SparecycleX402Escrow.NothingToRecover.selector);
        esc.recoverSurplus(address(usdg), admin);
        // A direct transfer is in no escrow: only that part can be recovered.
        usdg.mint(stranger, 3e6);
        vm.prank(stranger);
        usdg.transfer(address(esc), 3e6);
        assertEq(esc.surplus(), 3e6);
        vm.prank(stranger);
        vm.expectRevert();
        esc.recoverSurplus(address(usdg), stranger);
        vm.prank(admin);
        assertEq(esc.recoverSurplus(address(usdg), stranger), 3e6);
        assertEq(usdg.balanceOf(stranger), 3e6);
        assertEq(usdg.balanceOf(address(esc)), 40e6);
        assertEq(esc.totalHeld(), 40e6);
        // Another token: all of it.
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        other.mint(address(esc), 5);
        vm.prank(admin);
        esc.recoverSurplus(address(other), admin);
        assertEq(other.balanceOf(admin), 5);
        // The held escrow still settles in full.
        vm.prank(sched);
        esc.refund(_id(1));
        assertEq(usdg.balanceOf(address(esc)), 0);
    }

    function test_frontRunAuthorization_landsAsSurplus_andCanBeReturned() public {
        // Someone who saw the signed authorization submits it to the token directly: the payment lands in the escrow
        // contract without an escrow. fund() then fails (nonce used) and the job is never queued; the owner Safe can
        // send the surplus back to the payer.
        Auth memory a = _auth(payerKey, address(esc), 2e6);
        vm.prank(stranger);
        usdg.transferWithAuthorization(payer, address(esc), 2e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        vm.prank(sched);
        vm.expectRevert("authorization is used or canceled");
        esc.fund(_id(1), payer, 2e6, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        assertEq(esc.surplus(), 2e6);
        uint256 before = usdg.balanceOf(payer);
        vm.prank(admin);
        esc.recoverSurplus(address(usdg), payer);
        assertEq(usdg.balanceOf(payer), before + 2e6);
    }

    function test_noEthPath() public {
        vm.deal(stranger, 1 ether);
        vm.prank(stranger);
        (bool ok,) = address(esc).call{value: 1}("");
        assertFalse(ok, "no receive(): ETH is not an escrow asset");
    }
}
