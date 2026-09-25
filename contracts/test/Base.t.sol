// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {MockPonsFeeEscrow} from "./mocks/MockPonsFeeEscrow.sol";
import {MockERC20} from "./mocks/Mocks.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

/// @notice Shared fixture: one ETH-mode and one ERC-20-mode reward contract on a mock escrow.
abstract contract RewardsFixture is Test {
    uint64 internal constant EPOCH = 1 days;
    uint256 internal constant T0 = 1_750_000_000;

    address internal admin = makeAddr("admin");
    address internal sched = makeAddr("scheduler");
    address internal stranger = makeAddr("stranger");
    address internal funder = makeAddr("funder");

    MockPonsFeeEscrow internal escrow;
    MockERC20 internal usdg;
    SparecycleRewards internal ethR;
    SparecycleRewards internal tokR;

    function setUp() public virtual {
        vm.warp(T0);
        escrow = new MockPonsFeeEscrow();
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        ethR = new SparecycleRewards(admin, sched, address(0), address(escrow), EPOCH);
        tokR = new SparecycleRewards(admin, sched, address(usdg), address(escrow), EPOCH);
        vm.deal(funder, 1_000_000 ether);
        usdg.mint(funder, 1e30);
        vm.prank(funder);
        usdg.approve(address(tokR), type(uint256).max);
    }

    // ---------------------------------------------------------------- helpers

    function _ops(uint256 n) internal returns (address[] memory a) {
        a = new address[](n);
        for (uint256 i; i < n; ++i) {
            a[i] = makeAddr(string.concat("op", vm.toString(i)));
        }
    }

    function _leaves(SparecycleRewards r, uint64 epochId, address[] memory accts, uint256[] memory amts)
        internal
        pure
        returns (bytes32[] memory leaves)
    {
        leaves = new bytes32[](accts.length);
        for (uint256 i; i < accts.length; ++i) {
            leaves[i] = r.leafOf(epochId, accts[i], amts[i]);
        }
    }

    function _sum(uint256[] memory a) internal pure returns (uint256 s) {
        for (uint256 i; i < a.length; ++i) {
            s += a[i];
        }
    }

    function _fund(SparecycleRewards r, uint256 amount) internal {
        bool eth = r.payoutToken() == address(0); // read before prank: the view call would consume it
        vm.prank(funder);
        if (eth) r.fund{value: amount}();
        else r.fundToken(amount);
    }

    function _bal(SparecycleRewards r, address a) internal view returns (uint256) {
        return r.payoutToken() == address(0) ? a.balance : usdg.balanceOf(a);
    }

    function _warpToEnd(SparecycleRewards r) internal {
        SparecycleRewards.Epoch memory e = r.getEpoch(r.currentEpoch());
        uint256 end = uint256(e.startedAt) + r.epochLength();
        if (block.timestamp < end) vm.warp(end);
    }

    /// @dev Warps to the end of the open epoch and posts a root over (accts, amts) with reserved = Σ amts.
    function _close(SparecycleRewards r, address[] memory accts, uint256[] memory amts)
        internal
        returns (uint64 epochId, bytes32[] memory leaves, bytes32 root)
    {
        epochId = r.currentEpoch();
        leaves = _leaves(r, epochId, accts, amts);
        root = MerkleHelper.root(leaves);
        _warpToEnd(r);
        vm.prank(sched);
        r.closeEpochAndPostRoot(epochId, root, _sum(amts));
    }

    function _closeEmpty(SparecycleRewards r) internal returns (uint64 epochId) {
        epochId = r.currentEpoch();
        _warpToEnd(r);
        vm.prank(sched);
        r.closeEpochAndPostRoot(epochId, bytes32(0), 0);
    }

    function _claim(SparecycleRewards r, uint64 epochId, bytes32[] memory leaves, address who, uint256 amount)
        internal
    {
        bytes32[] memory p = MerkleHelper.proof(leaves, r.leafOf(epochId, who, amount));
        vm.prank(who);
        r.claim(epochId, amount, p);
    }

    /// @dev accounted == open pot + Σ settled (reserved - claimed), and accounted <= balance.
    function _assertAccounting(SparecycleRewards r) internal view {
        uint64 cur = r.currentEpoch();
        uint256 expected = r.getEpoch(cur).pot;
        for (uint64 i; i < cur; ++i) {
            SparecycleRewards.Epoch memory e = r.getEpoch(i);
            assertTrue(e.settled, "past epoch settled");
            assertLe(e.reserved, e.pot, "reserved <= pot");
            assertLe(e.claimed, e.reserved, "claimed <= reserved");
            expected += e.reserved - e.claimed;
        }
        assertEq(r.accounted(), expected, "accounted formula");
        assertLe(r.accounted(), _bal(r, address(r)), "accounted <= balance");
    }
}
