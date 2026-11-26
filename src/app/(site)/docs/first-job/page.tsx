import type { Metadata } from "next";
import Link from "next/link";
import { formatEther } from "viem";
import { C, Defs, DocsHeader, DocsNext, DocsSection, Note, Step, Steps } from "@/components/docs/docs-ui";
import { CodeBlock } from "@/components/ui/code-block";
import { MAINNET_CHAIN_ID } from "@/lib/addresses";
import { config } from "@/lib/config";
import { JOB_PAYMENT_WINDOW_SECONDS, jobPriceWei } from "@/lib/job-payment";
import { workUnits, type JobRequest } from "@/lib/protocol";
import { siteOrigin } from "@/lib/site";
import { POLICY } from "@/server/env";

export const metadata: Metadata = {
  title: "Your first job",
  description: "Run a first Sparecycle job in the playground or with curl: free trial or prepaid balance, status, and your private result.",
};

const IMAGE: JobRequest = {
  kind: "image",
  params: { model: "sd15", prompt: "a lighthouse at dusk, watercolor", negative: "", width: 512, height: 512, steps: 15, guidance: 7, seed: null },
};
const TEXT: JobRequest = { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "Name three uses for an idle GPU.", system: "", maxTokens: 64 } };
const TEXT_BODY = JSON.stringify({ kind: "text", params: { model: "qwen2.5-1.5b", prompt: TEXT.params.prompt, maxTokens: 64 } });
const IMAGE_BODY = JSON.stringify({ kind: "image", params: { model: "sd15", prompt: IMAGE.params.prompt, width: 512, height: 512, steps: 15 } });

const eth = (wei: bigint) => `${formatEther(wei)} ETH`;
const gwei = (wei: bigint) => `${Number(wei) / 1e9} gwei`;

