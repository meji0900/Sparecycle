import type { Metadata } from "next";
import Link from "next/link";
import { C, Defs, DocsHeader, DocsNext, DocsSection, Ext, Note } from "@/components/docs/docs-ui";
import { CodeBlock } from "@/components/ui/code-block";
import { DOCS_LINKS } from "@/lib/docs-nav";
import { JOB_PAYMENT_WINDOW_SECONDS } from "@/lib/job-payment";
import { listOperations, openApiDocument } from "@/lib/openapi";
import { REPO_URL, repoFile, siteOrigin } from "@/lib/site";
import { POLICY } from "@/server/env";

export const metadata: Metadata = {
  title: "API overview",
  description:
    "The Sparecycle scheduler API: every endpoint, how to authenticate (read secret, wallet sign-in, payment signature, node signature), errors and limits. OpenAPI 3.1 at /api/v1/openapi.json.",
};

const AUTH_LABEL: Record<string, string> = {
  readSecret: "read secret",
  walletSession: "wallet session",
  nodeSignature: "node signature",
  adminToken: "operator token",
};

function authOf(security: unknown): string {
  const list = (security as Record<string, unknown>[] | undefined) ?? [];
  if (!list.length) return "none";
  const names = list.map((s) => Object.keys(s)[0]).map((k) => (k ? AUTH_LABEL[k] ?? k : "none"));
  return [...new Set(names)].join(" or ");
}

