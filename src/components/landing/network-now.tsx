"use client";

import Link from "next/link";
import { IdleGuardNote, NODE_STATE_TONE } from "@/components/dapp/node-state";
import { StatusTag, type Tone } from "@/components/ui/status";
import { config } from "@/lib/config";
import { EM_DASH, formatInt } from "@/lib/format";
import { NODE_STATE_LABEL, shownNodeState, type PublicNodeState } from "@/lib/node-state";
import { useLiveJson } from "@/lib/use-live";

type Status = {
  nodes: { registered: number; online: number };
  jobs: { queued: number; running: number; agreedThisEpoch: number };
  gpuPool?: { configured: false } | { configured: true; state: "stopped" | "starting" | "running" | string; instances: number; error: string | null };
};
type Node = {
  nodeKey: string;
  gpu: string;
  vramMb: number;
  backend?: "cuda" | "vulkan" | "cpu";
  online: boolean;
  /** Idle Guard state; absent on older schedulers (then online = active). */
  state?: PublicNodeState;
  epochAgreedJobs: number;
  dev?: boolean;
  project?: boolean;
  paidTest?: boolean;
};

/** "NVIDIA GeForce RTX 3060" -> "RTX 3060". */
const gpuName = (g: string) => g.replace(/^(NVIDIA|AMD|Intel\(R\))\s+/i, "").replace(/^(GeForce|Radeon)\s+/i, "").trim() || g;

function nodeState(n: Node, pool: Status["gpuPool"]): { tone: Tone; label: string } {
  if (!n.online && n.project && pool?.configured) {
    if (pool.state === "starting") return { tone: "neutral", label: "Starting" };
    return { tone: "neutral", label: "Standby" };
  }
  const s = shownNodeState(n);
  return { tone: NODE_STATE_TONE[s], label: NODE_STATE_LABEL[s] };
}

/** List order: active, then paused (online but resting), then everything else; project GPUs first within each. */
const rank = (n: Node) => (n.online ? (shownNodeState(n) === "active" ? 0 : 1) : 2);

function Stat({ label, value, note }: { label: string; value: number | null; note?: string }) {
  return (
    <div className="flex flex-col gap-1 bg-coal px-5 py-5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="num text-[clamp(2rem,1.4rem+1.6vw,2.75rem)] leading-none font-semibold tracking-[-0.03em] text-text">
        {value === null ? <span className="text-faint">{EM_DASH}</span> : formatInt(value)}
      </dd>
      {note ? <dd className="text-xs text-faint">{note}</dd> : null}
    </div>
  );
}

/**
 * The network right now, from the scheduler: GPUs online and on standby, the job queue, and every registered GPU.
 * Project GPUs (run by Sparecycle to keep jobs moving while the network grows) are labelled and never paid.
 */
export function NetworkNow() {
  const status = useLiveJson<Status>(`${config.schedulerApiUrl}/status`, 15_000);
  const nodesRes = useLiveJson<{ nodes: Node[] }>(`${config.schedulerApiUrl}/nodes`, 15_000);
  const s = status.data;
  const pool = s?.gpuPool;
  const nodes = (nodesRes.data?.nodes ?? []).filter((n) => !n.dev);
  const ordered = [...nodes].sort((a, b) => rank(a) - rank(b) || Number(!!b.project) - Number(!!a.project));
  const online = nodes.filter((n) => n.online).length;
  const standby = nodes.filter((n) => !n.online && n.project && pool?.configured).length;
  const reachable = !!s;

  return (
    <section id="network" aria-labelledby="network-title" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div className="max-w-[640px]">
            <h2 id="network-title" className="text-title font-semibold text-text">
              The network right now
            </h2>
            <p className="mt-4 text-muted">
              Every GPU registered with the scheduler and the job queue, refreshed every 15 seconds.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2.5 sm:items-end">
            {reachable ? (
              <StatusTag tone="live">Live from the scheduler</StatusTag>
            ) : status.loading ? (
              <StatusTag tone="neutral">Connecting</StatusTag>
            ) : (
              <StatusTag tone="error">Scheduler not reachable</StatusTag>
            )}
            <Link href="/app" className="link text-sm">
              Open status page
            </Link>
          </div>
        </div>

        <dl className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-l border border-line bg-line lg:grid-cols-5">
          <Stat label="GPUs online" value={reachable ? online : null} note="A job needs two, with different owners" />
          <Stat label="On standby" value={reachable ? standby : null} note="Start by themselves when a job waits" />
          <Stat label="Jobs in queue" value={s ? s.jobs.queued : null} />
          <Stat label="Running now" value={s ? s.jobs.running : null} note="Each job runs on two GPUs" />
          <Stat label="Verified this period" value={s ? s.jobs.agreedThisEpoch : null} note="Both GPUs agreed" />
        </dl>

        <div className="mt-6 overflow-hidden rounded-l border border-line bg-coal">
          {ordered.length ? (
            <ul aria-label="GPUs on the network" className="divide-y divide-line">
              {ordered.map((n) => {
                const st = nodeState(n, pool);
                return (
                  <li key={n.nodeKey} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <StatusTag tone={st.tone}>{st.label}</StatusTag>
                      <span className="truncate font-medium text-text">{gpuName(n.gpu)}</span>
                      <span className="num text-sm text-muted">{Math.round(n.vramMb / 1024)} GB</span>
                      {n.backend && n.backend !== "cuda" ? <span className="text-sm text-faint">{n.backend}</span> : null}
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <span className="text-muted">
                        <span className="num text-text">{formatInt(n.epochAgreedJobs)}</span> verified this period
                      </span>
                      <span className={n.project ? "text-text" : "text-muted"}>{n.project ? (n.paidTest ? "Sparecycle GPU, paid test node" : "Sparecycle GPU") : "Community"}</span>
                    </div>
                    <IdleGuardNote backend={n.backend} className="basis-full" />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-5 py-6 text-sm text-muted">
              {nodesRes.loading ? "Reading the node list." : "No GPU has registered yet."}{" "}
              <Link href="/nodes" className="link">
                Run a node
              </Link>
            </p>
          )}
          <p className="border-t border-line px-5 py-3.5 text-xs leading-relaxed text-faint">
            Sparecycle GPUs are run by the project so jobs don&apos;t wait while the network grows. They are not paid from the
            pot; community GPUs are. A GPU marked paid test node is the team&apos;s own, paid on purpose to test the payout path in the open. A GPU counts as online when it asked for work or sent a heartbeat in the last two minutes. A paused GPU says why (its owner is using it, it is too hot, or it is outside its chosen hours) and takes no jobs until it resumes; when the pause began is not shown.
          </p>
        </div>
      </div>
    </section>
  );
}
