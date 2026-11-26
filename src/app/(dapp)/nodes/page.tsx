import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/dapp/app-shell";
import { LastEpochAverage } from "@/components/dapp/last-epoch-average";
import { DemoVideo } from "@/components/dapp/demo-video";
import { RegisteredNodesTable } from "@/components/dapp/node-list";
import { NODE_STATE_TONE } from "@/components/dapp/node-state";
import { SetupGuide } from "@/components/dapp/setup-guide";
import { SectionTitle, TableBox, td, th } from "@/components/dapp/ui";
import { StatusTag } from "@/components/ui/status";
import { IDLE_GUARD_HOURS_ONLY, NODE_STATE_LABEL, NODE_STATE_MEANING, type PublicNodeState } from "@/lib/node-state";
import { MODELS } from "@/lib/protocol";
import { IMAGE_MAX_BITS, TEXT_MIN_SIMILARITY } from "@/server/verify";
import { FUNDING, feesToTeamWallet, paidJobsLive } from "@/lib/funding-copy";

export const metadata: Metadata = {
  title: "Run a node",
  description:
    "Install the Sparecycle node client on an idle NVIDIA GPU, link the wallet that receives payouts and choose the hours it may work. No hourly rate.",
};

const gb = (mb: number) => `approximately ${Math.round(mb / 1000)} GB`;

const CHECKS: [string, string, string][] = [
  ["GPU name, UUID and VRAM", "Read once from nvidia-smi at start and sent to the scheduler when the node registers.", "The scheduler never sends one job to two nodes on the same GPU or the same owner wallet."],
  ["VRAM for Stable Diffusion 1.5", `At least ${MODELS.sd15.vramMb.toLocaleString("en-US")} MB (${gb(MODELS.sd15.vramMb)}).`, "Below that, image jobs stay off."],
  ["VRAM for Qwen2.5-1.5B (Q4)", `At least ${MODELS["qwen2.5-1.5b"].vramMb.toLocaleString("en-US")} MB (${gb(MODELS["qwen2.5-1.5b"].vramMb)}).`, "Below that, text jobs stay off."],
  ["Runtimes installed", "The Python environment (image jobs) and llama-server plus the model file (text jobs).", "A missing runtime turns that job type off; the node says which."],
  ["Another program on the GPU", "Any other process using more than 500 MB of VRAM. NVIDIA only (nvidia-smi).", "The node pauses and resumes on its own. The node list shows: paused, owner is using the GPU."],
  ["GPU temperature", "83 °C or hotter. NVIDIA only (nvidia-smi).", "The node pauses until it cools down. The node list shows: paused, GPU too hot."],
  ["Your hours", "The --hours ranges, in local time.", "Outside them the node waits. The node list shows: paused, outside chosen hours."],
];

const STATES: PublicNodeState[] = ["active", "paused-busy", "paused-hot", "paused-hours", "offline"];

