import type { ReactNode } from "react";
import { CodeBlock } from "@/components/ui/code-block";

// Shell of the API docs pages (/docs/api/keys, /docs/api/openai, /docs/api/mcp) inside the site layout. Standalone: the
// /docs layout and its nav can wrap these pages later without changes here.

export type ApiDocId = "keys" | "openai" | "mcp";

export function ApiDocPage({ title, lead, current, children }: { title: string; lead: ReactNode; current: ApiDocId; children: ReactNode }) {
  // The /docs layout (src/app/(site)/docs/layout.tsx) supplies the page frame and the sidebar (src/lib/docs-nav.ts).
  return (
    <div data-api-doc={current}>
      <h1 className="text-title font-semibold text-text">{title}</h1>
      <div className="mt-4 text-[15px] leading-relaxed text-muted">{lead}</div>
      <div className="mt-10 space-y-12">{children}</div>
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
