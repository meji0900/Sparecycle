import type { Metadata } from "next";
import Link from "next/link";
import { ROADMAP_STATUSES, roadmapByStatus } from "@/lib/roadmap";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Roadmap",
  description: "What Sparecycle is working on, by status: in progress, planned, exploring. No dates and no promises.",
};

export default function RoadmapPage() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-14 pb-24 sm:px-6 sm:pt-20">
      <header className="max-w-[720px]">
        <h1 className="text-title font-semibold text-text">Roadmap</h1>
        <p className="mt-4 text-muted">
          What is being worked on, by status. There are no dates here and nothing on this page is a promise: plans change when
          the work shows something new. When an item ships it leaves this page and goes to the{" "}
          <Link href="/changelog" className="link">changelog</Link>, with the date it went live and a link to its proof.
        </p>
      </header>

      <div className="mt-12 space-y-12">
        {ROADMAP_STATUSES.map((s, i) => {
          const items = roadmapByStatus(s.id);
          if (!items.length) return null;
          return (
            <section key={s.id} aria-labelledby={`status-${s.id}`} className="grid gap-4 md:grid-cols-[220px_minmax(0,720px)] md:gap-10">
              <div>
                <h2 id={`status-${s.id}`} className="flex items-center gap-2 font-semibold text-text">
                  <span
                    aria-hidden
                    className={cn("size-[9px] rounded-full border", i === 0 ? "border-signal bg-signal" : "border-line-strong bg-coal")}
                  />
                  {s.label}
                </h2>
                <p className="mt-1 text-sm text-faint">{s.note}</p>
              </div>
              <ul className="divide-y divide-line rounded-l border border-line">
                {items.map((item) => (
                  <li key={item.id} id={item.id} className="scroll-mt-24 px-5 py-4">
                    <h3 className="font-medium text-text">{item.title}</h3>
                    <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{item.summary}</p>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
