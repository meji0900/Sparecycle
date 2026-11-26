"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { StatusTag } from "@/components/ui/status";
import { config } from "@/lib/config";
import { formatAmount } from "@/lib/format";
import { FIRST_PAYOUT_TXS, MAINNET_EXPLORER } from "@/lib/proof";
import { useLiveJson, type ChainApi } from "@/lib/use-live";
import { cn } from "@/lib/utils";

// The playground's default image: SD 1.5, 512x512, 15 steps = 2,400 work units (src/lib/protocol.ts workUnits).
const EXAMPLE_UNITS = 2400n;
const EXPLORER = config.explorerUrl ?? MAINNET_EXPLORER;
// Epoch 1 on mainnet, 24 Nov 2026: the first paid job charged, its payout root posted, the payout claimed.
// The claim went to the team's own, labelled paid test node (the payout path tested in the open).
const FIRST_PAYOUT = FIRST_PAYOUT_TXS;

type Tab = "job" | "node" | "check";
const TABS: { id: Tab; label: string }[] = [
  { id: "job", label: "Run a job" },
  { id: "node", label: "Run a node" },
  { id: "check", label: "Check it" },
];

type JobsApi = { jobs: { id: string; model: string; kind: string; status: string; createdAt: number }[] };
type StatusApi = { epoch: { id: string | number; endsAt: number; length: number } | null };

function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col rounded-l border border-line-strong bg-[#101010] p-5", className)}>
      <p className="font-medium text-text">{title}</p>
      <div className="mt-4 flex flex-1 flex-col">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-faint">{label}</p>
      <div className="mt-1 text-sm text-text">{children}</div>
    </div>
  );
}

const STAGES = [
  ["Queued", "Waiting for two GPUs"],
  ["Running on two GPUs", "Each one makes it separately"],
  ["Checking", "The two results are compared"],
  ["Done", "Shown to you only if they agree"],
] as const;

