"use client";

import { Check, Copy, Download, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Hex } from "@/components/ui/address";
import { Button, buttonStyles } from "@/components/ui/button";
import { StatusTag, type Tone } from "@/components/ui/status";
import { apiDown, type JobDetail, type StatusResponse } from "@/lib/dapp/api";
import { useJobInvoice } from "@/lib/dapp/invoice";
import { useJobReceipt } from "@/lib/dapp/receipt";
import { useJobOutput } from "@/lib/dapp/job-output";
import { TERMINAL } from "@/lib/dapp/jobs";
import { chargeWords } from "@/lib/dapp/paid-jobs";
import { recheckLabel } from "@/lib/rounds";
import { useApiGet, useNow } from "@/lib/dapp/use-api";
import { cn } from "@/lib/utils";
import { JobInvoicePanel } from "./job-invoice";
import { JobReceiptPanel } from "./job-receipt";
import { settledFields, type PlayItem, type SettledFields } from "./playground-history";
import { outputLockText, SignInToView } from "./private-output";

/** Id of the receipt panel in the result area: the "Verify" links scroll to it. */
export const RECEIPT_ANCHOR = "pg-receipt";

/**
 * Brings the receipt panel of job `jobId` into view and puts the focus on its check, once that receipt has loaded (the
 * panel may still show another job's receipt for a moment after a new job is selected). Gives up after about 4 s.
 */
