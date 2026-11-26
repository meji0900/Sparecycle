import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { PageHeader } from "@/components/dapp/app-shell";
import { Panel, SectionTitle, TableBox, TableMessage, td, th } from "@/components/dapp/ui";
import { Notice, StatusTag } from "@/components/ui/status";
import { NOT_LIVE_YET } from "@/lib/addresses";
import { serverEnv } from "@/server/env";
import { loadHolderPage, type Figure, type Section, type Source, type Table } from "@/server/holder-page";

// The holder page (brief §7, docs/token-features.md). Behind TOKEN_HOLDER_PAGE: off (the default) = 404, and nothing
// links here. It renders src/server/holder-page.ts only: every figure and every row carries its on-chain source, and this
// file formats no number of its own (src/server/holder-page.test.ts checks both).

export const metadata: Metadata = {
  title: "Holders",
  description: "SPARE burned, distributed to holders and staked by node owners, read from the chain, each figure with its proof link.",
};

export const dynamic = "force-dynamic";

function SourceLink({ source }: { source: Source }) {
  const external = /^https?:\/\//.test(source.href);
  return (
    <a
      href={source.href}
      className="inline-flex items-center gap-1 text-xs text-faint underline decoration-line-strong underline-offset-4 transition-colors hover:text-muted hover:decoration-current"
      {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
    >
      {source.label}
      <ArrowUpRight aria-hidden className="size-3 shrink-0" />
    </a>
  );
}

function NotLiveValue() {
  return <span className="num text-[15px] text-amber">{NOT_LIVE_YET}</span>;
}

/** One figure: its value and its source, or the NOT LIVE YET placeholder and why. */
function FigureCell({ figure }: { figure: Figure }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 bg-coal px-5 py-4">
      <dt className="text-sm text-muted">{figure.label}</dt>
      {figure.kind === "value" ? (
        <>
          <dd className="min-w-0 text-[15px] break-words text-text">
            <span className="num text-lg">{figure.value}</span>
            {figure.unit ? <span className="ml-1.5 text-sm text-muted">{figure.unit}</span> : null}
          </dd>
          {figure.note ? <dd className="text-xs leading-relaxed text-faint">{figure.note}</dd> : null}
          <dd>
            <SourceLink source={figure.source} />
          </dd>
        </>
      ) : (
        <>
          <dd>
            <NotLiveValue />
          </dd>
          <dd className="text-xs leading-relaxed text-faint">{figure.why}</dd>
        </>
      )}
    </div>
  );
}

/**
 * Hairline grid of figures. The lines come from each cell's 1px shadow (as in Facts, src/components/dapp/ui.tsx), so a
 * short last row leaves plain background instead of a grey block.
 */
function FigureGrid({ cols, children }: { cols: 2 | 3; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-l border border-line bg-coal">
      <dl className={`grid gap-px [&>*]:shadow-[0_0_0_1px_#1f1f1f] sm:grid-cols-2 ${cols === 3 ? "lg:grid-cols-3" : ""}`}>{children}</dl>
    </div>
  );
}

