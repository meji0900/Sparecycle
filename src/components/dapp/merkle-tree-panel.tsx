"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import { useSceneEnv } from "@/components/three/use-scene-env";
import { exampleModel, pathModel, treeModel, type SceneModel } from "@/lib/dapp/merkle-model";
import { cn } from "@/lib/utils";

const MerkleTree = dynamic(() => import("@/components/three/merkle-tree"), { ssr: false, loading: () => null });

export type MerkleView =
  | { kind: "example" }
  | { kind: "tree"; epochId: number; layers: Hex[][]; leaf: Hex | null; verified: boolean | null }
  | { kind: "path"; epochId: number | null; leaf: Hex; proof: Hex[]; verified: boolean | null };

function caption(view: MerkleView, model: SceneModel | null, leafCount: number) {
  if (view.kind === "example") return "Eight dummy leaves. One path at a time lights up the way your proof will once it is loaded.";
  if (view.kind === "path") {
    const where = view.epochId === null ? "" : `Epoch ${view.epochId}: `;
    return `${where}your leaf, the ${view.proof.length} sibling hash${view.proof.length === 1 ? "" : "es"} in the proof and each computed parent. Siblings stand in for their collapsed subtrees.`;
  }
  const leaves = `${leafCount} ${leafCount === 1 ? "leaf" : "leaves"}`;
  if (model?.kind === "top") return `Epoch ${view.epochId}: published tree with ${leaves}. Only the top levels are drawn; the bottom row stands for collapsed subtrees.`;
  return view.leaf
    ? `Epoch ${view.epochId}: published tree with ${leaves}, your path highlighted.`
    : `Epoch ${view.epochId}: published tree with ${leaves}. A wallet with a leaf here sees its path once connected.`;
}

export function MerkleTreePanel({ view, className }: { view: MerkleView; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { reduced, inView, webgl } = useSceneEnv(ref);
  const [exampleLeaf, setExampleLeaf] = useState(5);

  // The example walks a different leaf every few seconds while visible and motion is allowed.
  useEffect(() => {
    if (view.kind !== "example" || reduced || !inView) return;
    const id = setInterval(() => setExampleLeaf((i) => (i + 3) % 8), 3400);
    return () => clearInterval(id);
  }, [view.kind, reduced, inView]);

  const model = useMemo<SceneModel | null>(() => {
    if (view.kind === "example") return exampleModel(exampleLeaf);
    if (view.kind === "path") return pathModel(view.leaf, view.proof, view.verified);
    return treeModel(view.layers, view.leaf, view.verified);
  }, [view, exampleLeaf]);

  const leafCount = view.kind === "tree" ? view.layers[0]?.length ?? 0 : 0;
  const frameloop = inView && !reduced ? "always" : "demand";
  const state =
    view.kind === "example"
      ? null
      : model?.verified === true
        ? "Path verifies against the root shown."
        : model?.verified === false
          ? "Path does not verify against the on-chain root."
          : null;

  return (
    <figure className={cn("min-w-0", className)}>
      <div ref={ref} className="relative aspect-[16/11] w-full overflow-hidden rounded-t-l border border-line bg-coal">
        {webgl && model ? <MerkleTree model={model} animate={!reduced} frameloop={frameloop} /> : null}
        {!webgl ? (
          <p className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted">
            3D view unavailable in this browser. The proof checks below do not depend on it.
          </p>
        ) : null}
        {view.kind === "example" ? (
          <p className="pointer-events-none absolute top-3 left-4 rounded-s border border-line bg-coal/90 px-2 py-1 text-xs text-muted">
            Example tree, not your data
          </p>
        ) : null}
      </div>
      <figcaption className="rounded-b-l border-x border-b border-line px-4 py-3 text-xs leading-relaxed text-muted">
        <p>{caption(view, model, leafCount)}</p>
        {state ? <p className="mt-1 text-text">{state}</p> : null}
        <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-faint">
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[2px] border border-signal bg-signal" />
            Verified path
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[2px] border border-[#e8e8e8] bg-[#333]" />
            Sibling hash in the proof
          </li>
          <li className="inline-flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[2px] border border-[#555] bg-[#333]" />
            Other node
          </li>
        </ul>
      </figcaption>
    </figure>
  );
}
