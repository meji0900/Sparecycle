// MCP server (docs: /docs/api/mcp): POST /api/v1/mcp (and /v1/mcp), Streamable HTTP, stateless, JSON responses only.
// Agents use the same API keys and rules as the OpenAI-compatible routes (`Authorization: Bearer sck_…` on every
// request: caps, kill switch, payer-only results). Exactly four tools, thin wrappers over ./openai and ./jobs:
// submit_job, get_job_status, get_job_result, get_balance. No withdraw tool and no key-management tool (A12).
//
// No MCP SDK dependency: this file implements the JSON-RPC subset the server needs. Dual-era, per the MCP spec:
//   - modern (2026-07-28): no handshake; every request carries `_meta["io.modelcontextprotocol/protocolVersion"]` and
//     `…/clientCapabilities`, mirrored in the MCP-Protocol-Version / Mcp-Method / Mcp-Name headers (checked: -32020
//     HeaderMismatch); server/discover; an unsupported version answers 400 -32022 with the supported list; an unknown
//     method 404 -32601; results carry resultType "complete" and the server info in `_meta`.
//   - legacy (2025-11-25, 2025-06-18, 2025-03-26): `initialize` negotiates the version (the client's if supported, else
//     the newest legacy one), notifications/initialized answers 202, then ping / tools/list / tools/call. Stateless:
//     no Mcp-Session-Id is minted. A missing MCP-Protocol-Version header means 2025-03-26.
// GET and DELETE answer 405 (no standalone SSE stream, no sessions). JSON-RPC batches are refused. Never logs
// prompts, outputs or keys.
import { LIMITS } from "@/lib/protocol";
import { keySpend } from "./apikeys";
import { apiKeyFromToken, bearerToken, requestHost, type KeyViewer } from "./auth";
import { serverEnv } from "./env";
import { clientIp, PRIVATE_HEADERS, readBody } from "./http";
import { keyJob, type KeyJob } from "./jobs";
import { limitBucket, takeHourly } from "./limits";
import { imageRequest, notCharged, OpenAIError, priceOf, submitForKey, textRequest, toOpenAIError } from "./openai";
import { accountJson } from "./payments";

/** Protocol revisions served. The first modern one is the newest; legacy ones use the initialize handshake. */
export const MCP_MODERN_VERSIONS = ["2026-07-28"] as const;
export const MCP_LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MCP_SUPPORTED_VERSIONS: readonly string[] = [...MCP_MODERN_VERSIONS, ...MCP_LEGACY_VERSIONS];
/** A legacy request without an MCP-Protocol-Version header is this version (Streamable HTTP rule). */
const LEGACY_DEFAULT_VERSION = "2025-03-26";
/** A12 (Default, not yet confirmed by Fabio): exactly these four tools. */
export const MCP_TOOL_NAMES = ["submit_job", "get_job_status", "get_job_result", "get_balance"] as const;
/** get_balance reads the chain (four calls): per key per hour. */
export const MCP_BALANCE_READS_PER_HOUR = 120;
const MAX_BODY_BYTES = 64 * 1024;

export const SERVER_INFO = { name: "sparecycle", title: "Sparecycle", version: "0.1.0" } as const;
const INSTRUCTIONS =
  "Sparecycle runs Qwen2.5-1.5B text jobs and Stable Diffusion 1.5 image jobs on two independent GPU nodes and returns a result only when both agree. " +
  "Jobs are asynchronous: submit_job returns a job_id; call get_job_status until status is agreed, then get_job_result. " +
  "A job is charged to the API key's wallet balance only when the two nodes agree; results_did_not_match, job_expired and content_rejected are never charged. " +
  "Text decoding is always greedy. This server cannot withdraw funds or manage keys.";

// JSON-RPC and MCP error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;
/** Application-defined (outside the JSON-RPC reserved range): missing, unknown or disabled API key. */
export const MCP_AUTH_ERROR = -31001;

type Id = string | number | null;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// ---- Tools ------------------------------------------------------------------------------------------------

