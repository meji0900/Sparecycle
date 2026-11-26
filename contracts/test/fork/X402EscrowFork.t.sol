// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SparecycleX402Escrow} from "../../src/SparecycleX402Escrow.sol";

interface IUSDG {
    function balanceOf(address) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

interface IRewardsScheduler {
    function scheduler() external view returns (address);
}

/// @notice SparecycleX402Escrow against Robinhood Chain mainnet state: real USDG (EIP-3009 through its module), the live
///         SparecycleRewards (scheduler, ETH payout) and the treasury Safe, with the launch caps (1 / 100 / 10 USDG).
///         FORK_TESTS=1 [FORK_RPC_URL=<rpc>] forge test --match-path test/fork/X402EscrowFork.t.sol -vv
///         Skips cleanly when FORK_TESTS is not 1 or the RPC cannot be reached.
contract X402EscrowForkTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant REWARDS = 0x68A0569130551154FC1aABD71d99f65681c58Fe9;
    address internal constant SAFE = 0xb262E4436aD6760F91e987f14e2fAc5D6550c71B;
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    SparecycleX402Escrow internal escrow;
    address internal scheduler;
    uint256 internal payerKey = 0xA11CE5;
    address internal payer;

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
        scheduler = IRewardsScheduler(REWARDS).scheduler();
        payer = vm.addr(payerKey);
        // The launch caps: 1 USDG per job, 100 USDG held in total, 10 USDG per payer per epoch (USDG has 6 decimals).
        escrow = new SparecycleX402Escrow(SAFE, REWARDS, USDG, SAFE, SAFE, 12 hours, [uint256(1e6), 100e6, 10e6]);
        deal(USDG, payer, 5e6);
        assertEq(IUSDG(USDG).balanceOf(payer), 5e6, "payer funded on the fork");
    }

    function _sign(uint256 amount, bytes32 nonce, uint256 validBefore) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, payer, address(escrow), amount, uint256(0), validBefore, nonce)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IUSDG(USDG).DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(payerKey, digest);
    }

    function _fund(bytes32 id, uint256 amount, bytes32 nonce) internal {
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(amount, nonce, validBefore);
        vm.prank(scheduler);
        escrow.fund(id, payer, amount, 0, validBefore, nonce, v, r, s);
    }

    /// An image job at the launch price (3,200 units x 5 micro-USDG = 16,000 = 0.016 USDG): funded by the payer's signed
    /// authorization, then forwarded on agreement. The pot pays ETH, so 95% goes to forwardTo (the Safe) for conversion
    /// and 5% to the treasury (also the Safe): the Safe receives the whole amount, the escrow keeps nothing.
    function test_Fork_FundThenForward() public {
        uint256 amount = 16_000;
        bytes32 nonce = keccak256("fork-forward");
        uint256 safeBefore = IUSDG(USDG).balanceOf(SAFE);
        _fund(keccak256("job-1"), amount, nonce);
        assertTrue(IUSDG(USDG).authorizationState(payer, nonce), "authorization used");
        assertEq(IUSDG(USDG).balanceOf(address(escrow)), amount, "escrow holds the payment");
        assertEq(IUSDG(USDG).balanceOf(payer), 5e6 - amount);
        vm.prank(scheduler);
        escrow.forward(keccak256("job-1"));
        assertEq(IUSDG(USDG).balanceOf(SAFE) - safeBefore, amount, "95% forwardTo + 5% treasury, both the Safe");
        assertEq(IUSDG(USDG).balanceOf(address(escrow)), 0);
        assertEq(escrow.totalHeld(), 0);
    }

    /// Results did not match: the scheduler refunds the payer in full.
    function test_Fork_FundThenRefundByScheduler() public {
        uint256 amount = 10_275;
        _fund(keccak256("job-2"), amount, keccak256("fork-refund"));
        vm.prank(scheduler);
        escrow.refund(keccak256("job-2"));
        assertEq(IUSDG(USDG).balanceOf(payer), 5e6, "payer whole again");
        assertEq(IUSDG(USDG).balanceOf(address(escrow)), 0);
    }

    /// A stuck scheduler cannot keep the money: after the deadline anyone can refund the payer.
    function test_Fork_RefundByAnyoneAfterDeadline() public {
        uint256 amount = 16_000;
        _fund(keccak256("job-3"), amount, keccak256("fork-deadline"));
        vm.expectRevert();
        vm.prank(address(0xBEEF));
        escrow.refund(keccak256("job-3"));
        vm.warp(block.timestamp + 12 hours + 1);
        vm.prank(address(0xBEEF));
        escrow.refund(keccak256("job-3"));
        assertEq(IUSDG(USDG).balanceOf(payer), 5e6);
    }

    /// The launch cap per job holds against the real token: 1 USDG + 1 is refused before any transfer.
    function test_Fork_PerJobCap() public {
        uint256 amount = 1e6 + 1;
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(amount, keccak256("fork-cap"), validBefore);
        vm.prank(scheduler);
        vm.expectRevert();
        escrow.fund(keccak256("job-4"), payer, amount, 0, validBefore, keccak256("fork-cap"), v, r, s);
        assertEq(IUSDG(USDG).balanceOf(payer), 5e6);
    }
}
