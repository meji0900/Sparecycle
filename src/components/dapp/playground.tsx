"use client";

import { ChevronDown, Shuffle } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/status";
import type { ApiFailure } from "@/lib/dapp/api";
import { formatEth, quoteJob } from "@/lib/dapp/paid-jobs";
import { LIMITS } from "@/lib/protocol";
import { cn } from "@/lib/utils";
import { accountFailureText, Eth, LowCreditNotice } from "./job-balance";
import { loadItems, MAX_ITEMS, PlaygroundHistory, saveItems, type PlayItem } from "./playground-history";
import { PlaygroundResult } from "./playground-result";
import { OutputPrivacyNotice } from "./private-output";
import { RadioCard, Row } from "./ui";
import { nowMs, submitFailureText, useJobSubmit } from "./use-job-submit";
import { WalletButton } from "./wallet-button";

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

const EXAMPLES = [
  { label: "Lighthouse at dusk", prompt: "A lighthouse on a rocky cliff at dusk, watercolour, soft warm light" },
  { label: "Fox in the snow", prompt: "A red fox sitting in fresh snow, morning light, detailed fur, photograph" },
  { label: "Tiny cabin", prompt: "An isometric tiny wooden cabin in a pine forest, glowing windows, 3d render" },
  { label: "Bowl of ramen", prompt: "A steaming bowl of ramen on a wooden table, studio photo, shallow depth of field" },
];

type Settings = { prompt: string; negative: string; width: number; height: number; steps: number; guidance: number; seed: number | null };

/** The image request exactly as /jobs builds it (a paid job sends this same object as `request`). */
const buildRequest = (s: Settings) => ({
  kind: "image",
  params: {
    model: "sd15",
    prompt: s.prompt,
    negative: s.negative,
    width: s.width,
    height: s.height,
    steps: s.steps,
    guidance: s.guidance,
    ...(s.seed !== null ? { seed: s.seed } : {}),
  },
});

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

/**
 * The image playground: a prompt, a few plain choices, the live stage of the job and this browser's images.
 * Submission goes through the same code as /jobs (free trial or a signed payment from the wallet's balance).
 */
