import type { Metadata } from "next";
import { DotBackdrop } from "@/components/dapp/dot-backdrop";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { ButtonLink } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="relative isolate border-b border-line">
        <DotBackdrop />
        <div className="mx-auto flex min-h-[62dvh] max-w-[1200px] flex-col justify-center px-4 py-24 sm:px-6">
          <p className="num text-sm text-faint">404</p>
          <h1 className="mt-3 max-w-[640px] text-title font-semibold text-text">This page does not exist.</h1>
          <p className="mt-4 max-w-[560px] text-muted">
            The link may be old or mistyped. The network status, claims, the install guide and the token facts are all reachable
            from the status page.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <ButtonLink href="/app" size="lg">
              Open the status page
            </ButtonLink>
            <ButtonLink href="/" size="lg" variant="secondary">
              Back to the home page
            </ButtonLink>
          </div>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