const SIDES = Array.from({ length: (LIMITS.image.side.max - LIMITS.image.side.min) / LIMITS.image.side.step + 1 }, (_, i) => LIMITS.image.side.min + i * LIMITS.image.side.step);
const SIZE_PATTERN = `^(${SIDES.join("|")})x(${SIDES.join("|")})$`;
/** Nullable as `anyOf` with single types (portable to clients that map schemas onto a single-`type` dialect). */
const nullable = (type: string) => ({ anyOf: [{ type }, { type: "null" }] });
const jobIdInput = {
  type: "object",
  properties: { job_id: { type: "string", pattern: "^0x[0-9a-f]{64}$", description: "The job_id returned by submit_job." } },
  required: ["job_id"],
  additionalProperties: false,
};

export const MCP_TOOLS = [
  {
    name: "submit_job",
    title: "Submit a job",
    description:
      "Queue one paid job: a short text answer from qwen2.5-1.5b (kind text) or one PNG from sd15 (kind image). Two independent nodes run it; " +
      "the price (price_wei) is charged to the API key's wallet balance only if their results agree. Returns job_id at once; poll get_job_status, then get_job_result. " +
      "Counts against the key's daily cap (UTC day).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["text", "image"] },
        model: { type: "string", enum: ["qwen2.5-1.5b", "sd15"], description: "qwen2.5-1.5b for text, sd15 for image." },
        prompt: { type: "string", minLength: 1, maxLength: LIMITS.text.prompt.max, description: `Text: up to ${LIMITS.text.prompt.max} characters. Image: up to ${LIMITS.image.prompt.max}.` },
        system: { type: "string", maxLength: LIMITS.text.system.max, description: "Text only: a system message." },
        max_tokens: { type: "integer", minimum: LIMITS.text.maxTokens.min, maximum: LIMITS.text.maxTokens.max, description: "Text only. Default 256." },
        size: { type: "string", pattern: SIZE_PATTERN, description: "Image only: <width>x<height>. Default 512x512." },
        negative_prompt: { type: "string", maxLength: LIMITS.image.negative.max, description: "Image only." },
        steps: { type: "integer", minimum: LIMITS.image.steps.min, maximum: LIMITS.image.steps.max, description: "Image only. Default 20." },
        guidance: { type: "number", minimum: LIMITS.image.guidance.min, maximum: LIMITS.image.guidance.max, description: "Image only. Default 7." },
        seed: { type: "integer", minimum: LIMITS.image.seed.min, maximum: LIMITS.image.seed.max, description: "Image only. Chosen by the scheduler when left out." },
      },
      required: ["kind", "model", "prompt"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { job_id: { type: "string" }, status: { type: "string" }, price_wei: { type: "string" } },
      required: ["job_id", "status", "price_wei"],
    },
    annotations: { title: "Submit a job", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "get_job_status",
    title: "Job status",
    description:
      "Status of a job this API key submitted: queued, running, checking, agreed (result ready), or disagreed / expired / rejected (never charged). " +
      "charge_status is pending until the epoch is charged, then charged; released or unpaid jobs are not charged.",
    inputSchema: jobIdInput,
    outputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        kind: { type: "string" },
        status: { type: "string" },
        settled_at: nullable("integer"),
        charge_status: nullable("string"),
        price_wei: nullable("string"),
      },
      required: ["job_id", "kind", "status", "settled_at", "charge_status", "price_wei"],
    },
    annotations: { title: "Job status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_job_result",
    title: "Job result",
    description:
      "The agreed result of a job this API key submitted: text content, or an image (PNG, base64). Before agreement it says the job is not ready. " +
      "A job the nodes did not agree on returns a tool error with code results_did_not_match, job_expired or content_rejected; nothing was charged for it.",
    inputSchema: jobIdInput,
    annotations: { title: "Job result", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_balance",
    title: "Balance",
    description:
      "The API key's wallet in the payments contract (balance, held for unsettled jobs, available, on-chain spend limit per epoch, pending withdrawal) " +
      "and the key's daily cap and what it spent today (UTC). Amounts are wei as decimal strings. Read-only: no tool can withdraw.",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        address: { type: "string" },
        balance_wei: { type: "string" },
        held_wei: { type: "string" },
        available_wei: { type: "string" },
        spend_limit_per_epoch_wei: { type: "string" },
        pending_withdrawal: nullable("object"),
        key: { type: "object" },
      },
      required: ["address", "balance_wei", "held_wei", "available_wei", "spend_limit_per_epoch_wei", "pending_withdrawal", "key"],
    },
    annotations: { title: "Balance", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
] as const;

