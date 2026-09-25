// Portions derived from https://github.com/idlexnetwork/idlex (MIT License, Copyright (c) 2026 Idlex) — see NOTICE.
//
// Payout Merkle tree of the Sparecycle reward contract. Pure (viem only), so the scheduler, the claim page
// in the browser and the e2e test all compute identical roots and proofs.
//
// leaf  = keccak256(abi.encodePacked(uint64 epochId, address account, uint256 amount))   (60 bytes in, so a
//         leaf can never collide with a 64-byte inner node)
// inner = keccak256(min(a, b) ‖ max(a, b))                                               (sorted pair)
// Leaves are sorted ascending; an odd node at the end of a level is promoted unchanged to the next level.
// This is exactly what OpenZeppelin `MerkleProof.verify(proof, root, leaf)` checks.
import { concat, encodePacked, keccak256, type Address, type Hex } from "viem";

/** Root of an epoch with no payouts. The contract accepts it only together with `reserved == 0`. */
export const ZERO_ROOT: Hex = `0x${"00".repeat(32)}`;

export type MerkleTree = {
  root: Hex;
  /** layers[0] = sorted leaves, last layer = [root]. Empty tree: [[]]. */
  layers: Hex[][];
};

const norm = (h: Hex) => h.toLowerCase() as Hex;

const compare = (a: Hex, b: Hex) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** OpenZeppelin `Hashes.commutativeKeccak256`. */
export function hashPair(a: Hex, b: Hex): Hex {
  return compare(a, b) <= 0 ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

/** keccak256(abi.encodePacked(uint64 epochId, address account, uint256 amount)). */
export function leafOf(epochId: bigint, account: Address, amount: bigint): Hex {
  return keccak256(encodePacked(["uint64", "address", "uint256"], [epochId, account, amount]));
}

/** Builds the tree over `leaves` (any order; duplicates are rejected). */
export function buildTree(leaves: Hex[]): MerkleTree {
  if (leaves.length === 0) return { root: ZERO_ROOT, layers: [[]] };
  const sorted = leaves.map(norm).sort(compare);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) throw new Error("duplicate leaf in Merkle tree");
  }
  const layers: Hex[][] = [sorted];
  while (layers[layers.length - 1].length > 1) {
    const level = layers[layers.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}

/** Sibling hashes from the leaf up to the root (for `MerkleProof.verify`). Throws if the leaf is absent. */
export function getProof(tree: MerkleTree, leaf: Hex): Hex[] {
  let idx = tree.layers[0].indexOf(norm(leaf));
  if (idx < 0) throw new Error("leaf not in tree");
  const proof: Hex[] = [];
  for (let d = 0; d < tree.layers.length - 1; d++) {
    const level = tree.layers[d];
    const sibling = idx ^ 1;
    if (sibling < level.length) proof.push(level[sibling]);
    idx >>= 1;
  }
  return proof;
}

/** Same check as OpenZeppelin `MerkleProof.verify`. */
export function verifyProof(proof: readonly Hex[], root: Hex, leaf: Hex): boolean {
  const computed = proof.reduce<Hex>((h, p) => hashPair(h, norm(p)), norm(leaf));
  return computed === norm(root);
}

export type PayoutEntry = { account: Address; amount: bigint };

/** Convenience: the tree of one epoch's payouts (one leaf per account, amounts > 0). */
export function buildEpochTree(epochId: bigint, entries: readonly PayoutEntry[]) {
  const leaves = entries.map((e) => ({ ...e, leaf: leafOf(epochId, e.account, e.amount) }));
  return { tree: buildTree(leaves.map((l) => l.leaf)), leaves };
}
