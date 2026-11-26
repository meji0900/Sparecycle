import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/dapp/app-shell";
import { JobAccountProvider } from "@/components/dapp/job-balance";
import { Playground } from "@/components/dapp/playground";
import { paidJobsLive as paidJobs } from "@/lib/funding-copy";
import { serverEnv } from "@/server/env";

export const metadata: Metadata = {
  title: "Playground",
  description: paidJobs
    ? "Run a model: an image from Stable Diffusion 1.5 or a short answer from Qwen2.5-1.5B, made by two machines and shown only when both agree. Free trial, or pay from your own prepaid balance with no API key."
    : "Run a model: an image from Stable Diffusion 1.5 or a short answer from Qwen2.5-1.5B, made by two machines and shown only when both agree. Free trial, a few jobs per hour.",
};

// The free-trial rate limit is a server setting (JOB_RATE_LIMIT); read it per request.
export const dynamic = "force-dynamic";

export default function PlaygroundPage() {
  const rateLimit = serverEnv.jobRateLimit();
  const playground = <Playground rateLimit={rateLimit} />;
  return (
    <>
      <PageHeader
        title="Playground"
        description={
          <>
            Run a model: describe an image for Stable Diffusion 1.5, or ask Qwen2.5-1.5B a short question. Two machines with different
            owners make it separately and you see it only when both agree.{" "}
            <Link href="/models" className="link">
              Models, prices and capacity
            </Link>
          </>
        }
      />
      {paidJobs ? <JobAccountProvider>{playground}</JobAccountProvider> : playground}
    </>
  );
}
