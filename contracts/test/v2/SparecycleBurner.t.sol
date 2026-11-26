// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {V2Fixture} from "./V2Fixture.sol";
import {SparecycleJobPaymentsV2} from "../../src/SparecycleJobPaymentsV2.sol";
import {SparecycleBurner} from "../../src/SparecycleBurner.sol";
import {SpareBurn} from "../../src/libraries/SpareBurn.sol";
import {MockSpare, MockSwapAdapter, FeeOnTransferSpare} from "../mocks/V2Mocks.sol";

contract SparecycleBurnerTest is V2Fixture {
    function _fundBurner(uint256 amount) internal {
        vm.prank(funder);
        (bool ok,) = address(burner).call{value: amount}("");
        assertTrue(ok);
    }

    /// @dev Posts an accepted price for the open epoch and closes it; returns the closed epoch id.
    function _pricedEpoch(uint256 price) internal returns (uint64 e) {
        if (pay.referenceSparePrice() == 0) {
            vm.prank(treasury);
            pay.setReferenceSparePrice(price);
        }
        _post(price);
        e = _closeEmpty(ethR);
    }

    function _burn(uint64 e, uint256 minOut) internal returns (uint256 ethIn, uint256 spareBurned) {
        vm.prank(sched);
        (ethIn, spareBurned) = burner.burnEpoch(e, minOut);
    }

    // ================================================================ construction

    function test_Constructor() public view {
        assertEq(address(burner.rewards()), address(ethR));
        assertEq(burner.treasury(), treasury);
        assertEq(address(burner.spare()), address(spareTok));
        assertEq(address(burner.swapAdapter()), address(adapter));
        assertEq(address(burner.priceSource()), address(pay));
        assertTrue(burner.useBurnFunction());
        assertEq(burner.maxEthPerBurn(), MAX_BURN);
        assertEq(burner.maxSlippageBps(), 400, "N12: 4% (owner, 26-27 Nov 2026)");
    }

    function test_Constructor_Rejects() public {
        vm.expectRevert(SparecycleBurner.ZeroAddress.selector);
        new SparecycleBurner(address(ethR), address(0), address(spareTok), address(adapter), alice, true, 1);
        vm.expectRevert(SparecycleBurner.NotEthRewards.selector);
        new SparecycleBurner(address(tokR), treasury, address(spareTok), address(adapter), alice, true, 1);
        vm.expectRevert(SparecycleBurner.OutOfRange.selector);
        new SparecycleBurner(address(ethR), treasury, address(spareTok), address(adapter), alice, true, 0);
        vm.expectRevert(abi.encodeWithSelector(SparecycleBurner.NoCode.selector, alice));
        new SparecycleBurner(address(ethR), treasury, alice, address(adapter), alice, true, 1);
    }

    // ================================================================ burnEpoch

    /// @notice Burn postponed (owner, 26-27 Nov 2026): with the deployed split the burner part is 0, so charges send
    ///         the burner nothing and `burnEpoch` has nothing to do (`NothingToBurn`, the epoch is not used up). ETH
    ///         and SPARE charges work as usual.
    function test_Burn_DefaultSplitSendsTheBurnerNothing() public {
        _deposit(alice, 100 ether);
        _spareDeposit(bob, 1_000_000 ether);
        _anchorAndPost(PRICE);
        _charge(alice, 40 ether);
        _chargeSpare(alice, 1 ether, bob, 1 ether);
        uint64 e = _closeEmpty(ethR);
        assertEq(address(burner).balance, 0, "burner part 0 bps");
        vm.prank(sched);
        vm.expectRevert(SparecycleBurner.NothingToBurn.selector);
        burner.burnEpoch(e, 1);
        assertFalse(burner.epochHandled(e), "a skipped burn uses nothing up");
        assertEq(burner.burnCount(), 0);
    }

    function test_Burn_FromChargesBuysAndBurns() public {
        _setSplit(200, 150, 150); // the Safe gives the burner a share (the deployed part is 0)
        _deposit(alice, 100 ether);
        _anchorAndPost(PRICE);
        _charge(alice, 40 ether); // burner part 150 bps = 0.6 ETH
        uint64 e = _closeEmpty(ethR);
        assertEq(address(burner).balance, 0.6 ether);
        uint256 floor = burner.minOutFloor(0.6 ether, PRICE);
        assertEq(floor, 6_000 ether * 96 / 100);
        uint256 supply = spareTok.totalSupply();
        vm.expectEmit(address(burner));
        emit SparecycleBurner.Burned(e, 0.6 ether, 6_000 ether);
        (uint256 ethIn, uint256 burned) = _burn(e, floor);
        assertEq(ethIn, 0.6 ether);
        assertEq(burned, 6_000 ether);
        assertEq(supply + 6_000 ether - spareTok.totalSupply(), 6_000 ether, "minted by the buy, then burned");
        assertEq(spareTok.balanceOf(address(burner)), 0);
        assertEq(address(burner).balance, 0);
        assertEq(burner.totalEthSpent(), 0.6 ether);
        assertEq(burner.totalSpareBurned(), 6_000 ether);
        assertTrue(burner.epochHandled(e));
    }

    function test_Burn_OnlyScheduler() public {
        _fundBurner(1 ether);
        uint64 e = _pricedEpoch(PRICE);
        vm.prank(stranger);
        vm.expectRevert(SparecycleBurner.NotScheduler.selector);
        burner.burnEpoch(e, 1);
        vm.prank(treasury);
        vm.expectRevert(SparecycleBurner.NotScheduler.selector);
        burner.burnEpoch(e, 1);
    }

    function test_Burn_EpochRules() public {
        _fundBurner(3 ether);
        vm.prank(sched);
        vm.expectRevert(
            abi.encodeWithSelector(SparecycleBurner.NotLastClosedEpoch.selector, uint64(0), type(uint64).max)
        );
        burner.burnEpoch(0, 1); // nothing closed yet
        uint64 e0 = _pricedEpoch(PRICE);
        uint64 e1 = _pricedEpoch(PRICE);
        uint256 floor = burner.minOutFloor(1 ether, PRICE);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleBurner.NotLastClosedEpoch.selector, e0, e1));
        burner.burnEpoch(e0, floor); // a skipped epoch cannot be burned later
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleBurner.NotLastClosedEpoch.selector, e1 + 1, e1));
        burner.burnEpoch(e1 + 1, floor); // the open epoch
        _burn(e1, floor);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleBurner.EpochAlreadyHandled.selector, e1));
        burner.burnEpoch(e1, floor); // once per epoch: no second buy
    }

    function test_Burn_NothingToBurn() public {
        uint64 e = _pricedEpoch(PRICE);
        vm.prank(sched);
        vm.expectRevert(SparecycleBurner.NothingToBurn.selector);
        burner.burnEpoch(e, 1);
    }

    /// @notice Brief 4 (2b): per-call cap, carry-over when capped.
    function test_Burn_CapAndCarryOver() public {
        _fundBurner(2.5 ether);
        uint64 e = _pricedEpoch(PRICE);
        uint256 floor = burner.minOutFloor(1 ether, PRICE);
        vm.expectEmit(address(burner));
        emit SparecycleBurner.Burned(e, 1 ether, 10_000 ether);
        vm.expectEmit(address(burner));
        emit SparecycleBurner.CarriedOver(e, 1.5 ether, SparecycleBurner.CarryReason.Cap);
        (uint256 ethIn,) = _burn(e, floor);
        assertEq(ethIn, 1 ether, "capped at maxEthPerBurn");
        assertEq(address(burner).balance, 1.5 ether, "the rest carries over");

        e = _pricedEpoch(PRICE);
        _burn(e, floor);
        assertEq(address(burner).balance, 0.5 ether);
        e = _pricedEpoch(PRICE);
        (ethIn,) = _burn(e, burner.minOutFloor(0.5 ether, PRICE));
        assertEq(ethIn, 0.5 ether);
        assertEq(address(burner).balance, 0);
        assertEq(burner.burnCount(), 3);
    }

    function test_Burn_NoAcceptedPriceCarriesEverything() public {
        _fundBurner(0.5 ether);
        vm.prank(treasury);
        pay.setReferenceSparePrice(PRICE);
        _post(PRICE * 2); // outside the band: SPARE paused this epoch
        uint64 e = _closeEmpty(ethR);
        vm.expectEmit(address(burner));
        emit SparecycleBurner.CarriedOver(e, 0.5 ether, SparecycleBurner.CarryReason.NoPrice);
        (uint256 ethIn, uint256 burned) = _burn(e, 1);
        assertEq(ethIn, 0);
        assertEq(burned, 0);
        assertEq(address(burner).balance, 0.5 ether);
        assertTrue(burner.epochHandled(e), "a row with a transaction hash, no buy");
        assertEq(burner.burnCount(), 0);
    }

    /// @notice Brief 4 (2b): minOut checked against the Safe-set max slippage.
    function test_Burn_MinOutFloor() public {
        _fundBurner(1 ether);
        uint64 e = _pricedEpoch(PRICE);
        uint256 floor = burner.minOutFloor(1 ether, PRICE);
        assertEq(floor, 9_600 ether, "value minus 4%");
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleBurner.MinOutBelowFloor.selector, floor - 1, floor));
        burner.burnEpoch(e, floor - 1);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleBurner.MinOutBelowFloor.selector, 0, floor));
        burner.burnEpoch(e, 0);
        // a looser Safe setting lowers the floor
        vm.prank(treasury);
        burner.setMaxSlippageBps(500);
        assertEq(burner.minOutFloor(1 ether, PRICE), 9_500 ether);
        _burn(e, 9_500 ether);
    }

    /// @notice Owner decision (26-27 Nov 2026): the 4% default leaves room for the Pons hook's 2.90% cut (taken in
    ///         SPARE on a buy) plus impact: a buy that gets 3.07% less than the epoch price still burns.
    function test_Burn_DefaultSlippageFitsTheHookCut() public {
        _fundBurner(1 ether);
        uint64 e = _pricedEpoch(PRICE);
        adapter.setShortBps(307);
        (uint256 ethIn, uint256 burned) = _burn(e, burner.minOutFloor(1 ether, PRICE));
        assertEq(ethIn, 1 ether);
        assertEq(burned, 9_693 ether);
    }

    function test_Burn_PoolMovedBeyondSlippageReverts() public {
        _fundBurner(1 ether);
        uint64 e = _pricedEpoch(PRICE);
        adapter.setPrice(PRICE * 105 / 100); // SPARE 5% dearer than the epoch price: fewer tokens per ETH
        uint256 floor = burner.minOutFloor(1 ether, PRICE);
        vm.prank(sched);
        vm.expectRevert(bytes("adapter: min out"));
        burner.burnEpoch(e, floor);
        assertEq(address(burner).balance, 1 ether, "nothing bought at any price");
    }

    function test_Burn_ShortOutputCaught() public {
        _fundBurner(1 ether);
        uint64 e = _pricedEpoch(PRICE);
        adapter.setIgnoreMinOut(true);
        adapter.setShortBps(500);
        uint256 floor = burner.minOutFloor(1 ether, PRICE);
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleBurner.InsufficientOutput.selector, 9_500 ether, floor));
        burner.burnEpoch(e, floor);
    }

    function test_Burn_FeeOnTransferOutputCaught() public {
        FeeOnTransferSpare fot = new FeeOnTransferSpare();
        MockSwapAdapter ad = new MockSwapAdapter(IERC20(address(fot)), PRICE);
        (SparecycleBurner b2, SparecycleJobPaymentsV2 p2,) = _deploySystem(address(fot), address(ad), false);
        fot.mint(address(ad), 1_000_000 ether);
        ad.setPayFromBalance(true); // a real transfer: the burner receives 1% less than the adapter sends
        vm.prank(funder);
        (bool ok,) = address(b2).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(treasury);
        p2.setReferenceSparePrice(PRICE);
        vm.prank(sched);
        p2.postSparePrice(0, PRICE);
        uint64 e = _closeEmpty(ethR);
        uint256 minOut = 10_000 ether; // what the adapter sends; the burner only gets 9,900
        vm.prank(sched);
        vm.expectRevert(abi.encodeWithSelector(SparecycleBurner.InsufficientOutput.selector, 9_900 ether, minOut));
        b2.burnEpoch(e, minOut);
        // with a minOut the fee leaves room for, the measured amount is what gets burned
        vm.prank(sched);
        (, uint256 burned) = b2.burnEpoch(e, 9_800 ether);
        assertEq(burned, 9_900 ether);
        assertEq(fot.balanceOf(SpareBurn.DEAD), 9_900 ether * 99 / 100, "dead address got it, minus the token's fee");
    }

    function test_Burn_AdapterRefundCountsOnlySpentEth() public {
        _fundBurner(1 ether);
        uint64 e = _pricedEpoch(PRICE);
        adapter.setRefundWei(0.1 ether); // the adapter swaps 0.9 ETH and sends 0.1 back
        vm.prank(treasury);
        burner.setMaxSlippageBps(1_000); // floor 9,000 SPARE for 1 ETH sent
        (uint256 ethIn, uint256 burned) = _burn(e, 9_000 ether);
        assertEq(ethIn, 0.9 ether);
        assertEq(burned, 9_000 ether);
        assertEq(address(burner).balance, 0.1 ether);
    }

    function test_Burn_DeadAddressMode() public {
        MockSpare tok = new MockSpare();
        MockSwapAdapter ad = new MockSwapAdapter(IERC20(address(tok)), PRICE);
        (SparecycleBurner b2, SparecycleJobPaymentsV2 p2,) = _deploySystem(address(tok), address(ad), false);
        vm.prank(funder);
        (bool ok,) = address(b2).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(treasury);
        p2.setReferenceSparePrice(PRICE);
        vm.prank(sched);
        p2.postSparePrice(0, PRICE);
        uint64 e = _closeEmpty(ethR);
        vm.prank(sched);
        b2.burnEpoch(e, 9_800 ether);
        assertEq(tok.balanceOf(SpareBurn.DEAD), 10_000 ether);
    }

    function test_Burn_ReentrancyBlocked() public {
        _fundBurner(1 ether);
        uint64 e = _pricedEpoch(PRICE);
        adapter.setHook(address(burner), abi.encodeCall(SparecycleBurner.burnEpoch, (e, 1)), 0);
        _burn(e, burner.minOutFloor(1 ether, PRICE));
        assertFalse(adapter.hookOk());
        assertEq(bytes4(adapter.hookErr()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(burner.burnCount(), 1);
    }

    // ================================================================ settings

    function test_Settings_OnlyTreasuryAndBounds() public {
        vm.startPrank(sched);
        vm.expectRevert(SparecycleBurner.NotTreasury.selector);
        burner.setMaxEthPerBurn(2 ether);
        vm.expectRevert(SparecycleBurner.NotTreasury.selector);
        burner.setMaxSlippageBps(100);
        vm.stopPrank();
        vm.startPrank(treasury);
        vm.expectRevert(SparecycleBurner.OutOfRange.selector);
        burner.setMaxEthPerBurn(0);
        vm.expectRevert(SparecycleBurner.OutOfRange.selector);
        burner.setMaxSlippageBps(1_001);
        burner.setMaxEthPerBurn(2 ether);
        burner.setMaxSlippageBps(0);
        vm.stopPrank();
        assertEq(burner.maxEthPerBurn(), 2 ether);
        assertEq(burner.minOutFloor(1 ether, PRICE), 10_000 ether, "zero slippage: full value");
    }

    // ================================================================ no exit except burn / delayed rescue

    function test_Rescue_OnlyAfterDelayWithNoBurn() public {
        _fundBurner(2 ether);
        vm.prank(stranger);
        vm.expectRevert(SparecycleBurner.NotTreasury.selector);
        burner.requestRescue();
        vm.prank(treasury);
        vm.expectRevert(SparecycleBurner.NoRescueRequest.selector);
        burner.executeRescue();

        vm.prank(treasury);
        burner.requestRescue();
        uint64 at = uint64(block.timestamp);
        vm.warp(block.timestamp + 30 days - 1);
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(SparecycleBurner.RescueNotReady.selector, at + 30 days));
        burner.executeRescue();

        // a burn after the request proves the pool works: the rescue is blocked
        uint64 e = _pricedEpoch(PRICE);
        _burn(e, burner.minOutFloor(1 ether, PRICE));
        vm.warp(block.timestamp + 1);
        vm.prank(treasury);
        vm.expectRevert(SparecycleBurner.BurnedSinceRescueRequest.selector);
        burner.executeRescue();

        // a fresh request, a long wait with no burn (the pool is gone): the rest goes to the treasury Safe only
        vm.prank(treasury);
        burner.requestRescue();
        vm.warp(block.timestamp + 30 days);
        vm.prank(sched); // the scheduler cannot trigger it
        vm.expectRevert(SparecycleBurner.NotTreasury.selector);
        burner.executeRescue();
        vm.prank(treasury);
        burner.executeRescue();
        assertEq(treasury.balance, 1 ether);
        assertEq(address(burner).balance, 0);
        assertEq(burner.rescueRequestedAt(), 0);
    }

    function test_Rescue_Cancel() public {
        vm.prank(treasury);
        burner.requestRescue();
        vm.prank(treasury);
        burner.cancelRescue();
        vm.warp(block.timestamp + 31 days);
        vm.prank(treasury);
        vm.expectRevert(SparecycleBurner.NoRescueRequest.selector);
        burner.executeRescue();
        vm.prank(treasury);
        vm.expectRevert(SparecycleBurner.NoRescueRequest.selector);
        burner.cancelRescue();
    }

    function test_RescueToken_NeverSpare() public {
        MockSpare other = new MockSpare();
        other.mint(address(burner), 2 ether);
        vm.prank(treasury);
        vm.expectRevert(SparecycleBurner.CannotRescueSpare.selector);
        burner.rescueToken(address(spareTok), 1);
        vm.prank(treasury);
        burner.rescueToken(address(other), 2 ether);
        assertEq(other.balanceOf(treasury), 2 ether);
    }

    /// @notice Fuzz: whatever the cap, slippage and balance, ETH leaves only through the adapter (a buy) and never
    ///         more than the cap per epoch.
    function testFuzz_Burn_OnlyBuyPathAndCap(uint96 balSeed, uint96 capSeed, uint16 slipSeed, uint8 epochs) public {
        uint256 bal = bound(uint256(balSeed), 1, 50 ether);
        uint256 cap = bound(uint256(capSeed), 1e9, 10 ether);
        uint16 slip = uint16(bound(slipSeed, 0, 1_000));
        vm.startPrank(treasury);
        burner.setMaxEthPerBurn(cap);
        burner.setMaxSlippageBps(slip);
        vm.stopPrank();
        _fundBurner(bal);
        uint256 adapterBefore = address(adapter).balance;
        uint256 n = bound(epochs, 1, 6);
        uint256 spent;
        for (uint256 i; i < n; ++i) {
            uint64 e = _pricedEpoch(PRICE);
            uint256 before = address(burner).balance;
            if (before == 0) break;
            uint256 send = before < cap ? before : cap;
            uint256 floor = burner.minOutFloor(send, PRICE);
            (uint256 ethIn,) = _burn(e, floor == 0 ? 1 : floor);
            assertLe(ethIn, cap, "never more than the cap per epoch");
            spent += ethIn;
        }
        assertEq(address(adapter).balance - adapterBefore, spent, "all ETH that left went into buys");
        assertEq(address(burner).balance, bal - spent);
        assertEq(treasury.balance, 0);
    }
}
