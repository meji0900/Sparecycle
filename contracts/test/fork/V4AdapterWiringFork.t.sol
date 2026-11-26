// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {SparecycleJobPaymentsV2} from "../../src/SparecycleJobPaymentsV2.sol";
import {SparecycleBurner} from "../../src/SparecycleBurner.sol";
import {SparecycleHolderPool} from "../../src/SparecycleHolderPool.sol";
import {UniswapV4SpareAdapter as Adapter} from "../../src/adapters/UniswapV4SpareAdapter.sol";
import {V4ForkBase} from "./V4ForkBase.sol";

interface ILiveRewardsV4Wiring {
    struct Epoch {
        uint64 index;
        uint64 startedAt;
        uint64 endedAt;
        uint256 pot;
        uint256 reserved;
        uint256 claimed;
        bytes32 merkleRoot;
        bool settled;
    }

    function currentEpoch() external view returns (uint64);
    function scheduler() external view returns (address);
    function owner() external view returns (address);
    function epochLength() external view returns (uint64);
    function getEpoch(uint64 epochId) external view returns (Epoch memory);
    function closeEpochAndPostRoot(uint64 epochId, bytes32 merkleRoot, uint256 reserved) external;
}

/// @notice The real UniswapV4SpareAdapter wired into freshly deployed SparecycleBurner + SparecycleJobPaymentsV2 +
///         SparecycleHolderPool, against the live SparecycleRewards, the treasury Safe and the live SPARE/ETH pool, on
///         a local fork (nothing is broadcast). Opt-in, like the other fork suites:
///           FORK_TESTS=1 [FORK_RPC_URL=<rpc>] node contracts/tools/forge.mjs test --match-path "test/fork/*V4*" -vv
///         The pool's hook takes 2.90% of every swap's output, more than the 2% default slippage of both contracts,
///         so with the defaults neither the SPARE sale nor the burn buy can pass its floor; after the Safe raises the
///         slippage (500 bps here, a test value within the 1,000 bps hard limit) both go through end to end.
contract V4AdapterWiringForkTest is V4ForkBase {
    address internal constant LIVE_REWARDS = 0x68A0569130551154FC1aABD71d99f65681c58Fe9; // ADDR.rewards
    address internal constant TREASURY_SAFE = 0xb262E4436aD6760F91e987f14e2fAc5D6550c71B; // ADDR.treasurySafe
    /// @dev Test value for the Safe-set slippage of both contracts: above the 290 bps hook cut plus impact.
    uint16 internal constant TEST_SLIPPAGE_BPS = 500;

    ILiveRewardsV4Wiring internal r = ILiveRewardsV4Wiring(LIVE_REWARDS);
    SparecycleBurner internal burner;
    SparecycleJobPaymentsV2 internal pay;
    SparecycleHolderPool internal pool;
    address internal sched;
    address internal spareCustomer = makeAddr("v4-fork-spare-customer");
    address internal ethCustomer = makeAddr("v4-fork-eth-customer");
    address internal funder = makeAddr("v4-fork-funder");

    function setUp() public {
        if (!_forkOrSkip()) return;
        assertEq(r.owner(), TREASURY_SAFE, "the live reward contract is owned by the treasury Safe");
        sched = r.scheduler();
        _deployAdapter();

        // N12 cap: 1% of the pool's ETH side, read live (as the deploy would).
        uint256 cap = _ethReserve() / 100;
        uint64 n = vm.getNonce(address(this));
        address v2At = vm.computeCreateAddress(address(this), n + 1);
        address poolAt = vm.computeCreateAddress(address(this), n + 2);
        burner = new SparecycleBurner(LIVE_REWARDS, TREASURY_SAFE, SPARE, address(adapter), v2At, true, cap);
        pay = new SparecycleJobPaymentsV2(
            LIVE_REWARDS, TREASURY_SAFE, address(burner), poolAt, SPARE, address(adapter), 1 ether
        );
        pool = new SparecycleHolderPool(LIVE_REWARDS, address(pay), TREASURY_SAFE);
        assertEq(address(pay), v2At);
        assertEq(address(pool), poolAt);

        vm.deal(ethCustomer, 1 ether);
        vm.deal(funder, 1 ether);
        deal(SPARE, spareCustomer, 1_000_000e18, true);
        vm.startPrank(spareCustomer);
        spare.approve(address(pay), 1_000_000e18);
        pay.depositSpare(1_000_000e18);
        vm.stopPrank();
        vm.prank(ethCustomer);
        pay.deposit{value: 0.05 ether}();
        vm.prank(funder);
        pay.fundDiscountReserve{value: 0.01 ether}();

        // The epoch's SPARE price: the pool's spot price, accepted (the Safe anchors the reference first).
        uint256 price = _spotPrice();
        uint64 open = r.currentEpoch();
        vm.prank(TREASURY_SAFE);
        pay.setReferenceSparePrice(price);
        vm.prank(sched);
        pay.postSparePrice(open, price);
    }

    function _one(address c, uint256 a) internal pure returns (address[] memory cs, uint256[] memory as_) {
        cs = new address[](1);
        as_ = new uint256[](1);
        cs[0] = c;
        as_[0] = a;
    }

    /// @dev No external call before the charge itself, so an expectRevert set by the caller applies to it.
    function _chargeWithSpare(uint64 id, uint256 ethLeg, uint256 spareEth, uint256 minEthOut) internal {
        (address[] memory cs, uint256[] memory as_) = _one(ethCustomer, ethLeg);
        (address[] memory ss, uint256[] memory sa) = _one(spareCustomer, spareEth);
        vm.prank(sched);
        pay.chargeWithSpare(id, cs, as_, ss, sa, minEthOut, keccak256("v4-fork-spare"));
    }

    function _saleFloor(uint256 ethLeg, uint256 spareEth) internal view returns (uint256 floor) {
        SparecycleJobPaymentsV2.SpareStatus status;
        (status,, floor,,) = pay.previewSpareLeg(r.currentEpoch(), ethLeg, spareEth, type(uint128).max);
        assertEq(uint8(status), uint8(SparecycleJobPaymentsV2.SpareStatus.Ok));
    }

    function _closeOpenEpoch() internal returns (uint64 id) {
        id = r.currentEpoch();
        uint256 end = uint256(r.getEpoch(id).startedAt) + r.epochLength();
        if (block.timestamp < end) vm.warp(end);
        vm.prank(sched);
        r.closeEpochAndPostRoot(id, bytes32(0), 0);
        assertEq(r.currentEpoch(), id + 1);
    }

    function _assertV2Accounting() internal view {
        assertEq(address(pay).balance, pay.totalBalance() + pay.totalCredits() + pay.discountReserve(), "v2 eth");
        assertEq(spare.balanceOf(address(pay)), pay.totalSpareBalance(), "v2 spare");
    }

    // ================================================================ the defaults cannot pay the hook

    /// @notice With the 2% defaults, the floor of a sale (and of a burn) is above what the pool can give after the
    ///         hook's 2.90% cut, so the adapter's own minimum check reverts and nothing moves.
    function test_Fork_DefaultSlippageIsBelowTheHookCut() public {
        assertEq(pay.maxSwapSlippageBps(), 200);
        assertEq(burner.maxSlippageBps(), 200);
        uint64 open = r.currentEpoch();
        uint256 floor = _saleFloor(0.01 ether, 0.01 ether);
        vm.expectPartialRevert(Adapter.InsufficientOutput.selector);
        _chargeWithSpare(open, 0.01 ether, 0.01 ether, floor);

        vm.prank(funder);
        (bool ok,) = address(burner).call{value: 0.01 ether}("");
        assertTrue(ok);
        uint64 id = _closeOpenEpoch();
        uint256 burnFloor = burner.minOutFloor(0.01 ether, pay.acceptedSparePrice(id));
        vm.expectPartialRevert(Adapter.InsufficientOutput.selector);
        vm.prank(sched);
        burner.burnEpoch(id, burnFloor);
        assertFalse(burner.epochHandled(id), "the failed burn left the epoch open for a retry");
        _assertAdapterEmpty();
    }

    // ================================================================ end to end

    /// @notice Safe raises both slippages; then a SPARE-paid charge sells SPARE through the real pool (pot paid in
    ///         full, burner part of the SPARE burned), and after the epoch closes burnEpoch buys SPARE through the
    ///         real pool and burns it. The adapter holds nothing at any point after a call.
    function test_Fork_SpareChargeAndBurnEndToEnd() public {
        vm.startPrank(TREASURY_SAFE);
        pay.setMaxSwapSlippageBps(TEST_SLIPPAGE_BPS);
        burner.setMaxSlippageBps(TEST_SLIPPAGE_BPS);
        vm.stopPrank();

        // ---- SPARE-paid charge (with an ETH leg) in the open epoch
        uint64 id = r.currentEpoch();
        uint256 potBefore = r.getEpoch(id).pot;
        uint256 supplyBefore = spare.totalSupply();
        uint256 owed = pay.spareOwed(id, 0.01 ether);
        uint256 floor = _saleFloor(0.01 ether, 0.01 ether);
        _chargeWithSpare(id, 0.01 ether, 0.01 ether, floor);

        assertEq(r.getEpoch(id).pot - potBefore, 0.0095 ether + 0.0095 ether, "the pot gets 95% of both legs");
        assertEq(pay.spareBalanceOf(spareCustomer), 1_000_000e18 - owed, "SPARE debited at the epoch price");
        uint256 burnedInCharge = (owed * 150) / 10_000; // N2b: the burner part of the current split
        assertEq(supplyBefore - spare.totalSupply(), burnedInCharge, "burner part of the SPARE burned");
        _assertV2Accounting();
        _assertAdapterEmpty();
        console2.log("SPARE charged:", owed);
        console2.log("sale floor (wei):", floor);

        // ---- burnEpoch for the epoch that just closed
        vm.prank(funder);
        (bool ok,) = address(burner).call{value: 0.01 ether}("");
        assertTrue(ok);
        uint256 burnerEth = address(burner).balance;
        assertGt(burnerEth, 0.01 ether, "the charge's burner part arrived too");
        uint64 closed = _closeOpenEpoch();
        assertEq(closed, id);
        uint256 send = burnerEth < burner.maxEthPerBurn() ? burnerEth : burner.maxEthPerBurn();
        uint256 minOut = burner.minOutFloor(send, pay.acceptedSparePrice(closed));
        supplyBefore = spare.totalSupply();
        vm.prank(sched);
        (uint256 ethIn, uint256 burned) = burner.burnEpoch(closed, minOut);

        assertEq(ethIn, send, "ETH spent: the whole balance up to the cap");
        assertGe(burned, minOut);
        assertEq(supplyBefore - spare.totalSupply(), burned, "bought SPARE burned (totalSupply fell)");
        assertEq(address(burner).balance, burnerEth - send, "the rest carries over");
        assertEq(spare.balanceOf(address(burner)), 0);
        assertTrue(burner.epochHandled(closed));
        _assertAdapterEmpty();
        console2.log("burn: ETH in (wei):", ethIn);
        console2.log("burn: SPARE burned:", burned);
        console2.log("burn: floor at 500 bps (SPARE):", minOut);
    }
}
