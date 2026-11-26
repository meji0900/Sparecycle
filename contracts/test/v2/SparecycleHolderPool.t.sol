// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {V2Fixture} from "./V2Fixture.sol";
import {SparecycleJobPaymentsV2} from "../../src/SparecycleJobPaymentsV2.sol";
import {SparecycleBurner} from "../../src/SparecycleBurner.sol";
import {SparecycleHolderPool} from "../../src/SparecycleHolderPool.sol";
import {MerkleHelper} from "../utils/MerkleHelper.sol";
import {MockSpare} from "../mocks/V2Mocks.sol";

/// @notice Test-only: lets `setMode` accept mode 2 so the next-epoch timing can be observed with two modes.
///         Claims in mode 2 still revert (the claim path is not overridden).
contract HolderPoolTwoModeHarness is SparecycleHolderPool {
    constructor(address r, address p, address t) SparecycleHolderPool(r, p, t) {}

    function _checkSelectableMode(uint8 mode) internal pure override {
        if (mode != MODE_CREDITS && mode != MODE_NVDA) revert UnknownMode(mode);
    }
}

/// @notice A payments contract that re-enters the pool's claim from inside creditFor.
contract ReenteringPayments {
    address public holderPool;
    address public rewards;
    bytes public err;
    bool public reentered;

    constructor(address pool_, address rewards_) {
        holderPool = pool_;
        rewards = rewards_;
    }

    function creditFor(address) external payable {
        bytes32[] memory none;
        try SparecycleHolderPool(payable(holderPool)).claim(0, 1, 0, none) {
            reentered = true;
        } catch (bytes memory e) {
            err = e;
        }
    }
}

