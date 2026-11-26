// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SparecycleRewards} from "../../src/SparecycleRewards.sol";
import {SparecycleJobPaymentsV2} from "../../src/SparecycleJobPaymentsV2.sol";
import {SparecycleBurner} from "../../src/SparecycleBurner.sol";
import {SparecycleHolderPool} from "../../src/SparecycleHolderPool.sol";
import {MockPonsFeeEscrow} from "../mocks/MockPonsFeeEscrow.sol";
import {MockSpare, MockSwapAdapter} from "../mocks/V2Mocks.sol";
import {V2SystemHandler} from "./V2SystemHandler.sol";

/// @notice Stateful invariants of SparecycleJobPaymentsV2 + SparecycleHolderPool + SparecycleBurner.
///         The closed set {customers, V2, reward contract, treasury, burner, holder pool, swap adapter} starts with a
///         fixed amount of ETH and nothing is ever dealt afterwards, so any wei sent anywhere else breaks
///         `invariant_EthOnlyToAllowedPlaces`.
contract V2SystemInvariantTest is Test {
    uint256 internal constant PRICE = 1e14; // test value, not a market price
    uint256 internal constant ACTOR_ETH = 100 ether;
    uint256 internal constant ADAPTER_ETH = 1_000 ether;

    SparecycleRewards internal r;
    SparecycleJobPaymentsV2 internal pay;
    SparecycleHolderPool internal pool;
    SparecycleBurner internal burner;
    MockSpare internal spare;
    MockSwapAdapter internal adapter;
    V2SystemHandler internal h;
    address internal treasury = makeAddr("inv-treasury");
    address internal sched = makeAddr("inv-scheduler");
    address[3] internal actors;
    uint256 internal initialTotal;

    function setUp() public {
        vm.warp(1_750_000_000);
        MockPonsFeeEscrow escrow = new MockPonsFeeEscrow();
        r = new SparecycleRewards(makeAddr("inv-admin"), sched, address(0), address(escrow), 1 hours);
        spare = new MockSpare();
        adapter = new MockSwapAdapter(IERC20(address(spare)), PRICE);

        uint64 n = vm.getNonce(address(this));
        address v2At = vm.computeCreateAddress(address(this), n + 1);
        address poolAt = vm.computeCreateAddress(address(this), n + 2);
        burner = new SparecycleBurner(address(r), treasury, address(spare), address(adapter), v2At, true, 0.05 ether);
        pay = new SparecycleJobPaymentsV2(
            address(r), treasury, address(burner), poolAt, address(spare), address(adapter), 3 ether
        );
        pool = new SparecycleHolderPool(address(r), address(pay), treasury);

        actors = [makeAddr("inv-alice"), makeAddr("inv-bob"), makeAddr("inv-carol")];
        h = new V2SystemHandler(r, pay, pool, burner, spare, adapter, sched, treasury, actors, PRICE);
        for (uint256 i; i < 3; ++i) {
            vm.deal(actors[i], ACTOR_ETH);
        }
        vm.deal(address(adapter), ADAPTER_ETH);
        adapter.setShortBps(290); // every fill 2.90% below the pool price, like the Pons hook's cut
        initialTotal = 3 * ACTOR_ETH + ADAPTER_ETH;

        bytes4[] memory sel = new bytes4[](20);
        sel[0] = V2SystemHandler.deposit.selector;
        sel[1] = V2SystemHandler.depositFor.selector;
        sel[2] = V2SystemHandler.depositSpare.selector;
        sel[3] = V2SystemHandler.requestWithdraw.selector;
        sel[4] = V2SystemHandler.withdraw.selector;
        sel[5] = V2SystemHandler.requestWithdrawSpare.selector;
        sel[6] = V2SystemHandler.withdrawSpare.selector;
        sel[7] = V2SystemHandler.chargeEth.selector;
        sel[8] = V2SystemHandler.chargeSpare.selector;
        sel[9] = V2SystemHandler.chargeSpare.selector; // weighted: the most complex path
        sel[10] = V2SystemHandler.postPrice.selector;
        sel[11] = V2SystemHandler.movePool.selector;
        sel[12] = V2SystemHandler.closeEpoch.selector;
        sel[13] = V2SystemHandler.burn.selector;
        sel[14] = V2SystemHandler.postHolderRoot.selector;
        sel[15] = V2SystemHandler.claim.selector;
        sel[16] = V2SystemHandler.rollExpired.selector;
        sel[17] = V2SystemHandler.proposeSplit.selector;
        sel[18] = V2SystemHandler.fundReserve.selector;
        sel[19] = V2SystemHandler.withdrawReserve.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    function _sumEth() internal view returns (uint256 s) {
        for (uint256 i; i < 3; ++i) {
            s += actors[i].balance;
        }
        s += address(pay).balance + address(r).balance + treasury.balance + address(burner).balance
        + address(pool).balance + address(adapter).balance + address(h).balance;
    }

    /// @notice ETH goes only to: the node pot, the treasury, the burner, the holder pool, the adapter (only from the
    ///         burner, for buys) and customers' own withdrawals. Each balance equals exactly what the allowed paths
    ///         put in minus what they took out.
    function invariant_EthOnlyToAllowedPlaces() public view {
        assertEq(_sumEth(), initialTotal, "no ETH left the closed set");
        assertEq(address(r).balance, h.ghostPotFromV2(), "pot = what V2 charges sent");
        assertEq(r.accounted(), address(r).balance, "pot fully accounted in the reward contract");
        assertEq(treasury.balance, h.ghostToTreasury() + h.ghostReserveWithdrawn(), "treasury");
        assertEq(address(burner).balance, h.ghostToBurner() - burner.totalEthSpent(), "burner: in - buys");
        assertEq(address(pool).balance, h.ghostToPool() - h.ghostCredited(), "pool: in - credit claims");
        assertEq(
            address(adapter).balance, ADAPTER_ETH + burner.totalEthSpent() - h.ghostSwapEthIn(), "adapter: only swaps"
        );
        uint256 v2In = h.ghostDepositsTotal() + h.ghostCredited() + h.ghostReserveFunded() + h.ghostSwapEthIn();
        uint256 v2Out = h.ghostPotFromV2() + h.ghostToTreasury() + h.ghostToBurner() + h.ghostToPool()
            + h.ghostWithdrawnTotal() + h.ghostReserveWithdrawn();
        assertEq(address(pay).balance, v2In - v2Out, "V2: in - out");
    }

    /// @notice Credits can never be withdrawn: every customer's wallet equals start - what they paid in + what
    ///         they withdrew, and nobody ever withdrew more than was deposited for them.
    function invariant_CreditsNeverWithdrawn() public view {
        uint256 sumBal;
        uint256 sumCred;
        uint256 sumSpare;
        for (uint256 i; i < 3; ++i) {
            address a = actors[i];
            assertLe(h.ghostWithdrawn(a), h.ghostDepositedFor(a), "withdrawn <= deposited");
            assertEq(a.balance, ACTOR_ETH - h.ghostSpentByActor(a) + h.ghostWithdrawn(a), "wallet exact");
            sumBal += pay.balanceOf(a);
            sumCred += pay.creditOf(a);
            sumSpare += pay.spareBalanceOf(a);
        }
        assertEq(pay.totalBalance(), sumBal, "totalBalance");
        assertEq(pay.totalCredits(), sumCred, "totalCredits");
        assertEq(pay.totalSpareBalance(), sumSpare, "totalSpareBalance");
        assertEq(address(pay).balance, pay.totalBalance() + pay.totalCredits() + pay.discountReserve(), "V2 buckets");
        assertEq(spare.balanceOf(address(pay)), pay.totalSpareBalance(), "V2 SPARE");
    }

    /// @notice The node pot always gets exactly what ETH-paid charges of the same sizes give (so SPARE-paid jobs
    ///         are never underpaid), which is at least 95% of everything charged.
    function invariant_PotNeverUnderpaid() public view {
        assertEq(h.ghostPotFromV2(), h.ghostPotRequired(), "pot == ETH-equivalent share");
        assertGe(h.ghostPotFromV2() * 10_000, h.ghostChargedValue() * 9_500, "pot >= 95%");
    }

    /// @notice SPARE: supply only drops by V2's direct burns (the burner burns exactly what it buys), and the
    ///         holder pool never reserves more than it holds.
    function invariant_SpareAndPool() public view {
        assertEq(h.ghostBurnMismatch(), 0, "burn amounts");
        assertEq(spare.totalSupply() + h.ghostV2SpareBurned(), h.ghostSpareMinted(), "supply");
        assertLe(pool.outstanding(), address(pool).balance, "pool covers open roots");
        uint256 n = h.rootCount();
        for (uint256 i; i < n; ++i) {
            SparecycleHolderPool.RootInfo memory ri = pool.getRoot(h.rootEpochs(i));
            assertLe(ri.claimed, ri.total, "claimed <= total");
        }
    }

    /// @notice Owner decision (26-27 Nov 2026): with burner part 0 and 0% discount, a SPARE sale that passes the 4%
    ///         floor always gives the pot its full share by itself (no treasury, reserve or burner cover).
    function invariant_ZeroBurnerSpareNeedsNoCover() public view {
        assertEq(h.ghostSubsidizedAtZeroBurner(), 0, "a zero-burner SPARE charge needed cover");
    }

    function invariant_NoUnexpected() public view {
        assertEq(h.ghostUnexpected(), 0, string.concat("a guarded action reverted: ", vm.toString(h.lastUnexpected())));
    }

    /// @dev A long pseudo-random walk over the same handler actions: the deep paths are reached (not only
    ///      early returns) and every invariant holds at the end.
    function test_HandlerCoverage_RandomWalk() public {
        h.proposeSplit(200, 150); // a later Safe change gives the burner a share, so the burn path runs too
        for (uint256 i; i < 600; ++i) {
            uint256 s = uint256(keccak256(abi.encode(i)));
            uint256 a = s >> 8;
            uint256 b = s >> 72;
            uint256 c = s >> 136;
            uint256 k = s % 17;
            if (k == 0) h.deposit(a, b);
            else if (k == 1) h.depositFor(a, b, c);
            else if (k == 2) h.depositSpare(a, b);
            else if (k == 3) h.requestWithdraw(a, b);
            else if (k == 4) h.withdraw(a);
            else if (k == 5) h.chargeEth(a, b);
            else if (k == 6 || k == 7) h.chargeSpare(a, b, c, s >> 200);
            else if (k == 8) h.postPrice(b);
            else if (k == 9) h.movePool(b);
            else if (k == 10) h.closeEpoch(b);
            else if (k == 11) h.burn(b);
            else if (k == 12) h.postHolderRoot(b, c);
            else if (k == 13) h.claim(a, b);
            else if (k == 14) h.proposeSplit(b, c);
            else if (k == 15) h.fundReserve(a, b);
            else h.withdrawReserve(b);
        }
        emit log_named_uint("spare charges", h.ghostSpareCharges());
        emit log_named_uint("spare deferred", h.ghostSpareDeferred());
        emit log_named_uint("burns", h.ghostBurns());
        emit log_named_uint("claims", h.ghostClaims());
        assertGt(h.ghostSpareCharges(), 0, "SPARE charges ran");
        assertGt(h.ghostSpareDeferred(), 0, "SPARE charges were deferred");
        assertGt(h.ghostBurns(), 0, "burns ran");
        assertGt(h.ghostClaims(), 0, "claims ran");
        assertGt(burner.totalSpareBurned(), 0, "SPARE bought and burned");
        assertGt(h.ghostCredited(), 0, "credits paid out through claims");
        assertGt(h.ghostSpareChargesAtZeroBurner(), 0, "SPARE charges ran at the deployed burner part 0");
        invariant_EthOnlyToAllowedPlaces();
        invariant_CreditsNeverWithdrawn();
        invariant_PotNeverUnderpaid();
        invariant_SpareAndPool();
        invariant_ZeroBurnerSpareNeedsNoCover();
        invariant_NoUnexpected();
    }

    /// @dev The deployed values (burner part 0, 0% discount, 4% slippage): charges, SPARE sales and claims run, the
    ///      burner receives nothing, so no burn runs and no SPARE is burned.
    function test_HandlerSmoke_DeployedSplitNoBurn() public {
        for (uint256 i; i < 3; ++i) {
            h.deposit(i, 10 ether);
            h.depositSpare(i, 40_000 ether);
        }
        h.postPrice(10_000);
        h.chargeEth(0, 3 ether);
        h.chargeSpare(1, 0.5 ether, 0, 2 ether);
        h.closeEpoch(0);
        h.burn(0);
        h.postHolderRoot(1, 2);
        h.claim(0, 0);
        h.postPrice(10_000);
        h.chargeSpare(2, 1 ether, 1, 0);
        assertGt(h.ghostSpareChargesAtZeroBurner(), 1, "SPARE charges at burner part 0");
        assertEq(address(burner).balance, 0, "the burner got nothing");
        assertEq(h.ghostBurns(), 0, "nothing to burn");
        assertEq(h.ghostV2SpareBurned(), 0, "no SPARE burned in charges");
        assertGt(h.ghostClaims(), 0, "a claim ran");
        invariant_EthOnlyToAllowedPlaces();
        invariant_CreditsNeverWithdrawn();
        invariant_PotNeverUnderpaid();
        invariant_SpareAndPool();
        invariant_ZeroBurnerSpareNeedsNoCover();
        invariant_NoUnexpected();
    }

    /// @dev Shows that the handler really exercises the SPARE, burn, claim and deferral paths (after the Safe gives
    ///      the burner a share: the deployed burner part is 0).
    function test_HandlerSmoke() public {
        h.proposeSplit(200, 150);
        for (uint256 i; i < 4; ++i) {
            h.closeEpoch(0);
        }
        for (uint256 i; i < 3; ++i) {
            h.deposit(i, 10 ether);
            h.depositSpare(i, 40_000 ether);
        }
        h.postPrice(10_000);
        h.chargeEth(0, 3 ether);
        h.chargeSpare(1, 0.5 ether, 0, 2 ether);
        h.closeEpoch(0);
        h.burn(0);
        h.postHolderRoot(1, 2);
        h.claim(0, 0);
        h.claim(1, 0);
        h.postPrice(12_500); // +25%: paused
        h.chargeSpare(1, 0.5 ether, 0, 2 ether);
        h.chargeEth(2, 1 ether);
        h.closeEpoch(0);
        h.burn(0);
        assertGt(h.ghostSpareCharges(), 0, "a SPARE charge ran");
        assertGt(h.ghostBurns(), 0, "a burn ran");
        assertGt(h.ghostClaims(), 0, "a claim ran");
        assertGt(h.ghostSpareDeferred(), 0, "a SPARE charge was deferred");
        invariant_EthOnlyToAllowedPlaces();
        invariant_CreditsNeverWithdrawn();
        invariant_PotNeverUnderpaid();
        invariant_SpareAndPool();
        invariant_NoUnexpected();
    }
}
