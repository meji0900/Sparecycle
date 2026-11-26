"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCS_LINKS, DOCS_NAV } from "@/lib/docs-nav";
import { cn } from "@/lib/utils";

/** Docs navigation from src/lib/docs-nav.ts: a sticky column on wide screens, a collapsible list on phones. */
export function DocsSidebar() {
  const pathname = usePathname();
  const current = DOCS_NAV.flatMap((s) => s.items).find((i) => i.href === pathname);

  const list = (
    <div className="space-y-6">
      {DOCS_NAV.map((section) => (
        <div key={section.title}>
          <p className="px-3 text-xs text-faint">{section.title}</p>
          <ul className="mt-1.5 space-y-0.5">
            {section.items.map((item) => {
              const active = item.href === pathname;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-m px-3 py-1.5 text-sm transition-colors duration-150",
                      active ? "bg-white/[0.05] text-text" : "text-muted hover:text-text",
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div>
        <p className="px-3 text-xs text-faint">More</p>
        <ul className="mt-1.5 space-y-0.5 text-sm">
          <li>
            <Link href={DOCS_LINKS.models} className="block rounded-m px-3 py-1.5 text-muted hover:text-text">
              Models and prices
            </Link>
          </li>
          <li>
            <Link href={DOCS_LINKS.changelog} className="block rounded-m px-3 py-1.5 text-muted hover:text-text">
              Changelog
            </Link>
          </li>
          <li>
            <Link href={DOCS_LINKS.roadmap} className="block rounded-m px-3 py-1.5 text-muted hover:text-text">
              Roadmap
            </Link>
          </li>
          <li>
            <a href={DOCS_LINKS.openapi} className="block rounded-m px-3 py-1.5 text-muted hover:text-text">
              OpenAPI (JSON)
            </a>
          </li>
        </ul>
      </div>
    </div>
  );

  return (
    <nav aria-label="Docs">
      <details className="group rounded-l border border-line lg:hidden">
        <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 text-sm text-text">
          <span>
            <span className="text-faint">Docs · </span>
            {current?.title ?? "Contents"}
          </span>
          <span aria-hidden className="text-faint transition-transform duration-150 group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="border-t border-line px-1 py-4">{list}</div>
      </details>
      <div className="hidden lg:sticky lg:top-24 lg:block">{list}</div>
    </nav>
  );
}