function JobTab() {
  const price = EXAMPLE_UNITS * config.jobPriceWeiPerUnit;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Make an image">
        <Field label="Prompt (example)">
          <p className="rounded-m border border-line bg-coal px-3 py-2.5 text-muted">a lighthouse on a cliff at dusk, oil painting</p>
        </Field>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field label="Model">Stable Diffusion 1.5</Field>
          <Field label="Size">
            <span className="num">512 × 512</span>, 15 steps
          </Field>
          <Field label="Price">
            <span className="num">{formatAmount(price, 18, 7)} ETH</span>
          </Field>
          <Field label="Or">Free trial, 5 an hour</Field>
        </div>
        <Link
          href="/playground"
          className="mt-6 inline-flex h-11 items-center justify-center rounded-m bg-signal px-4 text-sm font-medium text-signal-ink transition-opacity hover:opacity-90"
        >
          Make this image
        </Link>
      </Card>
      <Card title="What happens next">
        <ol className="divide-y divide-line rounded-m border border-line">
          {STAGES.map(([t, d], i) => (
            <li key={t} className="flex items-baseline gap-3 px-4 py-3">
              <span className="num text-xs text-signal">{i + 1}</span>
              <span className="min-w-0">
                <span className="block text-sm text-text">{t}</span>
                <span className="block text-xs text-muted">{d}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm text-muted">You are charged only if both GPUs agree. If they don&apos;t, the job costs you nothing.</p>
      </Card>
    </div>
  );
}

function useSecondsLeft(endsAt: number | null | undefined) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return endsAt && now !== null ? Math.max(0, endsAt - now) : null;
}
const hms = (s: number) => [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");

// An example schedule: nights, 22:00 to 07:00 local time.
const EXAMPLE_HOURS = new Set([22, 23, 0, 1, 2, 3, 4, 5, 6]);

function NodeTab() {
  const status = useLiveJson<StatusApi>(`${config.schedulerApiUrl}/status`, 15_000);
  const chain = useLiveJson<ChainApi>("/api/chain", 30_000);
  const rewards = chain.data?.rewards && chain.data.rewards.ok ? chain.data.rewards.data : null;
  const left = useSecondsLeft(status.data?.epoch?.endsAt);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Pick the hours it may work">
        <div className="grid grid-cols-12 gap-1" aria-label="Example: a GPU that works from 22:00 to 07:00">
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              className={cn(
                "flex h-9 items-center justify-center rounded-s border text-[11px]",
                EXAMPLE_HOURS.has(h) ? "border-signal/40 bg-signal-soft text-signal" : "border-line text-faint",
              )}
            >
              <span className="num">{String(h).padStart(2, "0")}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 text-sm text-muted">
          Example: nights only. Outside these hours the node takes no jobs, and if you start a game or a render it steps
          aside.
        </p>
        <Link href="/nodes" className="link mt-auto pt-4 text-sm">
          Read the install guide
        </Link>
      </Card>
      <Card title="Get paid for checked work">
        <dl className="divide-y divide-line rounded-m border border-line text-sm">
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt className="text-muted">Of every job price</dt>
            <dd className="text-text">
              <span className="num">95%</span> to the node pot, <span className="num">5%</span> to the treasury
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt className="text-muted">Node pot, this period</dt>
            <dd className="num text-text">
              {rewards ? `${formatAmount(BigInt(rewards.epoch.pot), rewards.payout.decimals)} ${rewards.payout.symbol}` : chain.loading ? "…" : "not readable now"}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt className="text-muted">Period closes in</dt>
            <dd className="num text-text">{left !== null ? hms(left) : status.loading ? "…" : "not readable now"}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 px-4 py-3">
            <dt className="text-muted">Your share</dt>
            <dd className="text-right text-text">By the work your GPU did in jobs that matched</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-muted">You claim it yourself after the period closes. You don&apos;t need to hold the token.</p>
      </Card>
    </div>
  );
}

const STATUS_LABEL: Record<string, { tone: "live" | "neutral" | "warn" | "off"; text: string }> = {
  agreed: { tone: "live", text: "Two GPUs agreed" },
  running: { tone: "neutral", text: "Running" },
  checking: { tone: "neutral", text: "Checking" },
  queued: { tone: "neutral", text: "Queued" },
  disagreed: { tone: "warn", text: "Did not match, not paid" },
  expired: { tone: "off", text: "Expired" },
};

function CheckTab() {
  const jobs = useLiveJson<JobsApi>(`${config.schedulerApiUrl}/jobs?limit=6`, 20_000);
  const list = jobs.data?.jobs ?? [];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Latest jobs, live">
        {list.length ? (
          <ul className="divide-y divide-line rounded-m border border-line">
            {list.map((j) => {
              const st = STATUS_LABEL[j.status] ?? { tone: "neutral" as const, text: j.status };
              return (
                <li key={j.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <span className="num min-w-0 truncate text-sm text-text">
                    {j.id.slice(0, 10)}… <span className="text-muted">{j.model}</span>
                  </span>
                  <StatusTag tone={st.tone}>{st.text}</StatusTag>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">{jobs.loading ? "Reading the job list…" : "No jobs to show right now."}</p>
        )}
        <Link href="/jobs" className="link mt-auto pt-4 text-sm">
          All jobs
        </Link>
      </Card>
      <Card title="The first payout, on Robinhood Chain">
        <ol className="divide-y divide-line rounded-m border border-line">
          {FIRST_PAYOUT.map((t, i) => (
            <li key={t.hash}>
              <a
                href={`${EXPLORER}/tx/${t.hash}`}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center justify-between gap-3 px-4 py-3"
              >
                <span className="min-w-0">
                  <span className="block text-sm text-text">
                    <span className="num mr-2 text-xs text-signal">{i + 1}</span>
                    {t.label}
                  </span>
                  <span className="num block truncate text-xs text-muted">
                    {t.hash.slice(0, 12)}…{t.hash.slice(-6)}
                  </span>
                </span>
                <ArrowUpRight className="size-3.5 shrink-0 text-faint transition-colors group-hover:text-signal" />
              </a>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm text-muted">
          Payout period 1, 24 Nov 2026. The claim went to the team&apos;s own GPU, openly labelled as a paid test node, to
          prove the path end to end.
        </p>
        <Link href="/proof" className="link mt-auto pt-4 text-sm">
          Every contract and transaction
        </Link>
      </Card>
    </div>
  );
}

/** What using Sparecycle looks like, in three tabs: real prices, live reads, real transactions. */
export function ProductPanel() {
  const [tab, setTab] = useState<Tab>("job");
  return (
    <section aria-label="What it looks like" className="border-b border-line">
      <div className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6">
        <div className="overflow-hidden rounded-l border border-line bg-coal">
          <div role="tablist" aria-label="Product" className="grid grid-cols-3 border-b border-line">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls={`panel-${t.id}`}
                onClick={() => setTab(t.id)}
                className={cn(
                  "h-12 border-b-2 text-sm transition-colors",
                  tab === t.id ? "border-signal bg-[#121212] text-text" : "border-transparent text-muted hover:text-text",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="p-4 sm:p-6">
            {tab === "job" ? <JobTab /> : tab === "node" ? <NodeTab /> : <CheckTab />}
          </div>
        </div>
      </div>
    </section>
  );
}
