"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Hex } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag } from "@/components/ui/status";
import { config } from "@/lib/config";
import { apiDown, type ApiFailure, type JobDetail } from "@/lib/dapp/api";
import { jobTag, lifecycleStage, modelLabel, TERMINAL } from "@/lib/dapp/jobs";
import { chargeNote, formatEth, formatGwei, paymentTag, quoteJob, showPayment } from "@/lib/dapp/paid-jobs";
import { useApiGet } from "@/lib/dapp/use-api";
import { formatInt, formatTime } from "@/lib/format";
import { LIMITS } from "@/lib/protocol";
import { cn } from "@/lib/utils";
import { accountFailureText, Eth } from "./job-balance";
import { JobLifecycle } from "./job-lifecycle";
import { RadioCard, Row } from "./ui";
import { nowMs, outputUrl, submitFailureText, useJobSubmit } from "./use-job-submit";
import { WalletButton } from "./wallet-button";

type Kind = "image" | "text";
const SIDES = Array.from({ length: (LIMITS.image.side.max - LIMITS.image.side.min) / LIMITS.image.side.step + 1 }, (_, i) => LIMITS.image.side.min + i * LIMITS.image.side.step);
const STORE = "sparecycle.my-jobs";

type Form = {
  kind: Kind;
  prompt: string;
  negative: string;
  width: string;
  height: string;
  steps: string;
  guidance: string;
  seed: string;
  textPrompt: string;
  system: string;
  maxTokens: string;
};

const INITIAL: Form = {
  kind: "image",
  prompt: "",
  negative: "",
  width: "512",
  height: "512",
  steps: "20",
  guidance: String(LIMITS.image.guidance.default),
  seed: "",
  textPrompt: "",
  system: "",
  maxTokens: "256",
};

type Submitted = { id: string; kind: Kind; at: number };
type Pay = "free" | "paid";

/** The job request as POST /api/v1/jobs takes it (a paid job sends this same object as `request`). */
function buildRequest(form: Form) {
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  return form.kind === "image"
    ? {
        kind: "image",
        params: {
          model: "sd15",
          prompt: form.prompt,
          negative: form.negative,
          width: num(form.width),
          height: num(form.height),
          steps: num(form.steps),
          guidance: num(form.guidance),
          ...(form.seed.trim() !== "" ? { seed: num(form.seed) } : {}),
        },
      }
    : {
        kind: "text",
        params: { model: "qwen2.5-1.5b", prompt: form.textPrompt, system: form.system, maxTokens: num(form.maxTokens) },
      };
}

const field = "mt-1.5 block w-full rounded-m border border-line-strong bg-slate px-3 text-sm text-text placeholder:text-faint aria-[invalid=true]:border-rust/60";

function Label({ htmlFor, children, hint }: { htmlFor: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-sm text-text">
        {children}
      </label>
      {hint ? <span className="text-xs text-faint">{hint}</span> : null}
    </div>
  );
}

function FieldError({ id, msg }: { id: string; msg: string | null }) {
  return msg ? (
    <p id={id} className="mt-1.5 text-xs text-rust">
      {msg}
    </p>
  ) : null;
}

function loadMine(): Submitted[] {
  try {
    const raw = window.localStorage.getItem(STORE);
    const list = raw ? (JSON.parse(raw) as Submitted[]) : [];
    return Array.isArray(list) ? list.filter((j) => typeof j.id === "string" && /^0x[0-9a-f]{64}$/.test(j.id)).slice(0, 10) : [];
  } catch {
    return [];
  }
}

