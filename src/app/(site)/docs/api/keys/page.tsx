import type { Metadata } from "next";
import Link from "next/link";
import { ApiDocPage, C, DocSection, DocTable, Example, Unconfirmed } from "@/components/docs/api-doc";
import { MAX_KEYS } from "@/lib/api-keys";
import { targetChain } from "@/lib/chain";
import { config } from "@/lib/config";
import { KEY_CREATES_PER_HOUR, PENDING_KEY_SECONDS } from "@/server/apikeys";
import { KEY_READS_PER_HOUR, PAID_JOBS_PER_HOUR } from "@/server/jobs";

export const metadata: Metadata = {
  title: "API keys",
  description: "Create Sparecycle API keys that pay for jobs from your wallet's prepaid balance, each with a daily cap and an off switch. A key can never withdraw.",
};

const origin = `https://${(config.domain ?? "sparecycle.tech").replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;

export default function ApiKeysDocs() {
  const contract = config.jobPayments?.toLowerCase() ?? "[JOB_PAYMENTS_ADDRESS not configured]";
  return (
    <ApiDocPage
      current="keys"
      title="API keys"
      lead={
        <p>
          An API key pays for jobs from your wallet&apos;s prepaid balance in the payments contract, without a wallet signature per job. Each key has its own
          daily cap and can be switched off at once. A key can never withdraw: withdrawals stay a wallet-only, on-chain action, and what you have not spent
          stays withdrawable by your wallet. The same keys work with the{" "}
          <Link href="/docs/api/openai" className="link">
            OpenAI-compatible API
          </Link>{" "}
          and the{" "}
          <Link href="/docs/api/mcp" className="link">
            MCP server
          </Link>
          .
        </p>
      }
    >
      <DocSection id="create" title="Create a key">
        <p>
          The easy way: open{" "}
          <Link href="/jobs#api-keys" className="link">
            Submit a job
          </Link>
          , connect the wallet you pay from, sign in (a signature, no gas), and use the API keys panel. Creating a key asks your wallet to sign one message;
          the key is then shown <strong className="text-text">once</strong>. Copy it right away: Sparecycle stores only its SHA-256 hash and cannot show it
          again.
        </p>
        <p>
          A key looks like <C>sck_&lt;keyId&gt;_&lt;secret&gt;</C>: <C>keyId</C> is 16 hex characters (shown in the panel, not secret), the secret is 43
          base64url characters. Send it as <C>Authorization: Bearer sck_…</C>.
        </p>
        <p>The message your wallet signs (EIP-191, personal_sign) names the key, its fingerprint (the first 16 hex characters of SHA-256 of the full key) and its cap:</p>
        <Example
          label="Link message"
          code={[
            "Sparecycle: allow one API key to pay for jobs from my balance",
            `Chain: ${targetChain.id}`,
            `Payments contract: ${contract}`,
            "Key: sck_<keyId>",
            "Key fingerprint: <first 16 hex of sha256(full key)>",
            "Daily cap: <wei> wei per UTC day",
            "Issued: <unix seconds>",
            "This key cannot withdraw. Revoke it at any time.",
          ].join("\n")}
        />
        <p>
          Plain wallets, ERC-1271 smart wallets and ERC-6492 (not yet deployed) smart wallets are accepted, the same way as the sign-in. A key that is not
          signed within {PENDING_KEY_SECONDS / 60} minutes expires; create a new one.
        </p>
      </DocSection>

      <DocSection id="cap" title="Daily cap and the on-chain spend limit">
        <p>
          Each key has a daily cap in wei. A job counts against the cap of the UTC day it was submitted on; caps reset at 00:00 UTC (08:00 WITA).
          <Unconfirmed id="D12" /> A job that would go over the cap is refused with <C>429 key-daily-cap</C> and nothing is queued. A job that ends without
          agreement (results did not match, no verdict in time, or a rejected image) is never charged and gives its price back to the key&apos;s counter.
        </p>
        <p>
          Lowering a cap, disabling and deleting need only your sign-in. Raising a cap needs a new signature over a link message with the new cap.
          <Unconfirmed id="A3" />
        </p>
        <p>
          <strong className="text-text">Set a spend limit per epoch.</strong> The daily cap is enforced by the Sparecycle scheduler. The only ceiling that does
          not depend on the scheduler is the spend limit per epoch in the payments contract (<C>setSpendLimit</C>, in Your balance on{" "}
          <Link href="/jobs#balance" className="link">
            Submit a job
          </Link>
          ). Its default is 0, which means no limit; the keys panel warns while it is 0. <Unconfirmed id="A2" />
        </p>
      </DocSection>

      <DocSection id="kill" title="Turn a key off">
        <p>
          Disable, delete, or disable all keys from the panel or the API below. It takes effect on the next request: the key is refused with <C>401</C>. Jobs
          of that key that are still queued (no node has started them) end as <C>expired</C> with the note <C>cancelled: API key disabled</C> and are never
          charged. Jobs already running settle normally.
        </p>
      </DocSection>

      <DocSection id="use" title="Pay for a job with a key">
        <p>
          Send the job request itself to <C>POST /api/v1/jobs</C>, without a <C>payment</C> block. The price is the same as for a wallet-signed job (work
          units times the price per unit) and the same available-balance check applies. Paid jobs per wallet are limited to {PAID_JOBS_PER_HOUR} per hour,
          keys included.
        </p>
        <Example
          label="curl"
          code={`curl -s ${origin}/api/v1/jobs \\
  -H "Authorization: Bearer $SPARECYCLE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"kind":"text","params":{"model":"qwen2.5-1.5b","prompt":"Name three colours.","maxTokens":64}}'

