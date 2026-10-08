import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Shell for the legal pages in the site layout: narrow column, h1, status line, related links. */
export function LegalPage({
  title,
  status,
  children,
  current,
}: {
  title: string;
  status: ReactNode;
  children: ReactNode;
  current: "terms" | "privacy" | "disclosures";
}) {
  const links = [
    { id: "disclosures", href: "/legal/disclosures", label: "Disclosures" },
    { id: "terms", href: "/legal/terms", label: "Terms" },
    { id: "privacy", href: "/legal/privacy", label: "Privacy" },
  ] as const;
  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-14 pb-24 sm:px-6 sm:pt-20">
      <div className="grid gap-12 lg:grid-cols-[200px_minmax(0,720px)]">
        <nav aria-label="Legal" className="order-last lg:order-none">
          <ul className="flex gap-1 lg:sticky lg:top-24 lg:flex-col">
            {links.map((l) => (
              <li key={l.id}>
                <Link
                  href={l.href}
                  aria-current={current === l.id ? "page" : undefined}
                  className={cn(
                    "block rounded-m px-3 py-2 text-sm transition-colors duration-150",
                    current === l.id ? "bg-white/[0.05] text-text" : "text-muted hover:text-text",
                  )}
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <article className="min-w-0">
          <h1 className="text-title font-semibold text-text">{title}</h1>
          <div className="mt-4 text-sm text-muted">{status}</div>
          <div className="mt-10 space-y-10">{children}</div>
        </article>
      </div>
    </div>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-[-0.01em] text-text">{title}</h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

/** Placeholder value shown literally until it is configured. */
export const Placeholder = ({ children }: { children: ReactNode }) => <span className="num text-text">{children}</span>;
