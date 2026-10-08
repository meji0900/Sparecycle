"use client";

import Image from "next/image";
import MagicBento, { type MagicBentoItem } from "@/components/reactbits/MagicBento";
import { paidJobsLive } from "@/lib/funding-copy";

/** Flow-made maquette icon, cropped to its subject and faded into the card. Decoration only. */
function ArtIcon({ name, zoom = 1.6 }: { name: string; zoom?: number }) {
  return (
    <div
      className="relative flex h-full min-h-[120px] w-full items-center justify-center overflow-hidden [mask-image:linear-gradient(180deg,transparent_0%,black_16%,black_84%,transparent_100%)]"
      aria-hidden
    >
      <div className="relative aspect-square h-full" style={{ transform: `scale(${zoom})` }}>
        <Image
          src={`/art/icon-${name}.webp`}
          alt=""
          fill
          sizes="(min-width: 1024px) 320px, 70vw"
          className="object-cover [mask-image:radial-gradient(closest-side,black_45%,transparent_100%)]"
        />
      </div>
    </div>
  );
}

const ITEMS: MagicBentoItem[] = [
  {
    title: "Fee-funded payouts",
    description: paidJobsLive
      ? "Nodes are paid from collected fees and verified job payments, not from emissions and not from a promised treasury."
      : "Nodes are paid from collected fees, not from emissions and not from a promised treasury.",
    visual: <ArtIcon name="fee-funded" zoom={1.9} />,
    colSpan: 2,
  },
  { title: "Two-node checks", description: "A job is eligible for payment only if two nodes agree.", visual: <ArtIcon name="two-node" zoom={1.8} /> },
  {
    title: "A public pot",
    description: "The current epoch pot is a number you can read from the reward contract, not a marketing metric.",
    visual: <ArtIcon name="public-pot" zoom={1.05} />,
  },
  {
    title: "Merkle claims",
    description: "Each eligible node claims from the contract with a proof. Unused pot rolls to the next epoch.",
    visual: <ArtIcon name="merkle" zoom={1.35} />,
  },
  {
    title: "A short model list",
    description: "MVP runs Stable Diffusion 1.5 and one small text model. This is not an open marketplace.",
    visual: <ArtIcon name="models" zoom={2.1} />,
  },
  { title: "No holding requirement", description: "You do not have to buy or lock the token to run a node.", visual: <ArtIcon name="no-holding" zoom={1.3} /> },
  {
    title: "No team allocation",
    description:
      "At launch, the supply goes to the Pons curve. Liquidity that forms at graduation is locked by Pons, not by a Sparecycle LP we control.",
    visual: <ArtIcon name="no-allocation" zoom={1.35} />,
    colSpan: 2,
  },
];

export function FeatureBento() {
  return (
    <MagicBento
      items={ITEMS}
      columns={3}
      rowHeight={250}
      gap={1}
      radius={8}
      theme="dark"
      glowColor="0, 200, 5"
      enableBorderGlow
      enableSpotlight
      spotlightRadius={260}
      enableStars={false}
      enableTilt={false}
      enableMagnetism={false}
      clickEffect={false}
      textAutoHide={false}
    />
  );
}
