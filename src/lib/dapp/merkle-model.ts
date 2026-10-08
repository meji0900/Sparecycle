// Layout of the 3D Merkle tree on the claim page, computed without three.js so the page can build it cheaply.
// Coordinates are scene units: x across the baseboard, y up. Leaves sit on the baseboard, the root on top.
import { keccak256, stringToHex, type Hex } from "viem";
import { buildTree, hashPair } from "@/lib/merkle";

export type NodeState = "idle" | "path" | "sibling" | "collapsed";

export type SceneNode = {
  id: string;
  x: number;
  y: number;
  size: number;
  state: NodeState;
  isRoot: boolean;
  /** Step of the leaf-to-root walk (0 = leaf); -1 when not on the path. */
  order: number;
};

export type SceneEdge = { a: [number, number]; b: [number, number]; path: boolean; order: number };

export type SceneModel = {
  kind: "example" | "tree" | "top" | "path";
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** Number of walk steps from leaf to root (0 when there is no path). */
  steps: number;
  /** null = no proof loaded; true = path verifies against the root shown; false = it does not. */
  verified: boolean | null;
  /** Changes whenever the highlighted path changes, so the scene can replay the walk. */
  pathKey: string;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** Baseboard span under the bottom row. */
  base: { x0: number; x1: number; y: number };
};

export const MAX_RENDERED_LEAVES = 64;
const TREE_WIDTH = 7.2;

function bounds(nodes: SceneNode[]) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.size / 2);
    maxX = Math.max(maxX, n.x + n.size / 2);
    minY = Math.min(minY, n.y - n.size / 2);
    maxY = Math.max(maxY, n.y + n.size / 2);
  }
  return { minX, maxX, minY, maxY };
}

function edgesFrom(nodes: SceneNode[], parentOf: (i: number) => number | null): SceneEdge[] {
  const out: SceneEdge[] = [];
  nodes.forEach((n, i) => {
    const p = parentOf(i);
    if (p === null) return;
    const q = nodes[p];
    const path = n.order >= 0 && q.order >= 0;
    out.push({ a: [n.x, n.y + n.size / 2], b: [q.x, q.y - q.size / 2], path, order: path ? n.order : -1 });
  });
  return out;
}

/**
 * A drawn tree from its layers (layers[0] = sorted leaves, last = [root]; parent of (d, i) is (d + 1, i >> 1)).
 * `from` > 0 draws only the top of a large tree; the bottom row then stands for collapsed subtrees.
 */
function fromLayers(layers: string[][], leafIndex: number | null, verified: boolean | null, kind: SceneModel["kind"], from = 0): SceneModel {
  const rows = layers.slice(from);
  const levels = rows.length;
  const n = rows[0].length;
  const spacing = n > 1 ? Math.min(1, TREE_WIDTH / (n - 1)) : 0;
  const leafSize = n > 1 ? Math.min(0.34, spacing * 0.6) : 0.34;
  const levelGap = levels > 5 ? 0.78 : 0.95;
  const nodes: SceneNode[] = [];
  const index: number[][] = [];
  const pathIdx = leafIndex === null ? null : leafIndex >> from;

  rows.forEach((row, d) => {
    index[d] = [];
    row.forEach((hash, i) => {
      let x: number;
      if (d === 0) x = (i - (n - 1) / 2) * spacing;
      else {
        const a = nodes[index[d - 1][2 * i]];
        const b = index[d - 1][2 * i + 1] !== undefined ? nodes[index[d - 1][2 * i + 1]] : null;
        x = b ? (a.x + b.x) / 2 : a.x;
      }
      const isRoot = d === levels - 1;
      const size = isRoot ? Math.max(0.36, leafSize * 1.35) : Math.min(0.34, leafSize * (1 + d * 0.14));
      let state: NodeState = d === 0 && from > 0 ? "collapsed" : "idle";
      let order = -1;
      if (pathIdx !== null) {
        const on = pathIdx >> d;
        if (i === on) {
          state = "path";
          order = d;
        } else if (i === (on ^ 1)) state = "sibling";
      }
      index[d][i] = nodes.length;
      nodes.push({ id: `${d}:${i}:${hash.slice(2, 10)}`, x, y: d * levelGap, size, state, isRoot, order });
    });
  });

  const parentOf = (k: number) => {
    for (let d = 0; d < levels - 1; d++) {
      const i = index[d].indexOf(k);
      if (i >= 0) return index[d + 1][i >> 1];
    }
    return null;
  };
  const b = bounds(nodes);
  const bottom = rows[0].map((_, i) => nodes[index[0][i]]);
  return {
    kind,
    nodes,
    edges: edgesFrom(nodes, parentOf),
    steps: pathIdx === null ? 0 : levels - 1,
    verified: pathIdx === null ? null : verified,
    pathKey: `${kind}:${layers[layers.length - 1][0]}:${leafIndex ?? "none"}:${verified}`,
    bounds: b,
    base: { x0: bottom[0].x - 0.5, x1: bottom[bottom.length - 1].x + 0.5, y: -leafSize / 2 - 0.04 },
  };
}

