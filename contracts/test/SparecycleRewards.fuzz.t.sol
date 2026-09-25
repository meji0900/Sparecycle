// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RewardsFixture} from "./Base.t.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {EthPusher} from "./mocks/Mocks.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

/// @notice Random fundings, reserved amounts and payout trees (including over-allocated trees from a buggy
///         scheduler) never pay out more than `reserved`, hence never more than the pot.
contract SparecycleRewardsFuzzTest is RewardsFixture {
    uint256 internal constant N = 6;
    EthPusher internal pusher;

    function setUp() public override {
        super.setUp();
        pusher = new EthPusher();
        vm.prank(funder);
        usdg.approve(address(escrow), type(uint256).max);
    }

    struct Case {
        uint256 fundAmt;
        uint256 pushAmt;
        uint256 escrowAmt;
        uint256 reservedSeed;
        uint256[N] weights;
        bool overAllocate;
        uint256 orderSeed;
    }

    function _inflows(SparecycleRewards r, Case memory c) internal returns (uint256 pot) {
        bool eth = r.payoutToken() == address(0);
        uint256 cap = eth ? 100_000 ether : 1e24;
        c.fundAmt = bound(c.fundAmt, 0, cap);
        c.pushAmt = bound(c.pushAmt, 0, cap);
        c.escrowAmt = bound(c.escrowAmt, 0, cap);
        if (c.fundAmt > 0) _fund(r, c.fundAmt);
        if (eth) {
            if (c.pushAmt > 0) pusher.pushTransfer{value: c.pushAmt}(payable(address(r)));
            escrow.credit{value: c.escrowAmt}(address(r));
            r.claimFeesFromEscrow();
        } else {
            vm.startPrank(funder);
            usdg.transfer(address(r), c.pushAmt);
            escrow.creditToken(address(r), address(usdg), c.escrowAmt);
            vm.stopPrank();
            r.claimFeesFromEscrowToken();
        }
        pot = c.fundAmt + c.pushAmt + c.escrowAmt; // the push is credited by the sync inside close
    }

    function _amounts(Case memory c, uint256 reserved) internal pure returns (uint256[] memory amts, uint256 wsum) {
        amts = new uint256[](N);
        for (uint256 i; i < N; ++i) {
            c.weights[i] = bound(c.weights[i], 0, 1e18);
            wsum += c.weights[i];
        }
        for (uint256 i; i < N; ++i) {
            if (c.overAllocate) amts[i] = bound(c.weights[i], 0, reserved); // sum may exceed reserved
            else amts[i] = wsum == 0 ? 0 : (reserved * c.weights[i]) / wsum; // floored, sum <= reserved
        }
    }

    function _claimAll(
        SparecycleRewards r,
        uint64 id,
        address[] memory ops,
        uint256[] memory amts,
        bytes32[] memory leaves,
        Case memory c,
        uint256 reserved
    ) internal returns (uint256 paid) {
        for (uint256 k; k < N; ++k) {
            uint256 i = (k + (c.orderSeed % N)) % N;
            bytes32[] memory p = MerkleHelper.proof(leaves, leaves[i]);
            uint256 before = _bal(r, ops[i]);
            vm.prank(ops[i]);
            try r.claim(id, amts[i], p) {
                paid += amts[i];
                assertEq(_bal(r, ops[i]) - before, amts[i]);
            } catch (bytes memory err) {
                assertTrue(c.overAllocate, "only an over-allocated tree can hit the cap");
                assertEq(bytes4(err), SparecycleRewards.ClaimExceedsReserved.selector);
                assertGt(r.getEpoch(id).claimed + amts[i], reserved);
            }
        }
    }

    function _run(SparecycleRewards r, Case memory c) internal {
        uint256 pot = _inflows(r, c);
        uint256 reserved = bound(c.reservedSeed, 0, pot);
        (uint256[] memory amts, uint256 wsum) = _amounts(c, reserved);
        address[] memory ops = _ops(N);

        uint64 id = r.currentEpoch();
        bytes32[] memory leaves = _leaves(r, id, ops, amts);
        _warpToEnd(r);
        vm.prank(sched);
        r.closeEpochAndPostRoot(id, MerkleHelper.root(leaves), reserved);
        assertEq(r.getEpoch(id).pot, pot, "pot = all inflows");
        assertEq(r.getEpoch(id + 1).pot, pot - reserved, "rollover = pot - reserved");

        uint256 paid = _claimAll(r, id, ops, amts, leaves, c, reserved);

        assertLe(paid, reserved, "paid <= reserved");
        assertLe(reserved, pot, "reserved <= pot");
        assertEq(r.getEpoch(id).claimed, paid, "claimed tracks payouts");
        assertEq(_bal(r, address(r)), pot - paid, "balance = inflows - payouts");
        assertEq(r.accounted(), pot - paid, "accounted = rollover + unclaimed reserved");
        if (!c.overAllocate) {
            // Pro-rata floored leaves: everything claims; < 1 unit per leaf of flooring dust stays reserved.
            if (wsum > 0) assertLt(reserved - paid, N, "flooring dust < 1 unit per leaf");
            else assertEq(paid, 0);
        }
        _assertAccounting(r);
    }

    function testFuzz_Eth_PayoutsBoundedByReservedAndPot(Case memory c) public {
        _run(ethR, c);
    }

    function testFuzz_Token_PayoutsBoundedByReservedAndPot(Case memory c) public {
        _run(tokR, c);
    }

    function testFuzz_ReservedAbovePotReverts(uint96 potAmt, uint256 extra, bool withPush) public {
        uint256 pot = bound(potAmt, 0, 100_000 ether);
        extra = bound(extra, 1, type(uint256).max - pot);
        if (withPush) pusher.pushTransfer{value: pot}(payable(address(ethR)));
        else if (pot > 0) _fund(ethR, pot);
        _warpToEnd(ethR);
        vm.prank(sched);
        vm.expectRevert(SparecycleRewards.ReservedExceedsPot.selector);
        ethR.closeEpochAndPostRoot(0, keccak256("r"), pot + extra);
    }

    function testFuzz_LeafOf(uint64 e, address a, uint256 amt) public view {
        assertEq(ethR.leafOf(e, a, amt), keccak256(bytes.concat(bytes8(e), bytes20(a), bytes32(amt))));
    }

    function testFuzz_OnlySchedulerCloses(address caller) public {
        vm.assume(caller != sched);
        _warpToEnd(ethR);
        vm.prank(caller);
        vm.expectRevert(SparecycleRewards.NotScheduler.selector);
        ethR.closeEpochAndPostRoot(0, bytes32(0), 0);
    }
}