export default function ApiPage() {
  const doc = openApiDocument();
  const ops = listOperations(doc);
  const origin = siteOrigin();
  const sessionHours = POLICY.sessionSeconds / 3600;

  return (
    <>
      <DocsHeader eyebrow="API" title="API overview">
        <p>
          The scheduler that hands out jobs, compares results and publishes payouts is served by this site under{" "}
          <C>{`${origin}/api/v1`}</C>. The full description is machine-readable:{" "}
          <a href={DOCS_LINKS.openapi} className="link">
            /api/v1/openapi.json
          </a>{" "}
          (OpenAPI 3.1). Field-level shapes are also in <Ext href={repoFile("docs/SPEC.md")}>docs/SPEC.md</Ext>.
        </p>
      </DocsHeader>

      <DocsSection id="conventions" title="Conventions">
        <Defs
          items={[
            ["Format", "JSON in and out. Amounts are decimal strings in wei (they do not fit in a JSON number). Times are unix seconds."],
            [
              "Errors",
              <>
                Always <C>{`{ "error": "<code>", "message": "…" }`}</C> with a kebab-case code, sometimes with extra fields (for
                example <C>field</C> or <C>retryAfter</C>). Never a stack trace.
              </>,
            ],
            ["Prompts", "Never returned by any endpoint. Public lists carry a salted hash of the prompt instead."],
            [
              "Caching",
              <>
                Anything that depends on who asks (job detail, results, invoices, receipts, sign-in) is sent with{" "}
                <C>Cache-Control: private, no-store</C>.
              </>,
            ],
            ["Trust", "One scheduler runs this API. It is centralized in this MVP; settled payouts on-chain cannot be changed afterwards."],
          ]}
        />
      </DocsSection>

      <DocsSection id="auth" title="Authentication">
        <p>Most reads need nothing. The rest use one of these:</p>
        <Defs
          items={[
            [
              "Read secret",
              <>
                Returned once by <C>POST /jobs</C> as <C>readSecret</C>; the scheduler stores only its hash. Send it as{" "}
                <C>Authorization: Bearer &lt;readSecret&gt;</C> to read that job&apos;s result, invoice and receipt.
              </>,
            ],
            [
              "Wallet session",
              <>
                Sign-In with Ethereum (EIP-4361), gasless: <C>GET /auth/nonce</C>, sign the message with your wallet,{" "}
                <C>POST /auth/verify</C>. The answer sets an HttpOnly cookie <C>sc_session</C> for {sessionHours} hours that reads
                the results, invoices and receipts of jobs this wallet paid for.
              </>,
            ],
            [
              "Payment signature",
              <>
                A paid job carries an EIP-191 signature by the payer over the request and its price, valid for{" "}
                {JOB_PAYMENT_WINDOW_SECONDS / 60} minutes and for one job. See{" "}
                <Link href="/docs/first-job#paid-api" className="link">
                  paid jobs over the API
                </Link>
                .
              </>,
            ],
            [
              "Node signature",
              <>
                The node client signs every request with its node key: headers <C>x-sc-from</C>, <C>x-sc-ts</C>, <C>x-sc-sig</C>{" "}
                over <C>sparecycle|METHOD|PATH|TS|sha256(body)</C>, 60-second window, each signature accepted once.
              </>,
            ],
            ["Operator token", "Bearer SCHEDULER_ADMIN_TOKEN, for the operator only. The endpoints answer 503 when none is configured."],
          ]}
        />
      </DocsSection>

      <DocsSection id="endpoints" title="Endpoints">
        <p>
          Generated from the same description as <C>/api/v1/openapi.json</C>, so the two cannot disagree. Paths are relative to{" "}
          <C>/api/v1</C>.
        </p>
        {doc.tags.map((tag) => {
          const rows = ops.filter((o) => o.op.tags[0] === tag.name);
          if (!rows.length) return null;
          return (
            <div key={tag.name} className="pt-2">
              <h3 className="font-medium text-text">{tag.name}</h3>
              <p className="mt-1 text-sm text-muted">{tag.description}</p>
              <ul className="mt-3 divide-y divide-line rounded-l border border-line">
                {rows.map(({ method, path, op }) => (
                  <li key={`${method} ${path}`} className="grid gap-1 px-4 py-3 sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] sm:gap-4">
                    <p className="num min-w-0 text-[13px] break-all text-text">
                      <span className={method === "get" || method === "head" ? "text-muted" : "text-signal"}>{method.toUpperCase()}</span>{" "}
                      {path}
                      {op.deprecated ? <span className="ml-2 font-sans text-xs text-amber">retired</span> : null}
                    </p>
                    <div className="min-w-0 text-sm">
                      <p className="text-muted">{op.summary}</p>
                      <p className="mt-0.5 text-xs text-faint">Auth: {authOf(op.security)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </DocsSection>

      <DocsSection id="limits" title="Limits">
        <Defs
          items={[
            [
              "Free trial jobs",
              <>
                A few per IP address per hour; the current limit is in the <C>x-sc-rate-limit</C> header of every{" "}
                <C>POST /jobs</C> answer. Over it: <C>429 rate-limited</C> with <C>retryAfter</C>.
              </>,
            ],
            ["Paid jobs", "Limited per paying wallet per hour, to protect the queue. Payment itself is the main guard."],
            ["Result reads", "Rate limited per viewer: per job for a read secret, per wallet for a session, otherwise per IP address."],
            ["Queue", `At most ${POLICY.maxOpenJobs} open jobs at once; beyond that, 503 queue-full.`],
            ["Job lifetime", `A job without a verdict after ${POLICY.jobTtlSeconds / 3600} hours expires and is not charged.`],
          ]}
        />
      </DocsSection>

      <DocsSection id="try" title="Try it">
        <CodeBlock
          label="Terminal"
          code={[`curl -s ${origin}/api/v1/status`, `curl -s ${origin}/api/v1/openapi.json -o sparecycle-openapi.json`].join("\n")}
        />
        <Note>
          Source of every endpoint: <Ext href={`${REPO_URL}/tree/main/src/app/api/v1`}>src/app/api/v1</Ext>. A route that is
          added without a matching entry in the OpenAPI modules fails the test suite.
        </Note>
      </DocsSection>

      <DocsNext
        links={[
          { href: "/docs/first-job", title: "Your first job", description: "Submit, poll and read a result with curl." },
          { href: "/docs/contracts", title: "Contracts and keys", description: "The on-chain side of the API." },
        ]}
      />
    </>
  );
}
