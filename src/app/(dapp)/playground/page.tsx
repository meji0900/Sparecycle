import type { Metadata } from "next";
import { PageHeader } from "@/components/dapp/app-shell";
import { JobAccountProvider } from "@/components/dapp/job-balance";
import { Playground } from "@/components/dapp/playground";
import { paidJobsLive as paidJobs } from "@/lib/funding-copy";
import { serverEnv } from "@/server/env";

export const metadata: Metadata = {
  title: "Playground",
  description: paidJobs
    ? "Describe an image and get it from Stable Diffusion 1.5, drawn by two GPUs and shown only when both agree. Free trial or pay from your own balance."
    : "Describe an image and get it from Stable Diffusion 1.5, drawn by two GPUs and shown only when both agree. Free trial, a few images per hour.",
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
            Describe an image and Stable Diffusion 1.5 draws it. Two GPUs on the network make it separately and you see it only when both
            agree.
          </>
        }
      />
      {paidJobs ? <JobAccountProvider>{playground}</JobAccountProvider> : playground}
    </>
  );
}
