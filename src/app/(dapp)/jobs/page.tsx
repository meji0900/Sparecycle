import type { Metadata } from "next";
import { ApiKeysPanel } from "@/components/dapp/api-keys-panel";
import { PageHeader } from "@/components/dapp/app-shell";
import { JobAccountProvider, JobBalance } from "@/components/dapp/job-balance";
import { JobLifecycle } from "@/components/dapp/job-lifecycle";
import { ReceiptChecker } from "@/components/dapp/job-receipt";
import { JobSubmit } from "@/components/dapp/job-submit";
import { LiveRecentJobs } from "@/components/dapp/recent-jobs";
import { SectionTitle } from "@/components/dapp/ui";
import { Notice } from "@/components/ui/status";
import { feesToTeamWallet, paidJobsLive as paidJobs } from "@/lib/funding-copy";
import { serverEnv } from "@/server/env";

export const metadata: Metadata = {
  title: "Submit a job",
  description: paidJobs
    ? "Submit a Stable Diffusion 1.5 image or a short Qwen2.5-1.5B text job: a free trial, or a fixed price per work unit paid from your own balance."
    : "Submit a Stable Diffusion 1.5 image or a short Qwen2.5-1.5B text job. Not a paid marketplace: compute is funded by trading fees.",
};

// The rate limit is a server setting (JOB_RATE_LIMIT); read it per request.
export const dynamic = "force-dynamic";

export default function JobsPage() {
  const rateLimit = serverEnv.jobRateLimit();
  return (
    <>
      <PageHeader
        art="/art/banner-jobs.webp"
        title="Submit a job"
        description="Two models only: Stable Diffusion 1.5 for images and Qwen2.5-1.5B-Instruct for short text. Each job runs on two nodes, and only results that agree count."
      />

      {paidJobs ? (
        <Notice tone="neutral" title="A fixed price, not a marketplace." className="mb-10">
          Nodes are paid from one pot: 95% of what paid jobs are charged{feesToTeamWallet ? "" : ", plus trading fees"}. Paid and free jobs wait in the same queue
          and may be delayed or refused when nodes are scarce. There is no bidding, no priority lane and no stake to submit.
        </Notice>
      ) : (
        <Notice tone="neutral" title="Submission is not a paid marketplace." className="mb-10">
          Compute is funded by trading fees and may be delayed or refused when the pot is thin or nodes are scarce. There is no
          bidding, no priority lane and no stake to submit.
        </Notice>
      )}

      {/* Phones: the form comes first so Submit stays close; the explainer follows. */}
      <div className="flex flex-col">
        <section aria-labelledby="lifecycle" className="order-last mt-14 lg:order-none lg:mt-0 lg:mb-12">
          <SectionTitle id="lifecycle" title="What happens to a job" />
          <JobLifecycle />
        </section>

        {paidJobs ? (
          <>
            <JobAccountProvider>
              <div className="max-w-[880px] xl:max-w-none">
                <JobSubmit rateLimit={rateLimit} side={<JobBalance />} />
              </div>
              {/* API keys pay from the same balance (src/server/apikeys.ts); management needs a wallet sign-in. */}
              <div className="mt-10 max-w-[880px]">
                <ApiKeysPanel />
              </div>
              {/* A saved job receipt, checked against the chain in this browser, without the Sparecycle API. */}
              <div className="mt-10 max-w-[880px]">
                <ReceiptChecker />
              </div>
            </JobAccountProvider>
            {/* Disclosure: who paid for each recent job, team-funded test jobs included. */}
            <section aria-labelledby="recent-jobs" className="mt-14">
              <SectionTitle
                id="recent-jobs"
                title="Recent jobs"
                description="The latest 20 jobs on the network and who paid for each: a free trial, a customer's balance, or the team's own test jobs (team-funded). Prompts are never shown."
              />
              <LiveRecentJobs />
            </section>
          </>
        ) : (
          <div className="max-w-[880px]">
            <JobSubmit rateLimit={rateLimit} />
          </div>
        )}
      </div>
    </>
  );
}