function saveMine(list: Submitted[]) {
  try {
    window.localStorage.setItem(STORE, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* storage blocked: the list lives for this visit only */
  }
}

/**
 * The job form and the jobs submitted from this browser. `side` (the balance panel, only when paid jobs are on)
 * sits beside the form on wide screens and between the form and the job list on narrow ones.
 */
export function JobSubmit({ rateLimit, side }: { rateLimit: number | null; side?: ReactNode }) {
  const [form, setForm] = useState<Form>(INITIAL);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [mine, setMine] = useState<Submitted[]>([]);
  // Paid jobs: present only inside JobAccountProvider (config.jobPayments set). Without it the form is free-only.
  const { acct, paidOn, weiPerUnit, stage, busy, submit: send } = useJobSubmit();
  const [pay, setPay] = useState<Pay>(paidOn && rateLimit === 0 ? "paid" : "free");
  const paid = paidOn && pay === "paid";
  const [signError, setSignError] = useState<string | null>(null);
  const closed = rateLimit === 0 && !paid;
  const quote = paidOn ? quoteJob(buildRequest(form), weiPerUnit) : null;
  const available = acct?.account ? BigInt(acct.account.available) : null;
  const short = paid && quote !== null && available !== null && available < quote.wei;

  useEffect(() => {
    // Read after mount: localStorage is per-viewer and absent on the server.
    const t = setTimeout(() => setMine(loadMine()), 0);
    return () => clearTimeout(t);
  }, []);

  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const errField = failure && failure.kind === "http" && failure.status === 400 && typeof failure.extra.field === "string" ? failure.extra.field : null;
  const errFor = (name: string) => (errField === name && failure && failure.kind === "http" ? failure.message : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || closed) return;
    setFailure(null);
    setSignError(null);
    const res = await send(buildRequest(form), paid);
    if (!res.ok) {
      setFailure(res.failure);
      setSignError(res.signError);
      return;
    }
    const next = [{ id: res.id, kind: form.kind, at: nowMs() }, ...mine.filter((m) => m.id !== res.id)];
    setMine(next);
    saveMine(next);
    // Keep the settings, clear only the prompt that was sent.
    setForm((f) => (f.kind === "image" ? { ...f, prompt: "" } : { ...f, textPrompt: "" }));
  }

  const msg = failure ? submitFailureText(failure, paid, rateLimit) : null;
  const kindOption = (k: Kind, title: string, sub: string) => (
    <RadioCard name="kind" value={k} checked={form.kind === k} onSelect={() => set("kind")(k)} title={title} sub={sub} />
  );

  const paymentFieldset = paidOn ? (
    <fieldset>
      <legend className="text-sm text-text">Payment</legend>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <RadioCard
          name="pay"
          value="free"
          checked={pay === "free"}
          onSelect={() => setPay("free")}
          title="Free trial"
          sub={
            rateLimit === 0 ? (
              "Closed on this scheduler."
            ) : (
              <>
                {rateLimit !== null ? `${rateLimit} free job${rateLimit === 1 ? "" : "s"} per hour per address.` : "Free jobs are rate limited per address."} Free
                jobs are paid to nodes from the same pot as every job.
              </>
            )
          }
        />
        <RadioCard
          name="pay"
          value="paid"
          checked={pay === "paid"}
          onSelect={() => setPay("paid")}
          title="Pay from balance"
          sub={
            quote ? (
              <>
                <span className="num text-text">{formatEth(quote.wei)}</span> ETH for this job. Charged only if two nodes agree.
              </>
            ) : (
              "The price shows once the job settings are valid."
            )
          }
        />
      </div>
      {paid ? (
        <div className="mt-3 rounded-m border border-line">
          <dl className="divide-y divide-line">
            <Row label="Price of this job">
              {quote ? <Eth wei={quote.wei} className="font-medium" /> : <span className="text-muted">Fix the settings above to see it</span>}
            </Row>
            {quote ? (
              <Row label="Work units">
                <span className="num">{formatInt(quote.units)}</span> <span className="text-muted">at</span>{" "}
                <span className="num">{formatGwei(weiPerUnit)}</span> <span className="text-muted">gwei each</span>
                {quote.draft ? <span className="block text-xs text-muted">Final once the prompt is filled in</span> : null}
              </Row>
            ) : null}
            <Row label="Available balance">
              {!acct?.isConnected ? (
                <span className="text-muted">Connect a wallet</span>
              ) : acct.account ? (
                <Eth wei={acct.account.available} />
              ) : acct.failure ? (
                <span className="text-muted">{accountFailureText(acct.failure).title}</span>
              ) : (
                <span className="text-muted">Reading…</span>
              )}
            </Row>
          </dl>
          <div className="space-y-3 border-t border-line px-5 py-3.5 text-xs leading-relaxed text-muted">
            {!acct?.isConnected ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p>Connect the wallet that holds your balance.</p>
                <WalletButton className="h-10 px-4" />
              </div>
            ) : short && quote && available !== null ? (
              <p className="text-amber">
                Available balance is <span className="num">{formatEth(available)}</span> ETH; this job costs{" "}
                <span className="num">{formatEth(quote.wei)}</span> ETH.{" "}
                <a href="#balance" className="link">
                  Deposit more
                </a>{" "}
                or pick a smaller job.
              </p>
            ) : null}
            <p>
              Your wallet asks you to sign a message: no transaction, no gas. The price is held from your balance and charged only if two
              nodes agree on the result; otherwise it is released.
            </p>
          </div>
        </div>
      ) : null}
    </fieldset>
  ) : null;

  const formEl = (
      <form onSubmit={submit} noValidate className="rounded-l border border-line">
        <div className="border-b border-line px-5 py-3.5">
          <h2 className="font-medium text-text">New job</h2>
        </div>
        <div className="space-y-6 px-5 py-5">
          <fieldset>
            <legend className="text-sm text-text">Model</legend>
            <p className="mt-1 text-xs text-faint">The MVP runs these two models only.</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {kindOption("image", "Stable Diffusion 1.5", "Image, 256 to 512 px, 10 to 30 steps.")}
              {kindOption("text", "Qwen2.5-1.5B-Instruct", "Short text, up to 512 tokens, greedy decoding.")}
            </div>
          </fieldset>

          <Notice tone="warn" title="Prompts and results are not private.">
            Anyone with the job id can view an agreed result. Do not submit personal or sensitive text.
          </Notice>

          {form.kind === "image" ? (
            <div className="space-y-5">
              <div>
                <Label htmlFor="prompt" hint={`${form.prompt.length} / ${LIMITS.image.prompt.max}`}>
                  Prompt
                </Label>
                <textarea
                  id="prompt"
                  rows={3}
                  maxLength={LIMITS.image.prompt.max}
                  value={form.prompt}
                  onChange={(e) => set("prompt")(e.target.value)}
                  placeholder="A watercolour of a lighthouse at dusk"
                  aria-invalid={errField === "prompt"}
                  aria-describedby={errField === "prompt" ? "prompt-err" : undefined}
                  className={cn(field, "resize-y py-2.5 leading-relaxed")}
                />
                <FieldError id="prompt-err" msg={errFor("prompt")} />
              </div>
              <div>
                <Label htmlFor="negative" hint={`Optional · ${form.negative.length} / ${LIMITS.image.negative.max}`}>
                  Negative prompt
                </Label>
                <input
                  id="negative"
                  maxLength={LIMITS.image.negative.max}
                  value={form.negative}
                  onChange={(e) => set("negative")(e.target.value)}
                  aria-invalid={errField === "negative"}
                  className={cn(field, "h-10")}
                />
                <FieldError id="negative-err" msg={errFor("negative")} />
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <Label htmlFor="width">Width</Label>
                  <select id="width" value={form.width} onChange={(e) => set("width")(e.target.value)} className={cn(field, "num h-10")}>
                    {SIDES.map((s) => (
                      <option key={s} value={s}>
                        {s} px
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="height">Height</Label>
                  <select id="height" value={form.height} onChange={(e) => set("height")(e.target.value)} className={cn(field, "num h-10")}>
                    {SIDES.map((s) => (
                      <option key={s} value={s}>
                        {s} px
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="steps" hint={`${LIMITS.image.steps.min}–${LIMITS.image.steps.max}`}>
                    Steps
                  </Label>
                  <input
                    id="steps"
                    type="number"
                    inputMode="numeric"
                    min={LIMITS.image.steps.min}
                    max={LIMITS.image.steps.max}
                    value={form.steps}
                    onChange={(e) => set("steps")(e.target.value)}
                    aria-invalid={errField === "steps"}
                    className={cn(field, "num h-10")}
                  />
                </div>
                <div>
                  <Label htmlFor="guidance" hint={`${LIMITS.image.guidance.min}–${LIMITS.image.guidance.max}`}>
                    Guidance
                  </Label>
                  <input
                    id="guidance"
                    type="number"
                    inputMode="decimal"
                    step={0.5}
                    min={LIMITS.image.guidance.min}
                    max={LIMITS.image.guidance.max}
                    value={form.guidance}
                    onChange={(e) => set("guidance")(e.target.value)}
                    aria-invalid={errField === "guidance"}
                    className={cn(field, "num h-10")}
                  />
                </div>
              </div>
              {["width", "height", "steps", "guidance"].includes(errField ?? "") ? <FieldError id="dims-err" msg={failure && failure.kind === "http" ? failure.message : null} /> : null}
              <div className="sm:max-w-[260px]">
                <Label htmlFor="seed" hint="Optional">
                  Seed
                </Label>
                <input
                  id="seed"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={LIMITS.image.seed.max}
                  value={form.seed}
                  onChange={(e) => set("seed")(e.target.value)}
                  placeholder="Picked by the scheduler"
                  aria-invalid={errField === "seed"}
                  className={cn(field, "num h-10")}
                />
                <FieldError id="seed-err" msg={errFor("seed")} />
                <p className="mt-1.5 text-xs text-faint">Both nodes render with the same seed so their images can be compared.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <Label htmlFor="text-prompt" hint={`${form.textPrompt.length} / ${LIMITS.text.prompt.max}`}>
                  Prompt
                </Label>
                <textarea
                  id="text-prompt"
                  rows={5}
                  maxLength={LIMITS.text.prompt.max}
                  value={form.textPrompt}
                  onChange={(e) => set("textPrompt")(e.target.value)}
                  placeholder="Summarise the rules of chess in five sentences."
                  aria-invalid={errField === "prompt"}
                  aria-describedby={errField === "prompt" ? "tprompt-err" : undefined}
                  className={cn(field, "resize-y py-2.5 leading-relaxed")}
                />
                <FieldError id="tprompt-err" msg={errFor("prompt")} />
              </div>
              <div>
                <Label htmlFor="system" hint={`Optional · ${form.system.length} / ${LIMITS.text.system.max}`}>
                  System prompt
                </Label>
                <input
                  id="system"
                  maxLength={LIMITS.text.system.max}
                  value={form.system}
                  onChange={(e) => set("system")(e.target.value)}
                  aria-invalid={errField === "system"}
                  className={cn(field, "h-10")}
                />
                <FieldError id="system-err" msg={errFor("system")} />
              </div>
              <div className="sm:max-w-[260px]">
                <Label htmlFor="max-tokens" hint={`${LIMITS.text.maxTokens.min}–${LIMITS.text.maxTokens.max}`}>
                  Max tokens
                </Label>
                <input
                  id="max-tokens"
                  type="number"
                  inputMode="numeric"
                  min={LIMITS.text.maxTokens.min}
                  max={LIMITS.text.maxTokens.max}
                  value={form.maxTokens}
                  onChange={(e) => set("maxTokens")(e.target.value)}
                  aria-invalid={errField === "maxTokens"}
                  className={cn(field, "num h-10")}
                />
                <FieldError id="max-tokens-err" msg={errFor("maxTokens")} />
              </div>
            </div>
          )}

          {paymentFieldset}

          {msg ? (
            <Notice tone="error" title={msg.title}>
              {msg.body}
            </Notice>
          ) : null}
          {signError ? (
            <Notice tone="error" title="Not signed">
              {signError}
            </Notice>
          ) : null}

          <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-relaxed text-muted">
              {paid ? (
                <>Fixed price per work unit. No bidding, no priority lane: paid and free jobs wait in one queue.</>
              ) : closed ? (
                <span className="text-amber">{paidOn ? "The free trial is closed on this scheduler. Pay from a balance instead." : "Job submission is closed on this scheduler."}</span>
              ) : rateLimit !== null ? (
                <>
                  Up to <span className="num text-text">{rateLimit}</span> job{rateLimit === 1 ? "" : "s"} per hour from one address.
                  No payment, no bidding, no priority lane.
                </>
              ) : (
                <>Rate limited per address per hour. No payment, no bidding, no priority lane.</>
              )}
            </p>
            <Button
              type="submit"
              size="lg"
              className="w-full shrink-0 sm:w-auto"
              disabled={busy || closed || (paid && (!acct?.isConnected || !quote || short))}
            >
              {stage === "sign" ? "Sign in your wallet…" : busy ? "Submitting…" : paid ? "Sign and submit" : "Submit job"}
            </Button>
          </div>
        </div>
      </form>
  );

  const mineEl = (
      <section aria-labelledby="mine" className={side ? "min-w-0 xl:col-start-1 xl:row-start-2" : undefined}>
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <h2 id="mine" className="text-xl font-semibold tracking-[-0.015em] text-text">
              Your jobs
            </h2>
            <p className="mt-1 text-sm text-muted">Jobs submitted from this browser. The list is kept on this device only.</p>
          </div>
          {mine.length ? (
            <Button
              variant="quiet"
              size="sm"
              onClick={() => {
                setMine([]);
                saveMine([]);
              }}
            >
              Clear list
            </Button>
          ) : null}
        </div>
        {mine.length ? (
          <div className="space-y-4">
            {mine.map((m) => (
              <JobCard key={m.id} id={m.id} />
            ))}
          </div>
        ) : (
          <p className="rounded-l border border-line px-5 py-6 text-sm text-muted">No jobs submitted from this browser yet.</p>
        )}
      </section>
  );

  if (!side) {
    return (
      <div className="space-y-12">
        {formEl}
        {mineEl}
      </div>
    );
  }
  // Wide screens: form and balance side by side, the job list under the form. Narrow: form, balance, list.
  return (
    <div className="grid gap-x-8 gap-y-12 xl:grid-cols-[minmax(0,1fr)_340px] xl:items-start">
      <div className="min-w-0 xl:col-start-1 xl:row-start-1">{formEl}</div>
      <div className="min-w-0 xl:col-start-2 xl:row-span-2 xl:row-start-1">{side}</div>
      {mineEl}
    </div>
  );
}

function JobCard({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  const q = useApiGet<JobDetail>(`/jobs/${id}`, done ? 30_000 : 3_000);
  const job = q.result?.ok ? q.result.data : null;
  const fail = q.result && !q.result.ok ? q.result.failure : null;
  const terminal = !!job && TERMINAL.includes(job.status);
  if (terminal !== done && terminal) setDone(true);

  const tag = job ? jobTag(job) : null;
  const pay = job && showPayment(job, !!config.jobPayments) ? paymentTag(job) : null;
  const failed = !!job && (job.status === "disagreed" || job.status === "expired" || job.status === "rejected");
  const out = job?.output ? outputUrl(job.output) : null;

  return (
    <article className="rounded-l border border-line">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-text">{job ? modelLabel(job.model) : "Job"}</span>
          <Hex value={id} kind="hash" head={10} tail={6} link={false} />
        </div>
        {tag ? (
          <StatusTag tone={tag.tone}>{tag.label}</StatusTag>
        ) : fail ? (
          <StatusTag tone="error">{fail.kind === "http" && fail.code === "unknown-job" ? "Unknown job" : "Not reachable"}</StatusTag>
        ) : (
          <StatusTag tone="neutral">Loading</StatusTag>
        )}
      </div>
      <div className="space-y-4 px-5 py-4">
        {job ? (
          <>
            <JobLifecycle compact stage={failed ? 3 : lifecycleStage(job)} failed={failed} failLabel={tag?.label} />
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-faint">Submitted</dt>
                <dd className="num text-muted">{formatTime(job.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-faint">Decided</dt>
                <dd className="num text-muted">{job.settledAt ? formatTime(job.settledAt) : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-faint">Epoch</dt>
                <dd className="num text-muted">{job.epochId ?? "—"}</dd>
              </div>
              {pay ? (
                <div className="min-w-0 sm:col-span-3">
                  <dt className="text-xs text-faint">Payment</dt>
                  <dd className="text-muted">
                    {pay.label}
                    {job.priceWei && /^\d+$/.test(job.priceWei) ? (
                      <>
                        {" "}
                        · <span className="num">{formatEth(job.priceWei)}</span> ETH
                      </>
                    ) : null}
                    {chargeNote(job) ? ` · ${chargeNote(job)}` : null}
                  </dd>
                </div>
              ) : null}
            </dl>
            {job.note ? <p className="text-xs text-muted">Scheduler note: {job.note}</p> : null}
            {out && job.outputType ? <Output url={out} type={job.outputType} /> : null}
            {job.status === "agreed" && !out ? <p className="text-sm text-muted">Agreed. The output is not stored.</p> : null}
          </>
        ) : fail ? (
          <p className="text-sm text-muted">
            {apiDown(fail) ? "Scheduler API not reachable. Retrying." : fail.kind === "http" && fail.code === "unknown-job" ? "The scheduler has no job with this id." : "Could not load this job."}
          </p>
        ) : (
          <p className="text-sm text-muted">Loading…</p>
        )}
      </div>
    </article>
  );
}

function Output({ url, type }: { url: string; type: string }) {
  const isImage = type.startsWith("image/");
  const [text, setText] = useState<{ url: string; body: string | null } | null>(null);
  useEffect(() => {
    if (isImage) return;
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.text() : null))
      .then((body) => setText({ url, body }))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [url, isImage]);

  if (isImage) {
    return (
      <figure className="space-y-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- scheduler output, size known only at runtime */}
        <img src={url} alt="Agreed output of this image job" className="max-h-[512px] w-auto max-w-full rounded-m border border-line" />
        <figcaption className="text-xs text-faint">
          Agreed output.{" "}
          <a href={url} className="link" target="_blank" rel="noreferrer">
            Open the PNG
          </a>
        </figcaption>
      </figure>
    );
  }
  const body = text && text.url === url ? text.body : undefined;
  return (
    <figure className="space-y-2">
      <pre className="max-h-[360px] overflow-auto rounded-m border border-line bg-graphite px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-text">
        {body === undefined ? "Loading output…" : body === null ? "Could not load the output." : body}
      </pre>
      <figcaption className="text-xs text-faint">Agreed output (text from one of the two nodes; the other matched within tolerance).</figcaption>
    </figure>
  );
}
