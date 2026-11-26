import Link from "next/link";
import type { ReactNode } from "react";
import { CodeBlock } from "@/components/ui/code-block";
import { cn } from "@/lib/utils";

// Shell of the API docs pages (/docs/api/keys, /docs/api/openai, /docs/api/mcp) inside the site layout. Standalone: the
// /docs layout and its nav can wrap these pages later without changes here.

const PAGES = [
  { id: "keys", href: "/docs/api/keys", label: "API keys" },
  { id: "openai", href: "/docs/api/openai", label: "OpenAI-compatible API" },
  { id: "mcp", href: "/docs/api/mcp", label: "MCP server" },
] as const;

export type ApiDocId = (typeof PAGES)[number]["id"];

export function ApiDocPage({ title, lead, current, children }: { title: string; lead: ReactNode; current: ApiDocId; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-14 pb-24 sm:px-6 sm:pt-20">
      <div className="grid gap-12 lg:grid-cols-[200px_minmax(0,760px)]">
        <nav aria-label="API docs" className="order-last lg:order-none">
          <ul className="flex flex-wrap gap-1 lg:sticky lg:top-24 lg:flex-col">
            {PAGES.map((p) => (
              <li key={p.id}>
                <Link
                  href={p.href}
                  aria-current={current === p.id ? "page" : undefined}
                  className={cn(
                    "block rounded-m px-3 py-2 text-sm transition-colors duration-150",
                    current === p.id ? "bg-white/[0.05] text-text" : "text-muted hover:text-text",
                  )}
                >
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <article className="min-w-0">
          <h1 className="text-title font-semibold text-text">{title}</h1>
          <div className="mt-4 text-[15px] leading-relaxed text-muted">{lead}</div>
          <div className="mt-10 space-y-12">{children}</div>
        </article>
      </div>
    </div>
  );
}

export function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-24 space-y-4">
      <h2 id={id} className="text-lg font-semibold tracking-[-0.01em] text-text">
        {title}
      </h2>
      <div className="space-y-4 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

/** Inline code. */
export const C = ({ children }: { children: ReactNode }) => <code className="num rounded-s bg-white/[0.05] px-1 py-0.5 text-[13px] text-text">{children}</code>;

export const Example = ({ label, code }: { label: string; code: string }) => <CodeBlock label={label} code={code} />;

/** A simple two-or-more column table. */
export function DocTable({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-m border border-line">
      <table className="w-full min-w-[560px] border-collapse text-left text-sm">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className="border-b border-line px-4 py-2.5 text-xs font-normal whitespace-nowrap text-faint">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j} className="border-b border-line px-4 py-2.5 align-top text-muted last:border-b-0">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Default, not yet confirmed" marker for a decision the project owner has not signed off. */
export const Unconfirmed = ({ id }: { id: string }) => (
  <span className="num ml-1 rounded-s border border-line px-1.5 py-0.5 text-[11px] text-faint">{id}: default, not yet confirmed</span>
);
