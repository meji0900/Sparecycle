import type { Metadata } from "next";
import Link from "next/link";
import { ApiDocPage, C, DocSection, DocTable, Example, Unconfirmed } from "@/components/docs/api-doc";
import { config } from "@/lib/config";
import { LIMITS } from "@/lib/protocol";
import { serverEnv } from "@/server/env";
import { DEFAULT_IMAGE_RESPONSE_FORMAT, DEFAULT_IMAGE_SIZE, DEFAULT_IMAGE_STEPS, DEFAULT_MAX_TOKENS, IDEMPOTENCY_WINDOW_SECONDS } from "@/server/openai";

export const metadata: Metadata = {
  title: "OpenAI-compatible API",
  description:
    "Run Qwen2.5-1.5B text and Stable Diffusion 1.5 images through Sparecycle's two-node check with the official OpenAI SDKs: change the base URL and use a Sparecycle API key.",
};

// The Prefer: wait cap is a server setting (API_MAX_WAIT_SECONDS); read it per request.
export const dynamic = "force-dynamic";

/** SDK versions these examples were run against (see docs/agent-api-testing.md). */
const JS_SDK = "openai@7.64.0";
const PY_SDK = "openai==3.59.0";

const host = (config.domain ?? "sparecycle.tech").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const base = `https://${host}/v1`;