type ToolResult = { content: Obj[]; structuredContent?: Obj; isError?: boolean };

const ok = (data: Obj): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
const toolError = (code: string, type: string, message: string, extra: Obj = {}): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: { code, type, message, ...extra } }) }],
  isError: true,
});

function onlyKeys(args: Obj, allowed: readonly string[]) {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  if (extra.length) throw new OpenAIError(400, "invalid_request", "invalid_request_error", `unknown argument: ${extra[0]}`, extra[0]);
}

function jobIdArg(args: Obj): string {
  onlyKeys(args, ["job_id"]);
  if (typeof args.job_id !== "string") throw new OpenAIError(400, "invalid_request", "invalid_request_error", "job_id is required", "job_id");
  return args.job_id;
}

async function submitTool(req: Request, key: KeyViewer, args: Obj): Promise<ToolResult> {
  onlyKeys(args, ["kind", "model", "prompt", "system", "max_tokens", "size", "negative_prompt", "steps", "guidance", "seed"]);
  let request;
  if (args.kind === "text") {
    for (const k of ["size", "negative_prompt", "steps", "guidance", "seed"]) {
      if (args[k] !== undefined) throw new OpenAIError(400, "invalid_request", "invalid_request_error", `${k} is for image jobs only`, k);
    }
    request = textRequest({ model: args.model, prompt: args.prompt, system: args.system, maxTokens: args.max_tokens });
  } else if (args.kind === "image") {
    for (const k of ["system", "max_tokens"]) {
      if (args[k] !== undefined) throw new OpenAIError(400, "invalid_request", "invalid_request_error", `${k} is for text jobs only`, k);
    }
    request = imageRequest({
      model: args.model,
      prompt: args.prompt,
      size: args.size,
      negative: args.negative_prompt,
      steps: args.steps,
      guidance: args.guidance,
      seed: args.seed,
    });
  } else {
    throw new OpenAIError(400, "invalid_request", "invalid_request_error", 'kind must be "text" or "image"', "kind");
  }
  const sub = await submitForKey(key, request, { surface: "mcp", ip: clientIp(req), idempotencyKey: null, bodyText: JSON.stringify(args) });
  return ok({ job_id: sub.jobId, status: "queued", price_wei: priceOf(request) });
}

function statusTool(key: KeyViewer, args: Obj): ToolResult {
  const job = keyJob(jobIdArg(args), key);
  return ok({ job_id: job.id, kind: job.kind, status: job.status, settled_at: job.settledAt, charge_status: job.chargeStatus, price_wei: job.priceWei });
}

function resultTool(key: KeyViewer, args: Obj): ToolResult {
  const job: KeyJob = keyJob(jobIdArg(args), key, { withOutput: true });
  const nc = notCharged(job);
  if (nc) return toolError(nc.code, nc.type, nc.message, { job_id: job.id, status: job.status, charged: false });
  if (job.status !== "agreed" || !job.output) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ job_id: job.id, status: job.status, ready: false, message: "Not finished yet: call get_job_status again in a few seconds." }),
        },
      ],
    };
  }
  if (job.kind === "image") {
    return { content: [{ type: "image", data: Buffer.from(job.output.body).toString("base64"), mimeType: "image/png" }] };
  }
  return { content: [{ type: "text", text: Buffer.from(job.output.body).toString("utf8") }] };
}

