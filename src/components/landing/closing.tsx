"use client";

import Link from "next/link";
import Cubes from "@/components/reactbits/Cubes";
import { ButtonLink } from "@/components/ui/button";

/** Closing band: the same primary action as the hero, next to a field of nodes you can touch. */
export function Closing() {
  return (
    <section aria-labelledby="closing-title" className="border-b border-line">
      <div className="mx-auto grid max-w-[1200px] items-center gap-12 px-4 py-20 sm:px-6 md:grid-cols-[1fr_minmax(0,460px)] md:py-24">
        <div className="max-w-[560px]">
          <h2 id="closing-title" className="text-title font-semibold text-text">
            Read the pot. Run a node. Claim with a proof.
          </h2>
          <p className="mt-5 text-muted">
            Launch App opens the node guide with a one-minute demo of the whole setup. Everything the network pays out
            is visible on Robinhood Chain before anyone claims it.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
            <ButtonLink href="/nodes" size="lg">
              Launch App
            </ButtonLink>
            <Link href="/app" className="link text-sm">
              Open the status page
            </Link>
          </div>
        </div>
        <div className="relative mx-auto aspect-square w-full max-w-[460px]" aria-hidden>
          <Cubes
            gridSize={8}
            gap={0.2}
            faceColor="#111111"
            edgeColor="#4a4a4a"
            edgeWidth={1}
            faceOpacity={1}
            shading={0.55}
            maxAngle={42}
            radius={2.2}
            rippleOnClick
            rippleColor="#00c805"
            autoAnimate
            intro={false}
          />
          <p className="pointer-events-none absolute -bottom-7 left-0 text-xs text-faint">
            Move the pointer across the grid. Click for a ripple.
          </p>
        </div>
      </div>
    </section>
  );
}
