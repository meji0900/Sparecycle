"use client";

import { Activity, Coins, Cpu, ImagePlus, ListChecks, ShieldCheck, Wallet } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { Wordmark } from "@/components/brand/wordmark";
import { targetChain } from "@/lib/chain";
import { cn } from "@/lib/utils";
import { AppBackdrop } from "./app-backdrop";
import { WalletButton } from "./wallet-button";
import { FUNDING } from "@/lib/funding-copy";
import { XLink } from "@/components/brand/x-link";
import { CaChip } from "@/components/brand/ca-chip";

const NAV = [
  { href: "/app", label: "Status", icon: Activity, match: (p: string) => p === "/app" },
  { href: "/app/claim", label: "Claim", icon: Wallet, match: (p: string) => p.startsWith("/app/claim") },
  { href: "/jobs", label: "Jobs", icon: ListChecks, match: (p: string) => p.startsWith("/jobs") },
  { href: "/playground", label: "Playground", icon: ImagePlus, match: (p: string) => p.startsWith("/playground") },
  { href: "/nodes", label: "Run a node", icon: Cpu, match: (p: string) => p.startsWith("/nodes") },
  { href: "/token", label: "Token", icon: Coins, match: (p: string) => p.startsWith("/token") },
  { href: "/proof", label: "Proof", icon: ShieldCheck, match: (p: string) => p.startsWith("/proof") },
];

function NetworkBadge() {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      <span aria-hidden className="size-1.5 rounded-full bg-signal" />
      {targetChain.name} <span className="num text-faint">{targetChain.id}</span>
    </span>
  );
}

/** The two banners the brief requires on every dApp page. */
function Banners() {
  return (
    <div className="grid gap-px overflow-hidden rounded-m border border-line bg-line text-sm sm:grid-cols-2">
      <p className="flex items-start gap-2.5 bg-graphite px-4 py-2.5 text-muted">
        <span aria-hidden className="mt-[7px] size-1.5 shrink-0 rounded-full bg-signal" />
        <span>
          <span className="text-text">{FUNDING.bannerLead}</span> {FUNDING.bannerRest}
        </span>
      </p>
      <p className="flex items-start gap-2.5 bg-graphite px-4 py-2.5 text-muted">
        <span aria-hidden className="mt-[6px] size-0 shrink-0 border-x-[4px] border-b-[7px] border-x-transparent border-b-amber" />
        <span>
          <span className="text-text">A centralized scheduler posts the Merkle root for this MVP.</span>{" "}
          <Link href="/legal/disclosures" className="link">
            Read the disclosures
          </Link>
        </span>
      </p>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/app";
  // Next scrolls a new page's segment into view, which leaves the sticky top bar covering the banners and the
  // page title on phones. Start every app page at the very top unless the link targets an #anchor.
  useEffect(() => {
    if (!window.location.hash) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    // On phones the tab row scrolls sideways: keep the current tab visible (no-op for the hidden desktop rail).
    document.querySelector<HTMLElement>('#app-tabs a[aria-current="page"]')?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [pathname]);
  return (
    <div className="relative isolate min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <AppBackdrop />
      {/* Rail (desktop) */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-coal/85 lg:flex">
        <div className="flex h-16 items-center px-5">
          <Wordmark />
        </div>
        <nav aria-label="App" className="flex flex-col gap-0.5 px-3 pt-2">
          {NAV.map(({ href, label, icon: Icon, match }) => {
            const active = match(pathname);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-10 items-center gap-3 rounded-m px-3 text-sm transition-colors duration-150",
                  active ? "bg-white/[0.04] text-text" : "text-muted hover:bg-white/[0.02] hover:text-text",
                )}
              >
                {active ? <span aria-hidden className="absolute top-2 bottom-2 -left-3 w-[2px] rounded-r bg-signal" /> : null}
                <Icon className="size-4" strokeWidth={1.75} />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto border-t border-line px-5 py-5">
          <div className="flex flex-col gap-1.5 text-xs">
            <Link href="/" className="text-muted hover:text-text">Home</Link>
            <Link href="/legal/disclosures" className="text-muted hover:text-text">Disclosures</Link>
            <Link href="/legal/terms" className="text-muted hover:text-text">Terms</Link>
            <XLink withLabel className="mt-1 text-xs" />
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-40 border-b border-line bg-coal/95">
          <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
            <div className="lg:hidden">
              <Wordmark />
            </div>
            <div className="hidden lg:block">
              <NetworkBadge />
            </div>
            <div className="flex items-center gap-2">
              <CaChip className="hidden md:inline-flex" />
              <XLink />
              <WalletButton />
            </div>
          </div>
          {/* Tabs (phones and tablets) */}
          <nav id="app-tabs" aria-label="App" className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden">
            {NAV.map(({ href, label, match }) => {
              const active = match(pathname);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "shrink-0 rounded-m px-3 py-1.5 text-sm whitespace-nowrap",
                    active ? "bg-white/[0.06] text-text shadow-[inset_0_-2px_0_var(--signal)]" : "text-muted",
                  )}
                >
                  {label}
                </Link>
              );
            })}
          </nav>
        </header>

        <main id="main" className="app-surface mx-auto w-full max-w-[1240px] px-4 pt-6 pb-20 sm:px-6 lg:px-8">
          <Banners />
          <div className="mt-8">{children}</div>
        </main>
      </div>
    </div>
  );
}

/**
 * Standard page heading inside the app. With `art`, the heading sits in a band with a Flow-made maquette
 * illustration on the right that fades into the page (decoration only, empty alt).
 */
export function PageHeader({
  title,
  description,
  aside,
  art,
}: {
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  art?: string;
}) {
  if (!art) {
    return (
      <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="max-w-[680px]">
          <h1 className="text-title font-semibold text-text">{title}</h1>
          {description ? <div className="mt-3 text-muted">{description}</div> : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
    );
  }
  return (
    <div className="relative mb-8 overflow-hidden rounded-l border border-line bg-coal">
      <div aria-hidden className="absolute inset-x-0 top-0 h-[170px] sm:inset-y-0 sm:left-auto sm:h-auto sm:w-[64%]">
        <Image
          src={art}
          alt=""
          fill
          priority
          sizes="(min-width: 640px) 64vw, 100vw"
          className="object-cover object-[70%_50%] [mask-image:linear-gradient(180deg,black_55%,transparent_100%)] sm:object-center sm:[mask-image:linear-gradient(90deg,transparent_0%,black_38%)]"
        />
      </div>
      <div className="relative flex flex-col justify-end gap-4 p-6 pt-[150px] sm:min-h-[240px] sm:flex-row sm:items-end sm:justify-between sm:p-8">
        <div className="max-w-[560px]">
          <h1 className="text-title font-semibold text-text">{title}</h1>
          {description ? <div className="mt-3 text-muted">{description}</div> : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
    </div>
  );
}
