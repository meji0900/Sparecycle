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

/** What every playground item has. The prompt is kept on this device only. */
type BaseItem = {
  id: string;
  /** Submitted at, ms. */
  at: number;
  prompt: string;
  paid: boolean;
  /** The job's read secret (returned once at submit): this browser's key to the output. Absent on older items. */
  secret?: string | null;
  /** Last status seen and the agreed output path, filled in as the job settles. */
  status?: JobStatus;
  output?: string | null;
};

/** One image job (Stable Diffusion 1.5) made in this browser's playground. */
export type ImageItem = BaseItem & {
  kind: "image";
  negative: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  /** Seed sent with the request; null = picked by the scheduler. */
  seed: number | null;
  /** The seed actually used, filled in as the job settles. */
  usedSeed?: number | null;
};

/** One text job (Qwen2.5-1.5B) made in this browser's playground. */
export type TextItem = BaseItem & { kind: "text"; system: string; maxTokens: number };

export type PlayItem = ImageItem | TextItem;

/** What a job adds to its item while it runs and when it settles. */
export type SettledFields = { status?: JobStatus; output?: string | null; usedSeed?: number | null };

const STORE = "sparecycle.playground";
export const MAX_ITEMS = 24;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A stored item, or null. Items saved before text jobs existed have no `kind`: they are images. */
function toItem(v: unknown): PlayItem | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.id !== "string" || !/^0x[0-9a-f]{64}$/.test(o.id) || !num(o.at) || typeof o.prompt !== "string") return null;
  const base = {
    id: o.id,
    at: o.at,
    prompt: o.prompt,
    paid: o.paid === true,
    secret: typeof o.secret === "string" ? o.secret : null,
    status: typeof o.status === "string" ? (o.status as JobStatus) : undefined,
    output: typeof o.output === "string" ? o.output : null,
  };
  if (o.kind === "text") {
    if (!num(o.maxTokens)) return null;
    return { ...base, kind: "text", system: typeof o.system === "string" ? o.system : "", maxTokens: o.maxTokens };
  }
  if (!num(o.width) || !num(o.height) || !num(o.steps)) return null;
  return {
    ...base,
    kind: "image",
    negative: typeof o.negative === "string" ? o.negative : "",
    width: o.width,
    height: o.height,
    steps: o.steps,
    guidance: num(o.guidance) ? o.guidance : 7.5,
    seed: num(o.seed) ? o.seed : null,
    usedSeed: num(o.usedSeed) ? o.usedSeed : null,
  };
}

export function loadItems(): PlayItem[] {
  try {
    const raw = window.localStorage.getItem(STORE);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.map(toItem).filter((i): i is PlayItem => i !== null).slice(0, MAX_ITEMS) : [];
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
export const settledFields = (job: JobDetail): SettledFields => ({
  status: job.status,
  output: (job.outputAvailable ?? !!job.output) ? resultUrl(job.id) : null,
  usedSeed: typeof job.params?.seed === "number" ? job.params.seed : null,
});

/** A paid job whose results were compared has a receipt that can be checked (free trial jobs have none). */
export const hasReceipt = (i: Pick<PlayItem, "paid" | "status">) => i.paid && !!i.status && TERMINAL.includes(i.status);

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
  onVerify,
  onSettled,
}: {
  item: PlayItem;
  selected: boolean;
  /** Poll this job until it settles (off for the job the result panel already follows). */
  watch: boolean;
  onSelect: () => void;
  onVerify: () => void;
  onSettled: (id: string, fields: SettledFields) => void;
}) {
  const pending = isPending(item);
  const q = useApiGet<JobDetail>(watch && pending ? `/jobs/${item.id}` : null, 6_000);
  const job = q.result?.ok ? q.result.data : null;
  useEffect(() => {
    if (job && TERMINAL.includes(job.status)) onSettled(item.id, settledFields(job));
    else if (job && job.status !== item.status) onSettled(item.id, { status: job.status });
  }, [job, item.id, item.status, onSettled]);

  const text = item.kind === "text";
  const out = useJobOutput(item.status === "agreed" && item.output ? item.id : null, item.secret, { text });
  const img = !text && out.state === "ready" ? out.url : null;
  const answer = text && out.state === "ready" ? out.text : null;
  // Paid jobs: what happened to the price, from the private invoice (the full invoice opens with the tile).
  const invoice = useJobInvoice(item.paid ? item.id : null, item.secret, { refreshKey: item.status });
  const charge = invoice.state === "ready" && invoice.invoice.invoice ? chargeWords(invoice.invoice).label : null;
  const label =
    item.status === "agreed"
      ? img || answer
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
          ) : answer ? (
            <span className="block size-full overflow-hidden px-2.5 pt-7 pb-2.5 text-left text-[11px] leading-snug break-words whitespace-pre-line text-muted">
              {answer.slice(0, 240)}
            </span>
          ) : (
            <span className="grid size-full place-items-center px-2 text-center text-xs text-muted">{label}</span>
          )}
          <span className="absolute top-1.5 left-1.5 rounded-s border border-line bg-coal/85 px-1 text-[10px] leading-4 text-faint">
            {text ? "Text" : "Image"}
          </span>
        </span>
        <span className="mt-1.5 line-clamp-2 px-0.5 text-xs leading-snug break-words text-muted group-hover:text-text">
          <span className="sr-only">{selected ? "Showing: " : "Show: "}</span>
          {item.prompt}
        </span>
        {item.paid ? (
          <span className="mt-1 block truncate px-0.5 text-[11px] leading-snug text-faint">
            Paid{charge ? ` · ${charge.toLowerCase()}` : ""}
          </span>
        ) : null}
      </button>
      {hasReceipt(item) ? (
        <button type="button" onClick={onVerify} className="link mt-1 ml-2 text-[11px]">
          Verify<span className="sr-only"> the receipt of this job</span>
        </button>
      ) : null}
    </li>
  );
}

/** "Your jobs": this browser's playground jobs, newest first. Nobody else's prompts or results. */
export function PlaygroundHistory({
  items,
  currentId,
  onSelect,
  onVerify,
  onSettled,
  onClear,
}: {
  items: PlayItem[];
  currentId: string | null;
  onSelect: (id: string) => void;
  /** Shows the job and scrolls to its receipt check. */
  onVerify: (id: string) => void;
  onSettled: (id: string, fields: SettledFields) => void;
  onClear: () => void;
}) {
  return (
    <section aria-labelledby="your-jobs">
      <SectionTitle
        id="your-jobs"
        title="Your jobs"
        description={`Made in this browser, newest first (the last ${MAX_ITEMS}). The list is kept on this device only; there is no public gallery. Open a paid job to see its invoice and verify its receipt.`}
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
              onVerify={() => onVerify(item.id)}
              onSettled={onSettled}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-l border border-line px-5 py-6 text-sm text-muted">No jobs made in this browser yet.</p>
      )}
    </section>
  );
}
