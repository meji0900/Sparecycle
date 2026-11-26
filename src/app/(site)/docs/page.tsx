import type { Metadata } from "next";
import Link from "next/link";
import { DocsHeader, DocsSection, Ext } from "@/components/docs/docs-ui";
import { ADDR, explorerAddressUrl } from "@/lib/addresses";
import { DOCS_LINKS, DOCS_NAV } from "@/lib/docs-nav";
import { REPO_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Copy-paste guides for running a job and running a node on Sparecycle, plus the API, contract addresses and billing.",
};

const PATHS = [
  {
    href: "/docs/first-job",
    title: "Run your first job",
    body: "Free trial or prepaid balance, the playground, job status and your private result. Includes the curl version.",
  },
  {
    href: "/docs/run-a-node",
    title: "Run a node",
    body: "Download and check the node client, install it, link your wallet and see your node online. Linux and Windows.",
  },
];

export default function DocsIndex() {
  return (
    <>
      <DocsHeader title="Docs">
        <p>
          Two guides you can follow by copy and paste, and the reference behind them. When a feature ships, these pages change
          the same day and the <Link href={DOCS_LINKS.changelog} className="link">changelog</Link> says what changed.
        </p>
      </DocsHeader>

      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {PATHS.map((p) => (
          <Link key={p.href} href={p.href} className="group rounded-l border border-line p-5 transition-colors hover:border-line-strong">
            <p className="font-medium text-text">
              {p.title} <span aria-hidden className="text-faint">→</span>
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted">{p.body}</p>
          </Link>
        ))}
      </div>

      {DOCS_NAV.filter((s) => s.title !== "Get started").map((section) => (
        <DocsSection key={section.title} id={section.title.toLowerCase().replace(/\s+/g, "-")} title={section.title}>
          <ul className="divide-y divide-line rounded-l border border-line">
            {section.items.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="block px-4 py-3 transition-colors hover:bg-white/[0.02]">
                  <span className="text-sm font-medium text-text">{item.title}</span>
                  <span className="mt-0.5 block text-sm text-muted">{item.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </DocsSection>
      ))}

      <DocsSection id="sources" title="Machine-readable and on-chain">
        <ul className="divide-y divide-line rounded-l border border-line text-sm">
          {(
            [
              [DOCS_LINKS.openapi, "API description (OpenAPI 3.1, JSON)", false],
              [DOCS_LINKS.feed, "Changelog feed (RSS)", false],
              [explorerAddressUrl(ADDR.rewards), "SparecycleRewards on Blockscout", true],
              [explorerAddressUrl(ADDR.payments), "SparecycleJobPayments on Blockscout", true],
              [REPO_URL, "Source code on GitHub (MIT)", true],
            ] as const
          ).map(([href, label, external]) => (
            <li key={href} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3">
              {external ? (
                <Ext href={href}>{label}</Ext>
              ) : (
                <a href={href} className="link">
                  {label}
                </a>
              )}
              <span className="num min-w-0 truncate text-xs text-faint">{href.replace(/^https:\/\//, "")}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm">
          Every address with its verification status is on <Link href="/docs/contracts" className="link">Contracts and keys</Link>.
          What is being worked on, without dates, is on the <Link href={DOCS_LINKS.roadmap} className="link">roadmap</Link>.
        </p>
      </DocsSection>
    </>
  );
}
