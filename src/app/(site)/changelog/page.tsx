import type { Metadata } from "next";
import Link from "next/link";
import { Rss } from "lucide-react";
import { explorerTxUrl } from "@/lib/addresses";
import { CHANGELOG, KIND_LABEL, formatChangelogDate } from "@/lib/changelog";
import { truncateMiddle } from "@/lib/format";

export const metadata: Metadata = {
  title: "Changelog",
  description: "What is live on Sparecycle, newest first. Every entry has the date it went live and a link to its proof.",
};

export default function ChangelogPage() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-14 pb-24 sm:px-6 sm:pt-20">
      <header className="max-w-[720px]">
        <h1 className="text-title font-semibold text-text">Changelog</h1>
        <p className="mt-4 text-muted">
          Only what is live, newest first. Each entry has the moment it went live (WITA, with UTC beside it) and at least one link
          you can open to check it: a transaction, a published document or a live endpoint. What is being worked on is on the{" "}
          <Link href="/roadmap" className="link">roadmap</Link>, without dates.
        </p>
        <p className="mt-4">
          <a href="/changelog.xml" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-text">
            <Rss className="size-4" aria-hidden />
            RSS feed
          </a>
        </p>
      </header>

      <ol className="mt-12 divide-y divide-line border-y border-line">
        {CHANGELOG.map((e) => {
          const d = formatChangelogDate(e.date);
          return (
            <li key={e.id} id={e.id} className="grid scroll-mt-24 gap-3 py-8 md:grid-cols-[220px_minmax(0,720px)] md:gap-10">
              <div className="text-sm">
                <time dateTime={e.date} className="block text-text">
                  {d.wita}
                </time>
                <span className="block text-faint">{d.utc ?? "Time of day not recorded"}</span>
                <span className="mt-2 inline-block rounded-s border border-line px-1.5 py-px text-xs text-muted">{KIND_LABEL[e.kind]}</span>
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-[-0.01em] text-text">
                  <a href={`#${e.id}`} className="hover:underline hover:decoration-line-strong hover:underline-offset-4">
                    {e.title}
                  </a>
                </h2>
                <p className="mt-2 text-[15px] leading-relaxed text-muted">{e.summary}</p>
                <ul className="mt-4 flex flex-col gap-1.5 text-sm">
                  {e.evidence.map((ev) => {
                    const href = ev.tx ? explorerTxUrl(ev.tx) : ev.url!;
                    const external = /^https?:\/\//.test(href);
                    return (
                      <li key={`${ev.label}-${href}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <span aria-hidden className="text-faint">
                          ↗
                        </span>
                        <a href={href} className="link" {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
                          {ev.label}
                        </a>
                        {ev.tx ? <span className="num text-xs text-faint">{truncateMiddle(ev.tx, 10, 6)}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