export function Playground({ rateLimit }: { rateLimit: number | null }) {
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [shape, setShape] = useState<Shape>("square");
  const [quality, setQuality] = useState<Quality>("fast");
  const [seed, setSeed] = useState("");
  const [guidance, setGuidance] = useState(String(DEFAULT_GUIDANCE));
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

  useEffect(() => {
    // Read after mount: localStorage is per-viewer and absent on the server.
    const t = setTimeout(() => {
      const list = loadItems();
      setItems(list);
      setCurrentId((c) => c ?? list[0]?.id ?? null);
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
    (id: string, fields: Partial<PlayItem>) => update((list) => list.map((i) => (i.id === id ? { ...i, ...fields } : i))),
    [update],
  );

  const seedNum = seed.trim() === "" ? null : Number(seed);
  const guidanceNum = guidance.trim() === "" ? DEFAULT_GUIDANCE : Number(guidance);
  const settings: Settings = {
    prompt,
    negative,
    width: SHAPES[shape].width,
    height: SHAPES[shape].height,
    steps: QUALITY[quality].steps,
    guidance: guidanceNum,
    seed: seedNum,
  };
  const current = items.find((i) => i.id === currentId) ?? null;
  const againSettings: Settings | null = current
    ? { prompt: current.prompt, negative: current.negative, width: current.width, height: current.height, steps: current.steps, guidance: current.guidance, seed: null }
    : null;

  const quote = paidOn ? quoteJob(buildRequest(settings), weiPerUnit) : null;
  const againQuote = paidOn && againSettings ? quoteJob(buildRequest(againSettings), weiPerUnit) : null;
  const available = acct?.account ? BigInt(acct.account.available) : null;
  const short = paid && quote !== null && available !== null && available < quote.wei;
  const cantPay = paid && (!acct?.isConnected || !quote || short);

  async function generate(s: Settings) {
    if (busy || closed) return;
    setFailure(null);
    setSignError(null);
    setLocalError(null);
    if (s.prompt.trim() === "") {
      setLocalError({ field: "prompt", message: "Describe the image first." });
      promptRef.current?.focus();
      return;
    }
    if (s.seed !== null && (!Number.isInteger(s.seed) || s.seed < LIMITS.image.seed.min || s.seed > LIMITS.image.seed.max)) {
      setLocalError({ field: "seed", message: `The seed must be a whole number from 0 to ${LIMITS.image.seed.max}, or empty.` });
      return;
    }
    if (!Number.isFinite(s.guidance) || s.guidance < LIMITS.image.guidance.min || s.guidance > LIMITS.image.guidance.max) {
      setLocalError({ field: "guidance", message: `Guidance must be a number from ${LIMITS.image.guidance.min} to ${LIMITS.image.guidance.max}.` });
      return;
    }
    // On phones the result sits under the form: bring it into view so the stage is visible.
    if (!window.matchMedia("(min-width: 1024px)").matches) resultRef.current?.scrollIntoView({ block: "nearest" });
    const res = await submit(buildRequest(s), paid);
    if (!res.ok) {
      if (res.failure) setFailure({ f: res.failure, paid });
      setSignError(res.signError);
      return;
    }
    const item: PlayItem = { id: res.id, at: nowMs(), ...s, paid, secret: res.readSecret };
    update((list) => [item, ...list.filter((i) => i.id !== res.id)]);
    setCurrentId(res.id);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void generate(settings);
  }

  function again() {
    if (againSettings) void generate({ ...againSettings, seed: randomSeed() });
  }

  function select(id: string) {
    setCurrentId(id);
    resultRef.current?.scrollIntoView({ block: "nearest" });
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

  const generateLabel = stage === "sign" ? "Sign in your wallet…" : busy ? "Sending…" : paid ? "Sign and generate" : "Generate";
  const againLabel = paid ? (
    <>
      Generate again{againQuote ? <span className="num font-normal opacity-80"> · {formatEth(againQuote.wei)} ETH</span> : null}
    </>
  ) : (
    "Generate again"
  );

  const freeSub =
    rateLimit === 0 ? "Closed on this scheduler." : rateLimit !== null ? `${rateLimit} image${rateLimit === 1 ? "" : "s"} per hour, no wallet needed.` : "A few images per hour, no wallet needed.";

  const form = (
    <form onSubmit={onSubmit} noValidate className="min-w-0 rounded-l border border-line bg-coal">
      <div className="space-y-6 px-5 py-5">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="pg-prompt" className="text-sm text-text">
              Describe your image
            </label>
            <span className="num text-xs text-faint">
              {prompt.length} / {LIMITS.image.prompt.max}
            </span>
          </div>
          <textarea
            id="pg-prompt"
            ref={promptRef}
            rows={5}
            maxLength={LIMITS.image.prompt.max}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              if (localError?.field === "prompt") setLocalError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void generate(settings);
              }
            }}
            placeholder="A cosy reading nook by a rainy window, warm lamp light, oil painting"
            aria-invalid={errField === "prompt"}
            aria-describedby={errField === "prompt" ? "pg-prompt-err" : "pg-prompt-tip"}
            className={cn(field, "mt-1.5 min-h-[132px] resize-y py-3 text-[15px] leading-relaxed")}
          />
          {errFor("prompt") ?? (
            <p id="pg-prompt-tip" className="mt-1.5 text-xs text-faint">
              Name the subject, then the style and the light. Ctrl + Enter generates.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Example prompts">
            {EXAMPLES.map((ex) => (
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
                      <span className="num text-text">{formatEth(quote.wei)}</span> ETH for this image. Charged only if both GPUs agree.
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
                  <Row label="Price of this image">
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
                      Available balance is <span className="num">{formatEth(available)}</span> ETH; this image costs{" "}
                      <span className="num">{formatEth(quote.wei)}</span> ETH.{" "}
                      <Link href="/jobs#balance" className="link">
                        Deposit more on the Jobs page
                      </Link>{" "}
                      or pick Fast.
                    </p>
                  ) : null}
                  <p>
                    Your wallet asks you to sign a message: no transaction, no gas. The price is held from your balance and charged only if
                    both GPUs agree; otherwise it is not charged and the hold is released.{" "}
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
          subject="image"
          fallback={
            <Notice tone="warn" title="Prompts and images are not private.">
              Anyone with the job id can see the prompt and the image. Do not enter names, personal details or anything sensitive.
            </Notice>
          }
        />

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
              <span className="text-amber">{paidOn ? "The free trial is closed on this scheduler. Pay from a balance instead." : "Image generation is closed on this scheduler."}</span>
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
            sending={stage}
            onSettled={onSettled}
            onAgain={again}
            againLabel={againLabel}
            againDisabled={busy || closed || (paid && (!acct?.isConnected || !againQuote || (available !== null && available < againQuote.wei)))}
          />
        </div>
      </div>
      <PlaygroundHistory
        items={items}
        currentId={currentId}
        onSelect={select}
        onSettled={onSettled}
        onClear={() => {
          update(() => []);
          setCurrentId(null);
        }}
      />
    </div>
  );
}