export default function OpenAiDocs() {
  const maxWait = serverEnv.apiMaxWaitSeconds();
  const T = LIMITS.text;
  const I = LIMITS.image;
  return (
    <ApiDocPage
      current="openai"
      title="OpenAI-compatible API"
      lead={
        <p>
          Point an OpenAI SDK at <C>{base}</C> (or <C>https://{host}/api/v1</C>) and use a Sparecycle{" "}
          <Link href="/docs/api/keys" className="link">
            API key
          </Link>
          . Two models only: <C>qwen2.5-1.5b</C> for chat and <C>sd15</C> for images. Every job runs on two independent nodes and you get an answer only when
          both agree; if they don&apos;t, you get an error that says nothing was charged, never a made-up answer.
        </p>
      }
    >
      <DocSection id="async" title="Async by default: create, then poll">
        <p>
          A create call answers <C>202</C> right away with the usual OpenAI object and an empty <C>choices</C> (chat) or <C>data</C> (images), plus a{" "}
          <C>sparecycle</C> block: <C>job_id</C>, <C>status</C>, <C>price_wei</C> and the <C>poll</C> path. Poll that path until <C>choices</C> /{" "}
          <C>data</C> is filled. For chat, the SDKs&apos; <C>chat.completions.retrieve(id)</C> is the poll.
        </p>
        <p>
          To wait instead, send <C>Prefer: wait=&lt;seconds&gt;</C> (RFC 7240) on a create or poll: the server holds the request until the job has a verdict
          or the time is up, and answers <C>200</C> with the finished object, or the <C>202</C> object if it is still running. The wait is capped at{" "}
          <strong className="text-text">{maxWait} seconds</strong> on this server (<C>API_MAX_WAIT_SECONDS</C>). The cap must stay below the hosting
          platform&apos;s request timeout, which has not been confirmed yet, so it may change. <Unconfirmed id="A9" />
        </p>
        <p>
          Nothing is streamed: <C>stream: true</C> is refused with <C>400 streaming_not_supported</C>, because no part of an answer exists before two nodes
          agree. <Unconfirmed id="A11" />
        </p>
      </DocSection>

      <DocSection id="retries" title="Retries and Idempotency-Key">
        <p>
          The OpenAI SDKs retry some failures on their own (408, 409, 429, 5xx and connection errors, twice by default). A retried create could queue and pay
          for a second job. Two rules keep that from happening:
        </p>
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          <li>Once a job is queued, the create call never answers with a retryable status.</li>
          <li>
            Send an <C>Idempotency-Key</C> header (1 to 255 visible characters, unique per job). The same key with the same body within{" "}
            {IDEMPOTENCY_WINDOW_SECONDS / 3600} hours returns the first job (with <C>Idempotent-Replayed: true</C>); the same key with another body is
            refused with <C>400 idempotency_key_reused</C>. <Unconfirmed id="A10" />
          </li>
        </ul>
        <p>
          Send an <C>Idempotency-Key</C> with every create, or set <C>maxRetries: 0</C> (JS) / <C>max_retries=0</C> (Python) for create calls.
        </p>
      </DocSection>

      <DocSection id="js" title="JavaScript / TypeScript (official SDK)">
        <p>
          Tested with <C>{JS_SDK}</C>.
        </p>
        <Example
          label="chat.mjs"
          code={`import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${base}", apiKey: process.env.SPARECYCLE_API_KEY });

// 202: choices is [] until two nodes agree. The Idempotency-Key makes the SDK's own retries safe.
const created = await client.chat.completions.create(
  { model: "qwen2.5-1.5b", messages: [{ role: "user", content: "Name three colours." }], max_tokens: 64 },
  { headers: { "Idempotency-Key": crypto.randomUUID() } },
);
console.log(created.id, created.sparecycle.status, created.sparecycle.price_wei);

for (;;) {
  try {
    const done = await client.chat.completions.retrieve(created.id, { headers: { Prefer: "wait=20" } });
    if (done.choices.length) {
      console.log(done.choices[0].message.content);
      break;
    }
  } catch (e) {
    // 422 = the nodes did not agree, no verdict in time, or a rejected image: nothing was charged.
    if (e instanceof OpenAI.APIError && e.status === 422) {
      console.log("not charged:", e.code);
      break;
    }
    throw e;
  }
}`}
        />
        <Example
          label="images.mjs"
          code={`import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${base}", apiKey: process.env.SPARECYCLE_API_KEY });

// steps, guidance, negative_prompt and seed are Sparecycle fields: plain extra body fields in JS.
const created = await client.images.generate(
  { model: "sd15", prompt: "a lighthouse at dusk, oil painting", size: "512x512", steps: 20 },
  { headers: { "Idempotency-Key": crypto.randomUUID() } },
);

// The OpenAI SDKs have no call to poll an image: use the generic GET.
let image;
do {
  image = await client.get(created.sparecycle.poll.replace(/^\\/v1/, ""), { headers: { Prefer: "wait=20" } });
} while (!image.data.length);
await import("node:fs").then((fs) => fs.writeFileSync("out.png", Buffer.from(image.data[0].b64_json, "base64")));`}
        />
        <p>
          In TypeScript, <C>sparecycle</C> is not in the SDK&apos;s types: read it as <C>(created as any).sparecycle</C>, and pass the extra image fields in
          an object typed as <C>any</C>.
        </p>
      </DocSection>

      <DocSection id="python" title="Python (official SDK)">
        <p>
          Tested with <C>{PY_SDK}</C>.
        </p>
        <Example
          label="chat.py"
          code={`import os, time, uuid
from openai import OpenAI, APIStatusError

client = OpenAI(base_url="${base}", api_key=os.environ["SPARECYCLE_API_KEY"])

created = client.chat.completions.create(
    model="qwen2.5-1.5b",
    messages=[{"role": "user", "content": "Name three colours."}],
    max_tokens=64,
    extra_headers={"Idempotency-Key": str(uuid.uuid4())},
)
print(created.id, created.model_extra["sparecycle"]["status"])

while True:
    try:
        done = client.chat.completions.retrieve(created.id, extra_headers={"Prefer": "wait=20"})
    except APIStatusError as e:
        if e.status_code == 422:  # not charged: results did not match, expired or rejected
            print("not charged:", e.body)
            break
        raise
    if done.choices:
        print(done.choices[0].message.content)
        break
    time.sleep(2)`}
        />
        <Example
          label="images.py"
          code={`import base64, os, uuid
from openai import OpenAI

client = OpenAI(base_url="${base}", api_key=os.environ["SPARECYCLE_API_KEY"])

created = client.images.generate(
    model="sd15",
    prompt="a lighthouse at dusk, oil painting",
    size="512x512",
    extra_body={"steps": 20, "negative_prompt": "blurry"},
    extra_headers={"Idempotency-Key": str(uuid.uuid4())},
)
poll = created.model_extra["sparecycle"]["poll"].removeprefix("/v1")
while True:
    image = client.get(poll, cast_to=object, options={"headers": {"Prefer": "wait=20"}})
    if image["data"]:
        break
with open("out.png", "wb") as f:
    f.write(base64.b64decode(image["data"][0]["b64_json"]))`}
        />
      </DocSection>

      <DocSection id="curl" title="curl">
        <Example
          label="curl"
          code={`curl -s ${base}/chat/completions \\
  -H "Authorization: Bearer $SPARECYCLE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"model":"qwen2.5-1.5b","messages":[{"role":"user","content":"Name three colours."}],"max_tokens":64}'
# 202 {"id":"chatcmpl-0x…","object":"chat.completion","choices":[],"sparecycle":{"job_id":"0x…","status":"queued",…}}

curl -s ${base}/chat/completions/chatcmpl-0x… \\
  -H "Authorization: Bearer $SPARECYCLE_API_KEY" -H "Prefer: wait=20"

curl -s ${base}/models -H "Authorization: Bearer $SPARECYCLE_API_KEY"`}
        />
      </DocSection>

      <DocSection id="limits" title="What each model accepts">
        <DocTable
          head={["Chat: qwen2.5-1.5b", "Accepted"]}
          rows={[
            [<C key="k">messages</C>, `at most one system message (up to ${T.system.max} characters), then exactly one user message (${T.prompt.min} to ${T.prompt.max} characters); string content only, no multi-turn`],
            [<C key="k">max_tokens</C>, <>
              {T.maxTokens.min} to {T.maxTokens.max}; default {DEFAULT_MAX_TOKENS} <Unconfirmed id="A7" /> (<C>max_completion_tokens</C> works too)
            </>],
            [<C key="k">temperature, top_p</C>, <>accepted and ignored: decoding is always greedy on the nodes, and every answer says <C>sparecycle.decoding: &quot;greedy&quot;</C></>],
            ["refused (400)", <>
              <C>stream: true</C>, <C>n</C> other than 1, <C>tools</C> / <C>functions</C>, <C>response_format</C> other than text, <C>logprobs</C>, <C>seed</C>, content parts
            </>],
          ]}
        />
        <DocTable
          head={["Images: sd15", "Accepted"]}
          rows={[
            [<C key="k">prompt</C>, `${I.prompt.min} to ${I.prompt.max} characters`],
            [<C key="k">size</C>, `"<width>x<height>", each side ${I.side.min} to ${I.side.max} in steps of ${I.side.step}; default ${DEFAULT_IMAGE_SIZE}`],
            [<C key="k">response_format</C>, <>
              <C>b64_json</C> (default) <Unconfirmed id="A8" /> or <C>url</C>: the authenticated <C>/api/v1/jobs/&lt;id&gt;/result</C>, which needs the same key ({DEFAULT_IMAGE_RESPONSE_FORMAT} when left out)
            </>],
            [<>Sparecycle fields (<C>extra_body</C>)</>, <>
              <C>negative_prompt</C> up to {I.negative.max} characters, <C>steps</C> {I.steps.min} to {I.steps.max} (default {DEFAULT_IMAGE_STEPS}), <C>guidance</C> {I.guidance.min} to {I.guidance.max} (default {I.guidance.default}), <C>seed</C> 0 to {I.seed.max} (chosen by the scheduler when left out)
            </>],
            ["refused (400)", <><C>n</C> other than 1, <C>quality</C>, <C>style</C>, <C>background</C>, <C>stream: true</C>, an <C>output_format</C> other than png</>],
          ]}
        />
        <p>
          Any other model name answers <C>404 model_not_found</C>. <C>GET /v1/models</C> lists exactly the two models. The price is the same as on{" "}
          <Link href="/jobs" className="link">
            Submit a job
          </Link>
          : work units times the price per unit, in <C>sparecycle.price_wei</C>.
        </p>
      </DocSection>

      <DocSection id="answers" title="What an answer contains, and what it doesn't">
        <ul className="list-disc space-y-2 pl-5 marker:text-faint">
          <li>
            No <C>usage</C> object: the scheduler does not count tokens, and no number is made up. <C>sparecycle.work_units</C> is given instead (the unit
            the price is computed from).
          </li>
          <li>
            <C>finish_reason</C> is always <C>&quot;stop&quot;</C>: the nodes do not report why generation stopped, and{" "}
            <C>sparecycle.finish_reason_reported: false</C> says so.
          </li>
          <li>Your prompt is never echoed back. Results are returned only to the key that submitted the job, or to your wallet&apos;s sign-in.</li>
          <li>Models have no <C>created</C> date in <C>/v1/models</C>: no release date is published for them here.</li>
        </ul>
      </DocSection>

      <DocSection id="errors" title="Errors">
        <p>
          Errors use the OpenAI shape <C>{`{ "error": { "message", "type", "param", "code" } }`}</C>. Every answer carries <C>Cache-Control: private, no-store</C>.
        </p>
        <DocTable
          head={["HTTP", "code", "type", "When"]}
          rows={[
            ["401", <C key="c">invalid_api_key</C>, "authentication_error", "missing, unknown, disabled or deleted key"],
            ["403", <C key="c">forbidden</C>, "permission_error", "the job was submitted by another key or wallet"],
            ["404", <C key="c">model_not_found</C>, "invalid_request_error", "a model other than qwen2.5-1.5b or sd15"],
            ["400", <C key="c">invalid_request</C>, "invalid_request_error", <>a parameter outside the limits above; <C>param</C> names it</>],
            ["400", <C key="c">streaming_not_supported</C>, "invalid_request_error", <><C>stream: true</C></>],
            ["400", <C key="c">idempotency_key_reused</C>, "invalid_request_error", "the Idempotency-Key was used with another body"],
            ["402", <C key="c">insufficient_balance</C>, "billing_error", "available balance below the price"],
            ["429", <C key="c">key_daily_cap_reached</C>, "rate_limit_error", <>the key&apos;s cap for today (UTC) is used up; answered with <C>x-should-retry: false</C></>],
            ["429", <C key="c">rate_limited</C>, "rate_limit_error", "more paid jobs per hour from one wallet than allowed"],
            ["503", <C key="c">queue_full</C>, "server_error", "the job queue is full; nothing was queued"],
            ["422", <C key="c">results_did_not_match</C>, "not_charged", "the two nodes' results differ (poll only)"],
            ["422", <C key="c">job_expired</C>, "not_charged", "no verdict within the job time limit, or the key was disabled before the job ran (poll only)"],
            ["422", <C key="c">content_rejected</C>, "not_charged", "a node's safety checker rejected the image (poll only)"],
          ]}
        />
        <p>
          The three <C>422 not_charged</C> outcomes come only from a poll (or a create with <C>Prefer: wait</C>), never as a fake completion. 422 is not in
          the SDKs&apos; retry list, so a client does not resubmit on its own. Nothing is charged for these jobs.
        </p>
      </DocSection>
    </ApiDocPage>
  );
}
