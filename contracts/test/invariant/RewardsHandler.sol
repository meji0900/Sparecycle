// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {SparecycleRewards} from "../../src/SparecycleRewards.sol";
import {MockPonsFeeEscrow} from "../mocks/MockPonsFeeEscrow.sol";
import {MockERC20, EthPusher} from "../mocks/Mocks.sol";
import {MerkleHelper} from "../utils/MerkleHelper.sol";

/// @notice Drives the reward contract through random inflows, closes with random payout splits, claims and
///         time warps, and keeps ghost totals the invariants compare against. Never reverts by itself
///         (`fail_on_revert = true`); expected reverts are asserted inside try/catch.
contract RewardsHandler is CommonBase, StdCheats, StdUtils {
    SparecycleRewards public immutable r;
    MockPonsFeeEscrow public immutable escrow;
    MockERC20 public immutable token; // address(0) in ETH mode
    EthPusher public immutable pusher;
    address public immutable sched;
    address public immutable funder;
    bool public immutable eth;
    uint256 internal immutable maxAmt;

    address[5] internal ops;

    // ghosts
    uint256 public ghostIn; // every unit that entered the contract
    uint256 public ghostPaid; // every unit paid by claim
    mapping(uint64 => uint256) public ghostCredited; // credited to an epoch while it was open
    mapping(uint64 => uint256) public ghostPaidPerEpoch;
    uint256 public ghostUnexpected; // must stay 0

    struct Tree {
        address[] accts;
        uint256[] amts;
        bytes32[] leaves;
    }

    mapping(uint64 => Tree) internal _trees;
    uint64[] internal _withLeaves;

    mapping(bytes32 => uint256) public calls;

    constructor(SparecycleRewards r_, MockPonsFeeEscrow escrow_, MockERC20 token_, address sched_) {
        r = r_;
        escrow = escrow_;
        token = token_;
        sched = sched_;
        eth = address(token_) == address(0);
        maxAmt = eth ? 1_000 ether : 1e15; // 1e15 = 1bn USDG at 6 decimals
        pusher = new EthPusher();
        funder = makeAddr("inv-funder");
        for (uint256 i; i < 5; ++i) {
            ops[i] = makeAddr(string.concat("inv-op", vm.toString(i)));
        }
        if (!eth) {
            vm.startPrank(funder);
            token_.approve(address(r_), type(uint256).max);
            token_.approve(address(escrow_), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _mintTo(address to, uint256 amt) internal {
        if (eth) vm.deal(to, to.balance + amt);
        else token.mint(to, amt);
    }

    // ------------------------------------------------------------------ inflows

    function fund(uint256 amt) external {
        amt = bound(amt, 0, maxAmt);
        _mintTo(funder, amt);
        vm.prank(funder);
        if (eth) r.fund{value: amt}();
        else r.fundToken(amt);
        ghostIn += amt;
        ghostCredited[r.currentEpoch()] += amt;
        calls["fund"]++;
    }

    /// @dev Value that arrives without crediting: a 2300-gas ETH push, or a plain token transfer.
    function push(uint256 amt) external {
        amt = bound(amt, 0, maxAmt);
        _mintTo(funder, amt);
        vm.prank(funder);
        if (eth) pusher.pushTransfer{value: amt}(payable(address(r)));
        else token.transfer(address(r), amt);
        ghostIn += amt;
        calls["push"]++;
    }

    /// @dev ETH that arrives with no call at all (selfdestruct-style). ETH mode only.
    function forceEth(uint256 amt) external {
        if (!eth) return;
        amt = bound(amt, 0, maxAmt);
        vm.deal(address(r), address(r).balance + amt);
        ghostIn += amt;
        calls["forceEth"]++;
    }

    function escrowFees(uint256 amt, bool transferPush) external {
        amt = bound(amt, 0, maxAmt);
        _mintTo(funder, amt);
        if (eth) escrow.setPushWithTransfer(transferPush);
        vm.prank(funder);
        if (eth) escrow.credit{value: amt}(address(r));
        else escrow.creditToken(address(r), address(token), amt);
        uint256 got = eth ? r.claimFeesFromEscrow() : r.claimFeesFromEscrowToken();
        if (got != amt) ghostUnexpected++;
        ghostIn += amt;
        ghostCredited[r.currentEpoch()] += amt;
        calls["escrowFees"]++;
    }

    function sync() external {
        uint256 expected = r.unaccounted();
        uint64 id = r.currentEpoch();
        uint256 got = r.sync();
        if (got != expected) ghostUnexpected++;
        ghostCredited[id] += got;
        calls["sync"]++;
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 0, 2 * uint256(r.epochLength()));
        vm.warp(block.timestamp + secs);
        calls["warp"]++;
    }

    // ------------------------------------------------------------------ close

    function close(uint256 reservedSeed, uint256 nSeed, uint256[5] memory w, bool overAllocate) external {
        uint64 id = r.currentEpoch();
        SparecycleRewards.Epoch memory e = r.getEpoch(id);
        uint256 end = uint256(e.startedAt) + r.epochLength();
        if (block.timestamp < end) vm.warp(end);

        uint256 unacc = r.unaccounted();
        uint256 pot = e.pot + unacc;
        uint256 n = bound(nSeed, 0, 5);
        uint256 reserved = n == 0 ? 0 : bound(reservedSeed, 0, pot);

        Tree storage t = _trees[id];
        if (n > 0) {
            uint256 wsum;
            for (uint256 i; i < n; ++i) {
                w[i] = bound(w[i], 0, 1e18);
                wsum += w[i];
            }
            for (uint256 i; i < n; ++i) {
                uint256 amt;
                if (overAllocate) amt = bound(w[i], 0, reserved);
                else amt = wsum == 0 ? 0 : (reserved * w[i]) / wsum;
                t.accts.push(ops[i]);
                t.amts.push(amt);
                t.leaves.push(r.leafOf(id, ops[i], amt));
            }
            _withLeaves.push(id);
        }
        bytes32 root = MerkleHelper.root(t.leaves);

        vm.prank(sched);
        r.closeEpochAndPostRoot(id, root, reserved);
        ghostCredited[id] += unacc;
        calls["close"]++;
    }

    // ------------------------------------------------------------------ claims

    function claim(uint256 epochSeed, uint256 leafSeed) external {
        if (_withLeaves.length == 0) return;
        uint64 id = _withLeaves[bound(epochSeed, 0, _withLeaves.length - 1)];
        Tree storage t = _trees[id];
        uint256 i = bound(leafSeed, 0, t.accts.length - 1);
        address who = t.accts[i];
        uint256 amt = t.amts[i];
        if (r.hasClaimed(id, who)) {
            calls["claim:skipped-claimed"]++;
            return;
        }
        bytes32[] memory p = MerkleHelper.proof(t.leaves, t.leaves[i]);
        SparecycleRewards.Epoch memory e = r.getEpoch(id);
        bool overCap = e.claimed + amt > e.reserved;
        uint256 before = eth ? who.balance : token.balanceOf(who);

        vm.prank(who);
        try r.claim(id, amt, p) {
            if (overCap) ghostUnexpected++;
            uint256 got = (eth ? who.balance : token.balanceOf(who)) - before;
            if (got != amt) ghostUnexpected++;
            ghostPaid += amt;
            ghostPaidPerEpoch[id] += amt;
            calls["claim"]++;
        } catch (bytes memory err) {
            if (!overCap || bytes4(err) != SparecycleRewards.ClaimExceedsReserved.selector) ghostUnexpected++;
            calls["claim:capped"]++;
        }
    }

    /// @dev A wrong amount, a stolen proof or a repeat must never pay.
    function badClaim(uint256 epochSeed, uint256 leafSeed, uint256 delta, address thief) external {
        if (_withLeaves.length == 0) return;
        uint64 id = _withLeaves[bound(epochSeed, 0, _withLeaves.length - 1)];
        Tree storage t = _trees[id];
        uint256 i = bound(leafSeed, 0, t.accts.length - 1);
        bytes32[] memory p = MerkleHelper.proof(t.leaves, t.leaves[i]);
        delta = bound(delta, 1, 1e30);
        bool asThief = thief != t.accts[i] && thief != address(0);
        address who = asThief ? thief : t.accts[i];
        uint256 amt = asThief ? t.amts[i] : t.amts[i] + delta;
        // A thief might coincidentally own another leaf with the same amount; skip that case.
        for (uint256 k; k < t.accts.length; ++k) {
            if (t.accts[k] == who && t.amts[k] == amt) return;
        }
        uint256 balBefore = eth ? address(r).balance : token.balanceOf(address(r));
        vm.prank(who);
        try r.claim(id, amt, p) {
            ghostUnexpected++;
        } catch {}
        if ((eth ? address(r).balance : token.balanceOf(address(r))) != balBefore) ghostUnexpected++;
        calls["badClaim"]++;
    }

    // ------------------------------------------------------------------ views for the invariants

    function withLeavesCount() external view returns (uint256) {
        return _withLeaves.length;
    }
}
