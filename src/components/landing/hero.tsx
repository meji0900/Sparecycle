"use client";

import { ArrowUpRight, Check, Copy, Terminal } from "lucide-react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import LogoLoop from "@/components/reactbits/LogoLoop";
import RotatingText from "@/components/reactbits/RotatingText";
import ShinyText from "@/components/reactbits/ShinyText";
import SplitText from "@/components/reactbits/SplitText";
import { useSceneEnv } from "@/components/three/use-scene-env";
import { Hex } from "@/components/ui/address";
import { ButtonLink } from "@/components/ui/button";
import { config } from "@/lib/config";
import { EM_DASH, formatAmount, formatBps, formatDuration, formatInt } from "@/lib/format";
import { PONS } from "@/lib/pons";
import { useLiveJson, type ChainApi, type SchedulerStatus } from "@/lib/use-live";
import { cn } from "@/lib/utils";
import { FUNDING } from "@/lib/funding-copy";
import { XLink } from "@/components/brand/x-link";

const NodeField = dynamic(() => import("@/components/three/node-field"), { ssr: false, loading: () => null });

type JobsApi = { jobs: { id: string; model: string; kind: string; status: string; createdAt: number; settledAt: number | null }[] };

/* ---------- small pieces ---------- */

function CopyChip({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="group inline-flex h-11 items-center gap-2.5 rounded-m border border-line-strong bg-coal/80 px-3.5 text-left transition-colors hover:border-[rgba(255,255,255,0.3)]"
      aria-label={done ? "Copied" : `Copy: ${value}`}
    >
      {icon}
      <span className="num text-[13px] text-text">{label}</span>
      {done ? <Check className="size-3.5 text-signal" /> : <Copy className="size-3.5 text-faint group-hover:text-text" />}
    </button>
  );
}

function AddressChip({ name, address, empty }: { name: string; address: string | null; empty: string }) {
  return (
    <div className="inline-flex h-9 items-center gap-2 rounded-m border border-line bg-coal/80 px-3 text-xs">
      <span className="text-muted">{name}</span>
      {address ? <Hex value={address} head={6} tail={4} /> : <span className="text-faint">{empty}</span>}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: ReactNode; note: string }) {
  return (
    <div className="min-w-0 bg-coal/85 px-4 py-3.5">
      <p className="text-xs text-muted">{label}</p>
      <p className="num mt-1.5 truncate text-[19px] leading-none text-text">{value}</p>
      <p className="mt-1.5 truncate text-[11px] text-faint">{note}</p>
    </div>
  );
}

