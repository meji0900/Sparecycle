import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { ReviewStatus } from "@/components/legal/review-status";
import { config } from "@/lib/config";
import { serverEnv } from "@/server/env";
import { supportEnabled } from "@/server/support";

export const metadata: Metadata = {
  title: "Privacy",
  description: "Placeholder until counsel drafts the Sparecycle privacy policy, with a factual list of what the software stores.",
};

// What it says about job results follows the scheduler's OUTPUT_AUTH setting, and about the support form its
// SUPPORT_WEBHOOK_URL setting, both read per request.
export const dynamic = "force-dynamic";

export default function PrivacyPage() {
  const privateResults = serverEnv.outputAuth() === "enforce";
  const supportOn = supportEnabled();
  return (
    <LegalPage
      title="Privacy"
      current="privacy"
      status={<ReviewStatus url={config.links.privacy} urlPlaceholder="[PRIVACY_POLICY_URL]" noun="privacy policy" />}
    >
      <LegalSection title="This page is a placeholder">
        <p>
          Counsel has not written the privacy policy yet. Until they do, this page is not a policy. Below is a factual list of
          what the software in this repository stores, so you can decide what to submit.
        </p>
      </LegalSection>

      <LegalSection title="What the software stores today">
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          {privateResults ? (
            <>
              <li>
                <span className="text-text">Jobs.</span> The scheduler stores each job&apos;s parameters, including the prompt, and
                the agreed result. Public lists show only a salted hash of the prompt. Do not submit personal or sensitive text.
              </li>
              <li>
                <span className="text-text">Who can see a result.</span> An agreed result is visible only to the browser that
                created the job, which keeps a key for it (the scheduler stores only a hash of that key), or, for paid and team
                jobs, to the wallet that paid once it signs in. Knowing or listing a job id is not enough.
              </li>
            </>
          ) : (
            <li>
              <span className="text-text">Jobs.</span> The scheduler stores each job&apos;s parameters, including the prompt. Public
              lists show only a salted hash of the prompt, but anyone with the job id can view an agreed result. Results visible
              only to the browser that created the job or the wallet that paid are built but not switched on yet. Do not submit
              personal or sensitive text.
            </li>
          )}
          <li>
            <span className="text-text">The two GPU nodes.</span> The two nodes that run a job see the prompt and produce the
            result while they work. What reached their machines cannot be recalled.
          </li>
          <li>
            <span className="text-text">Payments are public.</span> The CustomerCharged events of the payments contract and the
            per-epoch charge list (/api/v1/epochs/&#123;id&#125;/charges) are public. They link the paying wallet to the amount and
            the charge list links it to job ids.
          </li>
          {privateResults ? (
            <li>
              <span className="text-text">Results made before results became private.</span> They were readable by anyone with
              the job id and may already have been viewed, downloaded or cached. Those copies cannot be recalled. Free results
              from before the change can no longer be opened by anyone; older paid results stay readable by the wallet that paid.
            </li>
          ) : null}
          <li>
            <span className="text-text">Rate limiting.</span> Job submissions are counted per IP address per hour. The scheduler
            keeps a salted hash of the IP address, not the address itself.
          </li>
          <li>
            <span className="text-text">Support form.</span>{" "}
            {supportOn
              ? "A message sent from /docs/support (topic, message, and the wallet and job id if you add them) is forwarded to the project's support channel, an outside service that keeps its own copy, and is not stored by this site. The only trace here is the hourly rate-limit counter, under a salted hash of your IP address."
              : "The form at /docs/support is switched off: nothing typed into it is sent or stored. When it is switched on, a message is forwarded to the project's support channel, an outside service that keeps its own copy, and is not stored by this site apart from an hourly rate-limit counter under a salted hash of your IP address."}
          </li>
          <li>
            <span className="text-text">Nodes.</span> A node that registers sends its node key, the owner wallet and its
            signature, the GPU name and UUID, VRAM and supported models. Owner wallets, GPU names and VRAM are shown on the
            public status page.
          </li>
          <li>
            <span className="text-text">On-chain data.</span> Claims, Merkle roots and every transaction are public and
            permanent on Robinhood Chain. Nothing here can remove them.
          </li>
          <li>
            <span className="text-text">Your browser.</span> The wallet connection is remembered in a cookie, and the list of
            jobs you submitted, with the key to each job&apos;s result, is kept in this browser&apos;s local storage. Both stay on
            your device. If you sign in with a wallet to view paid results, the scheduler sets a session cookie for 12 hours and
            stores only a hash of it.
          </li>
        </ul>
      </LegalSection>
    </LegalPage>
  );
}
