"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import ScrollReveal from "@/components/reactbits/ScrollReveal";
import { useSceneEnv } from "@/components/three/use-scene-env";
import { cn } from "@/lib/utils";
import { FUNDING } from "@/lib/funding-copy";

const FeeFlow = dynamic(() => import("@/components/three/fee-flow"), { ssr: false, loading: () => null });

const STEPS = [
  {
    station: "Bonding curve",
    title: "A token trades on Pons v2.",
    body: "Trades pay a protocol fee, and optionally a creator tax set at launch. This project turns buybacks off so the creator share can fund work, not a vest.",
  },
  {
    station: "Fee escrow",
    title: "Fees are swept, then claimed.",
    body: "Fees accrue on the curve or the Pons hook until a sweep sends them to the official fee escrow. The reward contract (or a multisig that forwards to it) calls claim or claimToken.",
  },
  {
    station: "Epoch pot",
    title: "An epoch pot is filled only with what arrived.",
    body: FUNDING.potBody,
  },
  {
    station: "Two-node check",
    title: "Jobs are cross-checked.",
    body: "In the MVP, two nodes run each job. Only results that agree are eligible to be paid.",
  },
  {
    station: "Merkle claim",
    title: "Nodes claim with a proof.",
    body: "The scheduler posts a Merkle root for the epoch. Payouts reserved in that root cannot exceed the pot. Whatever is unused rolls forward.",
  },
];

export function HowItWorks() {
  const sceneRef = useRef<HTMLDivElement>(null);
  const { reduced, inView, webgl } = useSceneEnv(sceneRef);
  const [active, setActive] = useState<number | null>(null);
  const [auto, setAuto] = useState(0);
  const pinned = active !== null;

  // Walk through the stations while nobody is pointing at a step.
  useEffect(() => {
    if (reduced || !inView || pinned) return;
    const id = setInterval(() => setAuto((a) => (a + 1) % STEPS.length), 3200);
    return () => clearInterval(id);
  }, [reduced, inView, pinned]);

  const current = active ?? (reduced ? null : auto);
  const frameloop = !inView || reduced ? "demand" : "always";

  return (
    <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto max-w-[1200px] px-4 pt-24 pb-20 sm:px-6">
        <div className="max-w-[640px]">
          <h2 id="how-title" className="text-title font-semibold text-text">
            How it works
          </h2>
          <p className="mt-4 text-muted">
            Five steps, in order. Money moves only along the dashed lines: from trades into the pot, and out of the pot
            only to nodes whose work was checked.
          </p>
        </div>

        <div
          ref={sceneRef}
          className="relative mt-12 aspect-[4/3] w-full overflow-hidden rounded-t-l border border-line bg-coal sm:aspect-[12/3.8]"
          aria-hidden
        >
          {webgl ? <FeeFlow active={current} animate={!reduced} frameloop={frameloop} /> : null}
          <p className="pointer-events-none absolute top-3 left-4 text-xs text-faint">Illustration, not live data.</p>
        </div>

        <ol className="grid gap-px overflow-hidden rounded-b-l border-x border-b border-line bg-line sm:grid-cols-5">
          {STEPS.map((s, i) => (
            <li key={s.station} className="bg-coal">
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                aria-pressed={current === i}
                className="group flex h-full w-full flex-col items-start gap-3 p-5 text-left"
              >
                <span className="flex w-full items-center justify-between gap-3">
                  <span className={cn("text-xs transition-colors duration-200", current === i ? "text-signal" : "text-faint")}>
                    <span className="num">{i + 1}</span> {s.station}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      "h-px flex-1 transition-colors duration-200",
                      current === i ? "bg-signal" : "bg-line",
                    )}
                  />
                </span>
                <span className="font-medium text-text">{s.title}</span>
                <span className="text-sm leading-relaxed text-muted">{s.body}</span>
              </button>
            </li>
          ))}
        </ol>

        <ScrollReveal
          containerClassName="mt-16 max-w-[900px]"
          textClassName="!text-[clamp(1.75rem,1.1rem+2.2vw,2.75rem)] !leading-[1.15] tracking-[-0.03em] text-text"
          splitBy="words"
          effect="fade"
          mode="scrub"
          baseOpacity={0.14}
          enableBlur
          blurStrength={4}
        >
          If fees are small, rewards are small. If there are no fees, there is no payout.
        </ScrollReveal>
      </div>
    </section>
  );
}
