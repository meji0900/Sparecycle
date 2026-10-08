import Link from "next/link";
import { Wordmark } from "@/components/brand/wordmark";
import { config } from "@/lib/config";
import { PONS_DOCS_URL } from "@/lib/pons";
import { FUNDING } from "@/lib/funding-copy";
import { XLink } from "@/components/brand/x-link";

/** A footer link: real URL when configured, otherwise a visible placeholder (never a dead link). */
function FooterLink({ href, label, placeholder }: { href: string | null; label: string; placeholder: string }) {
  if (!href) {
    return (
      <span className="text-faint" title={`${placeholder} is not set yet`}>
        {label} <span className="num text-xs">{placeholder}</span>
      </span>
    );
  }
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
            {links.x ? <XLink withLabel /> : <FooterLink href={links.x} label="X" placeholder="[X_URL]" />}
            {links.github ? <FooterLink href={links.github} label="GitHub" placeholder="[GITHUB_URL]" /> : null}
            <FooterLink href={links.docs} label="Docs" placeholder="[DOCS_URL]" />
            <FooterLink href={links.telegram} label="Telegram" placeholder="[TELEGRAM_URL]" />
            <a href={PONS_DOCS_URL} target="_blank" rel="noreferrer" className="text-muted hover:text-text">
              Pons v2 docs
            </a>
          </div>
          <div className="flex flex-col gap-2.5">
            <p className="text-faint">Legal</p>
            <FooterLink href={links.tos ?? "/legal/terms"} label="Terms" placeholder="[TOS_URL]" />
            <FooterLink href={links.privacy ?? "/legal/privacy"} label="Privacy" placeholder="[PRIVACY_POLICY_URL]" />
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
