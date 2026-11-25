import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { ReviewStatus } from "@/components/legal/review-status";
import { config } from "@/lib/config";
import { FUNDING } from "@/lib/funding-copy";
import { serverEnv } from "@/server/env";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "Placeholder until counsel drafts the Sparecycle terms of use.",
};

// What it says about job results follows the scheduler's OUTPUT_AUTH setting, read per request.
export const dynamic = "force-dynamic";

export default function TermsPage() {
  const privateResults = serverEnv.outputAuth() === "enforce";
  return (
    <LegalPage title="Terms of use" current="terms" status={<ReviewStatus url={config.links.tos} urlPlaceholder="[TOS_URL]" noun="terms" />}>
      <LegalSection title="This page is a placeholder">
        <p>
          Counsel has not written the terms of use yet. Until they do, this page is not a contract and does not add any rule,
          policy or promise. It does not state a geographic, securities or eligibility policy; none should be assumed.
        </p>
        <p>
          What already applies is set out in the{" "}
          <Link href="/legal/disclosures" className="link">
            disclosures
          </Link>
          : not financial, legal or tax advice; not a yield product; {FUNDING.termsSummary}; the token can go to zero.
        </p>
      </LegalSection>

      <LegalSection title="What the terms will need to cover">
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          <li>Use of the website and the dApp, which is software provided as is.</li>
          {privateResults ? (
            <li>
              The public job-submission surface: allowed models, rate limits and content rules; that a result is visible only to
              the browser that created the job or the wallet that paid; that the two GPU nodes see the prompt and produce the
              result while they work, and what reached their machines cannot be recalled; that payment events and the per-epoch
              charge list are public; and that results made before results became private may already have been viewed or
              cached.
            </li>
          ) : (
            <li>
              The public job-submission surface: allowed models, rate limits, content rules, the fact that results are not private
              yet, and that the two GPU nodes see the prompt and produce the result while they work.
            </li>
          )}
          <li>Running a node: your hardware, your electricity, and payouts that depend on fees actually collected.</li>
          <li>The token launched on Pons v2, which this project does not issue or allocate to itself.</li>
          <li>Any geographic or eligibility rules counsel decides on.</li>
        </ul>
      </LegalSection>
    </LegalPage>
  );
}
