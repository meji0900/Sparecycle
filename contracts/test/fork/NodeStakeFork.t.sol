// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SparecycleNodeStake as NS} from "../../src/SparecycleNodeStake.sol";

interface ILiveRewardsForStake {
    function currentEpoch() external view returns (uint64);
    function epochLength() external view returns (uint64);
    function scheduler() external view returns (address);
    function owner() external view returns (address);
}

/// @notice SparecycleNodeStake against the real SPARE token and the live SparecycleRewards on Robinhood Chain mainnet,
///         on a local fork (nothing is broadcast). Opt-in, like the other fork suites:
///         FORK_TESTS=1 [FORK_RPC_URL=<rpc>] forge test --match-path test/fork/NodeStakeFork.t.sol -vv
///         Skips cleanly when FORK_TESTS is not 1 or the RPC cannot be reached.
contract NodeStakeForkTest is Test {
    // src/lib/addresses.ts: ADDR.spareToken, ADDR.rewards, ADDR.treasurySafe
    address internal constant SPARE = 0x012D695B94377E0c7b9EdEE3d824259BaA37cf3A;
    address internal constant LIVE_REWARDS = 0x68A0569130551154FC1aABD71d99f65681c58Fe9;
    address internal constant SAFE = 0xb262E4436aD6760F91e987f14e2fAc5D6550c71B;
    bytes32 internal constant EVIDENCE = keccak256("fork evidence bundle");

    IERC20 internal spare = IERC20(SPARE);
    ILiveRewardsForStake internal rewards = ILiveRewardsForStake(LIVE_REWARDS);
    NS internal st;
    address internal nodeOwner = makeAddr("fork-node-owner");
    uint64 internal len;

    function setUp() public {
        if (vm.envOr("FORK_TESTS", uint256(0)) != 1) {
            vm.skip(true);
            return;
        }
        try vm.createSelectFork(vm.envOr("FORK_RPC_URL", string("robinhood"))) {}
        catch {
            vm.skip(true); // RPC unreachable: skip, do not fail
            return;
        }
        assertEq(rewards.owner(), SAFE, "the live reward contract is owned by the treasury Safe");
        len = rewards.epochLength();

        // As launched: burn through SPARE.burn, minimum 0, the brief's default windows.
        NS.Config memory c = NS.Config({
            slashBps: 1_000,
            faultWindowEpochs: 8,
            appealWindowEpochs: 4,
            cooldownEpochs: 16,
            decisionWindowEpochs: 12,
            minStakeDelayEpochs: 1
        });
        st = new NS(SPARE, LIVE_REWARDS, SAFE, true, 0, c);
        assertEq(abi.encode(st.defaultConfig()), abi.encode(c));
        // A fresh owner wallet with 1,000 SPARE; totalSupply is adjusted too, so burns are visible in it.
        deal(SPARE, nodeOwner, 1_000e18, true);
        vm.prank(nodeOwner);
        spare.approve(address(st), type(uint256).max);
    }

    function test_Fork_ConfigAsLaunched() public view {
        assertEq(address(st.token()), SPARE);
        assertEq(address(st.rewards()), LIVE_REWARDS);
        assertEq(st.safe(), SAFE);
        assertTrue(st.burnWithBurnFunction());
        assertEq(st.epochLength(), len);
        assertEq(st.minStakePerNode(), 0);
        assertTrue(st.meetsMinimum(nodeOwner, 100), "minimum 0: staking is voluntary");
        assertTrue(st.safe() != rewards.scheduler());
    }

    /// @notice stake -> requestUnstake -> cooldown (stall fallback: no live epoch closes on the fork) -> unstake
    ///         returns everything.
    function test_Fork_StakeUnstakeRoundTrip() public {
        vm.prank(nodeOwner);
        assertEq(st.stake(1_000e18), 1_000e18, "SPARE credits in full (no transfer fee)");
        assertEq(spare.balanceOf(address(st)), 1_000e18);
        vm.prank(nodeOwner);
        st.requestUnstake(1_000e18);

        uint256 cooldown = uint256(st.cooldownEpochs()) * len;
        vm.warp(block.timestamp + 2 * cooldown - 1);
        assertFalse(st.canUnstake(nodeOwner));
        vm.warp(block.timestamp + 1);
        assertTrue(st.canUnstake(nodeOwner));

        vm.prank(nodeOwner);
        assertEq(st.unstake(), 1_000e18);
        assertEq(spare.balanceOf(nodeOwner), 1_000e18, "everything back");
        assertEq(spare.balanceOf(address(st)), 0);
        assertEq(st.totalStaked(), 0);
    }

    /// @notice stake -> proposeSlash (live scheduler key) -> appeal window (stall fallback) -> executeSlash (Safe)
    ///         burns through SPARE.burn: totalSupply falls by the slashed amount.
    function test_Fork_SlashBurnsRealSpare() public {
        vm.prank(nodeOwner);
        st.stake(1_000e18);
        uint256 amount = st.maxSlashOf(nodeOwner);
        assertEq(amount, 100e18);

        vm.prank(rewards.scheduler()); // the live scheduler key, read from the contract
        uint256 id = st.proposeSlash(nodeOwner, amount, EVIDENCE);

        uint256 appeal = uint256(st.appealWindowEpochs()) * len;
        vm.warp(block.timestamp + 2 * appeal);
        assertTrue(st.canExecute(id));

        uint256 supplyBefore = spare.totalSupply();
        uint256 safeBefore = spare.balanceOf(SAFE);
        uint256 deadBefore = spare.balanceOf(st.DEAD()); // the real 0x…dEaD already holds SPARE from others
        vm.expectEmit(true, true, true, true, address(st));
        emit NS.Slashed(nodeOwner, amount, id, EVIDENCE);
        vm.prank(SAFE);
        st.executeSlash(id);

        assertEq(spare.totalSupply(), supplyBefore - amount, "burned: totalSupply fell");
        assertEq(spare.balanceOf(address(st)), 900e18);
        assertEq(spare.balanceOf(st.DEAD()), deadBefore, "burn() path, not the dead address");
        assertEq(spare.balanceOf(SAFE), safeBefore, "the Safe received nothing");
        assertEq(st.slashableOf(nodeOwner), 900e18);
        assertEq(st.totalSlashed(), amount);
    }
}
