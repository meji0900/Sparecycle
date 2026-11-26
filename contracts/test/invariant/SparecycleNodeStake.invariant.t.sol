// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SparecycleRewards} from "../../src/SparecycleRewards.sol";
import {SparecycleNodeStake as NS} from "../../src/SparecycleNodeStake.sol";
import {MockPonsFeeEscrow} from "../mocks/MockPonsFeeEscrow.sol";
import {MockERC20} from "../mocks/Mocks.sol";
import {MockBurnableERC20} from "../mocks/StakeMocks.sol";
import {NodeStakeHandler} from "./NodeStakeHandler.sol";

/// @notice Stateful invariants of SparecycleNodeStake (brief §3): staked SPARE leaves only through `unstake` to its
///         own owner or through an executed slash to the burn; the books always match the balance; one open
///         proposal per owner; executed slashes never exceed slashBps; frozen stakes never move.
abstract contract NodeStakeInvariantBase is Test {
    NS internal st;
    SparecycleRewards internal r;
    NodeStakeHandler internal h;
    address internal sched;
    address internal safe;

    /// @dev Brief §10 defaults (N4 10%, W 8, A 4, C 16) + decision window 12 + min-stake delay 1.
    function _defaults() internal pure returns (NS.Config memory) {
        return NS.Config({
            slashBps: 1_000,
            faultWindowEpochs: 8,
            appealWindowEpochs: 4,
            cooldownEpochs: 16,
            decisionWindowEpochs: 12,
            minStakeDelayEpochs: 1
        });
    }

    /// @dev The shortest valid windows and the largest slash share (C = W + A + 1), so that random sequences of 64
    ///      calls regularly reach every path: unstake after a slash, expiry, re-proposals.
    function _short() internal pure returns (NS.Config memory) {
        return NS.Config({
            slashBps: 5_000,
            faultWindowEpochs: 1,
            appealWindowEpochs: 1,
            cooldownEpochs: 3,
            decisionWindowEpochs: 1,
            minStakeDelayEpochs: 1
        });
    }

    function _deploy(bool burnMode, NS.Config memory c) internal {
        vm.warp(1_750_000_000);
        sched = makeAddr("inv-scheduler");
        safe = makeAddr("inv-safe");
        r = new SparecycleRewards(safe, sched, address(0), address(new MockPonsFeeEscrow()), 1 hours);
        address tok = burnMode ? address(new MockBurnableERC20()) : address(new MockERC20("SpareCycle", "SPARE", 18));
        st = new NS(tok, address(r), safe, burnMode, 1_000e18, c);
        h = new NodeStakeHandler(st, r, sched, safe);

        bytes4[] memory sel = new bytes4[](17);
        sel[0] = NodeStakeHandler.stake.selector;
        sel[1] = NodeStakeHandler.requestUnstake.selector;
        sel[2] = NodeStakeHandler.cancelUnstake.selector;
        sel[3] = NodeStakeHandler.unstake.selector;
        sel[4] = NodeStakeHandler.appeal.selector;
        sel[5] = NodeStakeHandler.propose.selector;
        sel[6] = NodeStakeHandler.cancel.selector;
        sel[7] = NodeStakeHandler.execute.selector;
        sel[8] = NodeStakeHandler.scheduleMinStake.selector;
        sel[9] = NodeStakeHandler.rescue.selector;
        sel[10] = NodeStakeHandler.expire.selector;
        sel[11] = NodeStakeHandler.strangerTries.selector;
        sel[12] = NodeStakeHandler.donate.selector;
        sel[13] = NodeStakeHandler.closeEpochs.selector;
        sel[14] = NodeStakeHandler.warp.selector;
        sel[15] = NodeStakeHandler.execute.selector; // twice: decisions are the rare, interesting path
        sel[16] = NodeStakeHandler.closeEpochs.selector; // twice: windows are measured in closed epochs
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    function _owners() internal view returns (address[4] memory o) {
        for (uint256 i; i < 4; ++i) {
            o[i] = h.owners(i);
        }
    }

    /// @notice The contract holds exactly what is staked plus SPARE donated to it outside `stake` (stuck, never
    ///         credited): `balance == totalStaked + donated`, so `balance >= totalStaked`.
    function invariant_BalanceMatchesBooks() public view {
        assertEq(h.token().balanceOf(address(st)), st.totalStaked() + h.ghostDonated(), "balance == staked + donated");
        uint256 sum;
        address[4] memory o = _owners();
        for (uint256 i; i < 4; ++i) {
            sum += st.slashableOf(o[i]);
        }
        assertEq(sum, st.totalStaked(), "totalStaked == sum of accounts");
    }

    /// @notice Staked SPARE leaves only via `unstake` to its owner or via slash-burn: for every owner,
    ///         in == still staked + paid back + slashed, and the owner's wallet changed only by its own stakes and
    ///         unstakes. Nobody else (Safe, scheduler, stranger) ever holds SPARE.
    function invariant_StakeLeavesOnlyToOwnerOrBurn() public view {
        address[4] memory o = _owners();
        uint256 slashed;
        for (uint256 i; i < 4; ++i) {
            address a = o[i];
            assertEq(h.ghostIn(a), st.slashableOf(a) + h.ghostOut(a) + h.ghostSlashed(a), "per-owner conservation");
            assertEq(h.token().balanceOf(a), h.INITIAL() - h.ghostIn(a) + h.ghostOut(a), "owner wallet");
            slashed += h.ghostSlashed(a);
        }
        assertEq(st.totalSlashed(), slashed, "totalSlashed == executed proposals");
        assertEq(h.token().balanceOf(safe), 0, "Safe never receives SPARE");
        assertEq(h.token().balanceOf(sched), 0, "scheduler never receives SPARE");
        assertEq(h.token().balanceOf(h.stranger()), 0, "stranger never receives SPARE");
        assertEq(h.token().balanceOf(address(h)), 0, "handler never receives SPARE");
    }

    /// @notice Every slashed unit was burned: burn mode lowers the supply, dead mode parks it at 0x…dEaD.
    function invariant_SlashedIsBurned() public view {
        if (st.burnWithBurnFunction()) {
            assertEq(h.token().totalSupply(), h.ghostMinted() - st.totalSlashed(), "supply == minted - slashed");
            assertEq(h.token().balanceOf(st.DEAD()), 0);
        } else {
            assertEq(h.token().totalSupply(), h.ghostMinted(), "nothing burned in dead mode");
            assertEq(h.token().balanceOf(st.DEAD()), st.totalSlashed(), "dead == slashed");
        }
    }

    /// @notice At most one stored-open proposal per owner, and only the latest one against that owner (the one the
    ///         account points to) can be open; closed proposals carry their close time; every executed proposal
    ///         stayed within slashBps of the stake it was proposed against; no proposal was ever accepted inside
    ///         the grace period of the owner's previous one.
    function invariant_ProposalBookkeeping() public view {
        address[4] memory o = _owners();
        uint256[4] memory open;
        uint256[4] memory lastOpen;
        uint256[4] memory latest;
        uint256 n = st.proposalCount();
        uint256 executedSum;
        for (uint256 id = 1; id <= n; ++id) {
            NS.Proposal memory p = st.getProposal(id);
            assertTrue(p.status != NS.Status.None, "every id exists");
            assertTrue(p.evidenceHash != bytes32(0), "evidence on every proposal");
            assertLe(p.amount, h.ghostCapAtProposal(id), "amount <= slashBps of stake at proposal");
            if (p.status == NS.Status.Executed) executedSum += p.amount;
            if (p.status == NS.Status.Open) assertEq(p.closedAt, 0, "open proposals are not closed");
            else assertGe(p.closedAt, p.proposedAt, "closed proposals carry their close time");
            for (uint256 i; i < 4; ++i) {
                if (p.owner != o[i]) continue;
                latest[i] = id;
                if (p.status == NS.Status.Open) {
                    ++open[i];
                    lastOpen[i] = id;
                }
            }
        }
        assertEq(executedSum, st.totalSlashed(), "executed proposals == totalSlashed");
        for (uint256 i; i < 4; ++i) {
            assertLe(open[i], 1, "one open proposal per owner");
            assertEq(st.getAccount(o[i]).lastProposal, latest[i], "account points to its latest proposal");
            if (open[i] == 1) assertEq(lastOpen[i], latest[i], "only the latest proposal can be open");
        }
        assertEq(h.ghostProposedInGrace(), 0, "no proposal inside a grace period");
    }

    /// @notice No handler path saw an unexpected success, payout or burn.
    function invariant_NoUnexpected() public view {
        assertEq(h.ghostUnexpected(), 0);
    }
}

/// @notice The brief's default windows, plus a deterministic smoke pass that depends on them.
abstract contract NodeStakeDefaultsInvariantBase is NodeStakeInvariantBase {
    /// @notice Deterministic pass through every handler action, so a broken handler cannot hide behind random
    ///         sequences that never reach a decision.
    function test_HandlerSmoke() public {
        for (uint256 i; i < 4; ++i) {
            h.stake(i, 10_000e18);
        }
        h.requestUnstake(0, 4_000e18);
        h.propose(0, 500e18, 1, true); // owner 0: will be executed
        h.propose(1, 500e18, 2, false); // owner 1: will be cancelled
        h.propose(2, 500e18, 3, false); // owner 2: will expire
        h.propose(0, 1, 4, false); // already open: must fail inside
        h.appeal(0, 7);
        h.requestUnstake(0, 1); // frozen: must fail inside
        h.unstake(0); // frozen: must fail inside
        h.execute(0); // appeal window: must fail inside
        h.cancel(1);
        h.closeEpochs(4);
        h.warp(1 hours);
        h.execute(0);
        h.scheduleMinStake(2_000e18);
        h.donate(5e18);
        h.rescue(3e18);
        h.strangerTries(0);
        h.closeEpochs(6);
        h.closeEpochs(6);
        h.warp(3 hours);
        h.expire(2);
        h.unstake(0);
        h.requestUnstake(3, 1_000e18);
        h.cancelUnstake(3);
        assertEq(h.calls("execute"), 1);
        assertEq(h.calls("cancel"), 1);
        assertEq(h.calls("expire"), 1);
        assertEq(h.calls("unstake"), 1);
        assertGe(h.calls("executeBlocked"), 1);
        assertGe(h.calls("unstakeBlocked"), 1);
        assertGe(h.calls("requestFrozen"), 1);
        invariant_BalanceMatchesBooks();
        invariant_StakeLeavesOnlyToOwnerOrBurn();
        invariant_SlashedIsBurned();
        invariant_ProposalBookkeeping();
        invariant_NoUnexpected();
    }
}

contract SparecycleNodeStakeBurnInvariantTest is NodeStakeDefaultsInvariantBase {
    function setUp() public {
        _deploy(true, _defaults());
    }
}

contract SparecycleNodeStakeDeadInvariantTest is NodeStakeDefaultsInvariantBase {
    function setUp() public {
        _deploy(false, _defaults());
    }
}

/// @notice Shortest valid windows and a 50% slash share: random runs reach unstake-after-slash, expiry and
///         re-proposals often.
contract SparecycleNodeStakeShortWindowsInvariantTest is NodeStakeInvariantBase {
    function setUp() public {
        _deploy(true, _short());
    }
}
