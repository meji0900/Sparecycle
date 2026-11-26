import type { Metadata } from "next";
import Link from "next/link";
import { DocsHeader, DocsNext, DocsSection, Ext } from "@/components/docs/docs-ui";
import { NodeGuide } from "@/components/docs/node-guide";
import { repoFile, siteOrigin } from "@/lib/site";

export const metadata: Metadata = {
  title: "Run a node",
  description:
    "Install the Sparecycle node client on Linux or Windows (NVIDIA, AMD / Intel / iGPU or CPU), link your wallet and see your node online.",
};

export default function RunANodePage() {
  return (
    <>
      <DocsHeader eyebrow="Get started" title="Run a node">
        <p>
          The node client runs checked AI jobs on your GPU (or CPU, for text) while you do not need it. Each job runs on two
          nodes with different owners; when the two results match, the work counts toward a share of that epoch&apos;s pot, which node
          owners claim on-chain. There is no fixed rate: an epoch with an empty pot pays nothing.
        </p>
        <p>Pick your system and hardware; every command below follows the choice.</p>
      </DocsHeader>

      <DocsSection id="install" title="From download to online">
        <NodeGuide origin={siteOrigin()} />
      </DocsSection>

      <DocsSection id="after" title="After it is running">
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          <li>
            Each six-hour epoch, the scheduler splits the pot by the work your node did in matching jobs and publishes the
            split. Claim your share with a Merkle proof on the <Link href="/app/claim" className="link">claim page</Link>.
          </li>
          <li>
            Only cards in a benched family are listed as supported. The list, and how a family gets on it, is in{" "}
            <Ext href={repoFile("docs/gpu-support.md")}>GPU support</Ext>.
          </li>
          <li>
            Every flag and environment variable of the client:{" "}
            <Ext href={repoFile("node-client/README.md")}>node-client/README.md</Ext>.
          </li>
          <li>
            Stuck? Ask on the <Link href="/docs/support" className="link">support page</Link>.
          </li>
        </ul>
      </DocsSection>

      <DocsNext
        links={[
          { href: "/docs/contracts", title: "Contracts and keys", description: "Where the pot lives and who can do what." },
          { href: "/docs/first-job", title: "Your first job", description: "Send your node some work." },
        ]}
      />
    </>
  );
}