function RowsTable({ table }: { table: Table }) {
  const cols = table.columns.length + 1;
  return (
    <Panel title={table.label} className="mt-3">
      <TableBox label={table.label} minWidth={640}>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c} className={th}>
                {c}
              </th>
            ))}
            <th className={th}>Proof</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 ? (
            <TableMessage colSpan={cols}>{table.empty}</TableMessage>
          ) : (
            table.rows.map((r, i) => (
              <tr key={`${r.source.href}-${i}`}>
                {r.cells.map((c, j) => (
                  <td key={j} className={`${td} ${j === 0 ? "num text-text" : "text-muted"}`}>
                    {c}
                  </td>
                ))}
                <td className={td}>
                  <SourceLink source={r.source} />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </TableBox>
    </Panel>
  );
}

function SectionBlock({ section }: { section: Section }) {
  return (
    <section aria-labelledby={section.id} className="mt-12">
      <SectionTitle
        id={section.id}
        title={section.title}
        description={section.description}
        aside={section.live ? <StatusTag tone="live">Read live</StatusTag> : <StatusTag tone="warn">Not live yet</StatusTag>}
      />
      <FigureGrid cols={3}>
        {section.figures.map((f) => (
          <FigureCell key={f.label} figure={f} />
        ))}
      </FigureGrid>
      {section.tables.map((t) => (
        <RowsTable key={t.label} table={t} />
      ))}
    </section>
  );
}

export default async function HoldersPage() {
  if (!serverEnv.tokenHolderPage()) notFound();
  const m = await loadHolderPage();
  const [burned, distributed, staked, rules] = m.sections;

  return (
    <>
      <PageHeader
        art="/art/banner-token.webp"
        title="Holders"
        description={
          <>
            What happens to SPARE, read from the chain: burned, distributed to holders and staked by node owners. Every figure
            links to the transaction or contract read it comes from. No price, no forecast.
          </>
        }
        aside={
          <div className="flex flex-col items-start gap-1.5 sm:items-end">
            {m.block ? (
              <a href={m.block.href} target="_blank" rel="noreferrer" className="no-underline">
                <StatusTag tone="live">
                  Block <span className="num">{m.block.number}</span>
                </StatusTag>
              </a>
            ) : (
              <StatusTag tone="error">RPC unreachable</StatusTag>
            )}
            <span className="text-xs text-faint">
              Last read at <span className="num">{m.readAtText}</span>
            </span>
          </div>
        }
      />

      <div className="space-y-3">
        <Notice tone="warn" title="Token features are not live">
          Burns, holder distributions and node staking stay off until a legal review, external audits of the new contracts
          and the split of the treasury Safe&apos;s keys across different people are done. Until a contract is deployed, its
          part of this page shows <span className="num text-text">{NOT_LIVE_YET}</span>, never a zero or a sample number.
        </Notice>
        {m.readError ? (
          <Notice tone="error" title="Could not read the chain">
            {m.readError}
          </Notice>
        ) : null}
      </div>

      {[burned, distributed, staked].map((s) => (
        <SectionBlock key={s.id} section={s} />
      ))}

      <section aria-labelledby={rules.id} className="mt-12">
        <SectionTitle
          id={rules.id}
          title={rules.title}
          description={rules.description}
          aside={rules.live ? <StatusTag tone="live">Read live</StatusTag> : <StatusTag tone="warn">Not live yet</StatusTag>}
        />
        <FigureGrid cols={2}>
          {rules.figures.map((f) => (
            <FigureCell key={f.label} figure={f} />
          ))}
        </FigureGrid>

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <Panel title="Excluded from holder weights" footer={m.contractRule}>
            <ul className="divide-y divide-line">
              {m.exclusions.map((e) => (
                <li key={e.label} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                  <div className="min-w-0">
                    <p className="text-sm text-text">{e.label}</p>
                    <p className="text-xs leading-relaxed text-faint">{e.why}</p>
                  </div>
                  {e.address ? (
                    <a
                      href={e.href}
                      target="_blank"
                      rel="noreferrer"
                      className="num shrink-0 text-xs text-muted underline decoration-line-strong underline-offset-4 hover:text-text"
                      title={e.address}
                    >
                      {e.address.slice(0, 8)}…{e.address.slice(-6)}
                    </a>
                  ) : (
                    <span className="num shrink-0 text-xs text-amber">{e.notLive}</span>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="How a holder share is chosen">
            <ul className="space-y-3 px-5 py-4 text-sm leading-relaxed text-muted">
              {m.modeRule.map((line) => (
                <li key={line} className="flex gap-2.5">
                  <span aria-hidden className="mt-[9px] size-1 shrink-0 rounded-full bg-line-strong" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </section>
    </>
  );
}
