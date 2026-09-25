// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MerkleHelper
/// @notice Test-only Merkle tree builder matching the scheduler's tree (`src/lib/merkle.ts`) and OpenZeppelin
///         `MerkleProof.verify`: leaves sorted ascending, sorted-pair keccak256 for inner nodes, and an odd
///         node at the end of a layer is promoted unchanged to the next layer.
library MerkleHelper {
    /// @notice Commutative pair hash (OpenZeppelin `Hashes.commutativeKeccak256`).
    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @notice Returns a sorted copy of `leaves` (insertion sort; test sizes are small).
    function sorted(bytes32[] memory leaves) internal pure returns (bytes32[] memory out) {
        out = new bytes32[](leaves.length);
        for (uint256 i; i < leaves.length; ++i) {
            bytes32 v = leaves[i];
            uint256 j = i;
            while (j > 0 && out[j - 1] > v) {
                out[j] = out[j - 1];
                --j;
            }
            out[j] = v;
        }
    }

    /// @notice Next layer up: pairs hashed, odd last node promoted.
    function _up(bytes32[] memory layer) private pure returns (bytes32[] memory next) {
        uint256 n = layer.length;
        next = new bytes32[]((n + 1) / 2);
        for (uint256 i; i < n; i += 2) {
            next[i / 2] = i + 1 < n ? hashPair(layer[i], layer[i + 1]) : layer[i];
        }
    }

    /// @notice Root of the tree over `leaves` (any order). Zero for an empty list.
    function root(bytes32[] memory leaves) internal pure returns (bytes32) {
        if (leaves.length == 0) return bytes32(0);
        bytes32[] memory layer = sorted(leaves);
        while (layer.length > 1) layer = _up(layer);
        return layer[0];
    }

    /// @notice Proof for `leaf` in the tree over `leaves`. Reverts if `leaf` is not in `leaves`.
    function proof(bytes32[] memory leaves, bytes32 leaf) internal pure returns (bytes32[] memory p) {
        bytes32[] memory layer = sorted(leaves);
        uint256 idx = type(uint256).max;
        for (uint256 i; i < layer.length; ++i) {
            if (layer[i] == leaf) {
                idx = i;
                break;
            }
        }
        require(idx != type(uint256).max, "MerkleHelper: leaf not found");

        p = new bytes32[](256);
        uint256 len;
        while (layer.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < layer.length) p[len++] = layer[sib];
            layer = _up(layer);
            idx /= 2;
        }
        assembly {
            mstore(p, len)
        }
    }
}
