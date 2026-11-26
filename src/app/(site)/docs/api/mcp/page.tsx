import type { Metadata } from "next";
import Link from "next/link";
import { ApiDocPage, C, DocSection, DocTable, Example, Unconfirmed } from "@/components/docs/api-doc";
import { config } from "@/lib/config";
import { MCP_LEGACY_VERSIONS, MCP_MODERN_VERSIONS } from "@/server/mcp";

export const metadata: Metadata = {
  title: "MCP server",
  description: "Connect an MCP client or agent to Sparecycle with an API key: submit text and image jobs, check their status, fetch agreed results and read the balance.",
};

/** MCP Inspector version this server was checked with (see docs/agent-api-testing.md). */
const INSPECTOR = "@modelcontextprotocol/inspector@2.16.0";

const host = (config.domain ?? "sparecycle.tech").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const url = `https://${host}/v1/mcp`;

export default function McpDocs() {
  return (
    <ApiDocPage
      current="mcp"
      title="MCP server"
      lead={
        <p>
          Agents that speak the Model Context Protocol can use Sparecycle with the same{" "}
          <Link href="/docs/api/keys" className="link">
            API keys
          </Link>{" "}
          and the same rules as the{" "}
          <Link href="/docs/api/openai" className="link">
            OpenAI-compatible API
          </Link>
          : the key&apos;s daily cap, the off switch, and results only for the key that submitted the job.
        </p>
      }
    >
      <DocSection id="connect" title="Connect">
        <DocTable
          head={["Setting", "Value"]}
          rows={[
            ["Endpoint", <C key="u">{url}</C>],
            ["Also at", <C key="u">https://{host}/api/v1/mcp</C>],
            ["Transport", "Streamable HTTP, stateless: one POST per message, JSON answers, no session, no SSE stream (GET answers 405)"],
            ["Auth", <><C>Authorization: Bearer sck_…</C> on every request; no key, or a disabled or deleted key, answers 401</>],
            [
              "Protocol versions",
              <>
                {MCP_MODERN_VERSIONS.join(", ")} (no handshake; <C>server/discover</C>) and {MCP_LEGACY_VERSIONS.join(", ")} (with <C>initialize</C>)
              </>,
            ],
          ]}
        />
        <p>Most clients take a server URL and request headers. A typical configuration:</p>
        <Example
          label="mcp.json"
          code={`{
  "mcpServers": {
    "sparecycle": {
      "url": "${url}",
      "headers": { "Authorization": "Bearer sck_…" }
    }
  }
}`}
        />
        <Example label="Claude Code" code={`claude mcp add --transport http sparecycle ${url} --header "Authorization: Bearer $SPARECYCLE_API_KEY"`} />
        <Example
          label="MCP Inspector (command line)"
          code={`npx ${INSPECTOR} --cli ${url} --transport http \\
  --header "Authorization: Bearer $SPARECYCLE_API_KEY" --method tools/list`}
        />
        <p>Keep the key out of shared config files: use your client&apos;s secret or environment-variable support where it has one.</p>
      </DocSection>

      <DocSection id="tools" title="Tools">
        <p>
          Exactly four tools. There is no tool to withdraw funds and none to create or change keys. <Unconfirmed id="A12" />
        </p>
        <DocTable
          head={["Tool", "Input", "Output"]}
          rows={[
            [
              <C key="t">submit_job</C>,
              <>
                <C>kind</C> (text | image), <C>model</C> (qwen2.5-1.5b | sd15), <C>prompt</C>; text: <C>system</C>, <C>max_tokens</C>; image: <C>size</C>,{" "}
                <C>negative_prompt</C>, <C>steps</C>, <C>guidance</C>, <C>seed</C>
              </>,
              <>
                <C>job_id</C>, <C>status</C> (queued), <C>price_wei</C>, <C>receipt_url</C>
              </>,
            ],
            [
              <C key="t">get_job_status</C>,
              <C key="i">job_id</C>,
              <>
                <C>status</C>, <C>settled_at</C>, <C>charge_status</C>, <C>price_wei</C>, <C>receipt_url</C> (this key&apos;s jobs only)
              </>,
            ],
            [
              <C key="t">get_job_result</C>,
              <C key="i">job_id</C>,
              <>
                text content, or image content (PNG, base64), then a second text block{" "}
                <C>{`{ "sparecycle": { "job_id", "status", "receipt_url" } }`}</C>; before agreement, a note that it is not ready
              </>,
            ],
            [
              <C key="t">get_balance</C>,
              "none",
              <>
                the key&apos;s wallet: <C>balance_wei</C>, <C>held_wei</C>, <C>available_wei</C>, <C>spend_limit_per_epoch_wei</C>,{" "}
                <C>pending_withdrawal</C>; and the key: <C>daily_cap_wei</C>, <C>spent_today_wei</C>, <C>next_reset_at</C>
              </>,
            ],
          ]}
        />
        <p>
          Jobs are asynchronous: call <C>submit_job</C>, then <C>get_job_status</C> until it says <C>agreed</C>, then <C>get_job_result</C>. Limits and prices
          are the same as on the{" "}
          <Link href="/docs/api/openai#limits" className="link">
            OpenAI-compatible API
          </Link>
          .
        </p>
        <p>
          <C>receipt_url</C> is the job&apos;s receipt (<C>GET /api/v1/jobs/&lt;job_id&gt;/receipt</C>, read with the same key): both nodes&apos; signed
          results, and once the epoch&apos;s charge is on-chain, the proof that ties the job to that charge. See{" "}
          <Link href="/docs/billing" className="link">
            Billing
          </Link>
          .
        </p>
      </DocSection>

      <DocSection id="errors" title="Errors">
        <p>
          Problems with a job are tool errors (<C>isError: true</C>) whose text is JSON: <C>{`{ "error": { "code", "type", "message" } }`}</C>, with the same
          codes as the OpenAI-compatible API. A job the two nodes did not agree on comes back from <C>get_job_result</C> as <C>results_did_not_match</C>,{" "}
          <C>job_expired</C> or <C>content_rejected</C> with type <C>not_charged</C>: nothing was charged for it. Another key&apos;s job is{" "}
          <C>forbidden</C>; a job over the key&apos;s cap for today is <C>key_daily_cap_reached</C>. When no two nodes with different owners can take the
          model now, <C>submit_job</C> fails with <C>no_node_pair</C> and nothing is queued, held or charged; try again later (
          <Link href="/models" className="link">
            Models
          </Link>{" "}
          shows live capacity).
        </p>
        <p>
          A missing or bad key is an HTTP <C>401</C> with a JSON-RPC error. An unknown tool is JSON-RPC error <C>-32602</C>; the protocol&apos;s own errors
          (<C>-32020</C> header mismatch, <C>-32022</C> unsupported protocol version) follow the MCP specification.
        </p>
      </DocSection>
    </ApiDocPage>
  );
}