export default function NodesPage() {
  return (
    <>
      <PageHeader
        title="Run a node"
        description={
          <>
            Watch the one-minute demo, then follow the steps for your system. NVIDIA GPUs take image and text jobs; AMD or
            Intel GPUs, iGPUs and CPUs take text jobs. No hourly rate, and no token needed.
          </>
        }
      />

      <section aria-labelledby="demo" className="mb-14 grid scroll-mt-24 gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <h2 id="demo" className="sr-only">
          How a node gets set up
        </h2>
        <div className="flex flex-col rounded-l border border-line bg-coal p-5">
          <p className="text-sm text-muted">At a glance</p>
          <p className="mt-3 inline-flex w-fit items-center gap-2 rounded-full bg-signal-soft px-3 py-1 text-sm text-signal">
            <span aria-hidden className="size-1.5 rounded-full bg-signal" />
            Paid per epoch, claim with a proof
          </p>
          <dl className="mt-4 divide-y divide-line">
            {(
              [
                ["GPU", "NVIDIA RTX 30-series or newer for image and text jobs. AMD or Intel GPU, iGPU or CPU for text jobs."],
                ["System", "Windows 10/11 or Ubuntu 24.04+"],
                ["Hold", "Nothing. No token, no stake, no deposit."],
                ["Paid", feesToTeamWallet ? "From customers' payments for verified jobs. No hourly rate." : "From trading fees that actually arrived. No hourly rate."],
                ["Rule", "One wallet per GPU. Two nodes run every job."],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex gap-3 py-3">
                <span aria-hidden className="mt-1 text-signal">✓</span>
                <div>
                  <dt className="text-xs text-faint">{k}</dt>
                  <dd className="mt-0.5 text-sm text-text">{v}</dd>
                </div>
              </div>
            ))}
          </dl>
          <a
            href="#install"
            className="mt-auto inline-flex h-11 items-center justify-center rounded-m bg-signal text-sm font-medium text-signal-ink transition-colors hover:bg-[#19d41e]"
          >
            Set up your node
          </a>
        </div>
        <figure className="order-first overflow-hidden rounded-l border border-line bg-coal lg:order-none">
          <DemoVideo />
          <figcaption className="border-t border-line px-5 py-3.5 text-sm text-muted">
            Watch it once: from install to checked jobs in about a minute. Real output from a Ryzen 7 5700U laptop (Radeon
            iGPU, Vulkan) during the Robinhood Chain testnet run, 20 November 2026. No sound.
          </figcaption>
        </figure>
      </section>

      <section aria-labelledby="install">
        <SectionTitle
          id="install"
          title="Set up your node"
          description="Pick your system and hardware. The steps, downloads and commands below follow the choice. Everything installs inside the sparecycle-node folder; the node runs on your computer, not in a cloud we operate."
        />
        <SetupGuide />
      </section>

      <section aria-labelledby="checks" className="mt-14">
        <SectionTitle
          id="checks"
          title="What the client checks on your machine"
          description="Checks, not performance figures. Nothing here ranks nodes or predicts what a node is paid."
        />
        <div className="rounded-l border border-line">
          <TableBox label="Hardware checks" minWidth={720}>
            <thead>
              <tr>
                <th className={th}>Check</th>
                <th className={th}>What it looks at</th>
                <th className={th}>Effect</th>
              </tr>
            </thead>
            <tbody>
              {CHECKS.map(([a, b, c]) => (
                <tr key={a}>
                  <td className={`${td} font-medium text-text`}>{a}</td>
                  <td className={`${td} text-muted`}>{b}</td>
                  <td className={`${td} text-muted`}>{c}</td>
                </tr>
              ))}
            </tbody>
          </TableBox>
        </div>
      </section>

      <section aria-labelledby="idle-guard" className="mt-14">
        <SectionTitle
          id="idle-guard"
          title="Idle Guard: why a node is resting"
          description={
            <>
              Node client 0.4.0 and later tell the scheduler when they pause and why, so a resting node is not mistaken for a
              switched-off one. A paused node gets no jobs. Only the state is sent: no temperature, no VRAM figure, no
              process names, no process IDs. The list shows the reason, not when the pause began.
            </>
          }
        />
        <dl className="mb-5 divide-y divide-line rounded-l border border-line bg-coal">
          {STATES.map((s) => (
            <div key={s} className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-6">
              <dt className="shrink-0 sm:w-64">
                <StatusTag tone={NODE_STATE_TONE[s]}>{NODE_STATE_LABEL[s]}</StatusTag>
              </dt>
              <dd className="text-sm leading-relaxed text-muted">{NODE_STATE_MEANING[s]}</dd>
            </div>
          ))}
        </dl>
        <p className="mb-5 text-sm leading-relaxed text-muted">
          AMD, Intel and CPU nodes show <span className="text-text">{IDLE_GUARD_HOURS_ONLY}</span>: there is no reliable
          cross-vendor reading of temperature or other programs&apos; VRAM, so they pause on <span className="num text-text">--hours</span>{" "}
          only. Older clients still work; they show active or offline, as before.
        </p>
        <RegisteredNodesTable />
      </section>

      <div className="mt-14 grid gap-10 lg:grid-cols-2">
        <section aria-labelledby="how-checks">
          <SectionTitle id="how-checks" title="How jobs are checked" />
          <div className="space-y-4 text-sm leading-relaxed text-muted">
            <p>
              Every job runs on two nodes with different owner wallets and different GPUs. The scheduler compares the two
              results. If they agree, the job counts for the epoch. If they do not, neither node is paid for it.
            </p>
            <p>
              <span className="text-text">Images.</span> Both nodes render with the same seed. Two GPUs rarely produce
              bit-identical pixels, so the scheduler shrinks each image to a small grayscale fingerprint and accepts the pair
              when no more than <span className="num text-text">{IMAGE_MAX_BITS}</span> of its 64 bits differ.
            </p>
            <p>
              <span className="text-text">Text.</span> Both nodes decode greedily, so they should write nearly the same words.
              The scheduler ignores differences in whitespace and accepts the pair when the two texts are at least{" "}
              <span className="num text-text">{Math.round(TEXT_MIN_SIMILARITY * 100)}%</span> similar by edit distance.
            </p>
            <p>A check reduces bad results. It does not make the scheduler, which is centralized in this MVP, trustless.</p>
          </div>
        </section>
        <section aria-labelledby="how-paid">
          <SectionTitle id="how-paid" title="How and when payouts appear" />
          <div className="space-y-4 text-sm leading-relaxed text-muted">
            <p>
              Nothing is paid per hour or per job as it happens. When an epoch closes, the scheduler splits that epoch&apos;s
              on-chain pot across agreed jobs, pro rata by work units, floored, never above the pot; the rest rolls over. The two
              nodes on a job split its units equally, and shares are summed per owner wallet.
            </p>
            <p>
              The scheduler then posts the epoch&apos;s Merkle root to the reward contract. From that moment your owner wallet can
              claim its amount on the{" "}
              <Link href="/app/claim" className="link">
                claim page
              </Link>
              . Unclaimed amounts stay claimable.
            </p>
            <p>
              {feesToTeamWallet
                ? "The pot is 95% of what customers paid for verified jobs. A quiet period means a small pot, and an empty pot pays nothing."
                : paidJobsLive
                ? "The pot is the trading fees that actually arrived plus customers' payments for verified jobs. A quiet period means a small pot, and an empty pot pays nothing."
                : "The pot is only the trading fees that actually arrived. A quiet market means a small pot, and an empty pot pays nothing."}{" "}
              {FUNDING.noTopUp}
            </p>
            <LastEpochAverage />
          </div>
        </section>
      </div>
    </>
  );
}
