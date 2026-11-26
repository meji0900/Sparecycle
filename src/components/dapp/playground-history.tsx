"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import type { JobDetail, JobStatus } from "@/lib/dapp/api";
import { TERMINAL } from "@/lib/dapp/jobs";
import { useJobInvoice } from "@/lib/dapp/invoice";
import { resultUrl, useJobOutput } from "@/lib/dapp/job-output";
import { chargeWords } from "@/lib/dapp/paid-jobs";
import { useApiGet } from "@/lib/dapp/use-api";
import { cn } from "@/lib/utils";
import { SectionTitle } from "./ui";

/** One image job made in this browser's playground. The prompt is kept on this device only. */
export type PlayItem = {
  id: string;
  /** Submitted at, ms. */
  at: number;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  /** Seed sent with the request; null = picked by the scheduler. */
  seed: number | null;
  paid: boolean;
  /** The job's read secret (returned once at submit): this browser's key to the output. Absent on older items. */
  secret?: string | null;
  /** Last status seen, the agreed output path and the seed actually used, filled in as the job settles. */
  status?: JobStatus;
  output?: string | null;
  usedSeed?: number | null;
};

const STORE = "sparecycle.playground";
export const MAX_ITEMS = 24;

const isItem = (v: unknown): v is PlayItem => {
  const o = v as Partial<PlayItem> | null;
  return (
    !!o &&
    typeof o.id === "string" &&
    /^0x[0-9a-f]{64}$/.test(o.id) &&
    typeof o.at === "number" &&
    typeof o.prompt === "string" &&
    typeof o.width === "number" &&
    typeof o.height === "number" &&
    typeof o.steps === "number"
  );
};

export function loadItems(): PlayItem[] {
  try {
    const raw = window.localStorage.getItem(STORE);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list)
      ? list
          .filter(isItem)
          .map((i) => ({
            ...i,
            negative: typeof i.negative === "string" ? i.negative : "",
            guidance: typeof i.guidance === "number" ? i.guidance : 7.5,
            secret: typeof i.secret === "string" ? i.secret : null,
          }))
          .slice(0, MAX_ITEMS)
      : [];
  } catch {
    return [];
  }
}

export function saveItems(list: PlayItem[]) {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(list.slice(0, MAX_ITEMS)));
  } catch {
    /* storage blocked or full: the list lives for this visit only */
  }
}

export const isPending = (i: Pick<PlayItem, "status">) => !i.status || !TERMINAL.includes(i.status);

/** What a settled job adds to its playground item. `output` marks a stored output (the URL is built from the id). */
export const settledFields = (job: JobDetail): Partial<PlayItem> => ({
  status: job.status,
  output: (job.outputAvailable ?? !!job.output) ? resultUrl(job.id) : null,
  usedSeed: typeof job.params?.seed === "number" ? job.params.seed : null,
});

const TILE_LABEL: Partial<Record<JobStatus, string>> = {
  queued: "Queued",
  running: "Running",
  checking: "Checking",
  disagreed: "Did not agree",
  expired: "Expired",
  rejected: "Refused",
};

function Tile({
  item,
  selected,
  watch,
  onSelect,
  onSettled,
}: {
  item: PlayItem;
  selected: boolean;
  /** Poll this job until it settles (off for the job the result panel already follows). */
  watch: boolean;
  onSelect: () => void;
  onSettled: (id: string, fields: Partial<PlayItem>) => void;
}) {
  const pending = isPending(item);
  const q = useApiGet<JobDetail>(watch && pending ? `/jobs/${item.id}` : null, 6_000);
  const job = q.result?.ok ? q.result.data : null;
  useEffect(() => {
    if (job && TERMINAL.includes(job.status)) onSettled(item.id, settledFields(job));
    else if (job && job.status !== item.status) onSettled(item.id, { status: job.status });
  }, [job, item.id, item.status, onSettled]);

  const out = useJobOutput(item.status === "agreed" && item.output ? item.id : null, item.secret);
  const img = out.state === "ready" ? out.url : null;
  // Paid images: what happened to the price, from the private invoice (the full invoice opens with the tile).
  const invoice = useJobInvoice(item.paid ? item.id : null, item.secret, { refreshKey: item.status });
  const charge = invoice.state === "ready" && invoice.invoice.invoice ? chargeWords(invoice.invoice).label : null;
  const label =
    item.status === "agreed"
      ? img
        ? null
        : !item.output || out.state === "missing" || out.state === "error"
          ? "Not stored"
          : out.state === "loading"
            ? "Loading"
            : item.paid
              ? "Sign in to view"
              : "Private"
      : job && !TERMINAL.includes(job.status) && (job.round ?? 0) > 0
        ? "Re-checking"
        : (TILE_LABEL[item.status ?? "queued"] ?? "Queued");
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn(
          "group block w-full min-w-0 rounded-m border p-1.5 text-left transition-colors duration-150",
          selected ? "border-signal/60 bg-white/[0.04]" : "border-line hover:border-line-strong",
        )}
      >
        <span className="relative block aspect-square overflow-hidden rounded-s bg-slate">
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element -- scheduler output, size known only at runtime
            <img src={img} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <span className="grid size-full place-items-center px-2 text-center text-xs text-muted">{label}</span>
          )}
        </span>
        <span className="mt-1.5 line-clamp-2 block px-0.5 text-xs leading-snug break-words text-muted group-hover:text-text">
          <span className="sr-only">{selected ? "Showing: " : "Show: "}</span>
          {item.prompt}
        </span>
        {item.paid ? (
          <span className="mt-1 block truncate px-0.5 text-[11px] leading-snug text-faint">
            Paid{charge ? ` · ${charge.toLowerCase()}` : ""}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** "Your images": this browser's playground jobs, newest first. Nobody else's prompts or images. */
export function PlaygroundHistory({
  items,
  currentId,
  onSelect,
  onSettled,
  onClear,
}: {
  items: PlayItem[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onSettled: (id: string, fields: Partial<PlayItem>) => void;
  onClear: () => void;
}) {
  return (
    <section aria-labelledby="your-images">
      <SectionTitle
        id="your-images"
        title="Your images"
        description={`Made in this browser, newest first (the last ${MAX_ITEMS}). The list is kept on this device only; there is no public gallery. Open a paid image to see its invoice.`}
        aside={
          items.length ? (
            <Button variant="quiet" size="sm" onClick={onClear}>
              Clear list
            </Button>
          ) : null
        }
      />
      {items.length ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {items.map((item) => (
            <Tile
              key={item.id}
              item={item}
              selected={item.id === currentId}
              watch={item.id !== currentId}
              onSelect={() => onSelect(item.id)}
              onSettled={onSettled}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-l border border-line px-5 py-6 text-sm text-muted">No images made in this browser yet.</p>
      )}
    </section>
  );
}
