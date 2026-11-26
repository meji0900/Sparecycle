import type { Metadata } from "next";
import Link from "next/link";
import { ModelCatalog } from "@/components/site/model-catalog";
import { ButtonLink } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { siteOrigin } from "@/lib/site";
import { catalogJson } from "@/server/catalog";

export const metadata: Metadata = {
  title: "Models",
  description:
    "The models Sparecycle runs today, what each job costs per work unit, the limits, and live capacity. Every job runs on two machines with different owners and is charged only when both agree.",
};

// Live price and capacity from the scheduler's database: read per request.
export const dynamic = "force-dynamic";

export default function ModelsPage() {
  const catalog = catalogJson();
  const origin = siteOrigin();
  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-14 pb-24 sm:px-6 sm:pt-20">
      <header className="max-w-[720px]">
        <h1 className="text-title font-semibold text-text">Models</h1>
        <p className="mt-4 text-muted">
          Pick a model, send a prompt and pay from your prepaid balance, or try it free. You never pick a machine: every job goes to two
          machines with different owner wallets, and you get the result only when both agree. If they don&apos;t, you are not charged, and
          a paid job runs again on another pair. Each paid job has a receipt you can check against the chain.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <ButtonLink href="/playground" size="lg">
            Run a model
          </ButtonLink>
          <ButtonLink href="/docs/api" size="lg" variant="secondary">
            API docs
          </ButtonLink>
        </div>
      </header>

      <ModelCatalog initial={catalog} />

      <section aria-labelledby="pricing" className="mt-16 grid gap-6 md:grid-cols-[220px_minmax(0,720px)] md:gap-10">
        <h2 id="pricing" className="font-semibold text-text">
          How a job is priced
        </h2>
        <div className="space-y-3 text-[15px] leading-relaxed text-muted">
          <p>
            The price is set per work unit, and the scheduler counts a job&apos;s units from its settings before it runs, so you see the
            price before you pay. Nodes never report their own units. The price is held from your balance while the two machines work and
            is charged at the end of the six-hour epoch, only for jobs whose two results matched.
          </p>
          <p>
            95% of what is charged goes to the node pot and 5% to the project treasury, by the payments contract. See{" "}
            <Link href="/docs/billing" className="link">
              Billing
            </Link>{" "}
            for deposits, holds, receipts and withdrawals.
          </p>
        </div>
      </section>

      <section aria-labelledby="capacity" className="mt-12 grid gap-6 md:grid-cols-[220px_minmax(0,720px)] md:gap-10">
        <h2 id="capacity" className="font-semibold text-text">
          What the capacity means
        </h2>
        <dl className="divide-y divide-line rounded-l border border-line text-sm">
          {[
            ["Ready now", "At least two machines with different owners are online and can take the model. A job starts within seconds."],
            [
              "Starts on demand",
              "No pair is online, but the project's GPU pool can start one, including a stopped machine of the other owner. The first job takes 1 to 2 minutes.",
            ],
            [
              "No pair right now",
              "No two machines with different owners can be reached. A new job is refused at once (503 no-node-pair): nothing is queued, held or charged.",
            ],
          ].map(([k, v]) => (
            <div key={k} className="grid gap-1 px-4 py-3 sm:grid-cols-[170px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-text">{k}</dt>
              <dd className="leading-relaxed text-muted">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="for-agents" className="mt-12 grid gap-6 md:grid-cols-[220px_minmax(0,720px)] md:gap-10">
        <h2 id="for-agents" className="font-semibold text-text">
          The same list for programs
        </h2>
        <div className="min-w-0 space-y-3 text-[15px] leading-relaxed text-muted">
          <p>
            This page reads <span className="num text-text">GET /v1/catalog</span>, which needs no key. The OpenAI-shaped{" "}
            <span className="num text-text">/v1/models</span> stays behind an API key. Details in the{" "}
            <Link href="/docs/api#catalog" className="link">
              API overview
            </Link>
            .
          </p>
          <CodeBlock label="Terminal" code={`curl -s ${origin}/v1/catalog`} />
        </div>
      </section>
    </div>
  );
}