contract SparecycleHolderPoolTest is V2Fixture {
    function _fundPool(uint256 amount) internal {
        vm.prank(funder);
        pool.fund{value: amount}();
    }

    // ================================================================ construction and reads

    function test_Constructor() public view {
        assertEq(address(pool.rewards()), address(ethR));
        assertEq(address(pool.payments()), address(pay));
        assertEq(pool.treasury(), treasury);
        assertEq(pool.nextPostableEpoch(), 0);
        assertEq(pool.UNCLAIMED_ROLLOVER_EPOCHS(), 8, "N19");
        assertEq(pool.DEFAULT_MODE(), pool.MODE_CREDITS(), "N18");
        assertEq(pool.MODE_NVDA(), 2);
    }

    function test_Constructor_Rejects() public {
        vm.expectRevert(SparecycleHolderPool.ZeroAddress.selector);
        new SparecycleHolderPool(address(0), address(pay), treasury);
        vm.expectRevert(SparecycleHolderPool.ZeroAddress.selector);
        new SparecycleHolderPool(address(ethR), address(pay), address(0));
    }

    function test_LeafFormat() public view {
        bytes32 expected = keccak256(abi.encodePacked(uint64(7), alice, uint8(1), uint256(3 ether)));
        assertEq(pool.leafOf(7, alice, 1, 3 ether), expected);
        // 8 + 20 + 1 + 32 bytes
        assertEq(abi.encodePacked(uint64(7), alice, uint8(1), uint256(3 ether)).length, 61);
    }

    function test_ReceivesHolderPartFromCharges() public {
        _deposit(alice, 10 ether);
        _charge(alice, 4 ether);
        assertEq(address(pool).balance, 0.06 ether, "150 bps of 4 ETH");
        assertEq(pool.available(), 0.06 ether);
    }

    // ================================================================ postRoot

    function test_PostRoot_Rules() public {
        _fundPool(1 ether);
        vm.prank(stranger);
        vm.expectRevert(SparecycleHolderPool.NotScheduler.selector);
        pool.postRoot(0, bytes32(uint256(1)), 1);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleHolderPool.EpochNotClosed.selector, uint64(0), uint64(0)));
        pool.postRoot(0, bytes32(uint256(1)), 1);

        _closeEmpty(ethR);
        _closeEmpty(ethR); // open epoch 2
        vm.startPrank(sched);
        vm.expectRevert(SparecycleHolderPool.EmptyRootWithTotal.selector);
        pool.postRoot(0, bytes32(0), 1);
        vm.expectRevert(
            abi.encodeWithSelector(SparecycleHolderPool.TotalExceedsAvailable.selector, 1 ether + 1, 1 ether)
        );
        pool.postRoot(0, bytes32(uint256(1)), 1 ether + 1);
        pool.postRoot(1, bytes32(uint256(1)), 0.4 ether); // epoch 0 skipped
        vm.expectRevert(abi.encodeWithSelector(SparecycleHolderPool.EpochNotPostable.selector, uint64(0), uint64(2)));
        pool.postRoot(0, bytes32(uint256(1)), 0.1 ether);
        vm.expectRevert(abi.encodeWithSelector(SparecycleHolderPool.EpochNotPostable.selector, uint64(1), uint64(2)));
        pool.postRoot(1, bytes32(uint256(1)), 0.1 ether);
        vm.stopPrank();
        assertEq(pool.outstanding(), 0.4 ether);
        assertEq(pool.available(), 0.6 ether);
        SparecycleHolderPool.RootInfo memory r = pool.getRoot(1);
        assertEq(r.claimableUntilEpoch, 2 + 8);
        assertEq(r.postedInEpoch, 2);
    }

    function test_PostRoot_FollowsSchedulerRotation() public {
        _closeEmpty(ethR);
        address next = makeAddr("nextScheduler");
        vm.prank(admin);
        ethR.setScheduler(next);
        vm.prank(sched);
        vm.expectRevert(SparecycleHolderPool.NotScheduler.selector);
        pool.postRoot(0, bytes32(0), 0);
        vm.prank(next);
        pool.postRoot(0, bytes32(0), 0);
    }

    // ================================================================ claim (brief 6.5)

    /// @notice A credit-mode claim raises the holder's spend-only credit in V2 by exactly the amount; credits pay
    ///         for a job; credits cannot be withdrawn.
    function test_Claim_CreditsExactlyAndSpendOnly() public {
        _fundPool(1 ether);
        (uint64 e, bytes32[] memory leaves) = _closeAndPostHolders(_arr(alice, bob), _m(1, 1), _u(0.3 ether, 0.2 ether));
        uint256 v2Before = address(pay).balance;
        vm.expectEmit(address(pool));
        emit SparecycleHolderPool.Claimed(e, alice, 1, 0.3 ether);
        vm.expectEmit(address(pay));
        emit SparecycleJobPaymentsV2.CreditAdded(alice, 0.3 ether, 0.3 ether);
        _holderClaim(e, leaves, alice, 1, 0.3 ether);

        assertEq(pay.creditOf(alice), 0.3 ether, "exactly the amount");
        assertEq(pay.balanceOf(alice), 0, "not withdrawable balance");
        assertEq(address(pay).balance - v2Before, 0.3 ether, "the ETH moved with the claim");
        assertEq(address(pool).balance, 0.7 ether);
        assertEq(pool.outstanding(), 0.2 ether);
        assertTrue(pool.hasClaimed(e, alice));

        // credits pay for a job
        uint64 open = _open();
        uint256 potBefore = ethR.getEpoch(open).pot;
        _charge(alice, 0.3 ether);
        assertEq(pay.creditOf(alice), 0);
        assertEq(ethR.getEpoch(open).pot - potBefore, 0.285 ether);

        // and cannot be withdrawn
        _holderClaim(e, leaves, bob, 1, 0.2 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SparecycleJobPaymentsV2.InsufficientBalance.selector, bob, 0, 1));
        pay.requestWithdraw(1);
        _assertV2Accounting();
    }

    function test_Claim_DoubleClaimReverts() public {
        _fundPool(1 ether);
        (uint64 e, bytes32[] memory leaves) = _closeAndPostHolders(_arr(alice, bob), _m(1, 1), _u(0.3 ether, 0.2 ether));
        _holderClaim(e, leaves, alice, 1, 0.3 ether);
        bytes32[] memory p = MerkleHelper.proof(leaves, pool.leafOf(e, alice, 1, 0.3 ether));
        vm.prank(alice);
        vm.expectRevert(SparecycleHolderPool.AlreadyClaimed.selector);
        pool.claim(e, 1, 0.3 ether, p);
        assertEq(pay.creditOf(alice), 0.3 ether, "paid once");
        _holderClaim(e, leaves, bob, 1, 0.2 ether); // others unaffected
    }

    function test_Claim_InvalidProofs() public {
        _fundPool(1 ether);
        (uint64 e, bytes32[] memory leaves) = _closeAndPostHolders(_arr(alice, bob), _m(1, 1), _u(0.3 ether, 0.2 ether));
        bytes32[] memory p = MerkleHelper.proof(leaves, pool.leafOf(e, alice, 1, 0.3 ether));
        vm.startPrank(alice);
        vm.expectRevert(SparecycleHolderPool.InvalidProof.selector);
        pool.claim(e, 1, 0.3 ether + 1, p); // wrong amount
        vm.expectRevert(SparecycleHolderPool.InvalidProof.selector);
        pool.claim(e, 2, 0.3 ether, p); // mode is part of the leaf
        vm.stopPrank();
        vm.prank(carol);
        vm.expectRevert(SparecycleHolderPool.InvalidProof.selector);
        pool.claim(e, 1, 0.3 ether, p); // someone else's leaf
        vm.expectRevert(abi.encodeWithSelector(SparecycleHolderPool.NotPosted.selector, uint64(5)));
        pool.claim(5, 1, 0, p);
    }

    function test_Claim_NvdaModeNotAvailable() public {
        _fundPool(1 ether);
        (uint64 e, bytes32[] memory leaves) = _closeAndPostHolders(_arr(alice, bob), _m(2, 1), _u(0.3 ether, 0.2 ether));
        bytes32[] memory p = MerkleHelper.proof(leaves, pool.leafOf(e, alice, 2, 0.3 ether));
        vm.prank(alice);
        vm.expectRevert(SparecycleHolderPool.NvdaModeNotAvailable.selector);
        pool.claim(e, 2, 0.3 ether, p);
        assertEq(pay.creditOf(alice), 0);
        assertFalse(pool.hasClaimed(e, alice));
    }

    function test_Claim_UnknownModes() public {
        _fundPool(1 ether);
        (uint64 e, bytes32[] memory leaves) = _closeAndPostHolders(_arr(alice, bob), _m(0, 3), _u(0.3 ether, 0.2 ether));
        bytes32[] memory p = MerkleHelper.proof(leaves, pool.leafOf(e, alice, 0, 0.3 ether));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SparecycleHolderPool.UnknownMode.selector, uint8(0)));
        pool.claim(e, 0, 0.3 ether, p);
        p = MerkleHelper.proof(leaves, pool.leafOf(e, bob, 3, 0.2 ether));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SparecycleHolderPool.UnknownMode.selector, uint8(3)));
        pool.claim(e, 3, 0.2 ether, p);
    }

    function test_Claim_OverAllocatedTreeCappedAtTotal() public {
        _fundPool(1 ether);
        address[] memory hs = _arr(alice, bob);
        uint8[] memory ms = _m(1, 1);
        uint256[] memory amts = _u(0.3 ether, 0.2 ether);
        uint64 e = _closeEmpty(ethR);
        bytes32[] memory leaves = _holderLeaves(e, hs, ms, amts);
        vm.prank(sched);
        pool.postRoot(e, MerkleHelper.root(leaves), 0.4 ether); // total below the leaves' sum
        _holderClaim(e, leaves, alice, 1, 0.3 ether);
        bytes32[] memory p = MerkleHelper.proof(leaves, pool.leafOf(e, bob, 1, 0.2 ether));
        vm.prank(bob);
        vm.expectRevert(SparecycleHolderPool.ClaimExceedsTotal.selector);
        pool.claim(e, 1, 0.2 ether, p);
    }

    function test_Claim_ZeroLeafMarksClaimed() public {
        _fundPool(1 ether);
        (uint64 e, bytes32[] memory leaves) = _closeAndPostHolders(_arr(alice, bob), _m(1, 1), _u(0, 0.2 ether));
        _holderClaim(e, leaves, alice, 1, 0);
        assertTrue(pool.hasClaimed(e, alice));
        assertEq(pay.creditOf(alice), 0);
    }

    function test_Claim_ReentrancyBlocked() public {
        // a payments contract that re-enters claim() from creditFor
        uint64 n = vm.getNonce(address(this));
        address poolAt = vm.computeCreateAddress(address(this), n + 1);
        ReenteringPayments rp = new ReenteringPayments(poolAt, address(ethR));
        SparecycleHolderPool p2 = new SparecycleHolderPool(address(ethR), address(rp), treasury);
        vm.prank(funder);
        p2.fund{value: 1 ether}();
        uint64 e = _closeEmpty(ethR);
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = p2.leafOf(e, alice, 1, 0.5 ether);
        leaves[1] = p2.leafOf(e, bob, 1, 0.5 ether);
        vm.prank(sched);
        p2.postRoot(e, MerkleHelper.root(leaves), 1 ether);
        bytes32[] memory proof = MerkleHelper.proof(leaves, leaves[0]);
        vm.prank(alice);
        p2.claim(e, 1, 0.5 ether, proof);
        assertFalse(rp.reentered());
        assertEq(bytes4(rp.err()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(address(rp).balance, 0.5 ether, "paid once");
    }

    // ================================================================ modes

    function test_SetMode_OnlyCreditsSelectable() public {
        uint64 cur = _open();
        vm.expectEmit(address(pool));
        emit SparecycleHolderPool.ModeSet(alice, 1, cur + 1);
        vm.prank(alice);
        pool.setMode(1);
        vm.prank(alice);
        vm.expectRevert(SparecycleHolderPool.NvdaModeNotAvailable.selector);
        pool.setMode(2);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SparecycleHolderPool.UnknownMode.selector, uint8(0)));
        pool.setMode(0);
        assertEq(pool.modeOf(bob, 0), 1, "never chosen -> credits (N18)");
        assertEq(pool.currentModeOf(bob), 1);
    }

    /// @notice Brief 6.5: setMode during epoch N applies from epoch N+1 only (shown with two selectable modes).
    function test_SetMode_AppliesFromNextEpochOnly() public {
        uint64 n = vm.getNonce(address(this));
        address v2At = vm.computeCreateAddress(address(this), n + 1);
        address poolAt = vm.computeCreateAddress(address(this), n + 2);
        SparecycleBurner b =
            new SparecycleBurner(address(ethR), treasury, address(spareTok), address(adapter), v2At, true, 1);
        SparecycleJobPaymentsV2 p = new SparecycleJobPaymentsV2(
            address(ethR), treasury, address(b), poolAt, address(spareTok), address(adapter), CAP
        );
        HolderPoolTwoModeHarness h = new HolderPoolTwoModeHarness(address(ethR), address(p), treasury);

        _closeEmpty(ethR);
        _closeEmpty(ethR); // epoch 2
        vm.expectEmit(address(h));
        emit SparecycleHolderPool.ModeSet(alice, 2, 3);
        vm.prank(alice);
        h.setMode(2);
        assertEq(h.modeOf(alice, 2), 1, "the epoch of the call keeps the old mode");
        assertEq(h.currentModeOf(alice), 1);
        assertEq(h.modeOf(alice, 3), 2, "applies from N+1");

        _closeEmpty(ethR); // epoch 3
        assertEq(h.currentModeOf(alice), 2);
        vm.prank(alice);
        h.setMode(1); // back to credits, from epoch 4
        vm.prank(alice);
        h.setMode(2); // changed again in the same epoch: the last choice wins, still from epoch 4
        vm.prank(alice);
        h.setMode(1);
        assertEq(h.modeOf(alice, 2), 1, "history kept");
        assertEq(h.modeOf(alice, 3), 2);
        assertEq(h.modeOf(alice, 4), 1);
        assertEq(h.currentModeOf(alice), 2, "epoch 3 unchanged by changes made in epoch 3");

        // the harness only widens setMode: a mode-2 claim still reverts
        vm.prank(funder);
        h.fund{value: 1 ether}();
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = h.leafOf(3, alice, 2, 0.5 ether);
        leaves[1] = h.leafOf(3, bob, 1, 0.5 ether);
        _closeEmpty(ethR);
        vm.prank(sched);
        h.postRoot(3, MerkleHelper.root(leaves), 1 ether);
        bytes32[] memory proof = MerkleHelper.proof(leaves, leaves[0]);
        vm.prank(alice);
        vm.expectRevert(SparecycleHolderPool.NvdaModeNotAvailable.selector);
        h.claim(3, 2, 0.5 ether, proof);
    }

    function testFuzz_SetMode_NeverAppliesToTheCurrentEpoch(uint8 closes) public {
        uint256 c = bound(closes, 0, 20);
        for (uint256 i; i < c; ++i) {
            _closeEmpty(ethR);
        }
        uint64 cur = _open();
        vm.prank(alice);
        pool.setMode(1);
        // the stored choice starts at cur + 1; for every epoch <= cur the lookup finds nothing (default)
        assertEq(pool.modeOf(alice, cur), pool.DEFAULT_MODE());
        assertEq(pool.modeOf(alice, cur + 1), 1);
    }

    // ================================================================ rollover (N19)

    /// @notice Brief 6.5: unclaimed shares roll over after K epochs; never to the treasury.
    function test_Rollover_AfterKEpochs() public {
        _fundPool(1 ether);
        (uint64 e, bytes32[] memory leaves) = _closeAndPostHolders(_arr(alice, bob), _m(1, 1), _u(0.3 ether, 0.2 ether));
        uint64 postedIn = _open();
        SparecycleHolderPool.RootInfo memory r = pool.getRoot(e);
        assertEq(r.claimableUntilEpoch, postedIn + 8);
        _holderClaim(e, leaves, alice, 1, 0.3 ether);
        assertEq(pool.available(), 0.5 ether);

        for (uint256 i; i < 8; ++i) {
            _closeEmpty(ethR);
        }
        assertEq(_open(), postedIn + 8);
        assertEq(pool.rollExpired(10), 0, "still claimable in the last epoch of the window");

        _closeEmpty(ethR); // window over
        bytes32[] memory p = MerkleHelper.proof(leaves, pool.leafOf(e, bob, 1, 0.2 ether));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SparecycleHolderPool.ClaimWindowClosed.selector, e, postedIn + 8));
        pool.claim(e, 1, 0.2 ether, p);

        vm.expectEmit(address(pool));
        emit SparecycleHolderPool.RolledOver(e, 0.2 ether);
        assertEq(pool.rollExpired(10), 1);
        assertEq(pool.outstanding(), 0);
        assertEq(pool.available(), 0.7 ether, "bob's share is back in the pool");
        assertEq(treasury.balance, 0, "never to the treasury");
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(SparecycleHolderPool.ClaimWindowClosed.selector, e, postedIn + 8));
        pool.claim(e, 1, 0.2 ether, p);

        // the next root can hand it out again
        (uint64 e2, bytes32[] memory l2) = _closeAndPostHolders(_arr(bob), _m(1), _u(0.7 ether));
        _holderClaim(e2, l2, bob, 1, 0.7 ether);
        assertEq(pay.creditOf(bob), 0.7 ether);
        assertEq(address(pool).balance, 0);
    }

    function test_Rollover_PostRootRollsExpiredFirst() public {
        _fundPool(1 ether);
        _closeAndPostHolders(_arr(alice), _m(1), _u(1 ether));
        assertEq(pool.available(), 0);
        for (uint256 i; i < 9; ++i) {
            _closeEmpty(ethR);
        }
        // without an explicit rollExpired, postRoot rolls the expired root and can reuse its ETH
        uint64 e = _closeEmpty(ethR);
        bytes32[] memory leaves = _holderLeaves(e, _arr(bob), _m(1), _u(1 ether));
        vm.prank(sched);
        pool.postRoot(e, MerkleHelper.root(leaves), 1 ether);
        assertEq(pool.outstanding(), 1 ether);
        assertEq(pool.nextRollIndex(), 1);
    }

    function test_RescueToken_OnlyErc20ToTreasury() public {
        MockSpare other = new MockSpare();
        other.mint(address(pool), 3 ether);
        vm.prank(stranger);
        vm.expectRevert(SparecycleHolderPool.NotTreasury.selector);
        pool.rescueToken(address(other), 1);
        vm.prank(treasury);
        pool.rescueToken(address(other), 3 ether);
        assertEq(other.balanceOf(treasury), 3 ether);
        assertEq(IERC20(address(other)).balanceOf(address(pool)), 0);
    }
}
