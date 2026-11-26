// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V2Fixture} from "../v2/V2Fixture.sol";
import {UniswapV4SpareAdapter as Adapter} from "../../src/adapters/UniswapV4SpareAdapter.sol";
import {PoolKey} from "../../src/interfaces/IUniswapV4Minimal.sol";
import {MockPoolManager} from "../mocks/MockPoolManager.sol";

/// @notice The real UniswapV4SpareAdapter (over MockPoolManager) wired into SparecycleJobPaymentsV2 and
///         SparecycleBurner, so CI covers the wiring without a fork: V2 accepts the sale's ETH because it comes from
///         the adapter, and the 290 bps output fee (like the Pons hook) is above the 2% default slippage of both
///         contracts until the Safe raises it. The live-pool version is test/fork/V4AdapterWiringFork.t.sol.
contract UniswapV4SpareAdapterWiringTest is V2Fixture {
    uint256 internal constant RATE = 1e4; // SPARE base units per wei: 1 SPARE = 1e-4 ETH = PRICE
    uint16 internal constant RAISED_SLIPPAGE_BPS = 500;

    MockPoolManager internal pm;
    Adapter internal v4;

    function setUp() public override {
        super.setUp();
        pm = new MockPoolManager();
        address hook = address(new MockPoolManager()); // any contract: the mock calls no hooks
        pm.setPool(
            PoolKey({currency0: address(0), currency1: address(spareTok), fee: 0, tickSpacing: 200, hooks: hook}),
            uint160(1 << 96) * 100
        );
        pm.setRate(RATE);
        pm.setOutFeeBps(290);
        spareTok.mint(address(pm), 1e30);
        vm.deal(address(pm), 10_000 ether);
        v4 = new Adapter(address(pm), address(spareTok), 0, 200, hook);
        (burner, pay, pool) = _deploySystem(address(spareTok), address(v4), true);
    }

    function _assertAdapterEmpty() internal view {
        assertEq(address(v4).balance, 0);
        assertEq(spareTok.balanceOf(address(v4)), 0);
        assertEq(pm.deltaOf(address(0)), 0);
        assertEq(pm.deltaOf(address(spareTok)), 0);
    }

    function test_Wiring_SpareChargeSellsThroughTheAdapter() public {
        _deposit(bob, 10 ether);
        _spareDeposit(alice, 1_000_000 ether);
        vm.prank(carol);
        pay.fundDiscountReserve{value: 1 ether}();
        _anchorAndPost(PRICE);
        assertEq(address(pay.swapAdapter()), address(v4));

        // default 2%: the floor is above what a 2.90%-fee pool gives
        uint64 id = _open();
        uint256 floor = _floor(10 ether);
        (address[] memory cs, uint256[] memory as_) = _one(bob, 10 ether);
        (address[] memory ss, uint256[] memory sa) = _one(alice, 10 ether);
        vm.prank(sched);
        vm.expectPartialRevert(Adapter.InsufficientOutput.selector);
        pay.chargeWithSpare(id, cs, as_, ss, sa, floor, keccak256("l"));

        vm.prank(treasury);
        pay.setMaxSwapSlippageBps(RAISED_SLIPPAGE_BPS);
        floor = _floor(10 ether);
        uint256 potBefore = ethR.getEpoch(id).pot;
        uint256 supplyBefore = spareTok.totalSupply();
        uint256 owed = pay.spareOwed(id, 10 ether);
        _chargeSpareMin(bob, 10 ether, alice, 10 ether, floor);

        assertEq(ethR.getEpoch(id).pot - potBefore, 19 ether, "95% of both legs");
        uint256 burned = (owed * 150) / BPS;
        assertEq(supplyBefore - spareTok.totalSupply(), burned);
        uint256 sold = owed - burned;
        uint256 ethOut = sold / RATE - ((sold / RATE) * 290) / 10_000;
        assertGe(ethOut, floor);
        _assertV2Accounting();
        _assertAdapterEmpty();
    }

    function test_Wiring_BurnBuysThroughTheAdapter() public {
        vm.prank(funder);
        (bool ok,) = address(burner).call{value: 0.5 ether}("");
        assertTrue(ok);
        _anchorAndPost(PRICE);
        uint64 e = _closeEmpty(ethR);
        uint256 floor = burner.minOutFloor(0.5 ether, PRICE);
        vm.prank(sched);
        vm.expectPartialRevert(Adapter.InsufficientOutput.selector);
        burner.burnEpoch(e, floor);

        vm.prank(treasury);
        burner.setMaxSlippageBps(RAISED_SLIPPAGE_BPS);
        floor = burner.minOutFloor(0.5 ether, PRICE);
        uint256 supplyBefore = spareTok.totalSupply();
        vm.prank(sched);
        (uint256 ethIn, uint256 burnedOut) = burner.burnEpoch(e, floor);
        uint256 expected = 0.5 ether * RATE - (0.5 ether * RATE * 290) / 10_000;
        assertEq(ethIn, 0.5 ether);
        assertEq(burnedOut, expected, "the pool's output, net of the fee");
        assertEq(supplyBefore - spareTok.totalSupply(), expected, "burned");
        assertEq(address(burner).balance, 0);
        assertEq(spareTok.balanceOf(address(burner)), 0);
        _assertAdapterEmpty();
    }
}
