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
///         The pool's hook takes 2.90% of every swap's output. The deployed values (decided by the owner on 26-27 Nov
///         2026: 0% SPARE discount, split 350 / 0 / 150, 4% slippage in both contracts) fit it: a SPARE-paid charge
///         pays the pot its full 95% from the sale alone (no discount reserve), the burner gets nothing, and a burn
///         buy (once the Safe gives the burner a share) passes its floor. A 2% setting would not.
contract V4AdapterWiringForkTest is V4ForkBase {
    address internal constant LIVE_REWARDS = 0x68A0569130551154FC1aABD71d99f65681c58Fe9; // ADDR.rewards
    address internal constant TREASURY_SAFE = 0xb262E4436aD6760F91e987f14e2fAc5D6550c71B; // ADDR.treasurySafe
    /// @dev What the scheduler asks of a sale on top of the hook cut (src/server/payments-v2.ts, SPARE_SALE_BUFFER_BPS).
    uint256 internal constant SCHEDULER_BUFFER_BPS = 100;

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
        // No discount reserve: the deployed values must not need one.

        // The epoch's SPARE price: the pool's spot price, accepted (the Safe anchors the reference first).
        uint256 spot = _spotPrice(); // read first: a prank applies to the next external call
        vm.prank(TREASURY_SAFE);
        pay.setReferenceSparePrice(spot);
        _postSpot();
    }

    function _postSpot() internal {
        uint64 open = r.currentEpoch();
        uint256 spot = _spotPrice();
        vm.prank(sched);
        pay.postSparePrice(open, spot);
        assertGt(pay.acceptedSparePrice(open), 0, "accepted");
    }

    function _one(address c, uint256 a) internal pure returns (address[] memory cs, uint256[] memory as_) {
        cs = new address[](1);
        as_ = new uint256[](1);
        cs[0] = c;
        as_[0] = a;
    }

    /// @dev No external call before the charge itself, so an expectRevert set by the caller applies to it.
    function _chargeWithSpare(uint64 id, uint256 ethLeg, uint256 spareEth, uint256 minEthOut) internal {
        address[] memory cs;
        uint256[] memory as_;
        if (ethLeg != 0) (cs, as_) = _one(ethCustomer, ethLeg);
        (address[] memory ss, uint256[] memory sa) = _one(spareCustomer, spareEth);
        vm.prank(sched);
        pay.chargeWithSpare(id, cs, as_, ss, sa, minEthOut, keccak256("v4-fork-spare"));
    }

    function _saleFloor(uint256 ethLeg, uint256 spareEth) internal view returns (uint256 floor) {
        SparecycleJobPaymentsV2.SpareStatus status;
        (status,, floor,,) = pay.previewSpareLeg(r.currentEpoch(), ethLeg, spareEth, type(uint128).max);
        assertEq(uint8(status), uint8(SparecycleJobPaymentsV2.SpareStatus.Ok));
    }

    /// @dev The scheduler's minEthOut: the sold SPARE's value at the posted price minus the hook cut and a 1% buffer,
    ///      never below the contract's floor.
    function _schedulerMinOut(uint256 ethLeg, uint256 spareEth) internal view returns (uint256 minOut) {
        uint64 id = r.currentEpoch();
        uint256 price = pay.acceptedSparePrice(id);
        uint256 owed = pay.spareOwed(id, spareEth);
        (, uint16 b,) = pay.currentSplit();
        uint256 sold = owed - (owed * b) / 10_000;
        uint256 value = (sold * price) / 1e18;
        minOut = (value * (10_000 - HOOK_CUT_BPS - SCHEDULER_BUFFER_BPS)) / 10_000;
        uint256 floor = _saleFloor(ethLeg, spareEth);
        if (minOut < floor) minOut = floor;
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

    // ================================================================ the deployed values

    function test_Fork_DeployedValuesAreTheOwnerDecisions() public view {
        assertEq(pay.maxSwapSlippageBps(), 400);
        assertEq(burner.maxSlippageBps(), 400);
        assertEq(pay.SPARE_DISCOUNT_BPS(), 0);
        (uint16 t, uint16 b, uint16 h) = pay.currentSplit();
        assertEq(t, 350);
        assertEq(b, 0);
        assertEq(h, 150);
        assertEq(pay.discountReserve(), 0);
    }

    /// @notice 0% discount, burner part 0, 4% slippage, real pool: a SPARE-only charge (no ETH leg, so no treasury
    ///         part to borrow from, and an empty discount reserve) pays the live pot exactly 95%; the sale's surplus
    ///         goes to the Safe; nothing is burned and the burner gets nothing. Then an ETH leg and a SPARE leg together.
    function test_Fork_ZeroDiscountSpareChargeNeedsNoSubsidy() public {
        uint64 id = r.currentEpoch();
        (SparecycleJobPaymentsV2.SpareStatus st,, uint256 floor, uint256 req, uint256 cover) =
            pay.previewSpareLeg(id, 0, 0.01 ether, _schedulerMinOut(0, 0.01 ether));
        assertEq(uint8(st), uint8(SparecycleJobPaymentsV2.SpareStatus.Ok), "no cover needed");
        assertEq(cover, 0, "nothing to cover from");
        assertGe(floor, req, "the 4% floor alone is above the pot share");

        uint256 potBefore = r.getEpoch(id).pot;
        uint256 safeBefore = TREASURY_SAFE.balance;
        uint256 supplyBefore = spare.totalSupply();
        uint256 owed = pay.spareOwed(id, 0.01 ether);
        uint256 minOut = _schedulerMinOut(0, 0.01 ether);
        _chargeWithSpare(id, 0, 0.01 ether, minOut);

        assertEq(r.getEpoch(id).pot - potBefore, 0.0095 ether, "the pot gets 95% of the SPARE job's price");
        uint256 surplus = TREASURY_SAFE.balance - safeBefore;
        assertGt(surplus, 0, "the sale gave more than the pot share");
        assertGe(0.0095 ether + surplus, minOut, "sale output met the scheduler's minimum");
        assertEq(pay.spareBalanceOf(spareCustomer), 1_000_000e18 - owed, "SPARE debited at the epoch price");
        assertEq(spare.totalSupply(), supplyBefore, "burner part 0: nothing burned");
        assertEq(address(burner).balance, 0);
        assertEq(pay.discountReserve(), 0);
        _assertV2Accounting();
        _assertAdapterEmpty();
        console2.log("SPARE charged:", owed);
        console2.log("sale output (wei):", 0.0095 ether + surplus);
        console2.log("scheduler minEthOut (wei):", minOut);
        console2.log("contract floor at 400 bps (wei):", floor);

        // ETH leg + SPARE leg: 350 bps of the ETH leg + the sale surplus to the Safe, 150 bps to the pool
        potBefore = r.getEpoch(id).pot;
        safeBefore = TREASURY_SAFE.balance;
        minOut = _schedulerMinOut(0.01 ether, 0.01 ether);
        _chargeWithSpare(id, 0.01 ether, 0.01 ether, minOut);
        assertEq(r.getEpoch(id).pot - potBefore, 0.019 ether, "95% of both legs");
        assertGe(TREASURY_SAFE.balance - safeBefore, 0.00035 ether, "350 bps plus the surplus");
        assertEq(address(pool).balance, 0.00015 ether, "150 bps of the ETH leg");
        assertEq(address(burner).balance, 0, "0 bps");
        assertEq(pay.discountReserve(), 0);
        _assertV2Accounting();
        _assertAdapterEmpty();

        // The epoch closes: the burner has nothing, so there is no burn (and no epoch used up).
        uint64 closed = _closeOpenEpoch();
        vm.prank(sched);
        vm.expectRevert(SparecycleBurner.NothingToBurn.selector);
        burner.burnEpoch(closed, 1);
        assertFalse(burner.epochHandled(closed));
    }

    /// @notice A 2% setting (the earlier default) is below the hook cut: the sale and the burn both revert at the
    ///         adapter's minimum check and nothing moves. This is why the owner set 4%.
    function test_Fork_TwoPercentWouldNotFitTheHookCut() public {
        vm.startPrank(TREASURY_SAFE);
        pay.setMaxSwapSlippageBps(200);
        burner.setMaxSlippageBps(200);
        vm.stopPrank();
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

    // ================================================================ end to end, after a Safe split change

    /// @notice The Safe gives the burner a share (200 / 150 / 150, applied 4 epochs later); at the default 4%
    ///         slippage a SPARE-paid charge then burns the burner part of the SPARE and sells the rest through the
    ///         real pool (pot paid in full), and after the epoch closes burnEpoch buys SPARE through the real pool and
    ///         burns it. The adapter holds nothing at any point after a call.
    function test_Fork_AfterSplitChange_SpareChargeAndBurnAtDefaults() public {
        vm.prank(TREASURY_SAFE);
        pay.proposeSplit(200, 150, 150);
        for (uint256 i; i < 4; ++i) {
            _closeOpenEpoch();
        }
        _postSpot();
        (, uint16 b,) = pay.currentSplit();
        assertEq(b, 150);

        // ---- SPARE-paid charge (with an ETH leg) in the open epoch
        uint64 id = r.currentEpoch();
        uint256 potBefore = r.getEpoch(id).pot;
        uint256 supplyBefore = spare.totalSupply();
        uint256 owed = pay.spareOwed(id, 0.01 ether);
        uint256 minOut = _schedulerMinOut(0.01 ether, 0.01 ether);
        _chargeWithSpare(id, 0.01 ether, 0.01 ether, minOut);

        assertEq(r.getEpoch(id).pot - potBefore, 0.0095 ether + 0.0095 ether, "the pot gets 95% of both legs");
        assertEq(pay.spareBalanceOf(spareCustomer), 1_000_000e18 - owed, "SPARE debited at the epoch price");
        uint256 burnedInCharge = (owed * 150) / 10_000; // N2b: the burner part of the current split
        assertEq(supplyBefore - spare.totalSupply(), burnedInCharge, "burner part of the SPARE burned");
        assertEq(pay.discountReserve(), 0, "no reserve was needed");
        _assertV2Accounting();
        _assertAdapterEmpty();

        // ---- burnEpoch for the epoch that just closed, at the default 4% slippage
        uint256 burnerEth = address(burner).balance;
        assertGt(burnerEth, 0, "the charge's burner part arrived");
        uint64 closed = _closeOpenEpoch();
        assertEq(closed, id);
        uint256 send = burnerEth < burner.maxEthPerBurn() ? burnerEth : burner.maxEthPerBurn();
        uint256 burnMin = burner.minOutFloor(send, pay.acceptedSparePrice(closed));
        supplyBefore = spare.totalSupply();
        vm.prank(sched);
        (uint256 ethIn, uint256 burned) = burner.burnEpoch(closed, burnMin);

        assertEq(ethIn, send, "ETH spent: the whole balance up to the cap");
        assertGe(burned, burnMin);
        assertEq(supplyBefore - spare.totalSupply(), burned, "bought SPARE burned (totalSupply fell)");
        assertEq(address(burner).balance, burnerEth - send, "the rest carries over");
        assertEq(spare.balanceOf(address(burner)), 0);
        assertTrue(burner.epochHandled(closed));
        _assertAdapterEmpty();
        console2.log("burn: ETH in (wei):", ethIn);
        console2.log("burn: SPARE burned:", burned);
        console2.log("burn: floor at 400 bps (SPARE):", burnMin);
    }
}
