// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SparecycleX402Escrow} from "../../src/SparecycleX402Escrow.sol";
import {MockEIP3009Token} from "../mocks/MockEIP3009.sol";

/// @notice Drives SparecycleX402Escrow through random funds, forwards, refunds (scheduler and strangers), time warps,
///         direct donations and surplus recoveries, and keeps ghost books of where every unit went. Every call is
///         pre-checked so it never reverts (the suite runs with fail_on_revert = true).
contract X402EscrowHandler is Test {
    SparecycleX402Escrow public esc;
    MockEIP3009Token public token;
    address public sched;
    address public safe;
    address public conv;
    address public treasury;
    address public recoverTo = makeAddr("recoverTo");

    uint256[] internal payerKeys;
    address[] public payers;
    bytes32[] public ids;
    mapping(bytes32 => uint256) public settledCount; // forwards + refunds per escrow
    mapping(bytes32 => uint8) public ghostState; // 0 none, 1 held, 2 forwarded, 3 refunded
    mapping(bytes32 => uint256) public ghostAmount;
    mapping(bytes32 => address) public ghostPayer;

    uint256 public ghostFunded;
    uint256 public ghostForwarded;
    uint256 public ghostRefunded;
    uint256 public ghostDonated;
    uint256 public ghostRecovered;
    uint256 public ghostToPot;
    uint256 public ghostToTreasury;
    mapping(address => uint256) public ghostRefundedTo;
    uint256 public calls;
    uint256 internal seq;

    constructor(SparecycleX402Escrow esc_, MockEIP3009Token token_, address sched_, address safe_) {
        esc = esc_;
        token = token_;
        sched = sched_;
        safe = safe_;
        conv = esc_.forwardTo();
        treasury = esc_.treasury();
        for (uint256 i; i < 4; ++i) {
            uint256 k = uint256(keccak256(abi.encode("payer", i))) % (2 ** 160);
            payerKeys.push(k);
            payers.push(vm.addr(k));
            token.mint(vm.addr(k), 1e18);
        }
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function payersLength() external view returns (uint256) {
        return payers.length;
    }

    // ---------------------------------------------------------------- actions

    function fund(uint256 payerSeed, uint256 amount) external {
        calls++;
        amount = bound(amount, 1, esc.maxPerJob());
        if (esc.totalHeld() + amount > esc.maxTotalHeld() || esc.fundingPaused()) return;
        uint256 i = payerSeed % payerKeys.length;
        if (esc.fundedInEpoch(payers[i], esc.rewards().currentEpoch()) + amount > esc.maxPerPayerPerEpoch()) return;
        if (token.balanceOf(payers[i]) < amount) return;
        bytes32 id = keccak256(abi.encode("escrow", ++seq));
        bytes32 nonce = keccak256(abi.encode("auth", seq));
        uint256 validBefore = block.timestamp + 300;
        bytes32 structHash = keccak256(
            abi.encode(token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payers[i], address(esc), amount, uint256(0), validBefore, nonce)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerKeys[i], keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(sched);
        esc.fund(id, payers[i], amount, 0, validBefore, nonce, v, r, s);
        ids.push(id);
        ghostState[id] = 1;
        ghostAmount[id] = amount;
        ghostPayer[id] = payers[i];
        ghostFunded += amount;
    }

    function forward(uint256 idSeed) external {
        calls++;
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        (, uint64 deadline,,) = esc.escrows(id);
        if (ghostState[id] != 1 || block.timestamp > deadline) return;
        uint256 amount = ghostAmount[id];
        vm.prank(sched);
        esc.forward(id);
        ghostState[id] = 2;
        settledCount[id]++;
        ghostForwarded += amount;
        uint256 toTreasury = (amount * 500) / 10_000;
        ghostToTreasury += toTreasury;
        ghostToPot += amount - toTreasury;
    }

    function refundByScheduler(uint256 idSeed) external {
        calls++;
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        if (ghostState[id] != 1) return;
        vm.prank(sched);
        esc.refund(id);
        _refunded(id);
    }

    /// @dev A stranger refunds: only possible after the deadline, so warp there first.
    function refundByStranger(uint256 idSeed, address who) external {
        calls++;
        if (ids.length == 0 || who == sched) return;
        bytes32 id = ids[idSeed % ids.length];
        if (ghostState[id] != 1) return;
        (, uint64 deadline,,) = esc.escrows(id);
        if (block.timestamp <= deadline) vm.warp(uint256(deadline) + 1);
        vm.prank(who);
        esc.refund(id);
        _refunded(id);
    }

    function warp(uint256 secs) external {
        calls++;
        vm.warp(block.timestamp + bound(secs, 1, 3 days));
    }

    function donate(uint256 amount) external {
        calls++;
        amount = bound(amount, 1, 1e12);
        token.mint(address(this), amount);
        token.transfer(address(esc), amount);
        ghostDonated += amount;
    }

    function recover() external {
        calls++;
        uint256 s = esc.surplus();
        if (s == 0) return;
        vm.prank(safe);
        esc.recoverSurplus(address(token), recoverTo);
        ghostRecovered += s;
    }

    function setCaps(uint256 perJob, uint256 total, uint256 perPayer) external {
        calls++;
        perJob = bound(perJob, 1, 1e12);
        total = bound(total, perJob, 5e12);
        perPayer = bound(perPayer, 1, 5e12);
        vm.prank(safe);
        esc.setCaps(perJob, total, perPayer);
    }

    function togglePause() external {
        calls++;
        bool next = !esc.fundingPaused(); // read first: a prank applies to the next call
        vm.prank(safe);
        esc.setFundingPaused(next);
    }

    function _refunded(bytes32 id) internal {
        ghostState[id] = 3;
        settledCount[id]++;
        ghostRefunded += ghostAmount[id];
        ghostRefundedTo[ghostPayer[id]] += ghostAmount[id];
    }
}