# 201 {"id":"0x…","status":"queued","priceWei":"…"}   (no readSecret: read it with the key)

curl -s ${origin}/api/v1/jobs/0x…/result -H "Authorization: Bearer $SPARECYCLE_API_KEY"`}
        />
        <p>
          A key reads the results of the jobs submitted with that key only, not other jobs of the same wallet (<C>403</C>).
          <Unconfirmed id="A5" /> Your wallet sign-in still reads every job your wallet paid for. Jobs paid with a key get no per-job read secret.
          <Unconfirmed id="A4" />
        </p>
        <p>
          For text and images in the OpenAI format, use the{" "}
          <Link href="/docs/api/openai" className="link">
            OpenAI-compatible API
          </Link>
          ; for agents, the{" "}
          <Link href="/docs/api/mcp" className="link">
            MCP server
          </Link>
          .
        </p>
      </DocSection>

      <DocSection id="trust" title="What a key changes, and what it cannot do">
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          <li>A key can submit and read jobs. It cannot withdraw, cannot change your spend limit, and cannot create or manage keys.</li>
          <li>
            The payments contract never sees per-job signatures; it lets the scheduler key charge you up to your balance and your spend limit per epoch, with
            or without a key. What a key changes is the evidence: for key-paid jobs, the proof that you wanted a job is your one link signature plus the
            scheduler&apos;s records.
          </li>
          <li>
            Every entry of an epoch&apos;s published charge list (<C>/api/v1/epochs/&lt;id&gt;/charges</C>) carries <C>apiKeyId</C> (null for a
            wallet-signed job), so you can see which charges came from which key. Lists charged before keys existed are served unchanged, without the field.
          </li>
          <li>Anyone holding a key can spend up to its daily cap. Keep keys out of code repositories and browsers; turn a key off as soon as it may have leaked.</li>
        </ul>
        <p>
          Keys pay without a per-job signature after one link signature. <Unconfirmed id="D11" /> A wallet can hold at most {MAX_KEYS} active or pending
          keys. <Unconfirmed id="D13" />
        </p>
      </DocSection>

      <DocSection id="http" title="Managing keys over HTTP">
        <p>
          The panel uses these routes; scripts can too. They need the wallet session cookie <C>sc_session</C> from the sign-in (<C>GET /api/v1/auth/nonce</C>
          , then <C>POST /api/v1/auth/verify</C> with an EIP-4361 message); an API key is not accepted here. Without a session they answer an empty{" "}
          <C>401</C>. Every answer is <C>Cache-Control: private, no-store</C>.
        </p>
        <DocTable
          head={["Route", "Body", "Answer"]}
          rows={[
            [<C key="r">GET /api/v1/keys</C>, "", "owner, keys (label, prefix, fingerprint, status, dailyCapWei, spentTodayWei, nextResetAt, …)"],
            [<C key="r">POST /api/v1/keys</C>, <C key="b">{`{ label?, dailyCapWei }`}</C>, "201: keyId, fingerprint, linkMessage, issued (pending; no secret)"],
            [<C key="r">POST /api/v1/keys/:id/activate</C>, <C key="b">{`{ signature }`}</C>, "the full key in key, shown once"],
            [
              <C key="r">PATCH /api/v1/keys/:id</C>,
              <C key="b">{`{ label?, dailyCapWei?, status?: "active" | "disabled" }`}</C>,
              "the key; raising the cap first answers 409 link-signature-required with linkMessage and issued: sign it and send { dailyCapWei, issued, signature }",
            ],
            [<C key="r">DELETE /api/v1/keys/:id</C>, "", "ok; queued jobs cancelled (cancelledJobs)"],
            [<C key="r">POST /api/v1/keys/disable-all</C>, "", "disabled, cancelledJobs"],
          ]}
        />
        <p>
          Limits: {KEY_CREATES_PER_HOUR} key creations per wallet per hour; {KEY_READS_PER_HOUR} job reads per key per hour on the OpenAI-compatible and MCP
          routes.
        </p>
      </DocSection>

      <DocSection id="errors" title="Errors">
        <DocTable
          head={["Status", "error", "When"]}
          rows={[
            ["401", <C key="c">invalid-api-key</C>, "unknown, disabled or deleted key, or a wrong secret"],
            ["402", <C key="c">insufficient-balance</C>, "your available balance (balance minus held and pending withdrawal) is below the price"],
            ["429", <C key="c">key-daily-cap</C>, "the job would take the key over its cap for today (UTC); resetsAt says when it resets"],
            ["429", <C key="c">rate-limited</C>, `more than ${PAID_JOBS_PER_HOUR} paid jobs per hour from one wallet`],
            ["409", <C key="c">max-keys</C>, `the wallet already has ${MAX_KEYS} active or pending keys`],
            ["400", <C key="c">bad-link-signature</C>, "the signature is not from the signed-in wallet over that link message"],
            ["410", <C key="c">pending-key-expired</C>, "the key was not signed in time; create a new one"],
          ]}
        />
      </DocSection>
    </ApiDocPage>
  );
}
