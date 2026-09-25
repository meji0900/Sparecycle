// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SparecycleRewards} from "../../src/SparecycleRewards.sol";
import {MockPonsFeeEscrow} from "../mocks/MockPonsFeeEscrow.sol";
import {MockERC20} from "../mocks/Mocks.sol";
import {RewardsHandler} from "./RewardsHandler.sol";

/// @notice Stateful invariants of the reward contract (brief §4 "Invariants (must be tested)").
abstract contract RewardsInvariantBase is Test {
    SparecycleRewards internal r;
    RewardsHandler internal h;
    MockPonsFeeEscrow internal escrow;
    MockERC20 internal token;

    function _deploy(bool eth) internal {
        vm.warp(1_750_000_000);
        escrow = new MockPonsFeeEscrow();
        if (!eth) token = new MockERC20("Global Dollar", "USDG", 6);
        address sched = makeAddr("inv-scheduler");
        r = new SparecycleRewards(makeAddr("inv-admin"), sched, address(token), address(escrow), 1 hours);
        h = new RewardsHandler(r, escrow, token, sched);

        bytes4[] memory sel = new bytes4[](9);
        sel[0] = RewardsHandler.fund.selector;
        sel[1] = RewardsHandler.push.selector;
        sel[2] = RewardsHandler.forceEth.selector;
        sel[3] = RewardsHandler.escrowFees.selector;
        sel[4] = RewardsHandler.sync.selector;
        sel[5] = RewardsHandler.warp.selector;
        sel[6] = RewardsHandler.close.selector;
        sel[7] = RewardsHandler.claim.selector;
        sel[8] = RewardsHandler.badClaim.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    function _balance() internal view returns (uint256) {
        return address(token) == address(0) ? address(r).balance : token.balanceOf(address(r));
    }

    /// @notice For every epoch: reserved <= pot, claimed <= reserved, claimed == what was actually paid,
    ///         and pot == rolled in + credited while open ("funded + rolled in = pot").
    function invariant_PerEpochBounds() public view {
        uint64 cur = r.currentEpoch();
        uint256 rolledIn;
        for (uint64 i; i <= cur; ++i) {
            SparecycleRewards.Epoch memory e = r.getEpoch(i);
            assertEq(e.index, i, "index");
            assertLe(e.reserved, e.pot, "reserved <= pot");
            assertLe(e.claimed, e.reserved, "claimed <= reserved");
            assertEq(e.claimed, h.ghostPaidPerEpoch(i), "claimed == paid");
            assertEq(e.pot, rolledIn + h.ghostCredited(i), "pot == rolled in + credited");
            assertEq(e.settled, i < cur, "only past epochs settled");
            if (e.merkleRoot == bytes32(0)) assertEq(e.reserved, 0, "zero root => zero reserved");
            rolledIn = e.pot - e.reserved;
        }
    }

    /// @notice accounted == open pot + Σ settled (reserved - claimed) <= balance; total paid <= total in;
    ///         balance == total in - total paid (nothing else can leave).
    function invariant_Accounting() public view {
        uint64 cur = r.currentEpoch();
        uint256 owed = r.getEpoch(cur).pot;
        for (uint64 i; i < cur; ++i) {
            SparecycleRewards.Epoch memory e = r.getEpoch(i);
            owed += e.reserved - e.claimed;
        }
        uint256 bal = _balance();
        assertEq(r.accounted(), owed, "accounted formula");
        assertLe(r.accounted(), bal, "accounted <= balance");
        assertGe(bal, owed, "balance covers settled obligations + open pot");
        assertLe(h.ghostPaid(), h.ghostIn(), "paid <= funded");
        assertEq(bal, h.ghostIn() - h.ghostPaid(), "conservation");
        assertEq(r.unaccounted(), bal - r.accounted(), "unaccounted");
    }

    /// @notice No handler path observed an unexpected payout, revert or credit.
    function invariant_NoUnexpected() public view {
        assertEq(h.ghostUnexpected(), 0);
    }

    /// @notice Deterministic pass through every handler action, so a broken handler cannot hide behind
    ///         random sequences that never reach close/claim.
    function test_HandlerSmoke() public {
        uint256[5] memory w = [uint256(1), 2, 3, 4, 5];
        h.fund(10 ether);
        h.push(3 ether);
        h.forceEth(1 ether);
        h.escrowFees(2 ether, true);
        h.sync();
        h.close(type(uint256).max, 5, w, false);
        for (uint256 i; i < 5; ++i) {
            h.claim(0, i);
        }
        h.badClaim(0, 0, 1, address(0));
        h.badClaim(0, 1, 1, address(0xBAD));
        h.warp(1 days);
        h.close(1, 3, w, true);
        for (uint256 i; i < 3; ++i) {
            h.claim(1, i);
        }
        assertGt(h.calls("close"), 1);
        assertGt(h.calls("claim"), 4);
        invariant_PerEpochBounds();
        invariant_Accounting();
        invariant_NoUnexpected();
    }
}

contract SparecycleRewardsEthInvariantTest is RewardsInvariantBase {
    function setUp() public {
        _deploy(true);
    }
}

contract SparecycleRewardsTokenInvariantTest is RewardsInvariantBase {
    function setUp() public {
        _deploy(false);
    }
}
