// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SparecycleRewards} from "../../src/SparecycleRewards.sol";

/// @notice Rehearses moving the owner of the live reward contract (0x68A0…8Fe9) to a Safe, on a local fork of
///         Robinhood Chain mainnet. Nothing is broadcast: every call is a local simulation.
///         Opt-in: FORK_TESTS=1 FORK_RPC_URL=<rpc> [SAFE_ADDRESS=0x…] forge test --match-path test/fork/OwnershipFork.t.sol
///         SAFE_ADDRESS defaults to the treasury Safe (Option A in docs/ops/multisig-runbook.md).
contract OwnershipForkTest is Test {
    address internal constant LIVE_REWARDS = 0x68A0569130551154FC1aABD71d99f65681c58Fe9;
    address internal constant TREASURY_SAFE = 0xb262E4436aD6760F91e987f14e2fAc5D6550c71B;

    SparecycleRewards internal r;
    address internal safe;
    address internal eoaOwner;
    address internal scheduler;

    function setUp() public {
        if (vm.envOr("FORK_TESTS", uint256(0)) != 1) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envOr("FORK_RPC_URL", string("robinhood")));
        r = SparecycleRewards(payable(LIVE_REWARDS));
        safe = vm.envOr("SAFE_ADDRESS", TREASURY_SAFE);
        eoaOwner = r.owner();
        scheduler = r.scheduler();
        assertGt(safe.code.length, 0, "the Safe must be deployed (never transfer to a counterfactual address)");
        assertTrue(eoaOwner != safe, "owner already moved");
    }

    function _moveToSafe() internal {
        vm.prank(eoaOwner);
        r.transferOwnership(safe);
        assertEq(r.pendingOwner(), safe, "pendingOwner set");
        assertEq(r.owner(), eoaOwner, "the EOA stays owner until the Safe accepts");

        vm.prank(safe); // stands in for a Safe transaction with threshold signatures
        r.acceptOwnership();
        assertEq(r.owner(), safe, "owner is the Safe");
        assertEq(r.pendingOwner(), address(0), "nothing pending");
    }

    function test_Fork_TransferAcceptMovesOwnerPowers() public {
        _moveToSafe();

        // The old EOA lost every owner power.
        vm.startPrank(eoaOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eoaOwner));
        r.setScheduler(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eoaOwner));
        r.pauseClaims();
        vm.stopPrank();

        // The Safe holds them: rotate the scheduler and back, pause and unpause claims.
        vm.startPrank(safe);
        r.setScheduler(address(0xBEEF));
        assertEq(r.scheduler(), address(0xBEEF));
        r.setScheduler(scheduler);
        r.pauseClaims();
        assertTrue(r.claimsPaused());
        r.unpauseClaims();
        vm.stopPrank();
        assertFalse(r.claimsPaused());
        assertEq(r.scheduler(), scheduler, "scheduler unchanged after the round trip");
    }

    function test_Fork_SchedulerStillClosesEpochsAfterTheMove() public {
        _moveToSafe();
        uint64 id = r.currentEpoch();
        vm.warp(uint256(r.getEpoch(id).startedAt) + r.epochLength());
        assertTrue(r.canClose(id));

        vm.prank(scheduler); // the hot key is untouched by the move
        r.closeEpochAndPostRoot(id, bytes32(0), 0);
        assertTrue(r.getEpoch(id).settled, "epoch settled by the scheduler");
        assertEq(r.currentEpoch(), id + 1, "next epoch open");
    }

    function test_Fork_RollbackBeforeAcceptOverwritesPendingOwner() public {
        address wrong = makeAddr("wrong");
        vm.prank(eoaOwner);
        r.transferOwnership(wrong);
        vm.prank(eoaOwner);
        r.transferOwnership(safe); // the EOA can still correct a mistake before anyone accepts
        assertEq(r.pendingOwner(), safe);

        vm.prank(wrong);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, wrong));
        r.acceptOwnership();
        assertEq(r.owner(), eoaOwner);
    }

    function test_Fork_OnlyTheSafeCanMoveOwnershipOnceAccepted() public {
        _moveToSafe();
        vm.prank(eoaOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, eoaOwner));
        r.transferOwnership(eoaOwner);
    }
}
