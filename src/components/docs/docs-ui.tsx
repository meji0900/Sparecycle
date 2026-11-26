import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Page title and lead of a docs page. */
export function DocsHeader({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return (
    <header className="border-b border-line pb-8">
      {eyebrow ? <p className="text-sm text-faint">{eyebrow}</p> : null}
      <h1 className="mt-1 text-title font-semibold text-text">{title}</h1>
      {children ? <div className="mt-4 max-w-[64ch] space-y-3 text-[15px] leading-relaxed text-muted">{children}</div> : null}
    </header>
  );
}

/** A section with an anchor (#id) so it can be linked. */
export function DocsSection({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("scroll-mt-24 pt-10", className)}>
      <h2 id={`${id}-title`} className="text-xl font-semibold tracking-[-0.015em] text-text">
        <a href={`#${id}`} className="hover:underline hover:decoration-line-strong hover:underline-offset-4">
          {title}
        </a>
      </h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

/** Numbered steps (an ordered list; the numbers are drawn, the list semantics stay). */
export function Steps({ children }: { children: ReactNode }) {
  return <ol className="mt-2 space-y-0">{children}</ol>;
}

export function Step({ n, title, children }: { n: number; title: ReactNode; children: ReactNode }) {
  return (
    <li className="relative border-l border-line pb-8 pl-8 last:border-l-transparent last:pb-0">
      <span
        aria-hidden
        className="num absolute top-0 -left-3 grid size-6 place-items-center rounded-s border border-line-strong bg-coal text-xs text-muted"
      >
        {n}
      </span>
      <h3 className="font-medium text-text">
        <span className="sr-only">Step {n}: </span>
        {title}
      </h3>
      <div className="mt-3 min-w-0 space-y-3 text-[15px] leading-relaxed text-muted">{children}</div>
    </li>
  );
}

/** Inline code. */
export const C = ({ children }: { children: ReactNode }) => (
  <code className="num rounded-s border border-line bg-white/[0.03] px-1 py-px text-[0.9em] text-text">{children}</code>
);

/** A plain note in the flow of the text: neutral or a warning, shape + word, never colour alone. */
export function Note({ tone = "neutral", title, children }: { tone?: "neutral" | "warn"; title?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-m border px-4 py-3 text-sm leading-relaxed",
        tone === "warn" ? "border-amber/30 bg-amber-soft text-text/90" : "border-line bg-graphite text-muted",
      )}
    >
      {title ? <p className={cn("font-medium", tone === "warn" ? "text-amber" : "text-text")}>{title}</p> : null}
      <div className={cn(title && "mt-1", "space-y-2")}>{children}</div>
    </div>
  );
}

/** Label / value rows (definitions). */
export function Defs({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="divide-y divide-line rounded-l border border-line">
      {items.map(([k, v], i) => (
        <div key={i} className="grid gap-1 px-4 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
          <dt className="text-sm text-text">{k}</dt>
          <dd className="min-w-0 text-sm leading-relaxed text-muted">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "Next" links at the bottom of a page. */
export function DocsNext({ links }: { links: { href: string; title: string; description?: string }[] }) {
  return (
    <nav aria-label="Next" className="mt-14 grid gap-3 border-t border-line pt-8 sm:grid-cols-2">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="group rounded-l border border-line p-4 transition-colors hover:border-line-strong">
          <p className="text-sm font-medium text-text">
            {l.title} <span aria-hidden className="text-faint transition-transform group-hover:translate-x-0.5">→</span>
          </p>
          {l.description ? <p className="mt-1 text-sm text-muted">{l.description}</p> : null}
        </Link>
      ))}
    </nav>
  );
}

/** External link that opens in a new tab. */
export function Ext({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={cn("link", className)}>
      {children}
    </a>
  );
}