async function balanceTool(key: KeyViewer, args: Obj): Promise<ToolResult> {
  onlyKeys(args, []);
  takeHourly(limitBucket("mcp-balance", key.keyId), MCP_BALANCE_READS_PER_HOUR, "balance reads per API key");
  const a = await accountJson(key.owner);
  const s = keySpend(key.keyId);
  return ok({
    address: a.address,
    balance_wei: a.balance,
    held_wei: a.held,
    available_wei: a.available,
    spend_limit_per_epoch_wei: a.spendLimitPerEpoch,
    pending_withdrawal: a.withdrawal,
    key: {
      key_id: key.keyId,
      daily_cap_wei: s.cap.toString(),
      spent_today_wei: s.spent.toString(),
      remaining_today_wei: s.remaining.toString(),
      day: s.day,
      next_reset_at: s.nextResetAt,
    },
  });
}

/** Runs a tool. Input and business errors are tool execution errors (isError) with the OpenAI-style code and type. */
export async function callTool(req: Request, key: KeyViewer, name: string, args: Obj): Promise<ToolResult> {
  try {
    if (name === "submit_job") return await submitTool(req, key, args);
    if (name === "get_job_status") return statusTool(key, args);
    if (name === "get_job_result") return resultTool(key, args);
    return await balanceTool(key, args);
  } catch (e) {
    const err = toOpenAIError(e);
    return toolError(err.code, err.type, err.message, err.param ? { param: err.param } : {});
  }
}

// ---- Transport ----------------------------------------------------------------------------------------------

function rpcResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const res = new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? headers : { "content-type": "application/json; charset=utf-8", ...headers },
  });
  for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
  return res;
}

const rpcError = (status: number, id: Id, code: number, message: string, data?: unknown, headers: Record<string, string> = {}) =>
  rpcResponse(status, { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } }, headers);

/** Origin is allowed when absent (non-browser clients), the requested host, or an AUTH_DOMAIN host. */
function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  return host === requestHost(req) || serverEnv.authDomains().includes(host);
}

/** `=?base64?…?=` header values (Mcp-Name) decode to their UTF-8 text. */
function headerValue(v: string | null): string | null {
  if (v === null) return null;
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  return m ? Buffer.from(m[1], "base64").toString("utf8") : v;
}

/** POST /api/v1/mcp */
export async function handleMcp(req: Request): Promise<Response> {
  if (!originAllowed(req)) return rpcError(403, null, INVALID_REQUEST, "Origin not allowed");
  let text: string;
  try {
    text = await readBody(req, MAX_BODY_BYTES);
  } catch {
    return rpcError(413, null, INVALID_REQUEST, `the body is larger than ${MAX_BODY_BYTES} bytes`);
  }
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return rpcError(400, null, PARSE_ERROR, "Parse error");
  }
  if (Array.isArray(msg)) return rpcError(400, null, INVALID_REQUEST, "JSON-RPC batches are not supported: send one message per POST");
  if (!isObj(msg) || msg.jsonrpc !== "2.0") return rpcError(400, null, INVALID_REQUEST, "Invalid Request: expected one JSON-RPC 2.0 message");
  const hasId = "id" in msg && msg.id !== undefined;
  const id: Id = hasId && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
  if (hasId && id === null) return rpcError(400, null, INVALID_REQUEST, "Invalid Request: id must be a string or a number");
  const method = typeof msg.method === "string" ? msg.method : null;

  // Every message needs a valid API key (the kill switch acts on the next request).
  const key = apiKeyFromToken(bearerToken(req));
  if (!key) {
    return rpcError(401, id, MCP_AUTH_ERROR, "Unauthorized: send a Sparecycle API key (Authorization: Bearer sck_…). Unknown, disabled and deleted keys are refused.", undefined, {
      "www-authenticate": 'Bearer realm="sparecycle"',
    });
  }

  if (method === null) return rpcResponse(202, null); // a JSON-RPC response from a legacy client: nothing to answer
  if (!hasId) return rpcResponse(202, null); // notifications (notifications/initialized, notifications/cancelled, …)
  const params = isObj(msg.params) ? msg.params : {};
  const meta = isObj(params._meta) ? params._meta : null;
  const metaVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
  const headerVersion = req.headers.get("mcp-protocol-version");

  if (typeof metaVersion === "string") return modern(req, key, id, method, params, meta!, metaVersion, headerVersion);
  return legacy(req, key, id, method, params, headerVersion);
}