export default function FirstJobPage() {
  const origin = siteOrigin();
  const api = `${origin}/api/v1`;
  const unit = config.jobPriceWeiPerUnit;
  const ttlHours = POLICY.jobTtlSeconds / 3600;

  const submit = `curl -s -X POST ${api}/jobs \\
  -H 'content-type: application/json' \\
  -d '${TEXT_BODY}'`;
  const submitImage = `curl -s -X POST ${api}/jobs \\
  -H 'content-type: application/json' \\
  -d '${IMAGE_BODY}'`;
  const answer = `{
  "id": "0x5b1c…",          // the job id
  "status": "queued",
  "priceWei": null,         // null for a free trial job
  "readSecret": "Qm0f…"     // shown once: keep it to read the result
}`;
  const status = `curl -s ${api}/jobs/JOB_ID`;
  const result = `curl -s -H "Authorization: Bearer READ_SECRET" ${api}/jobs/JOB_ID/result`;
  const resultImage = `curl -s -H "Authorization: Bearer READ_SECRET" -o result.png ${api}/jobs/JOB_ID/result`;

  const paidBody = `{
  "request": ${TEXT_BODY},
  "payment": {
    "payer": "0xYOUR_WALLET",
    "signature": "0x…",          // personal_sign of the message below
    "issued": 1795528461,        // unix seconds when you signed
    "priceWei": "${jobPriceWei(TEXT, unit)}"      // work units × priceWeiPerUnit
  }
}`;
  const message = `Sparecycle: pay for one job from my balance
Chain: ${MAINNET_CHAIN_ID}
Payments contract: <payments contract, lowercase>
Job request: <sha256 of JSON.stringify(request), 0x + lowercase hex>
Price: <priceWei> wei
Issued: <issued>`;
  const script = `// pay-job.mjs: submit one paid text job from your prepaid balance.
// npm install viem, then: PAYER_KEY=0x… node pay-job.mjs   (a key you control; never paste it into a website)
import { sha256, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const API = "${api}";
const account = privateKeyToAccount(process.env.PAYER_KEY);
const request = ${TEXT_BODY};

// Price = work units × price per unit. Text: 8 per max token + 1 per 16 characters of prompt and system.
const units = request.params.maxTokens * 8 + Math.ceil(request.params.prompt.length / 16);
const acct = await (await fetch(\`\${API}/payments/account?address=\${account.address}\`)).json();
const priceWei = BigInt(units) * BigInt(acct.priceWeiPerUnit);
const issued = Math.floor(Date.now() / 1000);

const message = [
  "Sparecycle: pay for one job from my balance",
  "Chain: ${MAINNET_CHAIN_ID}",
  \`Payments contract: \${acct.contract.toLowerCase()}\`,
  \`Job request: \${sha256(stringToBytes(JSON.stringify(request)))}\`,
  \`Price: \${priceWei} wei\`,
  \`Issued: \${issued}\`,
].join("\\n");
const signature = await account.signMessage({ message });

const res = await fetch(\`\${API}/jobs\`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ request, payment: { payer: account.address, signature, issued, priceWei: priceWei.toString() } }),
});
console.log(res.status, await res.json()); // keep id and readSecret`;

  return (
    <>
      <DocsHeader eyebrow="Get started" title="Your first job">
        <p>
          A job is a Stable Diffusion 1.5 image or a Qwen2.5-1.5B text answer. Two GPUs with different owners run it and the
          scheduler compares their results. You are charged only when the two results match.
        </p>
        <p>Two ways in: the playground in your browser, or the API with curl. Both start with a free trial.</p>
      </DocsHeader>

      <DocsSection id="browser" title="In the browser">
        <Steps>
          <Step n={1} title="Connect a wallet (paid jobs only)">
            <p>
              The free trial needs no wallet. For paid jobs, open the <Link href="/jobs" className="link">Jobs page</Link> and
              connect a wallet on Robinhood Chain (chain id <span className="num">{MAINNET_CHAIN_ID}</span>). The site asks your
              wallet to switch networks if needed.
            </p>
          </Step>
          <Step n={2} title="Deposit, or use the free trial">
            <p>
              <span className="text-text">Free trial:</span> a few jobs per hour from one IP address, no wallet. The limit is set
              by the scheduler and sent with every answer in the <C>x-sc-rate-limit</C> header.
            </p>
            <p>
              <span className="text-text">Prepaid balance:</span> on the Jobs page, deposit ETH into the payments contract. It
              stays yours: only your wallet can withdraw what is not spent. See <Link href="/docs/billing" className="link">Billing</Link>.
            </p>
            <p>
              The price is {gwei(unit)} per work unit today. A 512×512 image at 15 steps is{" "}
              <span className="num text-text">{workUnits(IMAGE).toLocaleString("en-US")}</span> units ={" "}
              <span className="num text-text">{eth(jobPriceWei(IMAGE, unit))}</span>; a 64-token text answer to a short prompt is
              about <span className="num text-text">{workUnits(TEXT)}</span> units ={" "}
              <span className="num text-text">{eth(jobPriceWei(TEXT, unit))}</span>.
            </p>
          </Step>
          <Step n={3} title="Submit in the playground">
            <p>
              Open the <Link href="/playground" className="link">playground</Link>, describe the image, pick a shape and quality.
              The exact price is shown before you pay. A paid job asks your wallet to sign a message: no gas, nothing moves
              on-chain yet. The price is held from your available balance until the job ends.
            </p>
          </Step>
          <Step n={4} title="Follow its status">
            <Defs
              items={[
                ["queued", "Waiting for two nodes with different owners and the same backend."],
                ["running", "The two nodes are working on it."],
                ["checking", "One result is in; waiting for the second."],
                ["agreed", "The results matched. A paid job is charged at the end of the epoch (every six hours)."],
                ["disagreed", "The results did not match. Not charged, and neither node is paid for it."],
                ["rejected", "The image safety checker flagged it. Not charged."],
                ["expired", `No verdict within ${ttlHours} hours. Not charged.`],
              ]}
            />
          </Step>
          <Step n={5} title="Open your private result">
            <p>
              Only two parties can open an agreed result: this browser, which keeps the job&apos;s read secret, and, for a paid
              job, the wallet that paid, after a gasless sign-in on any device. Knowing the job id is not enough.
            </p>
            <Note tone="warn" title="The two GPUs see your prompt">
              The two nodes that run a job see the prompt and produce the result while they work, and that cannot be recalled.
              Do not submit personal or sensitive text.
            </Note>
          </Step>
          <Step n={6} title="Keep the receipt (paid jobs)">
            <p>
              A paid job shows a receipt under its invoice as soon as the two results are compared. Once the epoch&apos;s charge is
              on-chain the receipt is sealed: save it as a JSON file and choose Verify to check it against the chain yourself, through
              Robinhood Chain&apos;s public RPC rather than Sparecycle. See{" "}
              <Link href="/docs/billing#receipts" className="link">
                job receipts
              </Link>
              .
            </p>
          </Step>
        </Steps>
      </DocsSection>

      <DocsSection id="curl" title="With the API (curl)">
        <p>A free trial job, start to finish. Replace JOB_ID and READ_SECRET with the values from the first answer.</p>
        <Steps>
          <Step n={1} title="Submit a free trial job">
            <CodeBlock label="Terminal (bash, zsh, macOS, Linux, WSL)" code={submit} />
            <CodeBlock label="Answer (201)" code={answer} />
            <p>
              The <C>readSecret</C> is shown once and the scheduler keeps only its hash. Without it, nobody can open a free
              job&apos;s result, you included.
            </p>
          </Step>
          <Step n={2} title="Check its status">
            <CodeBlock label="Terminal" code={status} />
            <p>
              Repeat until <C>status</C> is <C>agreed</C>, <C>disagreed</C>, <C>rejected</C> or <C>expired</C>. A first job can
              wait a minute or two while the project&apos;s own GPUs start.
            </p>
          </Step>
          <Step n={3} title="Read the result">
            <CodeBlock label="Terminal" code={result} />
            <p>
              Text jobs answer <C>text/plain</C>, image jobs <C>image/png</C>. No credentials: <C>401</C>; wrong secret:{" "}
              <C>403</C>; not agreed: <C>409</C>.
            </p>
          </Step>
        </Steps>
        <p>An image job works the same way:</p>
        <CodeBlock label="Terminal: an image job" code={submitImage} />
        <CodeBlock label="Terminal: save the image" code={resultImage} />
        <Note title="Windows">
          In PowerShell, call <C>curl.exe</C> (not <C>curl</C>) and put the JSON in a file: <C>curl.exe -s -X POST {`${api}/jobs`} -H
          &quot;content-type: application/json&quot; -d &quot;@job.json&quot;</C>.
        </Note>
      </DocsSection>

      <DocsSection id="paid-api" title="Paid jobs over the API">
        <p>
          A paid job sends <C>{"{ request, payment }"}</C> instead of the bare request. Your balance must already be in the
          payments contract (deposit on the <Link href="/jobs" className="link">Jobs page</Link>).
        </p>
        <CodeBlock label="Body of POST /api/v1/jobs" code={paidBody} />
        <p>
          <C>signature</C> is an EIP-191 <C>personal_sign</C> by <C>payer</C> of these six lines, joined by newlines. It is valid
          for {JOB_PAYMENT_WINDOW_SECONDS / 60} minutes after <C>issued</C>, and each signature pays for one job only.
        </p>
        <CodeBlock label="The message you sign" code={message} />
        <p>
          The price must match the scheduler&apos;s: work units times <C>priceWeiPerUnit</C> from{" "}
          <C>GET /api/v1/payments/account?address=0x…</C>. If it does not, the answer is <C>409 price-changed</C> with the right{" "}
          <C>priceWei</C>; sign again. Too little available balance gives <C>402 insufficient-balance</C>.
        </p>
        <CodeBlock label="Node.js with viem" code={script} />
        <p>
          Read the result the same way as a free job, with the <C>readSecret</C> from the answer, or with a session of the
          paying wallet (see <Link href="/docs/api#auth" className="link">authentication</Link>). The same credentials read the
          job&apos;s invoice (<C>GET /api/v1/jobs/JOB_ID/invoice</C>) and its receipt (<C>GET /api/v1/jobs/JOB_ID/receipt</C>,{" "}
          <C>409 no-verdict</C> until the results are compared).
        </p>
      </DocsSection>

      <DocsNext
        links={[
          { href: "/docs/billing", title: "Billing", description: "What is held, when you are charged, how to withdraw." },
          { href: "/docs/api", title: "API overview", description: "Every endpoint and how to authenticate." },
        ]}
      />
    </>
  );
}