/** A published tree. Large trees are drawn from the first level that has at most 64 nodes. */
export function treeModel(layers: Hex[][], leaf: Hex | null, verified: boolean | null): SceneModel | null {
  if (!layers.length || !layers[0].length) return null;
  const leafIndex = leaf ? layers[0].indexOf(leaf.toLowerCase() as Hex) : -1;
  let from = 0;
  while (layers[from].length > MAX_RENDERED_LEAVES) from++;
  return fromLayers(layers, leafIndex >= 0 ? leafIndex : null, verified, from > 0 ? "top" : "tree", from);
}

/**
 * Path only (no published tree, or more than 64 leaves): the leaf, each computed parent, and each proof sibling
 * as a collapsed block. Sides follow the sorted-pair rule: the smaller hash is on the left.
 */
export function pathModel(leaf: Hex, proof: readonly Hex[], verified: boolean | null): SceneModel {
  const gap = 0.9;
  const levelGap = proof.length > 6 ? 0.72 : 0.85;
  const nodes: SceneNode[] = [];
  const parents: (number | null)[] = [];
  let cur: Hex = leaf.toLowerCase() as Hex;
  let x = 0;
  nodes.push({ id: `p0:${cur.slice(2, 10)}`, x, y: 0, size: 0.32, state: "path", isRoot: proof.length === 0, order: 0 });
  parents.push(null);
  let curIndex = 0;
  proof.forEach((sib, d) => {
    const s = sib.toLowerCase() as Hex;
    const left = BigInt(s) < BigInt(cur);
    const sx = x + (left ? -gap : gap);
    nodes.push({ id: `s${d}:${s.slice(2, 10)}`, x: sx, y: d * levelGap, size: 0.3, state: "sibling", isRoot: false, order: -1 });
    const sibIndex = nodes.length - 1;
    cur = hashPair(cur, s);
    x = (x + sx) / 2;
    const isRoot = d === proof.length - 1;
    nodes.push({ id: `p${d + 1}:${cur.slice(2, 10)}`, x, y: (d + 1) * levelGap, size: isRoot ? 0.42 : 0.32, state: "path", isRoot, order: d + 1 });
    const parentIndex = nodes.length - 1;
    parents[curIndex] = parentIndex;
    parents[sibIndex] = parentIndex;
    parents[parentIndex] = null;
    curIndex = parentIndex;
  });
  // A sibling's edge belongs to the computation but not to the lit path (siblings have order -1).
  const edges = edgesFrom(nodes, (i) => parents[i] ?? null);
  return {
    kind: "path",
    nodes,
    edges,
    steps: proof.length,
    verified,
    pathKey: `path:${leaf}:${proof.length}:${verified}`,
    bounds: bounds(nodes),
    base: { x0: -0.6, x1: 0.6, y: -0.2 },
  };
}

let exampleLayers: Hex[][] | null = null;
/** A real 8-leaf tree over dummy leaves, for the "before you load a proof" view. Not anyone's data. */
export function exampleModel(leafIndex: number): SceneModel {
  if (!exampleLayers) {
    exampleLayers = buildTree(Array.from({ length: 8 }, (_, i) => keccak256(stringToHex(`sparecycle example leaf ${i}`)))).layers;
  }
  return fromLayers(exampleLayers, leafIndex % 8, true, "example");
}