async function modern(req: Request, key: KeyViewer, id: Id, method: string, params: Obj, meta: Obj, version: string, headerVersion: string | null) {
  if (headerVersion === null) return rpcError(400, id, HEADER_MISMATCH, "Header mismatch: the MCP-Protocol-Version header is missing");
  if (headerVersion !== version) return rpcError(400, id, HEADER_MISMATCH, "Header mismatch: MCP-Protocol-Version does not match _meta protocolVersion");
  if (!(MCP_MODERN_VERSIONS as readonly string[]).includes(version)) {
    return rpcError(400, id, UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: MCP_SUPPORTED_VERSIONS, requested: version });
  }
  if (!isObj(meta["io.modelcontextprotocol/clientCapabilities"])) {
    return rpcError(400, id, INVALID_PARAMS, "Invalid params: _meta io.modelcontextprotocol/clientCapabilities is required");
  }
  const mcpMethod = req.headers.get("mcp-method");
  if (mcpMethod === null) return rpcError(400, id, HEADER_MISMATCH, "Header mismatch: the Mcp-Method header is missing");
  if (mcpMethod !== method) return rpcError(400, id, HEADER_MISMATCH, "Header mismatch: Mcp-Method does not match the request method");
  if (method === "tools/call") {
    const name = headerValue(req.headers.get("mcp-name"));
    if (name === null) return rpcError(400, id, HEADER_MISMATCH, "Header mismatch: the Mcp-Name header is missing");
    if (name !== params.name) return rpcError(400, id, HEADER_MISMATCH, "Header mismatch: Mcp-Name does not match params.name");
  }
  const result = (r: Obj) =>
    rpcResponse(200, { jsonrpc: "2.0", id, result: { resultType: "complete", ...r, _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } } });
  switch (method) {
    case "server/discover":
      return result({ supportedVersions: MCP_SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: MCP_TOOLS });
    case "tools/call":
      return call(req, key, id, params, result);
    default:
      return rpcError(404, id, METHOD_NOT_FOUND, "Method not found");
  }
}

async function legacy(req: Request, key: KeyViewer, id: Id, method: string, params: Obj, headerVersion: string | null) {
  const result = (r: Obj) => rpcResponse(200, { jsonrpc: "2.0", id, result: r });
  if (method === "initialize") {
    const asked = params.protocolVersion;
    const version = typeof asked === "string" && (MCP_LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_LEGACY_VERSIONS[0];
    return result({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
  }
  const version = headerVersion ?? LEGACY_DEFAULT_VERSION;
  if ((MCP_MODERN_VERSIONS as readonly string[]).includes(version)) {
    return rpcError(400, id, INVALID_PARAMS, "Invalid params: _meta io.modelcontextprotocol/protocolVersion is required in this protocol version");
  }
  if (!(MCP_LEGACY_VERSIONS as readonly string[]).includes(version)) {
    return rpcError(400, id, UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: MCP_SUPPORTED_VERSIONS, requested: version });
  }
  switch (method) {
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: MCP_TOOLS });
    case "tools/call":
      return call(req, key, id, params, result);
    default:
      return rpcError(200, id, METHOD_NOT_FOUND, "Method not found");
  }
}

async function call(req: Request, key: KeyViewer, id: Id, params: Obj, result: (r: Obj) => Response) {
  const name = params.name;
  if (typeof name !== "string" || !(MCP_TOOL_NAMES as readonly string[]).includes(name)) {
    return rpcError(200, id, INVALID_PARAMS, `Unknown tool. Tools: ${MCP_TOOL_NAMES.join(", ")}`);
  }
  const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
  if (!isObj(args)) return rpcError(200, id, INVALID_PARAMS, "Invalid params: arguments must be an object");
  return result(await callTool(req, key, name, args));
}
