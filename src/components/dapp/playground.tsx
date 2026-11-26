"use client";

import { ChevronDown, Shuffle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag } from "@/components/ui/status";
import { CATALOG_INFO, pairWords, type Catalog } from "@/lib/catalog";
import type { ApiFailure } from "@/lib/dapp/api";
import { formatEth, quoteJob } from "@/lib/dapp/paid-jobs";
import { useApiGet } from "@/lib/dapp/use-api";
import {
  imageJobRequest,
  PLAYGROUND_MODEL,
  TEXT_LENGTHS,
  textJobRequest,
  type ImageSettings,
  type TextLength,
  type TextSettings,
} from "@/lib/playground-request";
import { LIMITS } from "@/lib/protocol";
import { cn } from "@/lib/utils";
import { accountFailureText, Eth, LowCreditNotice } from "./job-balance";
import { loadItems, MAX_ITEMS, PlaygroundHistory, saveItems, type PlayItem, type SettledFields } from "./playground-history";
import { PlaygroundResult, showReceipt } from "./playground-result";
import { OutputPrivacyNotice } from "./private-output";
import { RadioCard, Row } from "./ui";
import { nowMs, submitFailureText, useJobSubmit } from "./use-job-submit";
import { WalletButton } from "./wallet-button";

type Kind = PlayItem["kind"];

const SHAPES = {
  square: { title: "Square", width: 512, height: 512 },
  portrait: { title: "Portrait", width: 384, height: 512 },
  landscape: { title: "Landscape", width: 512, height: 384 },
} as const;
type Shape = keyof typeof SHAPES;

const QUALITY = {
  fast: { title: "Fast", steps: 15, sub: "15 steps" },
  best: { title: "Best", steps: 30, sub: "30 steps, finer detail" },
} as const;
type Quality = keyof typeof QUALITY;

const DEFAULT_GUIDANCE = 7.5;

const EXAMPLES: Record<Kind, { label: string; prompt: string }[]> = {
  image: [
    { label: "Lighthouse at dusk", prompt: "A lighthouse on a rocky cliff at dusk, watercolour, soft warm light" },
    { label: "Fox in the snow", prompt: "A red fox sitting in fresh snow, morning light, detailed fur, photograph" },
    { label: "Tiny cabin", prompt: "An isometric tiny wooden cabin in a pine forest, glowing windows, 3d render" },
    { label: "Bowl of ramen", prompt: "A steaming bowl of ramen on a wooden table, studio photo, shallow depth of field" },
  ],
  text: [
    { label: "Explain simply", prompt: "Explain in three short sentences why two computers running the same job can be checked against each other." },
    { label: "Name ideas", prompt: "Suggest five short names for a neighbourhood bike repair club, one per line." },
    { label: "Summarise", prompt: "Summarise in two sentences: every job runs on two machines with different owners, and the answer is shown only when both results match." },
    { label: "Write a haiku", prompt: "Write a haiku about a computer fan spinning up at night." },
  ],
};

const randomSeed = () => {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
};

const field = "block w-full rounded-m border border-line-strong bg-slate px-3 text-sm text-text placeholder:text-faint aria-[invalid=true]:border-rust/60";

/** Collapsed-by-default section (native details: keyboard and screen readers get it for free). */
function Disclosure({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <details className="group rounded-m border border-line">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm text-text">
        <span className="min-w-0">
          {title}
          {note ? <span className="ml-2 text-xs text-faint">{note}</span> : null}
        </span>
        <ChevronDown aria-hidden className="size-4 shrink-0 text-muted transition-transform duration-150 group-open:rotate-180" strokeWidth={1.75} />
      </summary>
      <div className="space-y-4 border-t border-line px-4 py-4">{children}</div>
    </details>
  );
}

/** Outline of a shape for the shape choice. */
function ShapeIcon({ width, height, checked }: { width: number; height: number; checked: boolean }) {
  const s = 18 / Math.max(width, height);
  return (
    <span aria-hidden className="mt-0.5 grid size-5 shrink-0 place-items-center">
      <span
        className={cn("block rounded-[2px] border", checked ? "border-signal bg-signal/20" : "border-line-strong")}
        style={{ width: Math.round(width * s), height: Math.round(height * s) }}
      />
    </span>
  );
}

