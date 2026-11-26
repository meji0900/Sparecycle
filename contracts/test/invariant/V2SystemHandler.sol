// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SparecycleRewards} from "../../src/SparecycleRewards.sol";
import {SparecycleJobPaymentsV2} from "../../src/SparecycleJobPaymentsV2.sol";
import {SparecycleBurner} from "../../src/SparecycleBurner.sol";
import {SparecycleHolderPool} from "../../src/SparecycleHolderPool.sol";
import {MockSpare, MockSwapAdapter} from "../mocks/V2Mocks.sol";
import {MerkleHelper} from "../utils/MerkleHelper.sol";

/// @notice Drives the whole V2 system: deposits, depositFor, SPARE deposits, withdrawals, holder-pool roots and
///         credit claims, ETH charges, SPARE charges (with moving pool prices), price posts, split changes, epoch
///         closes, burns and the discount reserve. Every action checks its preconditions first; any revert that
///         still happens is counted as unexpected (the invariant `NoUnexpected` requires zero).
contract V2SystemHandler is Test {
    uint256 internal constant BPS = 10_000;

    SparecycleRewards public r;
    SparecycleJobPaymentsV2 public pay;
    SparecycleHolderPool public pool;
    SparecycleBurner public burner;
    MockSpare public spare;
    MockSwapAdapter public adapter;
    address public sched;
    address public treasury;
    address[3] public actors;
    uint256 public basePrice;

    // ---- ghosts: ETH
    mapping(address => uint256) public ghostSpentByActor; // own deposits + depositFor paid + reserve funded
    mapping(address => uint256) public ghostDepositedFor; // withdrawable ETH credited to the actor
    mapping(address => uint256) public ghostWithdrawn;
    uint256 public ghostDepositsTotal;
    uint256 public ghostWithdrawnTotal;
    uint256 public ghostCredited;
    uint256 public ghostReserveFunded;
    uint256 public ghostReserveWithdrawn;
    uint256 public ghostSwapEthIn; // ETH the adapter paid V2 for SPARE
    uint256 public ghostPotFromV2;
    uint256 public ghostToTreasury; // from charges (incl. sale surplus)
    uint256 public ghostToBurner;
    uint256 public ghostToPool;
    uint256 public ghostPotRequired; // sum  what ETH-paid charges of the same size give the pot
    uint256 public ghostChargedValue; // sum  ETH charged + sum  ETH value of SPARE-paid jobs

    // ---- ghosts: SPARE
    uint256 public ghostSpareMinted;
    uint256 public ghostV2SpareBurned;
    uint256 public ghostSpareWithdrawn;

    // ---- ghosts: outcomes
    uint256 public ghostUnexpected;
    bytes public lastUnexpected;
    uint256 public ghostBurnMismatch;
    uint256 public ghostSpareCharges;
    uint256 public ghostSpareChargesAtZeroBurner;
    /// @notice SPARE charges made with burner part 0 whose sale gave the pot less than its share (needed cover).
    ///         Owner decision (26-27 Nov 2026): at 0% discount and 4% slippage this never happens.
    uint256 public ghostSubsidizedAtZeroBurner;
    uint256 public ghostSpareDeferred;
    uint256 public ghostBurns;
    uint256 public ghostClaims;

    // ---- holder roots
    uint64[] public rootEpochs;
    mapping(uint64 => bytes32[]) internal _leaves;
    mapping(uint64 => mapping(address => uint256)) public leafAmount;
    mapping(uint64 => mapping(address => bool)) public hasLeaf;

    constructor(
        SparecycleRewards r_,
        SparecycleJobPaymentsV2 pay_,
        SparecycleHolderPool pool_,
        SparecycleBurner burner_,
        MockSpare spare_,
        MockSwapAdapter adapter_,
        address sched_,
        address treasury_,
        address[3] memory actors_,
        uint256 basePrice_
    ) {
        r = r_;
        pay = pay_;
        pool = pool_;
        burner = burner_;
        spare = spare_;
        adapter = adapter_;
        sched = sched_;
        treasury = treasury_;
        actors = actors_;
        basePrice = basePrice_;
    }

    receive() external payable {}

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % 3];
    }

    function _unexpected(bytes memory err) internal {
        ghostUnexpected += 1;
        lastUnexpected = err;
    }

    // ================================================================ customers

    function deposit(uint256 aSeed, uint256 amount) external {
        address a = _actor(aSeed);
        uint256 bal = a.balance;
        if (bal == 0) return;
        amount = bound(amount, 1, bal < 5 ether ? bal : 5 ether);
        vm.prank(a);
        try pay.deposit{value: amount}() {
            ghostSpentByActor[a] += amount;
            ghostDepositedFor[a] += amount;
            ghostDepositsTotal += amount;
        } catch (bytes memory e) {
            _unexpected(e);
        }
    }

    function depositFor(uint256 payerSeed, uint256 aSeed, uint256 amount) external {
        address payer = _actor(payerSeed);
        address a = _actor(aSeed);
        uint256 bal = payer.balance;
        if (bal == 0) return;
        amount = bound(amount, 1, bal < 2 ether ? bal : 2 ether);
        vm.prank(payer);
        try pay.depositFor{value: amount}(a) {
            ghostSpentByActor[payer] += amount;
            ghostDepositedFor[a] += amount;
            ghostDepositsTotal += amount;
        } catch (bytes memory e) {
            _unexpected(e);
        }
    }

    function depositSpare(uint256 aSeed, uint256 amount) external {
        address a = _actor(aSeed);
        amount = bound(amount, 1, 50_000 ether);
        _mintAndDepositSpare(a, amount);
    }

    function _mintAndDepositSpare(address a, uint256 amount) internal {
        spare.mint(a, amount);
        ghostSpareMinted += amount;
        vm.startPrank(a);
        spare.approve(address(pay), amount);
        try pay.depositSpare(amount) {}
        catch (bytes memory e) {
            _unexpected(e);
        }
        vm.stopPrank();
    }

    function requestWithdraw(uint256 aSeed, uint256 amount) external {
        address a = _actor(aSeed);
        uint256 bal = pay.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        try pay.requestWithdraw(amount) {}
        catch (bytes memory e) {
            _unexpected(e);
        }
    }

    function withdraw(uint256 aSeed) external {
        address a = _actor(aSeed);
        if (!pay.canWithdraw(a)) return;
        uint256 before = a.balance;
        vm.prank(a);
        try pay.withdraw() {
            uint256 got = a.balance - before;
            ghostWithdrawn[a] += got;
            ghostWithdrawnTotal += got;
        } catch (bytes memory e) {
            _unexpected(e);
        }
    }

    function requestWithdrawSpare(uint256 aSeed, uint256 amount) external {
        address a = _actor(aSeed);
        uint256 bal = pay.spareBalanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        try pay.requestWithdrawSpare(amount) {}
        catch (bytes memory e) {
            _unexpected(e);
        }
    }

    function withdrawSpare(uint256 aSeed) external {
        address a = _actor(aSeed);
        if (!pay.canWithdrawSpare(a)) return;
        uint256 before = spare.balanceOf(a);
        vm.prank(a);
        try pay.withdrawSpare() {
            ghostSpareWithdrawn += spare.balanceOf(a) - before;
        } catch (bytes memory e) {
            _unexpected(e);
        }
    }

    // ================================================================ scheduler: charges

    struct Snap {
        uint256 rewards;
        uint256 treasury;
        uint256 burner;
        uint256 pool;
        uint256 adapter;
        uint256 supply;
    }

    function _snap() internal view returns (Snap memory s) {
        s.rewards = address(r).balance;
        s.treasury = treasury.balance;
        s.burner = address(burner).balance;
        s.pool = address(pool).balance;
        s.adapter = address(adapter).balance;
        s.supply = spare.totalSupply();
    }

    function _recordFlows(Snap memory b) internal {
        ghostPotFromV2 += address(r).balance - b.rewards;
        ghostToTreasury += treasury.balance - b.treasury;
        ghostToBurner += address(burner).balance - b.burner;
        ghostToPool += address(pool).balance - b.pool;
        ghostSwapEthIn += b.adapter - address(adapter).balance;
    }

    function _potShare(uint256 x) internal pure returns (uint256) {
        return x - (x * 500) / BPS;
    }

    function chargeEth(uint256 aSeed, uint256 amount) external {
        address a = _actor(aSeed);
        uint256 avail = pay.creditOf(a) + pay.balanceOf(a);
        if (avail == 0) return;
        amount = bound(amount, 1, avail);
        address[] memory cs = new address[](1);
        uint256[] memory as_ = new uint256[](1);
        cs[0] = a;
        as_[0] = amount;
        Snap memory b = _snap();
        uint64 e = r.currentEpoch();
        vm.prank(sched);
        try pay.charge(e, cs, as_, keccak256(abi.encode(e, amount))) {
            _recordFlows(b);
            ghostPotRequired += _potShare(amount);
            ghostChargedValue += amount;
        } catch (bytes memory err) {
            _unexpected(err);
        }
    }

    struct SpareCall {
        uint64 e;
        address sc;
        uint256 value;
        address ec;
        uint256 ea;
        uint256 burnAmt;
        uint256 expectedOut;
        uint16 burnerBps;
    }

    function chargeSpare(uint256 sSeed, uint256 value, uint256 eSeed, uint256 ethAmt) external {
        SpareCall memory c;
        c.e = r.currentEpoch();
        if (pay.acceptedSparePrice(c.e) == 0) {
            ghostSpareDeferred += 1; // no price or paused this epoch: SPARE jobs wait, ETH charges go on
            return;
        }
        c.sc = _actor(sSeed);
        c.value = bound(value, 1e12, 1 ether);
        uint256 owed = pay.spareOwed(c.e, c.value);
        uint256 sbal = pay.spareBalanceOf(c.sc);
        if (sbal < owed) _mintAndDepositSpare(c.sc, owed - sbal + 1 ether);

        c.ec = _actor(eSeed);
        uint256 avail = pay.creditOf(c.ec) + pay.balanceOf(c.ec);
        c.ea = avail == 0 ? 0 : bound(ethAmt, 0, avail);

        (, uint16 bBps,) = pay.currentSplit();
        c.burnerBps = bBps;
        c.burnAmt = (owed * bBps) / BPS;
        c.expectedOut = adapter.quoteSell(owed - c.burnAmt);
        (SparecycleJobPaymentsV2.SpareStatus st,,,,) = pay.previewSpareLeg(c.e, c.ea, c.value, c.expectedOut);
        if (st != SparecycleJobPaymentsV2.SpareStatus.Ok) {
            ghostSpareDeferred += 1;
            return;
        }
        _execSpare(c);
    }

    function _execSpare(SpareCall memory c) internal {
        address[] memory cs = new address[](c.ea == 0 ? 0 : 1);
        uint256[] memory as_ = new uint256[](c.ea == 0 ? 0 : 1);
        if (c.ea != 0) {
            cs[0] = c.ec;
            as_[0] = c.ea;
        }
        address[] memory ss = new address[](1);
        uint256[] memory sa = new uint256[](1);
        ss[0] = c.sc;
        sa[0] = c.value;
        Snap memory b = _snap();
        vm.prank(sched);
        try pay.chargeWithSpare(c.e, cs, as_, ss, sa, c.expectedOut, keccak256(abi.encode(c.e, c.value, c.ea))) {
            _recordFlows(b);
            ghostPotRequired += _potShare(c.ea) + _potShare(c.value);
            ghostChargedValue += c.ea + c.value;
            uint256 burned = b.supply - spare.totalSupply();
            ghostV2SpareBurned += burned;
            if (burned != c.burnAmt) ghostBurnMismatch += 1;
            ghostSpareCharges += 1;
            if (c.burnerBps == 0) {
                ghostSpareChargesAtZeroBurner += 1;
                if (b.adapter - address(adapter).balance < _potShare(c.value)) ghostSubsidizedAtZeroBurner += 1;
            }
        } catch (bytes memory err) {
            _unexpected(err);
        }
    }

    // ================================================================ scheduler: prices, epochs, burns, roots

    function postPrice(uint256 moveSeed) external {
        uint64 e = r.currentEpoch();
        if (pay.sparePriceOf(e).posted) return;
        uint256 ref = pay.referenceSparePrice();
        if (ref == 0) {
            vm.prank(treasury);
            pay.setReferenceSparePrice(basePrice);
            ref = basePrice;
        }
        uint256 price = (ref * bound(moveSeed, 7_000, 13_000)) / BPS; // -30% .. +30%: some epochs pause
        if (price == 0) price = 1;
        vm.prank(sched);
        try pay.postSparePrice(e, price) {
            adapter.setPrice(price); // the pool sits at the posted price until moved
        } catch (bytes memory err) {
            _unexpected(err);
        }
    }

    function movePool(uint256 moveSeed) external {
        uint256 p = adapter.price();
        uint256 np = (p * bound(moveSeed, 9_400, 10_600)) / BPS; // +-6%: sometimes beyond the 4% slippage
        adapter.setPrice(np == 0 ? 1 : np);
    }

    function closeEpoch(uint256 extra) external {
        uint64 e = r.currentEpoch();
        SparecycleRewards.Epoch memory ep = r.getEpoch(e);
        uint256 end = uint256(ep.startedAt) + r.epochLength();
        uint256 t = end + bound(extra, 0, 1 hours);
        if (block.timestamp < t) vm.warp(t);
        vm.prank(sched);
        try r.closeEpochAndPostRoot(e, bytes32(0), 0) {}
        catch (bytes memory err) {
            _unexpected(err);
        }
    }

    function burn(uint256) external {
        uint64 cur = r.currentEpoch();
        if (cur == 0) return;
        uint64 e = cur - 1;
        if (burner.epochHandled(e)) return;
        uint256 bal = address(burner).balance;
        if (bal == 0) return;
        uint256 price = pay.acceptedSparePrice(e);
        uint256 minOut = 1;
        if (price != 0) {
            uint256 cap = burner.maxEthPerBurn();
            uint256 send = bal < cap ? bal : cap;
            uint256 floor = burner.minOutFloor(send, price);
            if (floor > minOut) minOut = floor;
            if (adapter.quoteBuy(send) < minOut) return; // the pool moved too far: no burn, ETH stays
        }
        uint256 supplyBefore = spare.totalSupply();
        vm.prank(sched);
        try burner.burnEpoch(e, minOut) returns (uint256, uint256) {
            if (spare.totalSupply() != supplyBefore) ghostBurnMismatch += 1; // bought (minted) == burned
            ghostBurns += 1;
        } catch (bytes memory err) {
            _unexpected(err);
        }
    }

    function postHolderRoot(uint256 aSeed, uint256 bSeed) external {
        uint64 cur = r.currentEpoch();
        if (cur == 0) return;
        uint64 e = cur - 1;
        if (e < pool.nextPostableEpoch()) return;
        pool.rollExpired(type(uint256).max);
        uint256 avail = pool.available();
        uint256 a0 = bound(aSeed, 0, avail);
        uint256 a1 = bound(bSeed, 0, avail - a0);
        uint256 total = a0 + a1;
        bytes32 root;
        if (total != 0) {
            bytes32[] memory leaves = new bytes32[](2);
            leaves[0] = pool.leafOf(e, actors[0], 1, a0);
            leaves[1] = pool.leafOf(e, actors[1], 1, a1);
            root = MerkleHelper.root(leaves);
            _leaves[e] = leaves;
            leafAmount[e][actors[0]] = a0;
            leafAmount[e][actors[1]] = a1;
            hasLeaf[e][actors[0]] = true;
            hasLeaf[e][actors[1]] = true;
        }
        vm.prank(sched);
        try pool.postRoot(e, root, total) {
            rootEpochs.push(e);
        } catch (bytes memory err) {
            _unexpected(err);
        }
    }

    function claim(uint256 aSeed, uint256 rootSeed) external {
        uint256 n = rootEpochs.length;
        if (n == 0) return;
        uint64 e = rootEpochs[rootSeed % n];
        address a = _actor(aSeed);
        if (!hasLeaf[e][a] || pool.hasClaimed(e, a)) return;
        SparecycleHolderPool.RootInfo memory ri = pool.getRoot(e);
        if (ri.rolledOver || r.currentEpoch() > ri.claimableUntilEpoch) return;
        uint256 amt = leafAmount[e][a];
        bytes32[] memory p = MerkleHelper.proof(_leaves[e], pool.leafOf(e, a, 1, amt));
        vm.prank(a);
        try pool.claim(e, 1, amt, p) {
            ghostCredited += amt;
            ghostClaims += 1;
        } catch (bytes memory err) {
            _unexpected(err);
        }
    }

    function rollExpired(uint256 maxRoots) external {
        try pool.rollExpired(bound(maxRoots, 0, 8)) {}
        catch (bytes memory err) {
            _unexpected(err);
        }
    }

    // ================================================================ treasury Safe

    function proposeSplit(uint256 tSeed, uint256 bSeed) external {
        uint16 t = uint16(bound(tSeed, 0, 500));
        uint16 b = uint16(bound(bSeed, 0, 500 - t));
        vm.prank(treasury);
        try pay.proposeSplit(t, b, 500 - t - b) {}
        catch (bytes memory err) {
            _unexpected(err);
        }
    }

    function fundReserve(uint256 aSeed, uint256 amount) external {
        address a = _actor(aSeed);
        uint256 bal = a.balance;
        if (bal == 0) return;
        amount = bound(amount, 1, bal < 0.5 ether ? bal : 0.5 ether);
        vm.prank(a);
        try pay.fundDiscountReserve{value: amount}() {
            ghostSpentByActor[a] += amount;
            ghostReserveFunded += amount;
        } catch (bytes memory err) {
            _unexpected(err);
        }
    }

    function withdrawReserve(uint256 amount) external {
        uint256 res = pay.discountReserve();
        if (res == 0) return;
        amount = bound(amount, 1, res);
        vm.prank(treasury);
        try pay.withdrawDiscountReserve(amount) {
            ghostReserveWithdrawn += amount;
        } catch (bytes memory err) {
            _unexpected(err);
        }
    }

    // ================================================================ reads for the invariants

    function rootCount() external view returns (uint256) {
        return rootEpochs.length;
    }
}
