import type { Metadata } from "next";
import Link from "next/link";
import { DocsHeader, DocsSection, Ext } from "@/components/docs/docs-ui";
import { SupportForm } from "@/components/docs/support-form";
import { config } from "@/lib/config";
import { REPO_URL } from "@/lib/site";
import { SUPPORT_LIMITS, SUPPORT_TOPICS, supportEnabled } from "@/server/support";

export const metadata: Metadata = {
  title: "Support",
  description: "Ask a question or report a problem with a Sparecycle job, node, balance or the API.",
};

// Whether the form is on follows SUPPORT_WEBHOOK_URL on the server, read per request.
export const dynamic = "force-dynamic";

export default function SupportPage() {
  const enabled = supportEnabled();
  return (
    <>
      <DocsHeader eyebrow="Help" title="Support">
        <p>
          Before writing, the guides answer most questions: <Link href="/docs/first-job" className="link">your first job</Link>,{" "}
          <Link href="/docs/run-a-node" className="link">running a node</Link> and{" "}
          <Link href="/docs/billing" className="link">billing</Link>. The live state of the network is on the{" "}
          <Link href="/app" className="link">status page</Link>.
        </p>
      </DocsHeader>

      <DocsSection id="form" title="Send a message">
        <SupportForm enabled={enabled} topics={SUPPORT_TOPICS} maxChars={SUPPORT_LIMITS.message.max} />
        <p className="text-sm">
          What happens to a message: it is forwarded to the project&apos;s support channel and this site keeps no copy. Only an
          hourly counter per sender is kept, under a salted hash of the IP address, to limit messages to{" "}
          {SUPPORT_LIMITS.perHour} an hour. See <Link href="/legal/privacy" className="link">Privacy</Link>.
        </p>
      </DocsSection>

      <DocsSection id="elsewhere" title="Other ways">
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          <li>
            Bugs and questions about the code: <Ext href={`${REPO_URL}/issues`}>GitHub issues</Ext>. Issues are public, so leave
            out anything private.
          </li>
          {config.links.x ? (
            <li>
              News and announcements: <Ext href={config.links.x}>Sparecycle on X</Ext>.
            </li>
          ) : null}
        </ul>
      </DocsSection>
    </>
  );
}