export function showReceipt(jobId: string) {
  let tries = 0;
  const go = () => {
    const el = document.getElementById(RECEIPT_ANCHOR);
    const mine = el?.dataset.job === jobId ? el : null;
    const verify = mine?.querySelector<HTMLButtonElement>("button[data-verify]");
    if (!mine || !verify) {
      if (++tries < 27) setTimeout(go, 150);
      else mine?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    mine.scrollIntoView({ behavior: "smooth", block: "start" });
    verify.focus({ preventScroll: true });
  };
  setTimeout(go, 0);
}

type Kind = PlayItem["kind"];

const STEPS: Record<Kind, { title: string; sub: string }[]> = {
  image: [
    { title: "Queued", sub: "Waiting for two GPUs" },
    { title: "Running on two GPUs", sub: "Each draws it separately" },
    { title: "Checking", sub: "Both outputs compared" },
    { title: "Done", sub: "Shown only if they agree" },
  ],
  text: [
    { title: "Queued", sub: "Waiting for two machines" },
    { title: "Running on two machines", sub: "Each writes it separately" },
    { title: "Checking", sub: "Both answers compared" },
    { title: "Done", sub: "Shown only if they agree" },
  ],
};

const stepOf = (status: JobDetail["status"] | undefined) => (status === "running" ? 1 : status === "checking" ? 2 : status && TERMINAL.includes(status) ? 3 : 0);

/** m:ss since `from` (ms). */
const elapsed = (now: number, from: number) => {
  const s = Math.max(0, Math.floor((now - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Where a job is: four steps, the current one marked by a filled box and the word "Now", not colour alone. */
function Stages({ kind, step, failed, failLabel }: { kind: Kind; step: number | null; failed: boolean; failLabel?: string }) {
  return (
    <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-m border border-line bg-line sm:grid-cols-4">
      {STEPS[kind].map((s, i) => {
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

/**
 * The result area: an image keeps the chosen shape, at most ~560 px on its long side; a text answer gets a fixed-height
 * box that scrolls inside when the answer is long.
 */
function Area({ kind, width, height, children }: { kind: Kind; width: number; height: number; children: ReactNode }) {
  if (kind === "text") {
    return <div className="relative h-[300px] w-full overflow-hidden rounded-m border border-line bg-slate sm:h-[340px]">{children}</div>;
  }
  return (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-m border border-line bg-slate"
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

const FAIL: Record<Kind, Record<"disagreed" | "expired" | "rejected", { tag: string; title: string; body: string }>> = {
  image: {
    disagreed: {
      tag: "Did not agree",
      title: "The two GPUs did not agree",
      body: "Their images differed by more than the allowed tolerance, so neither is shown. Try again; a new seed often helps.",
    },
    expired: { tag: "Expired", title: "No pair of GPUs finished in time", body: "The job waited or ran too long and was dropped. Try again in a few minutes." },
    rejected: { tag: "Refused", title: "The safety check refused this prompt", body: "Nothing was made. Change the prompt and try again." },
  },
  text: {
    disagreed: {
      tag: "Did not agree",
      title: "The two machines did not agree",
      body: "Their answers differed by more than the allowed tolerance, so neither is shown. Try again, or pick a shorter length.",
    },
    expired: { tag: "Expired", title: "No pair of machines finished in time", body: "The job waited or ran too long and was dropped. Try again in a few minutes." },
    rejected: { tag: "Refused", title: "The job was refused", body: "Nothing was made. Change the prompt and try again." },
  },
};

/** Copies the answer to the clipboard, with a short "Copied" confirmation. */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Button
      type="button"
      variant="secondary"
      size="lg"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => setDone(true))
          .catch(() => undefined);
      }}
    >
      {done ? <Check className="size-4" strokeWidth={1.75} aria-hidden /> : <Copy className="size-4" strokeWidth={1.75} aria-hidden />}
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * The large result area: the live stage of the current job (polled every 2 s until it settles), then the image or the
 * text answer with Download / Copy, Verify (a paid job's receipt) and Generate again, or what went wrong.
 */
export function PlaygroundResult({
  item,
  shape,
  kind,
  sending,
  onSettled,
  onAgain,
  againLabel,
  againDisabled,
}: {
  item: PlayItem | null;
  /** Width and height of the chosen shape, for the empty frame of an image. */
  shape: { width: number; height: number };
  /** The model kind picked in the form: the empty area matches it until a job is shown. */
  kind: Kind;
  /** A new job is being signed or sent. */
  sending: "sign" | "send" | null;
  onSettled: (id: string, fields: SettledFields) => void;
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
      const fields = settledFields(job);
      if (item.status !== job.status || (fields.output ?? null) !== (item.output ?? null)) onSettled(item.id, fields);
    } else if (job.status !== item.status) {
      onSettled(item.id, { status: job.status });
    }
  }, [item, job, onSettled]);

  // While sending (or before any job), the area matches the form's model; once a job is shown, the job's own kind.
  const shown: Kind = sending || !item ? kind : item.kind;
  const imageItem = item?.kind === "image" ? item : null;
  const w = sending || !imageItem ? shape.width : imageItem.width;
  const h = sending || !imageItem ? shape.height : imageItem.height;
  const paid = job ? job.payment === "paid" : !!item?.paid;
  // The output is fetched with this browser's read secret (or the wallet session): an image as a blob: URL, text as text.
  const hasOutput = status === "agreed" && (job ? (job.outputAvailable ?? !!job.output) : !!item?.output);
  const out = useJobOutput(hasOutput && item ? item.id : null, item?.secret, { text: item?.kind === "text" });
  const img = item?.kind === "image" && out.state === "ready" ? out.url : null;
  const answer = item?.kind === "text" && out.state === "ready" ? out.text : null;
  // Paid and team jobs have a payer wallet that can sign in to read the output on any device; free jobs don't.
  const hasPayer = job ? job.payment === "paid" || job.payment === "team" : !!item?.paid;
  // The price and what happened to it: the private invoice (read with this browser's key or the wallet session).
  const invoice = useJobInvoice(item && hasPayer ? item.id : null, item?.secret, { refreshKey: status, poll: true });
  const inv = invoice.state === "ready" && invoice.invoice.invoice ? invoice.invoice : null;
  // The payer's receipt, once the results are compared (provisional, then sealed when its charge is on-chain).
  const decided = !!status && TERMINAL.includes(status);
  const receipt = useJobReceipt(item && hasPayer && decided ? item.id : null, item?.secret, { refreshKey: status });
  const canVerify = !!item && hasPayer && decided && (receipt.state === "ready" || receipt.state === "loading");
  const lock = hasOutput ? outputLockText(out.state, hasPayer) : null;
  const seed = typeof job?.params?.seed === "number" ? job.params.seed : (imageItem?.usedSeed ?? imageItem?.seed ?? null);
  const failKind = status === "disagreed" || status === "expired" || status === "rejected" ? status : null;
  const gone = !job && fail && fail.kind === "http" && fail.code === "unknown-job";
  // A paid job checked again on another pair after a mismatch or a pair that never finished (round 0 = the first pair).
  const round = job?.round ?? 0;
  const recheck = pending ? recheckLabel(round, job?.maxRounds) : null;
  const fails = FAIL[shown];
  const noun = shown === "text" ? "answer" : "image";
  const machines = shown === "text" ? "machines" : "GPUs";
  const frame = (children: ReactNode) => (
    <Area kind={shown} width={w} height={h}>
      {children}
    </Area>
  );

  let tag: { tone: Tone; label: string } | null = null;
  if (sending) tag = { tone: "neutral", label: sending === "sign" ? "Waiting for signature" : "Sending" };
  else if (!item) tag = null;
  else if (gone) tag = { tone: "off", label: "Not found" };
  else if (status === "agreed") tag = { tone: "live", label: "Done" };
  else if (failKind) tag = { tone: failKind === "rejected" ? "error" : "warn", label: fails[failKind].tag };
  else if (recheck) tag = { tone: "neutral", label: recheck };
  else tag = { tone: "neutral", label: STEPS[shown][stepOf(status)].title };

  let body: ReactNode;
  if (sending) {
    body = frame(
      <FrameMessage title={sending === "sign" ? "Sign the message in your wallet" : "Sending your prompt"}>
        {sending === "sign" ? `No transaction and no gas: the signature pays for this one ${noun} from your balance.` : "Handing the job to the scheduler."}
      </FrameMessage>,
    );
  } else if (!item) {
    body = frame(
      <FrameMessage title={shown === "text" ? "The answer appears here" : "Your image appears here"}>
        {shown === "text" ? "Write a prompt, pick a length and press Generate." : "Describe something, pick a shape and press Generate."}
      </FrameMessage>,
    );
  } else if (gone) {
    body = frame(<FrameMessage title="The scheduler no longer has this job">Old jobs are cleared after a while. Run it again to get a new result.</FrameMessage>);
  } else if (img && broken !== img) {
    body = frame(
      // eslint-disable-next-line @next/next/no-img-element -- scheduler output, size known only at runtime
      <img src={img} alt={`Generated image: ${item.prompt}`} className="size-full object-contain" onError={() => setBroken(img)} />,
    );
  } else if (answer !== null) {
    body = frame(
      <div className="absolute inset-0 overflow-y-auto px-5 py-4" tabIndex={0} aria-label="Answer">
        <p className="text-[15px] leading-relaxed break-words whitespace-pre-wrap text-text">{answer}</p>
      </div>,
    );
  } else if (hasOutput && out.state === "loading") {
    body = frame(
      <FrameMessage title={`Both ${machines} agreed`}>
        Loading the {noun}.
      </FrameMessage>,
    );
  } else if (lock) {
    body = frame(
      <FrameMessage title={lock.title}>
        <p>{lock.body}</p>
        {hasPayer ? <SignInToView className="mt-3 flex flex-col items-center" /> : null}
      </FrameMessage>,
    );
  } else if (status === "agreed") {
    body = frame(
      <FrameMessage title={`Both ${machines} agreed`}>
        The {noun} could not be loaded. It may no longer be stored on the scheduler.
      </FrameMessage>,
    );
  } else if (failKind) {
    body = frame(
      <FrameMessage title={failKind === "disagreed" && round > 0 ? `No pair of ${machines} agreed (${round + 1} pairs tried)` : fails[failKind].title}>
        <p>{fails[failKind].body}</p>
        {paid ? <p className="mt-2 text-text">This was a paid job and it was not charged: paid jobs are charged only when both {machines} agree.</p> : null}
      </FrameMessage>,
    );
  } else {
    const step = stepOf(status);
    body = frame(
      <FrameMessage
        title={
          recheck ??
          (step === 0
            ? `Waiting for two ${machines}`
            : step === 1
              ? shown === "text"
                ? "Two machines are writing the answer"
                : "Two GPUs are drawing your image"
              : shown === "text"
                ? "Comparing the two answers"
                : "Comparing the two images")
        }
      >
        {recheck ? (
          <p>
            The first {round === 1 ? "pair" : `${round} pairs`} of {machines} did not agree or did not finish, so two others with different owners run
            the job again. The price stays held, and you are charged only if a pair agrees.
          </p>
        ) : null}
        <p>
          {step === 0
            ? recheck
              ? `It starts as soon as two such ${machines} are free.`
              : `The first job after a quiet period can take 1 to 2 minutes while the machines start. After that, ${shown === "text" ? "an answer" : "an image"} takes seconds.`
            : step === 1
              ? shown === "text"
                ? "Both get the same prompt and decode greedily, so their answers should match."
                : "Both use the same prompt and seed, so their images should match."
              : `You see the ${noun} only if both ${machines} made the same one.`}
        </p>
        {step === 0 && (pool?.state === "starting" || pool?.state === "stopped") ? <p className="mt-2 text-text">The GPU pool is starting now.</p> : null}
        {now !== null ? (
          <p className="mt-3">
            Waiting <span className="num text-text">{elapsed(now, item.at)}</span>
          </p>
        ) : null}
        {fail && apiDown(fail) ? <p className="mt-2 text-amber">Scheduler not reachable. Retrying.</p> : null}
      </FrameMessage>,
    );
  }

  const charge = inv ? chargeWords(inv).label : null;
  const payLabel = job?.payment === "team" ? "Team-funded" : paid ? `Paid${charge ? `, ${charge.toLowerCase()}` : ""}` : "Free trial";
  const verifyButton = canVerify ? (
    <Button type="button" size="lg" variant="secondary" onClick={() => item && showReceipt(item.id)}>
      <ShieldCheck className="size-4" strokeWidth={1.75} aria-hidden />
      Verify
    </Button>
  ) : null;

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
          {tag ? `${shown === "text" ? "Answer" : "Image"}: ${tag.label}` : ""}
        </div>
        {body}

        {item && !sending && !gone ? <Stages kind={item.kind} step={stepOf(status)} failed={!!failKind} failLabel={failKind ? fails[failKind].tag : undefined} /> : null}

        {item && !sending && status === "agreed" ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {img ? (
              <a href={img} download={`sparecycle-${item.id.slice(2, 10)}.png`} className={buttonStyles({ variant: "secondary", size: "lg" })}>
                <Download className="size-4" strokeWidth={1.75} aria-hidden />
                Download (PNG)
              </a>
            ) : null}
            {answer !== null ? <CopyButton text={answer} /> : null}
            {answer !== null && out.url ? (
              <a href={out.url} download={`sparecycle-${item.id.slice(2, 10)}.txt`} className={buttonStyles({ variant: "secondary", size: "lg" })}>
                <Download className="size-4" strokeWidth={1.75} aria-hidden />
                Download (TXT)
              </a>
            ) : null}
            {verifyButton}
            <Button type="button" size="lg" onClick={onAgain} disabled={againDisabled}>
              <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden />
              {againLabel}
            </Button>
          </div>
        ) : null}
        {item && !sending && failKind ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            {verifyButton}
            <Button type="button" size="lg" variant="secondary" onClick={onAgain} disabled={againDisabled} className="w-full sm:w-auto">
              <RefreshCw className="size-4" strokeWidth={1.75} aria-hidden />
              {againLabel}
            </Button>
          </div>
        ) : null}

        {item && !sending ? (
          <div className="space-y-1.5 border-t border-line pt-4 text-xs text-muted">
            <p className="text-sm break-words text-text">{item.prompt}</p>
            {item.kind === "image" && item.negative ? (
              <p className="break-words">
                <span className="text-faint">Avoid:</span> {item.negative}
              </p>
            ) : null}
            {item.kind === "text" && item.system ? (
              <p className="break-words">
                <span className="text-faint">Instructions:</span> {item.system}
              </p>
            ) : null}
            <dl className="flex flex-wrap gap-x-4 gap-y-1">
              <div>
                <dt className="sr-only">Model</dt>
                <dd>{item.kind === "text" ? "Qwen2.5-1.5B" : "Stable Diffusion 1.5"}</dd>
              </div>
              {item.kind === "image" ? (
                <>
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
                </>
              ) : (
                <div>
                  <dt className="sr-only">Length</dt>
                  <dd>
                    up to <span className="num">{item.maxTokens}</span> tokens
                  </dd>
                </div>
              )}
              <div>
                <dt className="sr-only">Payment</dt>
                <dd>{payLabel}</dd>
              </div>
            </dl>
            <p className="flex flex-wrap items-center gap-x-2">
              <span className="text-faint">Job</span>
              <Hex value={item.id} kind="hash" head={10} tail={6} link={false} />
            </p>
            {decided && !hasPayer ? <p className="text-faint">A free trial job is not charged, so it has no receipt to verify.</p> : null}
          </div>
        ) : null}

        {item && !sending && !gone && hasPayer ? <JobInvoicePanel state={invoice} /> : null}
        {item && !sending && !gone && hasPayer && decided ? (
          <div id={RECEIPT_ANCHOR} data-job={item.id} className="scroll-mt-24">
            <JobReceiptPanel state={receipt} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
