"use client";

import Image from "next/image";
import MagicBento, { type MagicBentoItem } from "@/components/reactbits/MagicBento";
import { paidJobsLive } from "@/lib/funding-copy";
import { TOKEN_COPY_OFF, tokenCopy, type TokenCopy } from "@/lib/token-copy";

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
    title: "Paid by customers",
    description: paidJobsLive
      ? "Node payouts come from what customers pay for checked jobs: 95% to the node pot, 5% to the project treasury. Not from token emissions, not from trading."
      : "Node payouts come from collected fees, not from emissions and not from a promised treasury.",
    visual: <ArtIcon name="fee-funded" zoom={1.9} />,
    colSpan: 2,
  },
  { title: "Two machines per job", description: "Every job runs on two GPUs with different owners. Only matching results are paid.", visual: <ArtIcon name="two-node" zoom={1.8} /> },
  {
    title: "Price first",
    description: "You see what a job costs before you pay, and you are charged only if both GPUs agree.",
    visual: <ArtIcon name="public-pot" zoom={1.05} />,
  },
  {
    title: "Claim when the period closes",
    description: "Every six hours the period closes and each node claims its share from the contract. Anything unused rolls into the next period.",
    visual: <ArtIcon name="merkle" zoom={1.35} />,
  },
  {
    title: "Two models, on purpose",
    description: "Stable Diffusion 1.5 for images and Qwen2.5-1.5B for text. Small enough to check, on a normal gaming GPU.",
    visual: <ArtIcon name="models" zoom={2.1} />,
  },
  { ...tokenCopy(TOKEN_COPY_OFF).bentoNoToken, visual: <ArtIcon name="no-holding" zoom={1.3} /> },
  {
    title: "Everything on-chain",
    description:
      "Customer balances, charges, the pot and every payout live on Robinhood Chain. The proof page lists every contract and transaction.",
    visual: <ArtIcon name="no-allocation" zoom={1.35} />,
    colSpan: 2,
  },
];

const NO_TOKEN_ITEM = ITEMS.findIndex((it) => it.title === tokenCopy(TOKEN_COPY_OFF).bentoNoToken.title);

/** `noToken`: the flag-dependent "No token needed" card (src/lib/token-copy.ts); the default is today's card. */
export function FeatureBento({ noToken }: { noToken?: TokenCopy["bentoNoToken"] } = {}) {
  const items = noToken ? ITEMS.map((it, i) => (i === NO_TOKEN_ITEM ? { ...it, ...noToken } : it)) : ITEMS;
  return (
    <MagicBento
      items={items}
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
