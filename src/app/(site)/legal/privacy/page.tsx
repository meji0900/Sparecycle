import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal/legal-page";
import { ReviewStatus } from "@/components/legal/review-status";
import { config } from "@/lib/config";

export const metadata: Metadata = {
  title: "Privacy",
  description: "Placeholder until counsel drafts the Sparecycle privacy policy, with a factual list of what the software stores.",
};

export default function PrivacyPage() {
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
          <li>
            <span className="text-text">Jobs.</span> The scheduler stores each job&apos;s parameters, including the prompt. Public
            lists show only a salted hash of the prompt, but the two nodes that run the job receive the prompt, and anyone with
            the job id can view an agreed result. Do not submit personal or sensitive text.
          </li>
          <li>
            <span className="text-text">Rate limiting.</span> Job submissions are counted per IP address per hour. The scheduler
            keeps a salted hash of the IP address, not the address itself.
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
            jobs you submitted is kept in this browser&apos;s local storage. Both stay on your device.
          </li>
        </ul>
      </LegalSection>
    </LegalPage>
  );
}
