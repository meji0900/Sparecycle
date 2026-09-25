// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/Test.sol";
import {RewardsFixture} from "./Base.t.sol";
import {SparecycleRewards} from "../src/SparecycleRewards.sol";
import {EthPusher} from "./mocks/Mocks.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

/// @notice Gas scenarios for the README table. Run with isolation so each call is its own transaction
///         (cold storage, like on-chain):  forge test --match-contract GasScenarios --isolate -vv
///         Printed numbers are `vm.lastCallGas().gasTotalUsed`; with --isolate that is the whole transaction
///         (intrinsic 21,000 + calldata + execution, before refunds), cross-checked against anvil receipts.
contract GasScenariosTest is RewardsFixture {
    /// @dev `gasTotalUsed` of the last call. Decoded by hand: the installed forge-std declares a 6-field
    ///      `Vm.Gas` struct while forge 1.8.1 returns 5 fields, so the typed cheatcode call fails to decode.
    function _lastGasUsed() internal view returns (uint256 used) {
        (bool ok, bytes memory ret) = address(vm).staticcall(abi.encodeWithSignature("lastCallGas()"));
        require(ok && ret.length >= 64, "lastCallGas");
        assembly {
            used := mload(add(ret, 64))
        }
    }

    function _log(string memory label) internal view {
        console2.log(label, _lastGasUsed());
    }

    function _closeTree(uint256 n) internal returns (uint64 id, bytes32[] memory leaves, address[] memory ops) {
        ops = new address[](n);
        uint256[] memory amts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ops[i] = address(uint160(0x10000 + i));
            amts[i] = 1 gwei;
        }
        _fund(ethR, n * 1 gwei + 1 ether);
        id = ethR.currentEpoch();
        leaves = _leaves(ethR, id, ops, amts);
        _warpToEnd(ethR);
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(id, MerkleHelper.root(leaves), n * 1 gwei);
        _log(string.concat("closeEpochAndPostRoot (rollover > 0, nothing to sync), leaves=", vm.toString(n)));
    }

    function _claimDepth(uint256 n) internal {
        (uint64 id, bytes32[] memory leaves, address[] memory ops) = _closeTree(n);
        bytes32[] memory p = MerkleHelper.proof(leaves, leaves[n / 2]);
        vm.prank(ops[n / 2]);
        ethR.claim(id, 1 gwei, p);
        _log(string.concat("claim ETH, proof length ", vm.toString(p.length)));
    }

    function test_Gas_Claim_Depth1() public {
        _claimDepth(2);
    }

    function test_Gas_Claim_Depth4() public {
        _claimDepth(16);
    }

    function test_Gas_Claim_Depth7() public {
        _claimDepth(128);
    }

    function test_Gas_Claim_Depth10() public {
        _claimDepth(1024);
    }

    function test_Gas_Claim_Token_Depth7() public {
        uint256 n = 128;
        address[] memory ops = new address[](n);
        uint256[] memory amts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ops[i] = address(uint160(0x10000 + i));
            amts[i] = 1e6;
        }
        _fund(tokR, n * 1e6);
        bytes32[] memory leaves = _leaves(tokR, 0, ops, amts);
        _warpToEnd(tokR);
        vm.prank(sched);
        tokR.closeEpochAndPostRoot(0, MerkleHelper.root(leaves), n * 1e6);
        bytes32[] memory p = MerkleHelper.proof(leaves, leaves[3]);
        vm.prank(ops[3]);
        tokR.claim(0, 1e6, p);
        _log("claim ERC-20 (USDG-like), proof length 7");
    }

    function test_Gas_Close_WithSync() public {
        _fund(ethR, 1 ether);
        new EthPusher().pushTransfer{value: 1 ether}(payable(address(ethR)));
        _warpToEnd(ethR);
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(0, keccak256("root"), 1.5 ether);
        _log("closeEpochAndPostRoot (sync credits a 2300-gas push first, rollover > 0)");
    }

    function test_Gas_Close_FullyReserved() public {
        _fund(ethR, 1 ether);
        _warpToEnd(ethR);
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(0, keccak256("root"), 1 ether);
        _log("closeEpochAndPostRoot (reserved == pot, rollover 0)");
    }

    function test_Gas_Close_Empty() public {
        _warpToEnd(ethR);
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(0, bytes32(0), 0);
        _log("closeEpochAndPostRoot (empty epoch, zero root)");
    }

    function test_Gas_Close_SecondEpoch() public {
        _closeTree(8);
        vm.warp(block.timestamp + EPOCH);
        vm.prank(sched);
        ethR.closeEpochAndPostRoot(1, keccak256("root"), 0.5 ether);
        _log("closeEpochAndPostRoot (steady state: epoch 1, pot from rollover)");
    }

    function test_Gas_Inflows() public {
        vm.prank(funder);
        ethR.fund{value: 1 ether}();
        _log("fund() first inflow of the epoch");
        vm.prank(funder);
        ethR.fund{value: 1 ether}();
        _log("fund() later inflow");
        vm.prank(funder);
        tokR.fundToken(1e6);
        _log("fundToken() (USDG-like)");
        new EthPusher().pushTransfer{value: 1 ether}(payable(address(ethR)));
        ethR.sync();
        _log("sync() crediting a push");
        escrow.credit{value: 1 ether}(address(ethR));
        ethR.claimFeesFromEscrow();
        _log("claimFeesFromEscrow() (mock escrow)");
        ethR.claimFeesFromEscrow();
        _log("claimFeesFromEscrow() with zero escrow balance (no-op)");
    }
}
