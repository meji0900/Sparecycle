// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SparecycleRewards} from "../../src/SparecycleRewards.sol";
import {SparecycleX402Escrow} from "../../src/SparecycleX402Escrow.sol";
import {MockPonsFeeEscrow} from "../mocks/MockPonsFeeEscrow.sol";
import {MockEIP3009Token} from "../mocks/MockEIP3009.sol";
import {X402EscrowHandler} from "./X402EscrowHandler.sol";

/// @notice Every escrow ends forwarded or refunded exactly once, and escrowed funds have no other way out.
contract SparecycleX402EscrowInvariantTest is Test {
    SparecycleX402Escrow internal esc;
    MockEIP3009Token internal token;
    X402EscrowHandler internal handler;
    address internal sched = makeAddr("scheduler");
    address internal safe = makeAddr("safe");

    function setUp() public {
        vm.warp(1_750_000_000);
        token = new MockEIP3009Token("Global Dollar", "1", 6);
        SparecycleRewards rewards = new SparecycleRewards(safe, sched, address(0), address(new MockPonsFeeEscrow()), 1 days);
        esc = new SparecycleX402Escrow(safe, address(rewards), address(token), makeAddr("treasury"), makeAddr("forwardTo"), 12 hours, [uint256(1e9), 1e10, 1e10]);
        handler = new X402EscrowHandler(esc, token, sched, safe);
        targetContract(address(handler));
    }

    /// @dev The escrow holds exactly the held escrows plus donations not yet recovered.
    function invariant_balanceIsHeldPlusSurplus() public view {
        assertEq(token.balanceOf(address(esc)), esc.totalHeld() + handler.ghostDonated() - handler.ghostRecovered());
        assertGe(token.balanceOf(address(esc)), esc.totalHeld());
    }

    /// @dev Every unit funded is still held, was forwarded or was refunded: nothing else.
    function invariant_conservation() public view {
        assertEq(handler.ghostFunded(), esc.totalHeld() + handler.ghostForwarded() + handler.ghostRefunded());
    }

    /// @dev Each escrow: the on-chain state matches the books, it settled at most once, and it is settled iff not held.
    function invariant_eachEscrowEndsExactlyOnce() public view {
        uint256 held;
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.ids(i);
            (address payer,, SparecycleX402Escrow.State s, uint256 amount) = esc.escrows(id);
            assertEq(uint8(s), handler.ghostState(id));
            assertEq(payer, handler.ghostPayer(id));
            assertEq(amount, handler.ghostAmount(id));
            uint256 c = handler.settledCount(id);
            assertLe(c, 1);
            assertEq(c == 1, s != SparecycleX402Escrow.State.Held);
            if (s == SparecycleX402Escrow.State.Held) held += amount;
        }
        assertEq(held, esc.totalHeld());
    }

    /// @dev Outflows go only to the conversion address + treasury (forwards), the payers (refunds) and the recovery
    ///      target (surplus): in exactly the booked amounts.
    function invariant_outflowsOnlyToTheirDestinations() public view {
        assertEq(token.balanceOf(esc.forwardTo()), handler.ghostToPot());
        assertEq(token.balanceOf(esc.treasury()), handler.ghostToTreasury());
        assertEq(handler.ghostToPot() + handler.ghostToTreasury(), handler.ghostForwarded());
        assertEq(token.balanceOf(handler.recoverTo()), handler.ghostRecovered());
        uint256 n = handler.payersLength();
        for (uint256 i; i < n; ++i) {
            address p = handler.payers(i);
            // Each payer started with 1e18: balance = start - what it funded + what came back.
            uint256 funded;
            uint256 m = handler.idsLength();
            for (uint256 j; j < m; ++j) {
                bytes32 id = handler.ids(j);
                if (handler.ghostPayer(id) == p) funded += handler.ghostAmount(id);
            }
            assertEq(token.balanceOf(p), 1e18 - funded + handler.ghostRefundedTo(p));
        }
    }
}