/** One job request from the form, exactly as POST /api/v1/jobs takes it (a paid job sends this same object as `request`). */
type Draft = { kind: "image"; s: ImageSettings } | { kind: "text"; s: TextSettings };
const requestOf = (d: Draft) => (d.kind === "image" ? imageJobRequest(d.s) : textJobRequest(d.s));

/**
 * The playground: pick a model from the catalog (Stable Diffusion 1.5 for images, Qwen2.5-1.5B for text), write a prompt,
 * a few plain choices, the live stage of the job and this browser's jobs. Submission goes through the same code as /jobs:
 * the free trial, or a signed payment from the connected wallet's prepaid balance (no API key, no custody), into the same
 * job queue as the API, so rounds, charge and receipt are the same. A paid job's receipt can be verified here.
 */
export function Playground({ rateLimit }: { rateLimit: number | null }) {
  const [kind, setKind] = useState<Kind>("image");
  const [prompts, setPrompts] = useState<Record<Kind, string>>({ image: "", text: "" });
  const [negative, setNegative] = useState("");
  const [shape, setShape] = useState<Shape>("square");
  const [quality, setQuality] = useState<Quality>("fast");
  const [seed, setSeed] = useState("");
  const [guidance, setGuidance] = useState(String(DEFAULT_GUIDANCE));
  const [system, setSystem] = useState("");
  const [length, setLength] = useState<TextLength>("medium");
  const [items, setItems] = useState<PlayItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ f: ApiFailure; paid: boolean } | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<{ field: string; message: string } | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const { acct, paidOn, weiPerUnit, stage, busy, submit } = useJobSubmit();
  const [pay, setPay] = useState<"free" | "paid">(paidOn && rateLimit === 0 ? "paid" : "free");
  const paid = paidOn && pay === "paid";
  const closed = rateLimit === 0 && !paid;
  // Live capacity of each model (the public catalog, also on /models).
  const catalogQ = useApiGet<Catalog>("/catalog", 20_000);
  const catalog = catalogQ.result?.ok ? catalogQ.result.data : null;
  const capOf = (k: Kind) => catalog?.models.find((m) => m.id === PLAYGROUND_MODEL[k])?.capacity ?? null;

  useEffect(() => {
    // Read after mount: localStorage is per-viewer and absent on the server; ?model= comes from the /models page.
    const t = setTimeout(() => {
      const list = loadItems();
      setItems(list);
      setCurrentId((c) => c ?? list[0]?.id ?? null);
      const want = new URLSearchParams(window.location.search).get("model");
      if (want === PLAYGROUND_MODEL.text) setKind("text");
      else if (want === PLAYGROUND_MODEL.image) setKind("image");
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const update = useCallback((next: (list: PlayItem[]) => PlayItem[]) => {
    setItems((list) => {
      const out = next(list).slice(0, MAX_ITEMS);
      saveItems(out);
      return out;
    });
  }, []);

  const onSettled = useCallback(
    (id: string, fields: SettledFields) => update((list) => list.map((i): PlayItem => (i.id === id ? { ...i, ...fields } : i))),
    [update],
  );

  const prompt = prompts[kind];
  const setPrompt = (v: string) => setPrompts((p) => ({ ...p, [kind]: v }));
  const promptLimit = kind === "image" ? LIMITS.image.prompt.max : LIMITS.text.prompt.max;
  const seedNum = seed.trim() === "" ? null : Number(seed);
  const guidanceNum = guidance.trim() === "" ? DEFAULT_GUIDANCE : Number(guidance);
  const draft: Draft =
    kind === "image"
      ? {
          kind,
          s: {
            prompt,
            negative,
            width: SHAPES[shape].width,
            height: SHAPES[shape].height,
            steps: QUALITY[quality].steps,
            guidance: guidanceNum,
            seed: seedNum,
          },
        }
      : { kind, s: { prompt, system, maxTokens: TEXT_LENGTHS[length].maxTokens } };
  const current = items.find((i) => i.id === currentId) ?? null;
  const againDraft: Draft | null = current
    ? current.kind === "image"
      ? {
          kind: "image",
          s: {
            prompt: current.prompt,
            negative: current.negative,
            width: current.width,
            height: current.height,
            steps: current.steps,
            guidance: current.guidance,
            seed: null,
          },
        }
      : { kind: "text", s: { prompt: current.prompt, system: current.system, maxTokens: current.maxTokens } }
    : null;

  const quote = paidOn ? quoteJob(requestOf(draft), weiPerUnit) : null;
  const againQuote = paidOn && againDraft ? quoteJob(requestOf(againDraft), weiPerUnit) : null;
  const available = acct?.account ? BigInt(acct.account.available) : null;
  const short = paid && quote !== null && available !== null && available < quote.wei;
  const cantPay = paid && (!acct?.isConnected || !quote || short);
  const cap = capOf(kind);
  const noPair = cap !== null && cap.pair === null;

  async function generate(d: Draft) {
    if (busy || closed) return;
    setFailure(null);
    setSignError(null);
    setLocalError(null);
    if (d.s.prompt.trim() === "") {
      setLocalError({ field: "prompt", message: d.kind === "image" ? "Describe the image first." : "Write a prompt first." });
      promptRef.current?.focus();
      return;
    }
    if (d.kind === "image") {
      const s = d.s;
      if (s.seed !== null && (!Number.isInteger(s.seed) || s.seed < LIMITS.image.seed.min || s.seed > LIMITS.image.seed.max)) {
        setLocalError({ field: "seed", message: `The seed must be a whole number from 0 to ${LIMITS.image.seed.max}, or empty.` });
        return;
      }
      if (!Number.isFinite(s.guidance) || s.guidance < LIMITS.image.guidance.min || s.guidance > LIMITS.image.guidance.max) {
        setLocalError({ field: "guidance", message: `Guidance must be a number from ${LIMITS.image.guidance.min} to ${LIMITS.image.guidance.max}.` });
        return;
      }
    }
    // On phones the result sits under the form: bring it into view so the stage is visible.
    if (!window.matchMedia("(min-width: 1024px)").matches) resultRef.current?.scrollIntoView({ block: "nearest" });
    const res = await submit(requestOf(d), paid);
    if (!res.ok) {
      if (res.failure) setFailure({ f: res.failure, paid });
      setSignError(res.signError);
      return;
    }
    const base = { id: res.id, at: nowMs(), paid, secret: res.readSecret };
    const item: PlayItem = d.kind === "image" ? { ...base, kind: "image", ...d.s } : { ...base, kind: "text", ...d.s };
    update((list) => [item, ...list.filter((i) => i.id !== res.id)]);
    setCurrentId(res.id);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void generate(draft);
  }

  function again() {
    if (!againDraft) return;
    void generate(againDraft.kind === "image" ? { kind: "image", s: { ...againDraft.s, seed: randomSeed() } } : againDraft);
  }

  function select(id: string) {
    setCurrentId(id);
    resultRef.current?.scrollIntoView({ block: "nearest" });
  }

  function verify(id: string) {
    setCurrentId(id);
    showReceipt(id);
  }

  const msg = failure ? submitFailureText(failure.f, failure.paid, rateLimit) : null;
  const errField =
    localError?.field ??
    (failure && failure.f.kind === "http" && failure.f.status === 400 && typeof failure.f.extra.field === "string" ? failure.f.extra.field : null);
  const errMsg = localError?.message ?? (failure && failure.f.kind === "http" ? failure.f.message : null);
  const errFor = (name: string) =>
    errField === name && errMsg ? (
      <p id={`pg-${name}-err`} className="mt-1.5 text-xs text-rust">
        {errMsg}
      </p>
    ) : null;

  const noun = kind === "image" ? "image" : "answer";
  const generateLabel = stage === "sign" ? "Sign in your wallet…" : busy ? "Sending…" : paid ? "Sign and generate" : "Generate";
  const againLabel = paid ? (
    <>
      Generate again{againQuote ? <span className="num font-normal opacity-80"> · {formatEth(againQuote.wei)} ETH</span> : null}
    </>
  ) : (
    "Generate again"
  );

  const freeSub =
    rateLimit === 0
      ? "Closed on this scheduler."
      : rateLimit !== null
        ? `${rateLimit} job${rateLimit === 1 ? "" : "s"} per hour, no wallet needed.`
        : "A few jobs per hour, no wallet needed.";

  const modelSub = (k: Kind) => {
    const c = capOf(k);
    const w = c ? pairWords(c) : null;
    return (
      <>
        <span className="block">{k === "image" ? "Images, 256 to 512 px" : "Short text, up to 512 tokens"}</span>
        {w ? (
          <StatusTag tone={w.tone} className="mt-2">
            {w.label}
          </StatusTag>
        ) : null}
      </>
    );
  };

  const form = (
    <form onSubmit={onSubmit} noValidate className="min-w-0 rounded-l border border-line bg-coal">
      <div className="space-y-6 px-5 py-5">
        <fieldset>
          <div className="flex items-baseline justify-between gap-3">
            <legend className="text-sm text-text">Model</legend>
            <Link href="/models" className="link text-xs">
              Prices, limits and capacity
            </Link>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 sm:gap-3">
            {(["image", "text"] as const).map((k) => (
              <RadioCard
                key={k}
                name="pg-model"
                value={PLAYGROUND_MODEL[k]}
                checked={kind === k}
                onSelect={() => {
                  setKind(k);
                  setLocalError(null);
                  setFailure(null);
                }}
                title={CATALOG_INFO[PLAYGROUND_MODEL[k]].name}
                sub={modelSub(k)}
                className="p-3 sm:p-4"
              />
            ))}
          </div>
        </fieldset>

        <div>
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="pg-prompt" className="text-sm text-text">
              {kind === "image" ? "Describe your image" : "Your prompt"}
            </label>
            <span className="num text-xs text-faint">
              {prompt.length} / {promptLimit}
            </span>
          </div>
          <textarea
            id="pg-prompt"
            ref={promptRef}
            rows={5}
            maxLength={promptLimit}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              if (localError?.field === "prompt") setLocalError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void generate(draft);
              }
            }}
            placeholder={
              kind === "image"
                ? "A cosy reading nook by a rainy window, warm lamp light, oil painting"
                : "Explain what a Merkle proof is to a ten-year-old, in four sentences."
            }
            aria-invalid={errField === "prompt"}
            aria-describedby={errField === "prompt" ? "pg-prompt-err" : "pg-prompt-tip"}
            className={cn(field, "mt-1.5 min-h-[132px] resize-y py-3 text-[15px] leading-relaxed")}
          />
          {errFor("prompt") ?? (
            <p id="pg-prompt-tip" className="mt-1.5 text-xs text-faint">
              {kind === "image"
                ? "Name the subject, then the style and the light. Ctrl + Enter generates."
                : "One question or task per job; there is no chat history. Ctrl + Enter generates."}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Example prompts">
            {EXAMPLES[kind].map((ex) => (
              <Button
                key={ex.label}
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPrompt(ex.prompt);
                  if (localError?.field === "prompt") setLocalError(null);
                  promptRef.current?.focus();
                }}
                title={ex.prompt}
              >
                {ex.label}
              </Button>
            ))}
          </div>
        </div>

        {kind === "image" ? (
          <>
            <fieldset>
              <legend className="text-sm text-text">Shape</legend>
              <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3">
                {(Object.keys(SHAPES) as Shape[]).map((k) => (
                  <RadioCard
                    key={k}
                    name="pg-shape"
                    value={k}
                    checked={shape === k}
                    onSelect={() => setShape(k)}
                    title={SHAPES[k].title}
                    sub={
                      <span className="num">
                        {SHAPES[k].width}×{SHAPES[k].height}
                      </span>
                    }
                    icon={<ShapeIcon width={SHAPES[k].width} height={SHAPES[k].height} checked={shape === k} />}
                    className="flex-col gap-2 p-3 sm:flex-row sm:gap-3"
                  />
                ))}
              </div>
            </fieldset>

            <fieldset>
              <legend className="text-sm text-text">Quality</legend>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:gap-3">
                {(Object.keys(QUALITY) as Quality[]).map((k) => (
                  <RadioCard
                    key={k}
                    name="pg-quality"
                    value={k}
                    checked={quality === k}
                    onSelect={() => setQuality(k)}
                    title={QUALITY[k].title}
                    sub={QUALITY[k].sub}
                    className="p-3"
                  />
                ))}
              </div>
            </fieldset>

            <div className="space-y-3">
              <Disclosure title="Avoid" note={negative.trim() ? "On" : "Optional"}>
                <div>
                  <div className="flex items-baseline justify-between gap-3">
                    <label htmlFor="pg-negative" className="text-sm text-text">
                      Things to keep out of the image
                    </label>
                    <span className="num text-xs text-faint">
                      {negative.length} / {LIMITS.image.negative.max}
                    </span>
                  </div>
                  <input
                    id="pg-negative"
                    maxLength={LIMITS.image.negative.max}
                    value={negative}
                    onChange={(e) => setNegative(e.target.value)}
                    placeholder="blurry, text, watermark"
                    aria-invalid={errField === "negative"}
                    className={cn(field, "mt-1.5 h-10")}
                  />
                  {errFor("negative")}
                </div>
              </Disclosure>
              <Disclosure title="Advanced" note={seed.trim() ? `Seed ${seed.trim()}` : "Seed and guidance"}>
                <div>
                  <div className="flex items-baseline justify-between gap-3">
                    <label htmlFor="pg-seed" className="text-sm text-text">
                      Seed
                    </label>
                    <span className="text-xs text-faint">Optional</span>
                  </div>
                  <div className="mt-1.5 flex gap-2">
                    <input
                      id="pg-seed"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={LIMITS.image.seed.max}
                      value={seed}
                      onChange={(e) => {
                        setSeed(e.target.value);
                        if (localError?.field === "seed") setLocalError(null);
                      }}
                      placeholder="Random"
                      aria-invalid={errField === "seed"}
                      aria-describedby="pg-seed-tip"
                      className={cn(field, "num h-10 min-w-0 flex-1")}
                    />
                    <Button type="button" variant="secondary" onClick={() => setSeed(String(randomSeed()))} aria-label="Pick a random seed">
                      <Shuffle className="size-4" strokeWidth={1.75} aria-hidden />
                      <span className="hidden sm:inline">Shuffle</span>
                    </Button>
                  </div>
                  {errFor("seed")}
                  <p id="pg-seed-tip" className="mt-1.5 text-xs text-faint">
                    The same prompt and seed give the same image. Leave it empty for a new one each time.
                  </p>
                </div>
                <div className="sm:max-w-[220px]">
                  <div className="flex items-baseline justify-between gap-3">
                    <label htmlFor="pg-guidance" className="text-sm text-text">
                      Guidance
                    </label>
                    <span className="num text-xs text-faint">
                      {LIMITS.image.guidance.min}–{LIMITS.image.guidance.max}
                    </span>
                  </div>
                  <input
                    id="pg-guidance"
                    type="number"
                    inputMode="decimal"
                    step={0.5}
                    min={LIMITS.image.guidance.min}
                    max={LIMITS.image.guidance.max}
                    value={guidance}
                    onChange={(e) => {
                      setGuidance(e.target.value);
                      if (localError?.field === "guidance") setLocalError(null);
                    }}
                    aria-invalid={errField === "guidance"}
                    aria-describedby="pg-guidance-tip"
                    className={cn(field, "num mt-1.5 h-10")}
                  />
                  {errFor("guidance")}
                  <p id="pg-guidance-tip" className="mt-1.5 text-xs text-faint">
                    How closely to follow the prompt. {DEFAULT_GUIDANCE} suits most prompts.
                  </p>
                </div>
              </Disclosure>
            </div>
          </>
        ) : (
          <>
            <fieldset>
              <legend className="text-sm text-text">Length</legend>
              <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3">
                {(Object.keys(TEXT_LENGTHS) as TextLength[]).map((k) => (
                  <RadioCard
                    key={k}
                    name="pg-length"
                    value={k}
                    checked={length === k}
                    onSelect={() => setLength(k)}
                    title={TEXT_LENGTHS[k].title}
                    sub={<span className="num">{TEXT_LENGTHS[k].maxTokens} tokens</span>}
                    className="flex-col gap-2 p-3 sm:flex-row sm:gap-3"
                  />
                ))}
              </div>
              <p className="mt-2 text-xs text-faint">The price counts the length you pick, not the words actually written.</p>
            </fieldset>
            <Disclosure title="Instructions" note={system.trim() ? "On" : "Optional system message"}>
              <div>
                <div className="flex items-baseline justify-between gap-3">
                  <label htmlFor="pg-system" className="text-sm text-text">
                    How the model should answer
                  </label>
                  <span className="num text-xs text-faint">
                    {system.length} / {LIMITS.text.system.max}
                  </span>
                </div>
                <input
                  id="pg-system"
                  maxLength={LIMITS.text.system.max}
                  value={system}
                  onChange={(e) => setSystem(e.target.value)}
                  placeholder="Answer in plain English, in short sentences."
                  aria-invalid={errField === "system"}
                  className={cn(field, "mt-1.5 h-10")}
                />
                {errFor("system")}
              </div>
            </Disclosure>
          </>
        )}

        {paidOn ? (
          <fieldset>
            <legend className="text-sm text-text">Payment</legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <RadioCard name="pg-pay" value="free" checked={pay === "free"} onSelect={() => setPay("free")} title="Free trial" sub={freeSub} />
              <RadioCard
                name="pg-pay"
                value="paid"
                checked={pay === "paid"}
                onSelect={() => setPay("paid")}
                title="Pay from balance"
                sub={
                  quote ? (
                    <>
                      <span className="num text-text">{formatEth(quote.wei)}</span> ETH for this {noun}. Charged only if both machines agree.
                    </>
                  ) : (
                    "The price shows once the settings are valid."
                  )
                }
              />
            </div>
            <LowCreditNotice priceWei={quote?.wei ?? null} paid={paid} depositHref="/jobs#balance" className="mt-3" />
            {paid ? (
              <div className="mt-3 rounded-m border border-line">
                <dl className="divide-y divide-line">
                  <Row label={`Price of this ${noun}`}>
                    {quote ? <Eth wei={quote.wei} className="font-medium" /> : <span className="text-muted">Fix the settings to see it</span>}
                  </Row>
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
                      Available balance is <span className="num">{formatEth(available)}</span> ETH; this {noun} costs{" "}
                      <span className="num">{formatEth(quote.wei)}</span> ETH.{" "}
                      <Link href="/jobs#balance" className="link">
                        Deposit more on the Jobs page
                      </Link>{" "}
                      or pick a {kind === "image" ? "faster setting" : "shorter length"}.
                    </p>
                  ) : null}
                  <p>
                    Your wallet asks you to sign a message: no transaction, no gas, no API key. The price is held from your balance and charged
                    only if both machines agree; otherwise it is not charged and the hold is released. Each paid job gets a receipt you can
                    verify against the chain.{" "}
                    <Link href="/jobs#balance" className="link">
                      Manage your balance
                    </Link>
                  </p>
                </div>
              </div>
            ) : null}
          </fieldset>
        ) : null}

        <OutputPrivacyNotice
          subject={kind === "image" ? "image" : "result"}
          fallback={
            <Notice tone="warn" title="Prompts and results are not private.">
              Anyone with the job id can see the prompt and the {noun}. Do not enter names, personal details or anything sensitive.
            </Notice>
          }
        />

        {noPair && cap && !(failure?.f.kind === "http" && failure.f.code === "no-node-pair") ? (
          <Notice tone="warn" title="No pair of machines can take this model right now">
            {pairWords(cap).text}
          </Notice>
        ) : null}
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
              quote ? (
                <>
                  You will sign for <span className="num text-text">{formatEth(quote.wei)}</span> ETH.
                </>
              ) : (
                "Fix the settings to see the price."
              )
            ) : closed ? (
              <span className="text-amber">{paidOn ? "The free trial is closed on this scheduler. Pay from a balance instead." : "The free trial is closed on this scheduler."}</span>
            ) : (
              <>Free trial: {freeSub.charAt(0).toLowerCase() + freeSub.slice(1)}</>
            )}
          </p>
          <Button type="submit" size="lg" className="w-full shrink-0 sm:w-auto sm:min-w-[160px]" disabled={busy || closed || cantPay}>
            {generateLabel}
          </Button>
        </div>
      </div>
    </form>
  );

  return (
    <div className="space-y-14">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start xl:gap-8">
        {form}
        <div ref={resultRef} className="min-w-0 scroll-mt-28">
          <PlaygroundResult
            item={current}
            shape={SHAPES[shape]}
            kind={kind}
            sending={stage}
            onSettled={onSettled}
            onAgain={again}
            againLabel={againLabel}
            againDisabled={
              busy || closed || (paid && (!acct?.isConnected || !againQuote || (available !== null && available < againQuote.wei)))
            }
          />
        </div>
      </div>
      <PlaygroundHistory
        items={items}
        currentId={currentId}
        onSelect={select}
        onVerify={verify}
        onSettled={onSettled}
        onClear={() => {
          update(() => []);
          setCurrentId(null);
        }}
      />
    </div>
  );
}
