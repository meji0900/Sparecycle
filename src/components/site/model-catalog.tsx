"use client";

// The live model catalog on /models: rendered on the server from the same data as GET /api/v1/catalog, then read again
// from that endpoint every 20 s, so capacity ("ready now", "starts on demand", "no pair right now") stays current.
import { ArrowUpRight, Image as ImageIcon, MessageSquareText } from "lucide-react";
import type { ReactNode } from "react";
import { ButtonLink } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status";
import { pairWords, type Catalog, type CatalogModel } from "@/lib/catalog";
import { formatEth, formatGwei } from "@/lib/dapp/paid-jobs";
import { useApiGet } from "@/lib/dapp/use-api";
import { cn } from "@/lib/utils";

const int = (n: number) => n.toLocaleString("en-US");

/** One limit in words, from its name in LIMITS (unknown names are shown as they are). */
function limitWords(name: string, l: Record<string, number>): [string, string] {
  const range = (unit: string) => `${l.min === 0 ? `up to ${int(l.max)}` : `${int(l.min)} to ${int(l.max)}`}${unit}`;
  switch (name) {
    case "prompt":
      return ["Prompt", range(" characters")];
    case "negative":
      return ["Things to avoid", range(" characters")];
    case "system":
      return ["System message", range(" characters")];
    case "side":
      return ["Width and height", `${l.min} to ${l.max} px, in steps of ${l.step}`];
    case "steps":
      return ["Steps", range("")];
    case "guidance":
      return ["Guidance", `${l.min} to ${l.max}${typeof l.default === "number" ? ` (default ${l.default})` : ""}`];
    case "seed":
      return ["Seed", `optional, 0 to ${int(l.max)}`];
    case "maxTokens":
      return ["Answer length (maxTokens)", range(" tokens")];
    default:
      return [name, Object.entries(l).map(([k, v]) => `${k} ${v}`).join(", ")];
  }
}

const BACKEND_LABEL: Record<string, string> = { cuda: "NVIDIA (CUDA)", vulkan: "Vulkan GPUs", cpu: "CPU" };

function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-5 py-3 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-faint">{label}</dt>
      <dd className="min-w-0 text-sm leading-relaxed break-words text-muted">{children}</dd>
    </div>
  );
}

function ModelCard({ m, paidJobs, pool }: { m: CatalogModel; paidJobs: boolean; pool: boolean }) {
  const w = pairWords(m.capacity);
  const Icon = m.kind === "image" ? ImageIcon : MessageSquareText;
  return (
    <article aria-labelledby={`model-${m.id}`} className="flex min-w-0 flex-col rounded-l border border-line bg-coal">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-line px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-m border border-line bg-graphite text-muted">
            <Icon className="size-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-faint">{m.kind === "image" ? "Image" : "Text"}</p>
            <h2 id={`model-${m.id}`} className="text-lg font-semibold tracking-[-0.01em] text-text">
              {m.name}
            </h2>
            <p className="num mt-0.5 text-xs text-faint">{m.id}</p>
          </div>
        </div>
        <StatusTag tone={w.tone}>{w.label}</StatusTag>
      </div>

      <div className="space-y-4 px-5 py-5">
        <p className="text-[15px] leading-relaxed text-muted">{m.summary}</p>
        <div className="rounded-m border border-line bg-graphite px-4 py-3.5">
          {paidJobs ? (
            <>
              <p className="text-sm text-muted">
                <span className="num text-xl font-semibold tracking-[-0.01em] text-text">{formatEth(m.price.example.priceWei)}</span>{" "}
                <span className="text-text">ETH</span> for {m.price.example.label}
              </p>
              <p className="mt-1 text-xs text-faint">
                <span className="num">{int(m.price.example.units)}</span> work units at <span className="num">{formatGwei(m.price.priceWeiPerUnit)}</span>{" "}
                gwei per unit. Charged only when both machines agree.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">Paid jobs are not enabled on this scheduler: free trial only.</p>
          )}
        </div>
        <div className="space-y-1 text-sm leading-relaxed text-muted">
          <p>{w.text}</p>
          <p>
            <span className="num text-text">{m.capacity.ready}</span> {m.capacity.ready === 1 ? "machine" : "machines"} ready
            {pool ? (
              <>
                , <span className="num text-text">{m.capacity.standby}</span> on standby in the GPU pool
              </>
            ) : null}
            .
          </p>
        </div>
      </div>

      <dl className="divide-y divide-line border-t border-line">
        <Fact label="How units count">{m.price.units}</Fact>
        <Fact label="Limits">
          <ul className="space-y-0.5">
            {Object.entries(m.limits).map(([name, l]) => {
              const [k, v] = limitWords(name, l);
              return (
                <li key={name}>
                  <span className="text-text">{k}:</span> {v}
                </li>
              );
            })}
          </ul>
        </Fact>
        <Fact label="Model">{m.label}</Fact>
        <Fact label="Weights">
          <a href={m.sourceUrl} target="_blank" rel="noreferrer" className="link inline-flex items-center gap-1 break-all">
            {m.source}
            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
          </a>
        </Fact>
        <Fact label="License">{m.license}</Fact>
        <Fact label="Runs on">
          {m.backends.map((b) => BACKEND_LABEL[b] ?? b).join(", ")}, at least <span className="num">{int(m.vramMb)}</span> MB of memory. Both copies
          of a job run on the same kind.
        </Fact>
        <Fact label="API">
          <code className="num text-text">POST {m.endpoint}</code>
        </Fact>
        <Fact label="Good to know">
          <ul className="list-disc space-y-1 pl-4">
            {m.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Fact>
      </dl>

      <div className="mt-auto flex flex-wrap gap-3 border-t border-line px-5 py-4">
        <ButtonLink href={`/playground?model=${encodeURIComponent(m.id)}`}>Run it in the playground</ButtonLink>
        <ButtonLink href="/docs/api/openai" variant="secondary">
          Call it from the API
        </ButtonLink>
      </div>
    </article>
  );
}

/** The catalog: who runs the machines, then one card per model, kept live from GET /api/v1/catalog. */
export function ModelCatalog({ initial }: { initial: Catalog }) {
  const q = useApiGet<Catalog>("/catalog", 20_000);
  const cat = q.result?.ok ? q.result.data : initial;
  const stale = q.result !== null && !q.result.ok;
  return (
    <>
      <div
        className={cn(
          "mt-10 rounded-l border px-5 py-4",
          cat.network.operators === "project-run" ? "border-amber/30 bg-amber-soft" : "border-line bg-graphite",
        )}
      >
        <p className={cn("font-medium", cat.network.operators === "project-run" ? "text-amber" : "text-text")}>
          {cat.network.operators === "project-run" ? "All nodes are project-run today" : "Who runs the nodes"}
        </p>
        <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-text/85">{cat.network.note}</p>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {cat.models.map((m) => (
          <ModelCard key={m.id} m={m} paidJobs={cat.pricing.paidJobs} pool={cat.network.pool.configured} />
        ))}
      </div>
      <p className="mt-4 text-xs text-faint" aria-live="polite">
        {stale ? "Could not refresh just now; showing the last numbers read." : "Read live from the scheduler every 20 seconds."}
      </p>
    </>
  );
}
