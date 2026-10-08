import { cn } from "@/lib/utils";

const STAGES = [
  { title: "Queued", body: "The scheduler holds the job until two suitable nodes poll for work." },
  { title: "Running on two nodes", body: "Two nodes with different owners and different GPUs run the same spec." },
  { title: "Results compared", body: "The scheduler compares the two outputs within a small tolerance." },
  { title: "Agreed or disagreed", body: "Agreed jobs count for the epoch. Disagreed, expired or rejected jobs are unpaid." },
  { title: "Eligible in the epoch root", body: "At close, agreed jobs share the pot by work units and land in the Merkle root." },
];

/**
 * The job lifecycle as a numbered strip (a real sequence). `stage` highlights where a job is; `failed` marks a job
 * that stopped at step 4 without agreement. Current step: filled marker + "Now" text, not colour alone.
 */
export function JobLifecycle({
  stage = null,
  failed = false,
  failLabel,
  compact = false,
}: {
  stage?: number | null;
  failed?: boolean;
  failLabel?: string;
  compact?: boolean;
}) {
  return (
    <ol className="grid grid-cols-1 gap-px overflow-hidden rounded-m border border-line bg-line sm:grid-cols-5">
      {STAGES.map((s, i) => {
        const done = stage !== null && i < stage;
        const now = stage !== null && i === stage;
        const stopped = failed && i === 3;
        const skipped = failed && i > 3;
        return (
          <li
            key={s.title}
            aria-current={now ? "step" : undefined}
            className={cn("flex min-w-0 flex-col gap-1.5 bg-coal", compact ? "px-3 py-2.5" : "px-4 py-4", skipped && "opacity-50")}
          >
            <span className="flex items-center gap-2 text-xs">
              {stage !== null ? (
                <span
                  aria-hidden
                  className={cn(
                    "grid size-4 shrink-0 place-items-center rounded-[3px] border",
                    stopped ? "border-amber text-amber" : now ? "border-signal bg-signal" : done ? "border-signal/60" : "border-line-strong",
                  )}
                >
                  {done && !stopped ? <span className="size-1.5 rounded-[1px] bg-signal" /> : null}
                  {stopped ? <span className="text-[9px] leading-none">!</span> : null}
                </span>
              ) : null}
              <span className={cn("num", now || stopped ? "text-text" : "text-faint")}>{i + 1}</span>
              {now && !stopped ? <span className="text-signal">Now</span> : null}
              {done && !stopped ? <span className="sr-only">done</span> : null}
            </span>
            <span className={cn("text-sm font-medium", now || done || stopped ? "text-text" : "text-muted")}>
              {stopped && failLabel ? failLabel : s.title}
            </span>
            {!compact ? <span className="text-xs leading-relaxed text-muted">{s.body}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
