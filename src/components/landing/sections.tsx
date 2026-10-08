import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { CodeBlock } from "@/components/ui/code-block";
import { FeatureBento } from "./feature-bento";
import { config, tickerLabel } from "@/lib/config";
import { EM_DASH, formatAmount, formatBps, formatInt } from "@/lib/format";
import { chainSnapshot } from "@/lib/onchain";
import { PONS_DOCS_URL } from "@/lib/pons";
import { cn } from "@/lib/utils";
import { FUNDING } from "@/lib/funding-copy";

function Section({
  id,
  title,
  intro,
  children,
  className,
  art,
}: {
  id: string;
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Flow-made maquette illustration shown under the heading on wide screens (decoration only). */
  art?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("scroll-mt-20 border-b border-line", className)}>
      <div className="mx-auto grid max-w-[1200px] gap-10 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
        <div className="max-w-[440px]">
          <div className="lg:sticky lg:top-24">
            <h2 id={`${id}-title`} className="text-title font-semibold text-text">
              {title}
            </h2>
            {intro ? <div className="mt-4 text-muted">{intro}</div> : null}
            {art ? (
              <div aria-hidden className="relative mt-10 hidden aspect-[4/3] w-full lg:block">
                <Image
                  src={art}
                  alt=""
                  fill
                  sizes="420px"
                  className="object-cover object-[70%_50%] [mask-image:radial-gradient(50%_50%_at_50%_50%,black_35%,transparent_100%)]"
                />
              </div>
            ) : null}
          </div>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

/* ---------- What the MVP includes ---------- */
export function Features() {
  return (
    <section id="features" aria-labelledby="features-title" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <h2 id="features-title" className="text-title font-semibold text-text">
            What the MVP includes
          </h2>
          <p className="max-w-[380px] text-muted">Small on purpose. Each item is something you can check.</p>
        </div>
        <div className="mt-10">
          <FeatureBento />
        </div>
      </div>
    </section>
  );
}

/* ---------- Where the money comes from ---------- */
const FLOW = [
  "A trader pays the standard Pons fee on the quote asset, plus any creator tax fixed at launch. The tax cannot be raised later.",
  "Pons takes its share of the standard fee first. With buybacks off, the rest of that fee, plus the entire creator tax, is the creator share.",
  "That share stays on the curve or the hook until someone sweeps it into the Pons fee escrow.",
  "The reward contract, set as creatorFeeRecipient if that path works, otherwise funded by a multisig that claims and forwards, pulls the escrow balance into the current epoch pot.",
  "The scheduler may assign payouts only for jobs that passed the two-node check, and only up to the pot. It then posts a Merkle root. Nodes claim. The remainder rolls over.",
];

export function Mechanics() {
  return (
    <Section
      id="fees"
      title="Where the money comes from"
      intro="One trade, followed all the way to a node. Rates are read live from the token's curve once it exists; none are promised here."
    >
      {/* schematic of one trade's fee; widths are not to scale and carry no rate */}
      <figure className="rounded-l border border-line p-5">
        <figcaption className="text-sm text-muted">What a trader pays, split by who receives it (schematic, not to scale)</figcaption>
        <div className="mt-4 flex h-10 w-full overflow-hidden rounded-s border border-line text-xs">
          <div className="flex basis-[30%] items-center justify-center bg-slate px-2 text-muted">Pons share</div>
          <div className="flex basis-[45%] items-center justify-center border-l border-line bg-signal-soft px-2 text-text">
            Rest of the standard fee
          </div>
          <div className="flex basis-[25%] items-center justify-center border-l border-dashed border-line-strong px-2 text-muted">
            Creator tax, if set
          </div>
        </div>
        <div className="mt-2 flex text-xs">
          <span className="basis-[30%] text-faint">Kept by Pons</span>
          <span className="basis-[70%] border-t border-signal/40 pt-1.5 text-text">
            Creator share: the only money that can reach the pot
          </span>
        </div>
      </figure>

      <ol className="mt-8 space-y-0 divide-y divide-line border-y border-line">
        {FLOW.map((t, i) => (
          <li key={i} className="grid grid-cols-[32px_1fr] gap-4 py-5">
            <span className="num pt-0.5 text-sm text-faint">{i + 1}</span>
            <p className="text-text">{t}</p>
          </li>
        ))}
      </ol>
      <p className="mt-8 text-muted">
        Sparecycle does not hold a discretionary team wallet that can refill the pot. If the claim from escrow returns
        nothing, the pot does not grow.
      </p>
    </Section>
  );
}

/* ---------- Run a node ---------- */
export function RunANode() {
  const payout = config.nodePayoutAsset ?? "[NODE_PAYOUT_ASSET]";
  const siteUrl = config.domain ? `https://${config.domain.replace(/^https?:\/\//, "")}` : process.env.NEXT_PUBLIC_APP_URL ?? "<SCHEDULER_URL>";
  return (
    <Section id="run-a-node" title="Run a node" art="/art/banner-nodes.webp" intro={<Link href="/nodes" className="link">Read the install guide</Link>}>
      <ul className="divide-y divide-line border-y border-line">
        {[
          <>
            You need an NVIDIA GPU (RTX 30-series or newer is the testing baseline), the install script for your OS, and a
            wallet that can receive <span className="num text-text">{payout}</span> on Robinhood Chain.
          </>,
          <>
            Install from the <Link href="/nodes" className="link">/nodes guide</Link>. The scripts are rebranded from an
            MIT-licensed starting point; they are not a hosted cloud image we operate for you.
          </>,
          "The node pulls jobs from the scheduler, runs the allowed models, and submits a result. A second node runs the same job. Agreement is required for payment eligibility.",
          "Payment, if any, shows up as a Merkle claim after the epoch closes. There is no hourly wage and no advertised rate of return.",
          "You do not need to hold the token.",
        ].map((t, i) => (
          <li key={i} className="py-5 text-muted">
            {t}
          </li>
        ))}
      </ul>
      <div className="mt-8 grid gap-3">
        <CodeBlock
          label="1. Install (from the node-client folder)"
          code={"bash install.sh                                        # Ubuntu 24.04+\npowershell -ExecutionPolicy Bypass -File install.ps1   # Windows 10/11"}
        />
        <CodeBlock
          label="2. Link your payout wallet once (a signature, no gas)"
          code="node src/agent.ts link-message --owner 0xYOUR_WALLET"
        />
        <CodeBlock
          label="3. Start, only in the hours your GPU is idle"
          code={`node src/agent.ts start --network ${siteUrl} \\\n  --owner 0xYOUR_WALLET --owner-sig 0xSIGNATURE --hours 1-8`}
        />
      </div>
    </Section>
  );
}

/* ---------- The token, stated plainly ---------- */
const TOKEN_FACTS = [
  "The token is created on Pons v2 in a single launchToken transaction. Until that transaction confirms, there is no token address. Always check the address when it exists.",
  "The entire supply is minted to the bonding curve. The creator receives no reserved allocation.",
  "If the curve sells out, Pons graduates the launch into a Uniswap v4 pool with a Pons hook. Liquidity is permanently locked by Pons. Sparecycle does not provide or unlock LP of its own.",
  "Creator trading fees fund the job pot. Buybacks are off. This is not a reason the token should go up, and it is not a yield on holding.",
  "An optional creator tax, if set, is fixed at launch and cannot be raised. The live rates belong on the token page as reads from the curve, not as slogans.",
  `Pons v2 was still unaudited as of ${config.factsCheckedOn}. The token can lose all of its value.`,
];

export async function TokenSection() {
  const snap = await chainSnapshot();
  const pons = snap.pons.ok ? snap.pons.data : null;
  const rows: [string, ReactNode][] = pons
    ? [
        ["Launch fee", <span key="a" className="num">{formatAmount(BigInt(pons.launchFee), 18)} ETH</span>],
        ["Creator tax cap", <span key="b" className="num">{formatBps(Number(pons.maxCreatorTaxBps))}</span>],
        [`Supply, config ${pons.launchConfigId}`, <span key="c" className="num">{formatAmount(BigInt(pons.config.supply), 18, 0)}</span>],
        [`Standard fee, config ${pons.launchConfigId}`, <span key="d" className="num">{formatBps(Number(pons.config.curveFeeBps))}</span>],
        [`Graduation threshold, config ${pons.launchConfigId}`, <span key="e" className="num">{formatAmount(BigInt(pons.config.graduationThreshold), 18)} ETH</span>],
        ["Launches enabled", <span key="f">{pons.launchEnabled ? "Yes" : "No"}</span>],
      ]
    : [];

  return (
    <Section
      id="token"
      title="The token, stated plainly"
      art="/art/banner-token.webp"
      intro={
        <>
          Ticker <span className="num text-text">{tickerLabel()}</span> is set at
          launch. <Link href="/token" className="link">Token page</Link>
        </>
      }
    >
      <ul className="divide-y divide-line border-y border-line">
        {TOKEN_FACTS.map((t) => (
          <li key={t} className="py-5 text-muted">
            {t}
          </li>
        ))}
      </ul>

      <div className="mt-10 rounded-l border border-line">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-4">
          <p className="font-medium text-text">Pons v2 factory, read live</p>
          <p className="text-xs text-faint">
            {snap.network.ok ? (
              <>
                Block <span className="num">{formatInt(BigInt(snap.network.data.blockNumber))}</span>, Robinhood Chain
              </>
            ) : (
              "Chain unreachable"
            )}
          </p>
        </div>
        {pons ? (
          <dl className="grid sm:grid-cols-2">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 border-b border-line px-5 py-3 sm:odd:border-r">
                <dt className="text-sm text-muted">{k}</dt>
                <dd className="text-sm text-text">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="px-5 py-4 text-sm text-muted">
            {EM_DASH} Could not read the Pons factory right now. Nothing is shown rather than a stale number.
          </p>
        )}
        <p className="px-5 py-4 text-xs text-faint">
          Factory parameters can be changed by the Pons owner. Re-read them immediately before any launch. Source:{" "}
          <a href={PONS_DOCS_URL} className="link" target="_blank" rel="noreferrer">
            Pons v2 docs
          </a>
          .
        </p>
      </div>
    </Section>
  );
}

/* ---------- Roadmap ---------- */
const ROADMAP = [
  [
    "Now",
    "Landing page, status page, claim page, node install guide, limited job submit. Reward contract and tests. Scheduler and node client adapted from the MIT prototype, rebranded.",
  ],
  [
    "Launch, only after checks",
    "canLaunch on the launching wallet, live fee and config reads, a working claim path into the pot (contract recipient tested, or multisig fallback).",
  ],
  ["MVP models", "Stable Diffusion 1.5 and one small text model. Two-node checks. Pay in the chosen payout asset."],
  ["Later, only if the pot actually supports it", "More models or a less centralized scheduler. Not promised. No global GPU fabric phase."],
] as const;

export function Roadmap() {
  return (
    <Section id="roadmap" title="Roadmap">
      <ol className="relative border-l border-line">
        {ROADMAP.map(([t, d], i) => (
          <li key={t} className="relative pb-10 pl-8 last:pb-0">
            <span
              aria-hidden
              className={cn(
                "absolute top-1.5 -left-[5px] size-[9px] rounded-full border",
                i === 0 ? "border-signal bg-signal" : "border-line-strong bg-coal",
              )}
            />
            <p className="font-medium text-text">
              {t}
              {i === 0 ? <span className="sr-only"> (current phase)</span> : null}
            </p>
            <p className="mt-2 max-w-[62ch] text-muted">{d}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* ---------- FAQ ---------- */
const FAQ: [string, string][] = [
  ["Is this a yield product?", "No. Nodes may receive a payout if fees were collected and their jobs passed a check. There is no fixed return, no APY, and no payment for simply holding the token."],
  ["Where does the money come from?", "From creator trading fees on the Pons v2 token, after the protocol share, with buybacks off. If nobody trades, the pot does not fill."],
  ["Do you top up rewards?", "No. The contract is specified without a team withdrawal or refill function for the pot."],
  ["Do I have to hold the token to run a node?", "No."],
  ["What jobs can I submit?", "In the MVP, only the listed models, with a rate limit. This is not an open marketplace and not a general-purpose GPU cloud."],
  ["Who locks the liquidity?", "Pons, at graduation, in its launch locker. We do not hold a Sparecycle LP we can pull."],
  ["Does the creator get a token allocation?", "No. Supply is minted to the curve."],
  ["Is Pons audited?", `As of ${config.factsCheckedOn}, official docs said reviews were in progress and that v2 should be treated as unaudited until reports are published.`],
  ["Is the scheduler decentralized?", "Not in the MVP. A single scheduler closes epochs and posts the Merkle root. That is a trust assumption, and it is disclosed on the status page."],
  ["Is this financial advice?", "No."],
];

export function Faq() {
  return (
    <Section id="faq" title="FAQ">
      <div className="divide-y divide-line border-y border-line">
        {FAQ.map(([q, a]) => (
          <details key={q} className="group">
            <summary className="flex cursor-pointer items-center justify-between gap-6 py-5 text-text">
              <span className="font-medium">{q}</span>
              <span aria-hidden className="relative size-3 shrink-0">
                <span className="absolute inset-x-0 top-1/2 h-px bg-muted" />
                <span className="absolute inset-y-0 left-1/2 w-px bg-muted transition-transform duration-200 group-open:scale-y-0" />
              </span>
            </summary>
            <p className="max-w-[64ch] pb-6 text-muted">{a}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}

/* ---------- Limits and disclosures ---------- */
export function Disclosures() {
  const items = [
    "Not financial, legal, or tax advice.",
    FUNDING.disclosureItem,
    `${FUNDING.noTopUp} No team token allocation: the supply is minted to the Pons curve.`,
    "The token can go to zero. The LP lock at graduation is Pons's mechanism, not a price floor.",
    `Pons v2 was unaudited as of ${config.factsCheckedOn}: reviews by SB Security, Dingbats and Pashov Audit Group were in progress, none closed.`,
    "The scheduler is centralized in this MVP. The operator that posts the Merkle root can err or misbehave. Cross-checking reduces bad results; it does not make root posting trustless.",
    "The reward contract as creatorFeeRecipient has been exercised only on a local fork of Robinhood Chain mainnet (a throwaway launch, a buy, a Pons operator sweep, then a claim into the pot). It has not been tried on live mainnet. A multisig that claims and forwards is the fallback.",
    "Once the reward contract is the fee recipient it cannot redirect fees elsewhere, by design. While an epoch is open, the contract owner could replace the scheduler; settled epochs cannot be touched.",
  ];
  return (
    <section id="disclosures" aria-labelledby="disclosures-title" className="scroll-mt-20 border-b border-line">
      <div className="mx-auto max-w-[1200px] px-4 py-20 sm:px-6">
        <div className="rounded-l border border-amber/25 bg-amber-soft/40 p-6 sm:p-10">
          <h2 id="disclosures-title" className="text-title font-semibold text-text">
            Limits and disclosures
          </h2>
          <ul className="mt-8 grid gap-x-12 gap-y-5 text-[15px] leading-relaxed text-text/90 md:grid-cols-2">
            {items.map((t) => (
              <li key={t} className="flex gap-3">
                <span aria-hidden className="mt-2.5 h-px w-3 shrink-0 bg-amber" />
                <span>{t}</span>
              </li>
            ))}
          </ul>
          <p className="mt-8 text-sm text-muted">
            Sparecycle is not affiliated with or endorsed by Pons. Read the{" "}
            <a href={PONS_DOCS_URL} className="link" target="_blank" rel="noreferrer">
              official Pons v2 docs
            </a>{" "}
            and the full <Link href="/legal/disclosures" className="link">disclosures</Link>.
          </p>
        </div>
      </div>
    </section>
  );
}
