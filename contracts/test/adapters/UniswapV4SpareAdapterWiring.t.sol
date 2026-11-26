// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {V2Fixture} from "../v2/V2Fixture.sol";
import {UniswapV4SpareAdapter as Adapter} from "../../src/adapters/UniswapV4SpareAdapter.sol";
import {PoolKey} from "../../src/interfaces/IUniswapV4Minimal.sol";
import {MockPoolManager} from "../mocks/MockPoolManager.sol";

/// @notice The real UniswapV4SpareAdapter (over MockPoolManager) wired into SparecycleJobPaymentsV2 and
///         SparecycleBurner, so CI covers the wiring without a fork: V2 accepts the sale's ETH because it comes from
///         the adapter, and the 290 bps output fee (like the Pons hook) fits the 4% default slippage of both contracts
///         (decided by the owner on 26-27 Nov 2026); a 2% setting would not. The live-pool version is
///         test/fork/V4AdapterWiringFork.t.sol.
contract UniswapV4SpareAdapterWiringTest is V2Fixture {
    uint256 internal constant RATE = 1e4; // SPARE base units per wei: 1 SPARE = 1e-4 ETH = PRICE
    uint16 internal constant TOO_TIGHT_SLIPPAGE_BPS = 200;

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

    /// @notice Deployed values (0% discount, burner part 0, 4% slippage): a SPARE-paid charge sells all of its SPARE
    ///         through the adapter, pays the pot its full 95% with no ETH leg and no discount reserve, and burns
    ///         nothing. A 2% setting is below the fee and the adapter refuses the fill.
    function test_Wiring_SpareChargeSellsThroughTheAdapter() public {
        _deposit(bob, 10 ether);
        _spareDeposit(alice, 1_000_000 ether);
        _anchorAndPost(PRICE);
        assertEq(address(pay.swapAdapter()), address(v4));
        assertEq(pay.discountReserve(), 0);

        uint64 id = _open();
        vm.prank(treasury);
        pay.setMaxSwapSlippageBps(TOO_TIGHT_SLIPPAGE_BPS);
        uint256 floor = _floor(10 ether);
        (address[] memory cs, uint256[] memory as_) = _none();
        (address[] memory ss, uint256[] memory sa) = _one(alice, 10 ether);
        vm.prank(sched);
        vm.expectPartialRevert(Adapter.InsufficientOutput.selector);
        pay.chargeWithSpare(id, cs, as_, ss, sa, floor, keccak256("l"));

        uint16 deflt = pay.DEFAULT_MAX_SWAP_SLIPPAGE_BPS();
        vm.prank(treasury);
        pay.setMaxSwapSlippageBps(deflt);
        floor = _floor(10 ether);
        assertEq(floor, 9.6 ether);
        uint256 potBefore = ethR.getEpoch(id).pot;
        uint256 supplyBefore = spareTok.totalSupply();
        uint256 owed = pay.spareOwed(id, 10 ether);
        assertEq(owed, 100_000 ether, "no discount");
        _chargeSpareMin(bob, 0, alice, 10 ether, floor);

        assertEq(ethR.getEpoch(id).pot - potBefore, 9.5 ether, "95% of the SPARE job's ETH price");
        assertEq(spareTok.totalSupply(), supplyBefore, "burner part 0: nothing burned");
        uint256 ethOut = owed / RATE - ((owed / RATE) * 290) / 10_000;
        assertEq(ethOut, 9.71 ether);
        assertEq(treasury.balance, ethOut - 9.5 ether, "the sale covered the pot; the rest to the treasury");
        assertEq(pay.discountReserve(), 0, "no subsidy");
        assertEq(address(burner).balance, 0);
        _assertV2Accounting();
        _assertAdapterEmpty();
    }

    /// @notice The burn buy through the adapter at the 4% default (with ETH the Safe sent; V2's burner part is 0).
    function test_Wiring_BurnBuysThroughTheAdapter() public {
        vm.prank(funder);
        (bool ok,) = address(burner).call{value: 0.5 ether}("");
        assertTrue(ok);
        _anchorAndPost(PRICE);
        uint64 e = _closeEmpty(ethR);
        vm.prank(treasury);
        burner.setMaxSlippageBps(TOO_TIGHT_SLIPPAGE_BPS);
        uint256 floor = burner.minOutFloor(0.5 ether, PRICE);
        vm.prank(sched);
        vm.expectPartialRevert(Adapter.InsufficientOutput.selector);
        burner.burnEpoch(e, floor);

        uint16 deflt = burner.DEFAULT_MAX_SLIPPAGE_BPS();
        vm.prank(treasury);
        burner.setMaxSlippageBps(deflt);
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