function FloatCard({ className, children, title, tone = "live" }: { className?: string; children: ReactNode; title: string; tone?: "live" | "idle" }) {
  return (
    <div className={cn("w-[264px] rounded-l border border-line-strong bg-[#101010]/95 p-4 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)]", className)}>
      <p className="flex items-center gap-2 text-xs text-muted">
        <span aria-hidden className={cn("size-1.5 rounded-full", tone === "live" ? "bg-signal" : "border border-faint")} />
        {title}
      </p>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

/** Seconds left in the current epoch, ticking client-side from the scheduler's own endsAt. */
function useCountdown(endsAt: number | null | undefined) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  if (!endsAt || now === null) return null;
  return Math.max(0, endsAt - now);
}

const hms = (s: number) =>
  [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":");

const MODULES = [
  { href: "/app", title: "Status", text: "Epoch, pot, root, live jobs", icon: "public-pot", zoom: 1.05 },
  { href: "/app/claim", title: "Claim", text: "Merkle proof, one click", icon: "merkle", zoom: 1.3 },
  { href: "/jobs", title: "Jobs", text: "SD 1.5 and Qwen2.5-1.5B", icon: "two-node", zoom: 1.8 },
  { href: "/nodes", title: "Run a node", text: "Install guide, idle planner", icon: "models", zoom: 2.1 },
  { href: "/token", title: "Token", text: "Pons v2 facts, read live", icon: "no-allocation", zoom: 1.35 },
];

/* ---------- hero ---------- */

export function Hero({ ticker }: { ticker: string }) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const { reduced, inView, dense, webgl } = useSceneEnv(sceneRef);
  const frameloop = !inView || reduced ? "demand" : "always";

  const chain = useLiveJson<ChainApi>("/api/chain", 20_000);
  const sched = useLiveJson<SchedulerStatus & { epoch: { clock?: string; note?: string | null } | null }>(
    `${config.schedulerApiUrl}/status`,
    15_000,
  );
  const jobs = useLiveJson<JobsApi>(`${config.schedulerApiUrl}/jobs?limit=8`, 20_000);

  const net = chain.data?.network?.ok ? chain.data.network.data : null;
  const pons = chain.data?.pons?.ok ? chain.data.pons.data : null;
  const rewards = chain.data?.rewards && chain.data.rewards.ok ? chain.data.rewards.data : null;
  const epoch = sched.data?.epoch ?? null;
  const left = useCountdown(epoch?.endsAt);
  const latestAgreed = jobs.data?.jobs.find((j) => ["agreed", "eligible", "paid"].includes(j.status)) ?? null;
  const schedulerDown = !sched.loading && !sched.data;

  const facts = [
    "Robinhood Chain · chain id 4663",
    pons ? `Pons launch fee ${formatAmount(BigInt(pons.launchFee), 18)} ETH (live)` : "Pons v2 launchpad",
    pons ? `Creator tax cap ${formatBps(Number(pons.maxCreatorTaxBps))} (live)` : null,
    pons ? `Graduation ${formatAmount(BigInt(pons.config.graduationThreshold), 18)} ETH, config ${pons.launchConfigId} (live)` : null,
    "Buybacks off",
    "No team allocation",
    "LP locked by Pons at graduation",
    "Two-node checks",
    "Merkle claims, capped by the pot",
    "Stable Diffusion 1.5 + Qwen2.5-1.5B",
    `Pons v2 unaudited as of ${config.factsCheckedOn}`,
  ].filter(Boolean) as string[];

  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden border-b border-line">
      {/* 3D node field: full-bleed on desktop, a band on phones */}
      <div ref={sceneRef} className="relative h-[280px] w-full md:absolute md:inset-0 md:h-auto" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_70%_60%,#151515_0%,#0c0c0c_60%)]" />
        {webgl ? (
          <div className="absolute inset-0">
            <NodeField animate={!reduced} dense={dense} frameloop={frameloop} />
          </div>
        ) : null}
        <div className="pointer-events-none absolute inset-0 hidden bg-[linear-gradient(90deg,#0c0c0c_0%,rgba(12,12,12,0.9)_36%,rgba(12,12,12,0.3)_60%,rgba(12,12,12,0)_76%)] md:block" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-[linear-gradient(0deg,#0c0c0c_25%,rgba(12,12,12,0))]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-[linear-gradient(180deg,#0c0c0c,rgba(12,12,12,0))] md:hidden" />
      </div>

      <div className="relative mx-auto max-w-[1200px] px-4 pt-2 sm:px-6 md:pt-10">
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-10 md:grid-cols-[minmax(0,1fr)_300px] lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* copy column */}
          <div className="min-w-0 max-w-[660px]">
            <Link
              href={config.tokenAddress ? "/proof" : "/legal/disclosures"}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-line-strong bg-coal/80 py-1 pr-3 pl-1 text-xs transition-colors hover:border-[rgba(255,255,255,0.3)]"
            >
              <span className="rounded-full bg-signal-soft px-2 py-0.5 text-signal">{config.tokenAddress ? "Live" : "New"}</span>
              <ShinyText
                text={config.tokenAddress ? `${config.ticker ?? "The token"} is live on Pons. Reward and payments contracts verified on-chain.` : "Reward contract: 94 tests and a mainnet-fork run passed. Not deployed yet."}
                color="#9b9b9b"
                shineColor="#ededed"
                speed={3.2}
                className="min-w-0 truncate"
              />
              <ArrowUpRight className="size-3.5 shrink-0 text-faint" />
            </Link>

            <div className="mt-5 flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-2 rounded-m border border-line bg-coal/80 px-2.5 py-1.5 text-muted">
                <span aria-hidden className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-signal opacity-50 motion-reduce:hidden" />
                  <span className="relative inline-flex size-2 rounded-full bg-signal" />
                </span>
                Live on Robinhood Chain
              </span>
              <span className="num rounded-m border border-line bg-coal/80 px-2.5 py-1.5 text-muted">
                block {net ? formatInt(BigInt(net.blockNumber)) : EM_DASH}
              </span>
              <span className="rounded-m border border-line bg-coal/80 px-2.5 py-1.5 text-muted">
                {pons ? (pons.launchEnabled ? "Pons launches open (read live)" : "Pons launches closed (read live)") : "Pons v2"}
              </span>
            </div>

            <h1 id="hero-title" className="mt-6 text-[clamp(2.6rem,1.5rem+4vw,4.25rem)] leading-[0.98] font-semibold tracking-[-0.04em] text-balance text-text">
              <SplitText
                tag="span"
                text={FUNDING.tagline}
                className="block"
                textAlign="left"
                splitType="words"
                effect="rise"
                mask
                trigger="load"
                delay={45}
                duration={0.9}
              />
            </h1>
            <p className="mt-6 max-w-[58ch] text-[17px] leading-relaxed text-muted">
              {FUNDING.heroBody}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="/nodes" size="lg">
                Launch App
              </ButtonLink>
              <ButtonLink href="/app" size="lg" variant="secondary">
                Network status
              </ButtonLink>
              <CopyChip label="bash install.sh" value="bash install.sh" icon={<Terminal className="size-3.5 text-faint" />} />
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <AddressChip name="Token (CA)" address={config.tokenAddress} empty="Not launched yet" />
              <AddressChip name="Reward contract" address={config.rewardContract} empty="Not deployed yet" />
              <AddressChip name="Pons factory" address={PONS.factory} empty={EM_DASH} />
            </div>
            <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <Link href="/proof" className="link">
                Check every contract and transaction on-chain
              </Link>
              <XLink withLabel />
            </p>

            <p className="mt-5 text-sm leading-relaxed text-muted">
              Robinhood Chain (EVM, chain id <span className="num text-text">4663</span>). Token launched via Pons v2.{" "}
              <span className="num text-text">{ticker}</span> ticker set at launch. MVP models:{" "}
              <RotatingText
                texts={["Stable Diffusion 1.5", "Qwen2.5-1.5B-Instruct"]}
                mainClassName="num inline-flex translate-y-[3px] overflow-hidden rounded-s border border-line bg-coal/80 px-2 py-0.5 align-baseline text-text"
                rotationInterval={2600}
                effect="slide"
                staggerDuration={0.012}
                splitBy="characters"
                auto={!reduced}
              />
            </p>
          </div>

          {/* floating live cards (desktop) */}
          <div className="relative hidden h-full min-h-[480px] md:block" aria-label="Live readouts">
            <FloatCard title={epoch?.clock === "contract" ? "Current epoch, reward contract" : "Current epoch, scheduler clock"} className="absolute top-2 right-0">
              {epoch ? (
                <>
                  <p className="num text-2xl text-text">Epoch {epoch.id}</p>
                  {left !== null ? (
                    <p className="mt-1 text-sm text-muted">
                      Closes in <span className="num text-text">{hms(left)}</span>
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-faint">
                    {epoch.note ?? `Epoch length ${formatDuration(epoch.length)}.`}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted">{schedulerDown ? "Scheduler API not reachable." : "Reading the scheduler…"}</p>
              )}
            </FloatCard>

            <FloatCard
              title="Latest checked job"
              tone={latestAgreed ? "live" : "idle"}
              className="absolute top-[196px] -left-6 lg:-left-10"
            >
              {latestAgreed ? (
                <Link href="/jobs" className="block">
                  <p className="num text-sm text-text">
                    {latestAgreed.id.slice(0, 10)}… · {latestAgreed.model}
                  </p>
                  <p className="mt-1.5 text-xs text-signal">Two nodes agreed</p>
                </Link>
              ) : (
                <p className="text-sm text-muted">
                  No checked job yet. The first one appears here once two nodes agree.{" "}
                  <Link href="/nodes" className="link">
                    Run a node
                  </Link>
                </p>
              )}
            </FloatCard>

            <FloatCard title="Epoch pot" tone={rewards ? "live" : "idle"} className="absolute top-[350px] right-2">
              {rewards ? (
                <p className="num text-2xl text-text">
                  {formatAmount(BigInt(rewards.epoch.pot), rewards.payout.decimals)}{" "}
                  <span className="text-sm text-muted">{rewards.payout.symbol}</span>
                </p>
              ) : (
                <p className="text-sm text-muted">
                  {EM_DASH} The reward contract is not deployed yet, so there is no pot to read.
                </p>
              )}
            </FloatCard>
          </div>
        </div>

        {/* live stats */}
        <div className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-l border border-line bg-line md:mt-4 lg:grid-cols-4">
          <Stat
            label="Epoch pot"
            value={rewards ? `${formatAmount(BigInt(rewards.epoch.pot), rewards.payout.decimals)} ${rewards.payout.symbol}` : EM_DASH}
            note={rewards ? "Read from the reward contract" : "Contract not deployed yet"}
          />
          <Stat
            label="Jobs checked this epoch"
            value={sched.data ? formatInt(sched.data.jobs.agreedThisEpoch) : EM_DASH}
            note={sched.data ? "Two nodes agreed, from the scheduler" : "Scheduler not reachable"}
          />
          <Stat
            label="Nodes online"
            value={sched.data ? formatInt(sched.data.nodes.online) : EM_DASH}
            note={sched.data ? `${formatInt(sched.data.nodes.registered)} registered, from the scheduler` : "Scheduler not reachable"}
          />
          <Stat
            label="Pons launch fee"
            value={pons ? `${formatAmount(BigInt(pons.launchFee), 18)} ETH` : EM_DASH}
            note={pons ? "launchFee(), read live" : "Factory not reachable"}
          />
        </div>
      </div>

      {/* facts ticker */}
      <div className="relative mt-8 border-y border-line bg-coal/70 py-3">
        <LogoLoop
          logos={facts.map((f) => ({
            node: (
              <span className="inline-flex items-center gap-2 text-[13px] whitespace-nowrap text-muted">
                <span aria-hidden className="size-1 rounded-full bg-signal" />
                {f}
              </span>
            ),
            title: f,
          }))}
          speed={reduced ? 0 : 38}
          gap={40}
          logoHeight={20}
          fadeOut
          fadeOutColor="#0c0c0c"
          pauseOnHover
          ariaLabel="Facts about the network, read live where marked"
        />
      </div>

      {/* product modules */}
      <nav aria-label="Open the app" className="relative mx-auto max-w-[1200px] px-4 py-8 sm:px-6">
        <ul className="flex snap-x gap-3 overflow-x-auto pb-1 lg:grid lg:grid-cols-5 lg:overflow-visible">
          {MODULES.map((m) => (
            <li key={m.href} className="min-w-[220px] snap-start lg:min-w-0">
              <Link
                href={m.href}
                className="group flex h-full items-center gap-3 rounded-l border border-line bg-coal/80 p-3 transition-colors hover:border-line-strong"
              >
                <span className="relative size-14 shrink-0 overflow-hidden rounded-m bg-[#121212]" aria-hidden>
                  <Image
                    src={`/art/icon-${m.icon}.webp`}
                    alt=""
                    fill
                    sizes="56px"
                    style={{ transform: `scale(${m.zoom})` }}
                    className="object-cover"
                  />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                    {m.title}
                    <ArrowUpRight className="size-3.5 text-faint transition-colors group-hover:text-signal" />
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted">{m.text}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-right text-[11px] text-faint">
          Background: 3D illustration of the two-node check, not live data. Every number above is a live read or a dash.
        </p>
      </nav>
    </section>
  );
}
