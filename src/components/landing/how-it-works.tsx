"use client";

import Link from "next/link";
import ScrollReveal from "@/components/reactbits/ScrollReveal";

const STEPS = [
  {
    title: "You send a job and pay for it.",
    body: "Pick an image or a text job. The price is shown before you pay, and the free trial needs no wallet.",
    link: { href: "/playground", label: "Open the playground" },
  },
  {
    title: "Two machines run the same job.",
    body: "The scheduler hands it to two GPUs with different owners. Neither sees the other's result.",
    link: { href: "/#network", label: "See the GPUs online" },
  },
  {
    title: "They are paid only if they agree.",
    body: "If the results match, you get yours and the two owners can claim their share when the six-hour period closes. If they don't match, nobody is paid for that job and you are not charged.",
    link: { href: "/proof", label: "See a real payout" },
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto max-w-[1200px] px-4 pt-24 pb-20 sm:px-6">
        <div className="max-w-[640px]">
          <h2 id="how-title" className="text-title font-semibold text-text">
            How it works
          </h2>
          <p className="mt-4 text-muted">Three steps. The money only moves after step three.</p>
        </div>

        <ol className="mt-12 grid gap-px overflow-hidden rounded-l border border-line bg-line md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-3 bg-coal p-6">
              <span className="num text-sm text-signal">{i + 1}</span>
              <p className="text-lg font-medium text-text">{s.title}</p>
              <p className="text-sm leading-relaxed text-muted">{s.body}</p>
              <Link href={s.link.href} className="link mt-auto pt-2 text-sm">
                {s.link.label}
              </Link>
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
          No agreement, no payment. Nodes are paid for checked work, from what customers paid for it.
        </ScrollReveal>
      </div>
    </section>
  );
}
