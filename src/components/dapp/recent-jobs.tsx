"use client";

import { useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import AnimatedList from "@/components/reactbits/AnimatedList";
import { StatusTag } from "@/components/ui/status";
import { apiUrl, type ApiJob, type JobsResponse } from "@/lib/dapp/api";
import { config } from "@/lib/config";
import { jobTag, modelLabel } from "@/lib/dapp/jobs";
import { paymentTag, showPayment } from "@/lib/dapp/paid-jobs";
import { useNow } from "@/lib/dapp/use-api";
import { formatTime, relativeTime, truncateMiddle } from "@/lib/format";
import { useLiveJson } from "@/lib/use-live";

// AnimatedList restyled to the Sparecycle tokens: flat graphite rows, 1px hairlines, no gradient, no glow.
const TOKENS = {
  "--al-tile": "#111111",
  "--al-tile-edge": "rgba(255, 255, 255, 0.08)",
  "--al-tile-highlight": "transparent",
  "--al-tile-shadow": "none",
  "--al-well": "rgba(255, 255, 255, 0.04)",
  "--al-ink": "#ededed",
  "--al-muted": "#9b9b9b",
  "--al-thumb": "rgba(255, 255, 255, 0.14)",
  "--al-ring": "rgba(255, 255, 255, 0.22)",
  "--al-ring-fill": "rgba(255, 255, 255, 0.02)",
  "--al-hover": "none",
  "--al-press": "none",
  "--al-active": "none",
} as CSSProperties;

/** The latest jobs as an animated list. Rows animate in as they arrive; reduced motion shows them in place. */
export function RecentJobs({ jobs, now }: { jobs: ApiJob[]; now: number | null }) {
  const reduced = useReducedMotion();
  return (
    <AnimatedList
      items={jobs.map((j) => ({ id: j.id, title: j.id }))}
      frame={false}
      radius={6}
      gap={6}
      width="100%"
      maxHeight={560}
      animation={reduced ? "none" : "slide"}
      stagger={0.03}
      showGradients={jobs.length > 6}
      fadeSize={40}
      selectOnHover
      enableArrowNavigation
      style={TOKENS}
      itemClassName="cursor-default"
      renderItem={(_, index) => {
        const j = jobs[index];
        if (!j) return null;
        const tag = jobTag(j);
        // Who paid (free trial, a customer, or the team's own test job: a disclosure, always shown). Prices are private (D7).
        const pay = showPayment(j, !!config.jobPayments) ? paymentTag(j) : null;
        return (
          <div className="grid min-w-0 flex-1 gap-x-4 gap-y-1.5 px-1 py-0.5 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto] sm:items-center">
            <div className="flex min-w-0 items-baseline gap-2.5">
              <span className="num shrink-0 text-sm text-text" title={j.id}>
                {truncateMiddle(j.id, 8, 6)}
              </span>
              <span className="truncate text-sm text-muted">{modelLabel(j.model)}</span>
            </div>
            <div className="flex min-w-0 items-baseline gap-2.5 text-xs text-faint">
              <span className="shrink-0">Prompt hash</span>
              <span className="num truncate text-muted" title={j.promptHash}>
                {truncateMiddle(j.promptHash, 8, 6)}
              </span>
            </div>
            <div className={pay ? "flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 sm:justify-end" : "flex items-center justify-between gap-3 sm:justify-end"}>
              {pay ? (
                // Phones: own line, so every row wraps the same way. Wide: inline before the time.
                <span className="flex basis-full items-center gap-2 sm:basis-auto">
                  <StatusTag tone={pay.tone}>{pay.label}</StatusTag>
                </span>
              ) : null}
              <span className="text-xs whitespace-nowrap text-faint" title={formatTime(j.createdAt)}>
                {j.epochId !== null && j.epochId !== undefined ? (
                  <>
                    Epoch <span className="num">{j.epochId}</span> ·{" "}
                  </>
                ) : null}
                {now !== null ? relativeTime(j.createdAt * 1000, now) : formatTime(j.createdAt)}
              </span>
              <StatusTag tone={tag.tone}>{tag.label}</StatusTag>
            </div>
          </div>
        );
      }}
    />
  );
}

/** The latest 20 jobs on the network, loaded here (the jobs page shows who paid for each: a disclosure). */
export function LiveRecentJobs() {
  const jobs = useLiveJson<JobsResponse>(apiUrl("/jobs?limit=20"), 15_000);
  const now = useNow(15_000);
  const list = jobs.data?.jobs ?? [];
  if (jobs.data && list.length) return <RecentJobs jobs={list} now={now} />;
  return (
    <p className="rounded-l border border-line px-5 py-6 text-sm text-muted">
      {jobs.data ? "No jobs yet." : jobs.loading ? "Loading jobs…" : "Scheduler API not reachable. No rows are shown rather than invented ones."}
    </p>
  );
}
