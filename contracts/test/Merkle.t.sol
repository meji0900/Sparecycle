// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

/// @notice The in-test tree builder (same rules as `src/lib/merkle.ts`) agrees with OpenZeppelin `MerkleProof`.
contract MerkleHelperTest is Test {
    function _leaf(uint64 e, address a, uint256 amt) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(e, a, amt));
    }

    function _tree(uint256 n) internal pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            leaves[i] = _leaf(1, address(uint160(i + 1)), (i + 1) * 1 ether);
        }
    }

    function _checkAll(bytes32[] memory leaves) internal pure {
        bytes32 root = MerkleHelper.root(leaves);
        for (uint256 i; i < leaves.length; ++i) {
            bytes32[] memory p = MerkleHelper.proof(leaves, leaves[i]);
            assertTrue(MerkleProof.verify(p, root, leaves[i]), "member verifies");
            assertFalse(MerkleProof.verify(p, root, keccak256(abi.encode(leaves[i]))), "non-member fails");
        }
    }

    function test_Size1() public pure {
        bytes32[] memory l = _tree(1);
        assertEq(MerkleHelper.root(l), l[0]);
        assertEq(MerkleHelper.proof(l, l[0]).length, 0);
        _checkAll(l);
    }

    function test_Size2() public pure {
        bytes32[] memory l = _tree(2);
        assertEq(MerkleHelper.root(l), MerkleHelper.hashPair(l[0], l[1]));
        _checkAll(l);
    }

    function test_Size3_OddNodePromoted() public pure {
        bytes32[] memory l = _tree(3);
        bytes32[] memory s = MerkleHelper.sorted(l);
        // Layer 1 = [h(s0,s1), s2]; root = h(h(s0,s1), s2). The promoted node's proof has one element.
        assertEq(MerkleHelper.root(l), MerkleHelper.hashPair(MerkleHelper.hashPair(s[0], s[1]), s[2]));
        assertEq(MerkleHelper.proof(l, s[2]).length, 1);
        _checkAll(l);
    }

    function test_Size7() public pure {
        _checkAll(_tree(7));
    }

    function test_OrderIndependent() public pure {
        bytes32[] memory l = _tree(7);
        bytes32[] memory r = new bytes32[](7);
        for (uint256 i; i < 7; ++i) {
            r[i] = l[6 - i];
        }
        assertEq(MerkleHelper.root(l), MerkleHelper.root(r));
    }

    /// @notice Fixed cross-check vector for `src/lib/merkle.ts` (epoch 1, accounts 0x…01/02/03, 1/2/3 ether).
    ///         The expected values were computed independently with viem (encodePacked + keccak256,
    ///         sorted leaves, sorted-pair hashing, odd node promoted). Documented in contracts/README.md.
    function test_CrossCheckVector() public pure {
        bytes32[] memory l = _tree(3);
        assertEq(l[0], 0x048d78b241b1346f17fd3dae57260e459ee74d81d73c08ad8cda31cbc70471fc);
        assertEq(l[1], 0xf871567b802ca48cef05b1172094a5d175d420723ee040ede02c4edfd595194f);
        assertEq(l[2], 0xb4de704126bca82e18914d2799c541dce7d4d18e0f640f0d2e09789f25803a40);
        assertEq(MerkleHelper.root(l), 0x4971f2383291235f443738a07a4de878815dbfa43170bc2af3e913c86fb3e7b9);
    }

    function testFuzz_RandomTrees(uint256 seed, uint8 nRaw) public pure {
        uint256 n = bound(nRaw, 1, 40);
        bytes32[] memory leaves = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            leaves[i] = keccak256(abi.encode(seed, i));
        }
        _checkAll(leaves);
    }
}
