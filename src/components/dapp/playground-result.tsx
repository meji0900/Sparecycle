"use client";

import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Hex } from "@/components/ui/address";
import { Button, buttonStyles } from "@/components/ui/button";
import { StatusTag, type Tone } from "@/components/ui/status";
import { apiDown, type JobDetail, type StatusResponse } from "@/lib/dapp/api";
import { TERMINAL } from "@/lib/dapp/jobs";
import { chargeNote } from "@/lib/dapp/paid-jobs";
import { useApiGet, useNow } from "@/lib/dapp/use-api";
import { cn } from "@/lib/utils";
import { settledFields, type PlayItem } from "./playground-history";
import { outputUrl } from "./use-job-submit";

const STEPS = [
  { title: "Queued", sub: "Waiting for two GPUs" },
  { title: "Running on two GPUs", sub: "Each draws it separately" },
  { title: "Checking", sub: "Both outputs compared" },
  { title: "Done", sub: "Shown only if they agree" },
];

const stepOf = (status: JobDetail["status"] | undefined) => (status === "running" ? 1 : status === "checking" ? 2 : status && TERMINAL.includes(status) ? 3 : 0);

/** m:ss since `from` (ms). */
const elapsed = (now: number, from: number) => {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Where a job is: four steps, the current one marked by a filled box and the word "Now", not colour alone. */
function Stages({ step, failed, failLabel }: { step: number | null; failed: boolean; failLabel?: string }) {
  return (
    <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-m border border-line bg-line sm:grid-cols-4">
      {STEPS.map((s, i) => {
        const done = step !== null && (i < step || (i === 3 && step === 3 && !failed));
        const now = step !== null && i === step && step < 3;
        const stopped = failed && i === 3;
        return (
          <li key={s.title} aria-current={now ? "step" : undefined} className="flex min-w-0 flex-col gap-1 bg-coal px-3 py-2.5">
            <span className="flex items-center gap-2 text-xs">
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
              <span className={cn("num", now || stopped ? "text-text" : "text-faint")}>{i + 1}</span>
              {now ? <span className="text-signal">Now</span> : null}
              {done && !stopped ? <span className="sr-only">done</span> : null}
            </span>
            <span className={cn("text-sm font-medium", now || done || stopped ? "text-text" : "text-muted")}>{stopped && failLabel ? failLabel : s.title}</span>
            <span className="text-xs leading-snug text-muted">{s.sub}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The picture area: keeps the chosen shape, at most ~560 px on its long side. */
function Frame({ width, height, children, className }: { width: number; height: number; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("relative mx-auto w-full overflow-hidden rounded-m border border-line bg-slate", className)}
      style={{ aspectRatio: `${width} / ${height}`, maxWidth: `${Math.round((560 * width) / height)}px` }}
    >
      {children}
    </div>
  );
}

function FrameMessage({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 overflow-y-auto p-5 text-center">
      <p className="text-base font-medium text-text sm:text-lg">{title}</p>
      {children ? <div className="max-w-[360px] text-sm leading-relaxed text-muted">{children}</div> : null}
    </div>
  );
}

const FAIL: Record<"disagreed" | "expired" | "rejected", { tag: string; title: string; body: string }> = {
  disagreed: {
    tag: "Did not agree",
    title: "The two GPUs did not agree",
    body: "Their images differed by more than the allowed tolerance, so neither is shown. Try again; a new seed often helps.",
  },
  expired: {
    tag: "Expired",
    title: "No pair of GPUs finished in time",
    body: "The job waited or ran too long and was dropped. Try again in a few minutes.",
  },
  rejected: {
    tag: "Refused",
    title: "The safety check refused this prompt",
    body: "Nothing was made. Change the prompt and try again.",
  },
};

/**
 * The large result area: the live stage of the current job (polled every 2 s until it settles), then the image
 * with Download and Generate again, or what went wrong.
 */
export function PlaygroundResult({
  item,
  shape,
  sending,
  onSettled,
  onAgain,
  againLabel,
  againDisabled,
}: {
  item: PlayItem | null;
  /** Width and height of the chosen shape, for the empty frame. */
  shape: { width: number; height: number };
  /** A new job is being signed or sent. */
  sending: "sign" | "send" | null;
  onSettled: (id: string, fields: Partial<PlayItem>) => void;
  onAgain: () => void;
  againLabel: ReactNode;
  againDisabled: boolean;
}) {
  const settled = !!item?.status && TERMINAL.includes(item.status);
  const q = useApiGet<JobDetail>(item ? `/jobs/${item.id}` : null, settled ? undefined : 2_000);
  const job = q.result?.ok && q.result.data.id === item?.id ? q.result.data : null;
  const fail = q.result && !q.result.ok ? q.result.failure : null;
  const status = job?.status ?? item?.status;
  const pending = !!item && (!status || !TERMINAL.includes(status));
  const now = useNow(pending ? 1_000 : 3_600_000);
  // While waiting in the queue, say when the project's GPU pool is starting (it sleeps after quiet periods).
  const statusQ = useApiGet<StatusResponse>(pending && status !== "running" && status !== "checking" ? "/status" : null, 15_000);
  const pool = statusQ.result?.ok ? statusQ.result.data.gpuPool : undefined;
  const [broken, setBroken] = useState<string | null>(null);

  useEffect(() => {
    if (!item || !job) return;
    if (TERMINAL.includes(job.status)) {
      if (item.status !== job.status || (job.output ?? null) !== (item.output ?? null)) onSettled(item.id, settledFields(job));
    } else if (job.status !== item.status) {
      onSettled(item.id, { status: job.status });
    }
  }, [item, job, onSettled]);

  const w = item?.width ?? shape.width;
  const h = item?.height ?? shape.height;
  const paid = job ? job.payment === "paid" : !!item?.paid;
  const output = job?.output ?? item?.output ?? null;
  const img = status === "agreed" && output ? outputUrl(output) : null;
  const seed = typeof job?.params?.seed === "number" ? job.params.seed : (item?.usedSeed ?? item?.seed ?? null);
  const failKind = status === "disagreed" || status === "expired" || status === "rejected" ? status : null;
  const gone = !job && fail && fail.kind === "http" && fail.code === "unknown-job";

  let tag: { tone: Tone; label: string } | null = null;
  if (sending) tag = { tone: "neutral", label: sending === "sign" ? "Waiting for signature" : "Sending" };
  else if (!item) tag = null;
  else if (gone) tag = { tone: "off", label: "Not found" };
  else if (status === "agreed") tag = { tone: "live", label: "Done" };
  else if (failKind) tag = { tone: failKind === "rejected" ? "error" : "warn", label: FAIL[failKind].tag };
  else tag = { tone: "neutral", label: STEPS[stepOf(status)].title };

  let body: ReactNode;
  if (sending) {
    body = (
      <Frame width={w} height={h}>
        <FrameMessage title={sending === "sign" ? "Sign the message in your wallet" : "Sending your prompt"}>
          {sending === "sign" ? "No transaction and no gas: the signature pays for this one image from your balance." : "Handing the job to the scheduler."}
        </FrameMessage>
      </Frame>
    );
  } else if (!item) {
    body = (
      <Frame width={w} height={h}>
        <FrameMessage title="Your image appears here">Describe something, pick a shape and press Generate.</FrameMessage>
      </Frame>
    );
  } else if (gone) {
    body = (
      <Frame width={w} height={h}>
        <FrameMessage title="The scheduler no longer has this job">Old jobs are cleared after a while. Generate it again to get a new image.</FrameMessage>
      </Frame>
    );
  } else if (img && broken !== img) {
    body = (
      <Frame width={w} height={h}>
        {/* eslint-disable-next-line @next/next/no-img-element -- scheduler output, size known only at runtime */}
        <img src={img} alt={`Generated image: ${item.prompt}`} className="size-full object-contain" onError={() => setBroken(img)} />
      </Frame>
    );
  } else if (status === "agreed") {
    body = (
      <Frame width={w} height={h}>
        <FrameMessage title="Both GPUs agreed">The image could not be loaded. It may no longer be stored on the scheduler.</FrameMessage>
      </Frame>
    );
  } else if (failKind) {
    body = (
      <Frame width={w} height={h}>
        <FrameMessage title={FAIL[failKind].title}>
          <p>{FAIL[failKind].body}</p>
          {paid ? <p className="mt-2 text-text">This was a paid job and it was not charged: paid jobs are charged only when both GPUs agree.</p> : null}
        </FrameMessage>
      </Frame>
    );
  } else {
    const step = stepOf(status);
    body = (
      <Frame width={w} height={h}>
        <FrameMessage
          title={step === 0 ? "Waiting for two GPUs" : step === 1 ? "Two GPUs are drawing your image" : "Comparing the two images"}
        >
          <p>
            {step === 0
              ? "The first job after a quiet period can take 1 to 2 minutes while GPUs start. After that, an image takes seconds."
              : step === 1
                ? "Both use the same prompt and seed, so their images should match."
                : "You see the image only if both GPUs made the same one."}
          </p>
          {step === 0 && (pool?.state === "starting" || pool?.state === "stopped") ? <p className="mt-2 text-text">The GPU pool is starting now.</p> : null}
          {now !== null ? (
            <p className="mt-3">
              Waiting <span className="num text-text">{elapsed(now, item.at)}</span>
            </p>
          ) : null}
          {fail && apiDown(fail) ? <p className="mt-2 text-amber">Scheduler not reachable. Retrying.</p> : null}
        </FrameMessage>
      </Frame>
    );
  }

  const charge = job && job.payment === "paid" ? chargeNote(job) : null;

  return (
    <section aria-labelledby="result-title" className="min-w-0 rounded-l border border-line bg-coal">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
        <h2 id="result-title" className="font-medium text-text">
          Result
        </h2>
        {tag ? <StatusTag tone={tag.tone}>{tag.label}</StatusTag> : null}
      </div>
      <div className="space-y-5 px-5 py-5">
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {tag ? `Image: ${tag.label}` : ""}
        </div>
        {body}

        {item && !sending && !gone ? <Stages step={stepOf(status)} failed={!!failKind} failLabel={failKind ? FAIL[failKind].tag : undefined} /> : null}

        {item && !sending && status === "agreed" ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            {img ? (
              <a href={img} download={`sparecycle-${item.id.slice(2, 10)}.png`} className={buttonStyles({ variant: "secondary", size: "lg" })}>
                <Download className="size-4" strokeWidth={1.75} aria-hidden />
                Download (PNG)
              </a>
            ) : null}
            <Button type="button" size="lg" onClick={onAgain} disabled={againDisabled}>
              <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden />
              {againLabel}
            </Button>
          </div>
        ) : null}
        {item && !sending && failKind ? (
          <div>
            <Button type="button" size="lg" variant="secondary" onClick={onAgain} disabled={againDisabled} className="w-full sm:w-auto">
              <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden />
              {againLabel}
            </Button>
          </div>
        ) : null}

        {item && !sending ? (
          <div className="space-y-1.5 border-t border-line pt-4 text-xs text-muted">
            <p className="text-sm break-words text-text">{item.prompt}</p>
            {item.negative ? (
              <p className="break-words">
                <span className="text-faint">Avoid:</span> {item.negative}
              </p>
            ) : null}
            <dl className="flex flex-wrap gap-x-4 gap-y-1">
              <div>
                <dt className="sr-only">Size</dt>
                <dd className="num">
                  {item.width} × {item.height}
                </dd>
              </div>
              <div>
                <dt className="sr-only">Steps</dt>
                <dd>
                  <span className="num">{item.steps}</span> steps
                </dd>
              </div>
              <div>
                <dt className="sr-only">Seed</dt>
                <dd>
                  seed <span className="num">{seed ?? "picked by the scheduler"}</span>
                </dd>
              </div>
              <div>
                <dt className="sr-only">Payment</dt>
                <dd>{paid ? `Paid${charge ? `, ${charge.toLowerCase()}` : ""}` : "Free trial"}</dd>
              </div>
            </dl>
            <p className="flex flex-wrap items-center gap-x-2">
              <span className="text-faint">Job</span>
              <Hex value={item.id} kind="hash" head={10} tail={6} link={false} />
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
