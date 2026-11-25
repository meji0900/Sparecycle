import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";
import { config } from "@/lib/config";
import { PONS_DOCS_URL } from "@/lib/pons";
import { FUNDING } from "@/lib/funding-copy";
import { XLink } from "@/components/brand/x-link";

/** A footer link when its URL is configured; nothing at all otherwise (never a dead link or a visible placeholder). */
function FooterLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return null;
  const external = href.startsWith("http");
  return external ? (
    <a href={href} target="_blank" rel="noreferrer" className="text-muted transition-colors hover:text-text">
      {label}
    </a>
  ) : (
    <Link href={href} className="text-muted transition-colors hover:text-text">
      {label}
    </Link>
  );
}

export function SiteFooter() {
  const { links } = config;
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-[1200px] gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.2fr_2fr]">
        <div className="space-y-3">
          <Wordmark />
          <p className="max-w-xs text-sm text-muted">{FUNDING.short}</p>
          {/* HEY Research's live badge: it shows only what HEY verifies from public evidence. */}
          <a
            href="https://heyresearch.xyz/project/sparecycle?utm_source=badge&utm_medium=html"
            target="_blank"
            rel="noreferrer"
            className="inline-block pt-2"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- external live SVG, served by HEY */}
            <img
              src="https://heyresearch.xyz/api/badge/sparecycle?theme=dark"
              alt="SpareCycle on HEY Research Lab"
              width={440}
              height={120}
              loading="lazy"
              className="h-auto w-full max-w-[330px]"
            />
          </a>
        </div>
        <div className="grid gap-8 text-sm sm:grid-cols-3">
          <div className="flex flex-col gap-2.5">
            <p className="text-faint">Product</p>
            <Link href="/app" className="text-muted hover:text-text">Network status</Link>
            <Link href="/app/claim" className="text-muted hover:text-text">Claim</Link>
            <Link href="/nodes" className="text-muted hover:text-text">Install guide</Link>
            <Link href="/jobs" className="text-muted hover:text-text">Submit a job</Link>
            <Link href="/token" className="text-muted hover:text-text">Token facts</Link>
            <Link href="/proof" className="text-muted hover:text-text">Mainnet proof</Link>
          </div>
          <div className="flex flex-col gap-2.5">
            <p className="text-faint">Elsewhere</p>
            {links.x ? <XLink withLabel /> : null}
            {links.github ? <FooterLink href={links.github} label="GitHub" /> : null}
            <FooterLink href={links.docs} label="Docs" />
            <FooterLink href={links.telegram} label="Telegram" />
            <a href={PONS_DOCS_URL} target="_blank" rel="noreferrer" className="text-muted hover:text-text">
              Pons v2 docs
            </a>
          </div>
          <div className="flex flex-col gap-2.5">
            <p className="text-faint">Legal</p>
            <FooterLink href={links.tos ?? "/legal/terms"} label="Terms" />
            <FooterLink href={links.privacy ?? "/legal/privacy"} label="Privacy" />
            <Link href="/legal/disclosures" className="text-muted hover:text-text">Disclosures</Link>
          </div>
        </div>
      </div>
      <div className="border-t border-line">
        <p className="mx-auto max-w-[1200px] px-4 py-6 text-xs text-faint sm:px-6">
          Not financial or legal advice. Not a yield product. Chain id 4663. Token via Pons v2.
        </p>
      </div>
    </footer>
  );
}
