// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SparecycleRewards} from "../../src/SparecycleRewards.sol";
import {SparecycleNodeStake as NS} from "../../src/SparecycleNodeStake.sol";
import {MockERC20} from "../mocks/Mocks.sol";

interface IMintableToken is IERC20 {
    function mint(address to, uint256 amount) external;
}

/// @notice Drives SparecycleNodeStake through random stakes, unstake requests/cancels/withdrawals, proposals,
///         appeals, Safe decisions, expiries, minimum changes, donations, rescues, epoch closes and time warps, and
///         keeps the ghost totals the invariants compare against. Never reverts by itself (`fail_on_revert = true`):
///         every call it expects to succeed is guarded by the contract's own views (so a view that disagrees with
///         the function fails the run), and every call it expects to fail runs in try/catch and counts as
///         `ghostUnexpected` if it succeeds.
contract NodeStakeHandler is CommonBase, StdCheats, StdUtils {
    uint256 public constant INITIAL = 1e30; // SPARE minted to each owner up front
    uint256 internal constant MAX_AMT = 1e24;

    NS public immutable st;
    SparecycleRewards public immutable r;
    IMintableToken public immutable token;
    MockERC20 public immutable other;
    address public immutable sched;
    address public immutable safe;
    address public immutable stranger;
    bool public immutable burnMode;
    uint64 internal immutable len;

    address[4] public owners;
    uint256[] internal _ids;

    // ghosts
    mapping(address => uint256) public ghostIn; // credited by stake()
    mapping(address => uint256) public ghostOut; // paid by unstake()
    mapping(address => uint256) public ghostSlashed; // burned by executeSlash()
    mapping(uint256 => uint256) public ghostCapAtProposal; // maxSlashOf(owner) when the proposal was made
    uint256 public ghostMinted;
    uint256 public ghostDonated; // SPARE sent to the contract without stake()
    uint256 public ghostUnexpected; // must stay 0
    uint256 public ghostProposedInGrace; // proposals the contract accepted inside the handler's own grace window
    // The handler's own record of each proposal's timing, independent of the contract's storage.
    mapping(address => uint256) public lastId;
    mapping(uint256 => uint64) internal _propEpoch;
    mapping(uint256 => uint64) internal _propAt;
    mapping(uint256 => uint64) internal _closedEpoch; // set when the handler cancelled or executed it
    mapping(uint256 => uint64) internal _closedAt;

    mapping(bytes32 => uint256) public calls;

    constructor(NS st_, SparecycleRewards r_, address sched_, address safe_) {
        st = st_;
        r = r_;
        token = IMintableToken(address(st_.token()));
        burnMode = st_.burnWithBurnFunction();
        sched = sched_;
        safe = safe_;
        len = r_.epochLength();
        stranger = makeAddr("inv-stranger");
        other = new MockERC20("Other", "OTH", 18);
        for (uint256 i; i < 4; ++i) {
            address o = makeAddr(string.concat("inv-owner", vm.toString(i)));
            owners[i] = o;
            token.mint(o, INITIAL);
            ghostMinted += INITIAL;
            vm.prank(o);
            token.approve(address(st_), type(uint256).max);
        }
    }

    function ownerCount() external pure returns (uint256) {
        return 4;
    }

    function idCount() external view returns (uint256) {
        return _ids.length;
    }

    // ---------------------------------------------------------------- owners

    function stake(uint256 seed, uint256 amount) external {
        address o = _owner(seed);
        uint256 bal = token.balanceOf(o);
        if (bal == 0) return;
        amount = bound(amount, 1, bal < MAX_AMT ? bal : MAX_AMT);
        uint256 before = st.stakedOf(o);
        vm.prank(o);
        uint256 got = st.stake(amount);
        if (got != amount || st.stakedOf(o) != before + amount) ++ghostUnexpected;
        ghostIn[o] += got;
        ++calls["stake"];
    }

    function requestUnstake(uint256 seed, uint256 amount) external {
        address o = _owner(seed);
        uint256 s = st.stakedOf(o);
        if (s == 0) return;
        if (st.openProposalOf(o) != 0) {
            vm.prank(o);
            try st.requestUnstake(1) {
                ++ghostUnexpected; // frozen stake must not start leaving
            } catch {
                ++calls["requestFrozen"];
            }
            return;
        }
        amount = bound(amount, 1, s);
        vm.prank(o);
        st.requestUnstake(amount);
        ++calls["request"];
    }

    function cancelUnstake(uint256 seed) external {
        address o = _owner(seed);
        (uint256 u,,) = st.unstakingOf(o);
        if (u == 0) return;
        vm.prank(o);
        st.cancelUnstake();
        ++calls["cancelUnstake"];
    }

    function unstake(uint256 seed) external {
        address o = _owner(seed);
        (uint256 u,,) = st.unstakingOf(o);
        if (u == 0) return;
        bool can = st.canUnstake(o);
        uint256 balBefore = token.balanceOf(o);
        if (can) {
            vm.prank(o);
            uint256 got = st.unstake();
            if (got != u || token.balanceOf(o) != balBefore + u) ++ghostUnexpected;
            ghostOut[o] += u;
            ++calls["unstake"];
        } else {
            vm.prank(o);
            try st.unstake() {
                ++ghostUnexpected; // cooldown running or stake frozen: nothing may leave
            } catch {
                ++calls["unstakeBlocked"];
            }
        }
    }

    function appeal(uint256 idSeed, uint256 ev) external {
        if (_ids.length == 0) return;
        uint256 id = _ids[idSeed % _ids.length];
        address o = st.getProposal(id).owner;
        if (!st.canAppeal(id)) return;
        vm.prank(o);
        st.appeal(id, keccak256(abi.encode("appeal", ev)));
        ++calls["appeal"];
    }

    // ---------------------------------------------------------------- scheduler

    function propose(uint256 seed, uint256 amount, uint256 ev, bool tryAboveCap) external {
        address o = _owner(seed);
        uint256 cap = st.maxSlashOf(o);
        if (cap == 0) return;
        bytes32 h = keccak256(abi.encode("evidence", ev));
        // The handler's own answer: no live proposal and the grace period after the last one is over.
        bool allowed = _mayProposeGhost(o);
        if (allowed != st.canPropose(o)) ++ghostUnexpected;
        if (!allowed) {
            vm.prank(sched);
            try st.proposeSlash(o, 1, h) {
                ++ghostProposedInGrace; // an open proposal or a grace period must block it
            } catch {
                ++calls["proposeBlocked"];
            }
            return;
        }
        if (tryAboveCap) {
            vm.prank(sched);
            try st.proposeSlash(o, cap + 1, h) {
                ++ghostUnexpected;
            } catch {}
        }
        amount = bound(amount, 1, cap);
        vm.prank(sched);
        uint256 id = st.proposeSlash(o, amount, h);
        ghostCapAtProposal[id] = cap;
        lastId[o] = id;
        _propEpoch[id] = r.currentEpoch();
        _propAt[id] = uint64(block.timestamp);
        _ids.push(id);
        ++calls["propose"];
    }

    // ---------------------------------------------------------------- Safe

    function cancel(uint256 idSeed) external {
        if (_ids.length == 0) return;
        uint256 id = _ids[idSeed % _ids.length];
        if (st.getProposal(id).status != NS.Status.Open) return;
        bool expired = _expiredGhost(id);
        vm.prank(safe);
        st.cancelSlash(id);
        NS.Status s = st.getProposal(id).status;
        if (expired) {
            // A cancel after the decision window records the expiry instead.
            if (s != NS.Status.Expired) ++ghostUnexpected;
            ++calls["cancelExpired"];
        } else {
            if (s != NS.Status.Cancelled) ++ghostUnexpected;
            _closedEpoch[id] = r.currentEpoch();
            _closedAt[id] = uint64(block.timestamp);
            ++calls["cancel"];
        }
    }

    function execute(uint256 idSeed) external {
        if (_ids.length == 0) return;
        uint256 id = _ids[idSeed % _ids.length];
        NS.Proposal memory p = st.getProposal(id);
        if (p.status != NS.Status.Open) return;
        if (!st.canExecute(id)) {
            vm.prank(safe);
            try st.executeSlash(id) {
                ++ghostUnexpected; // inside the appeal window or expired
            } catch {
                ++calls["executeBlocked"];
            }
            return;
        }
        if (p.amount > ghostCapAtProposal[id]) ++ghostUnexpected;
        uint256 supplyBefore = token.totalSupply();
        uint256 deadBefore = token.balanceOf(st.DEAD());
        uint256 slashableBefore = st.slashableOf(p.owner);
        vm.prank(safe);
        st.executeSlash(id);
        _closedEpoch[id] = r.currentEpoch();
        _closedAt[id] = uint64(block.timestamp);
        ghostSlashed[p.owner] += p.amount;
        if (st.slashableOf(p.owner) != slashableBefore - p.amount) ++ghostUnexpected;
        if (burnMode) {
            if (token.totalSupply() != supplyBefore - p.amount) ++ghostUnexpected;
        } else if (token.balanceOf(st.DEAD()) != deadBefore + p.amount) {
            ++ghostUnexpected;
        }
        ++calls["execute"];
    }

    function scheduleMinStake(uint256 v) external {
        vm.prank(safe);
        st.scheduleMinStakePerNode(bound(v, 0, MAX_AMT));
        ++calls["minStake"];
    }

    /// @dev Rescues a stray other token (must work) and tries to rescue SPARE (must fail).
    function rescue(uint256 amount) external {
        amount = bound(amount, 1, MAX_AMT);
        other.mint(address(st), amount);
        vm.prank(safe);
        st.rescueToken(address(other), safe, amount);
        vm.prank(safe);
        try st.rescueToken(address(token), safe, 1) {
            ++ghostUnexpected;
        } catch {}
        ++calls["rescue"];
    }

    // ---------------------------------------------------------------- anyone

    function expire(uint256 idSeed) external {
        if (_ids.length == 0) return;
        uint256 id = _ids[idSeed % _ids.length];
        if (st.getProposal(id).status != NS.Status.Open || st.proposalStatus(id) != NS.Status.Expired) return;
        vm.prank(stranger);
        st.expireSlash(id);
        ++calls["expire"];
    }

    /// @dev A stranger tries every privileged entry point; all must fail.
    function strangerTries(uint256 seed) external {
        address o = _owner(seed);
        vm.startPrank(stranger);
        try st.proposeSlash(o, 1, keccak256("x")) {
            ++ghostUnexpected;
        } catch {}
        if (_ids.length != 0) {
            uint256 id = _ids[seed % _ids.length];
            try st.executeSlash(id) {
                ++ghostUnexpected;
            } catch {}
            try st.cancelSlash(id) {
                ++ghostUnexpected;
            } catch {}
            try st.appeal(id, keccak256("x")) {
                ++ghostUnexpected;
            } catch {}
        }
        try st.unstake() {
            ++ghostUnexpected;
        } catch {}
        try st.scheduleMinStakePerNode(0) {
            ++ghostUnexpected;
        } catch {}
        vm.stopPrank();
        ++calls["stranger"];
    }

    /// @dev SPARE sent straight to the contract: never credited to anyone, never rescuable.
    function donate(uint256 amount) external {
        amount = bound(amount, 1, MAX_AMT);
        token.mint(address(st), amount);
        ghostMinted += amount;
        ghostDonated += amount;
        ++calls["donate"];
    }

    // ---------------------------------------------------------------- time

    function closeEpochs(uint256 n) external {
        n = bound(n, 1, 12);
        for (uint256 i; i < n; ++i) {
            uint64 id = r.currentEpoch();
            uint256 end = uint256(r.getEpoch(id).startedAt) + len;
            if (block.timestamp < end) vm.warp(end);
            vm.prank(sched);
            r.closeEpochAndPostRoot(id, bytes32(0), 0);
        }
        ++calls["close"];
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 3 * uint256(len)));
        ++calls["warp"];
    }

    // ---------------------------------------------------------------- internal

    function _owner(uint256 seed) internal view returns (address) {
        return owners[seed % 4];
    }

    /// @dev The handler's own copy of the window rule (n epochs closed and n epoch lengths passed, or twice the
    ///      time if epochs stall), applied to timings the handler recorded itself.
    function _overGhost(uint64 e0, uint64 t0, uint256 n) internal view returns (bool) {
        uint256 span = n * len;
        if (block.timestamp < uint256(t0) + span) return false;
        if (uint256(r.currentEpoch()) >= uint256(e0) + n) return true;
        return block.timestamp >= uint256(t0) + 2 * span;
    }

    function _expiredGhost(uint256 id) internal view returns (bool) {
        return _overGhost(_propEpoch[id], _propAt[id], uint256(st.appealWindowEpochs()) + st.decisionWindowEpochs());
    }

    /// @dev May the scheduler propose against `o` now? No live proposal, and 2 epochs (the grace period) since the
    ///      last one was cancelled or executed, or since it expired (appeal + decision + 2 from the proposal).
    function _mayProposeGhost(address o) internal view returns (bool) {
        uint256 id = lastId[o];
        if (id == 0) return true;
        NS.Status s = st.getProposal(id).status;
        if (s == NS.Status.Open && !_expiredGhost(id)) return false;
        if (_closedAt[id] != 0) return _overGhost(_closedEpoch[id], _closedAt[id], 2);
        return _overGhost(_propEpoch[id], _propAt[id], uint256(st.appealWindowEpochs()) + st.decisionWindowEpochs() + 2);
    }
}
