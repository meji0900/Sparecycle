// OpenAI-compatible API (docs: /docs/api/openai). An OpenAI SDK user changes only `baseURL` (https://<host>/v1 or
// /api/v1) and uses a Sparecycle API key (`Authorization: Bearer sck_…`, see ./apikeys) to run the two live models
// through the two-node check:
//
//   POST /v1/chat/completions          qwen2.5-1.5b  -> a text job      GET /v1/chat/completions/chatcmpl-<jobId>  poll
//   POST /v1/images/generations        sd15          -> an image job    GET /v1/images/generations/img-<jobId>     poll
//   GET  /v1/models                    the two models, nothing else
//
// Async by default: a create answers 202 with the OpenAI object shape and empty `choices` / `data` plus a `sparecycle`
// block (job id, status, price, poll path). A poll answers 200 with the same shape, filled once two nodes agreed. The
// three final "not charged" outcomes (results did not match, no verdict within the TTL, safety checker) are 422
// errors of type `not_charged`, only on a poll or a `Prefer: wait` create, never a made-up answer. `Prefer: wait=<s>`
// (RFC 7240) holds a create or poll up to API_MAX_WAIT_SECONDS. `Idempotency-Key` makes a retried create return the
// first job. Nothing is streamed (`stream: true` -> 400): no byte of output exists before two nodes agree.
//
// Never invents numbers: no `usage` (the scheduler has no token counts), `finish_reason` is always "stop" with
// `sparecycle.finish_reason_reported: false`, and text decoding is greedy on the nodes whatever `temperature` says.
// Prompts are never echoed back or logged.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { jobPriceWei } from "@/lib/job-payment";
import { LIMITS, MODEL_IDS, MODELS, parseJobRequest, SpecError, type JobRequest, type JobStatus, type ModelId } from "@/lib/protocol";
import { keyFromRequest } from "./apikeys";
import { bearerToken, requestHost, type KeyViewer } from "./auth";
import { getDb, nowSec } from "./db";
import { POLICY, serverEnv } from "./env";
import { ApiError, clientIp, PRIVATE_HEADERS, privateJson, readBody } from "./http";
import { jobStatusOf, jobView, keyJob, secretJob, submitJob, X402_CHARGE_STATUS, type KeyJob } from "./jobs";
import { priceWeiPerUnit } from "./payments";
import { isX402Job, x402Applies, x402Pay, x402PaymentInfo } from "./x402";

/** A6 (Default, not yet confirmed by Fabio): at most one `system` message, then exactly one `user` message. No multi-turn. */
export const CHAT_MAX_SYSTEM_MESSAGES = 1;
export const CHAT_USER_MESSAGES = 1;
/** A7 (Default, not yet confirmed by Fabio): `max_tokens` when the request has none (inside LIMITS.text.maxTokens). */
export const DEFAULT_MAX_TOKENS = 256;
/** A8 (Default, not yet confirmed by Fabio): image `response_format` when the request has none. */
export const DEFAULT_IMAGE_RESPONSE_FORMAT = "b64_json" as const;
/** Image `size` when the request has none (brief 2.4). */
export const DEFAULT_IMAGE_SIZE = "512x512";
/** Image `steps` when the request has none: the default of the /jobs form. Not a decision of the brief (open item). */
export const DEFAULT_IMAGE_STEPS = 20;
/** A10 (Default, not yet confirmed by Fabio): an Idempotency-Key is remembered for the job TTL. */
export const IDEMPOTENCY_WINDOW_SECONDS = POLICY.jobTtlSeconds;
/** A11 (Default, not yet confirmed by Fabio): no single-chunk streaming after agreement in this batch. */
export const STREAMING_AFTER_AGREEMENT = false;
/** How often a `Prefer: wait` request looks at its job again. */
export const WAIT_POLL_MS = 500;
const MAX_IDEMPOTENCY_KEY_CHARS = 255;
const FINAL: readonly JobStatus[] = ["agreed", "disagreed", "expired", "rejected"];

export type Surface = "chat" | "images" | "mcp";
type ImageFormat = "b64_json" | "url";

// ---- Errors (OpenAI shape) --------------------------------------------------------------------------

/** An error answered as { error: { message, type, param, code } } (plus an optional `sparecycle` block). */
export class OpenAIError extends Error {
  status: number;
  type: string;
  code: string;
  param: string | null;
  headers: Record<string, string>;
  sparecycle?: Record<string, unknown>;
  constructor(status: number, code: string, type: string, message: string, param: string | null = null, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.type = type;
    this.param = param;
    this.headers = headers;
  }
}

const invalid = (message: string, param: string | null, code = "invalid_request") => new OpenAIError(400, code, "invalid_request_error", message, param);

/** Status, code and type of each scheduler error code (brief 2.7). */
const FROM_API: Record<string, [number, string, string]> = {
  "invalid-api-key": [401, "invalid_api_key", "authentication_error"],
  "auth-required": [401, "invalid_api_key", "authentication_error"],
  forbidden: [403, "forbidden", "permission_error"],
  "invalid-job": [400, "invalid_request", "invalid_request_error"],
  "invalid-json": [400, "invalid_request", "invalid_request_error"],
  "body-too-large": [413, "invalid_request", "invalid_request_error"],
  "invalid-job-id": [404, "not_found", "invalid_request_error"],
  "unknown-job": [404, "not_found", "invalid_request_error"],
  "insufficient-balance": [402, "insufficient_balance", "billing_error"],
  "key-daily-cap": [429, "key_daily_cap_reached", "rate_limit_error"],
  "rate-limited": [429, "rate_limited", "rate_limit_error"],
  "queue-full": [503, "queue_full", "server_error"],
  "payments-off": [503, "payments_off", "server_error"],
  "api-keys-off": [503, "api_keys_off", "server_error"],
  // x402 (./x402; only thrown while X402_ENABLED=1)
  "payment-in-progress": [409, "payment_in_progress", "invalid_request_error"],
  "payment-used": [409, "payment_used", "invalid_request_error"],
  "payment-refunded": [409, "payment_refunded", "invalid_request_error"],
  "payment-pending": [503, "payment_pending", "server_error"],
  "x402-off": [503, "x402_off", "server_error"],
  "x402-unavailable": [503, "x402_unavailable", "server_error"],
  "x402-paused": [503, "x402_paused", "server_error"],
  "x402-over-cap": [400, "x402_amount_over_cap", "invalid_request_error"],
};

/** Job-spec fields -> the OpenAI parameter they came from. */
const PARAM_OF: Record<string, string> = {
  prompt: "prompt",
  negative: "negative_prompt",
  width: "size",
  height: "size",
  steps: "steps",
  guidance: "guidance",
  seed: "seed",
  maxTokens: "max_tokens",
  system: "messages",
};

export function toOpenAIError(e: unknown): OpenAIError {
  if (e instanceof OpenAIError) return e;
  if (e instanceof ApiError) {
    const [status, code, type] = FROM_API[e.code] ?? [e.status >= 500 ? e.status : 400, e.code.replace(/-/g, "_"), e.status >= 500 ? "server_error" : "invalid_request_error"];
    const field = typeof e.extra?.field === "string" ? e.extra.field : null;
    const headers: Record<string, string> = {};
    if (code === "key_daily_cap_reached") headers["x-should-retry"] = "false"; // it can't succeed before the UTC reset
    if (status === 401) headers["www-authenticate"] = 'Bearer realm="sparecycle"';
    if (typeof e.extra?.retryAfter === "number") headers["retry-after"] = String(e.extra.retryAfter);
    const err = new OpenAIError(status, code, type, e.message, field ? (PARAM_OF[field] ?? field) : null, headers);
    if (code === "key_daily_cap_reached" || code === "insufficient_balance") {
      err.sparecycle = Object.fromEntries(
        Object.entries(e.extra ?? {}).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]),
      );
    }
    return err;
  }
  console.error(`[sparecycle] openai route internal error: ${e instanceof Error ? e.message : String(e)}`);
  return new OpenAIError(500, "internal_error", "server_error", "The scheduler hit an internal error.");
}

export function errorJson(e: OpenAIError): Response {
  const body: Record<string, unknown> = { error: { message: e.message, type: e.type, param: e.param, code: e.code } };
  if (e.sparecycle) body.sparecycle = e.sparecycle;
  return privateJson(body, e.status, e.headers);
}

/** Like handlePrivate (./http), with every error in the OpenAI shape. Every response is `private, no-store`. */
export function handleOpenAI<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    let res: Response;
    try {
      res = await fn(...args);
    } catch (e) {
      res = errorJson(toOpenAIError(e));
    }
    for (const [k, v] of Object.entries(PRIVATE_HEADERS)) res.headers.set(k, v);
    return res;
  };
}

/** The API key of a request; 401 invalid_api_key without one (no sessions, no read secrets on these routes). */
export function requireKey(req: Request): KeyViewer {
  const key = keyFromRequest(req);
  if (!key) {
    throw new OpenAIError(401, "invalid_api_key", "authentication_error", "Send a Sparecycle API key: Authorization: Bearer sck_…", null, {
      "www-authenticate": 'Bearer realm="sparecycle"',
    });
  }
  return key;
}

// ---- Request mapping --------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const present = (b: Obj, k: string) => b[k] !== undefined && b[k] !== null;

function modelOf(v: unknown, want: ModelId): ModelId {
  if (v === undefined || v === null) throw invalid(`model is required: ${want}`, "model");
  if (typeof v !== "string") throw invalid("model must be a string", "model");
  if (v === want) return want;
  if ((MODEL_IDS as string[]).includes(v)) {
    throw invalid(
      want === "sd15" ? "qwen2.5-1.5b is a text model: use POST /v1/chat/completions" : "sd15 is an image model: use POST /v1/images/generations",
      "model",
    );
  }
  throw new OpenAIError(404, "model_not_found", "invalid_request_error", `Unknown model. Available models: ${MODEL_IDS.join(", ")}.`, "model");
}

function rejectStream(b: Obj) {
  if (b.stream === true) {
    throw invalid("stream is not supported: nothing is sent before two nodes agree. Leave stream unset and poll.", "stream", "streaming_not_supported");
  }
  if (present(b, "stream") && typeof b.stream !== "boolean") throw invalid("stream must be a boolean", "stream");
}

function intIn(v: unknown, param: string, lim: { min: number; max: number }): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lim.min || v > lim.max) {
    throw invalid(`${param} must be a whole number in ${lim.min}..${lim.max}`, param);
  }
  return v;
}

/** Validates a job request built from OpenAI fields; job-spec errors come back with the OpenAI parameter name. */
function checked(request: JobRequest, paramOf: Record<string, string>): JobRequest {
  try {
    return parseJobRequest(request);
  } catch (e) {
    if (e instanceof SpecError) throw invalid(e.message.replace(/^(\w+)/, paramOf[e.field] ?? PARAM_OF[e.field] ?? e.field), paramOf[e.field] ?? PARAM_OF[e.field] ?? e.field);
    throw e;
  }
}

/** A text job from plain fields (chat completions and MCP submit_job). */
export function textRequest(p: { model: unknown; prompt: unknown; system?: unknown; maxTokens?: unknown }, params = { prompt: "prompt", system: "system", maxTokens: "max_tokens" }) {
  const model = modelOf(p.model, "qwen2.5-1.5b");
  const maxTokens = p.maxTokens === undefined || p.maxTokens === null ? DEFAULT_MAX_TOKENS : intIn(p.maxTokens, params.maxTokens, LIMITS.text.maxTokens);
  if (typeof p.prompt !== "string") throw invalid(`${params.prompt} must be a string`, params.prompt);
  if (p.system !== undefined && p.system !== null && typeof p.system !== "string") throw invalid(`${params.system} must be a string`, params.system);
  const request: JobRequest = { kind: "text", params: { model: model as "qwen2.5-1.5b", prompt: p.prompt, system: (p.system as string | undefined) ?? "", maxTokens } };
  return checked(request, params);
}

/** An image job from plain fields (images/generations and MCP submit_job). */
export function imageRequest(p: { model: unknown; prompt: unknown; size?: unknown; negative?: unknown; steps?: unknown; guidance?: unknown; seed?: unknown }) {
  const model = modelOf(p.model, "sd15");
  if (typeof p.prompt !== "string") throw invalid("prompt must be a string", "prompt");
  const size = p.size === undefined || p.size === null ? DEFAULT_IMAGE_SIZE : p.size;
  const L = LIMITS.image;
  const m = typeof size === "string" ? /^(\d{1,4})x(\d{1,4})$/.exec(size) : null;
  const sideOk = (n: number) => n >= L.side.min && n <= L.side.max && n % L.side.step === 0;
  if (!m || !sideOk(Number(m[1])) || !sideOk(Number(m[2]))) {
    throw invalid(`size must be "<width>x<height>" with each side ${L.side.min}..${L.side.max} in steps of ${L.side.step}`, "size");
  }
  if (p.negative !== undefined && p.negative !== null && typeof p.negative !== "string") throw invalid("negative_prompt must be a string", "negative_prompt");
  const steps = p.steps === undefined || p.steps === null ? DEFAULT_IMAGE_STEPS : intIn(p.steps, "steps", L.steps);
  if (p.guidance !== undefined && p.guidance !== null && (typeof p.guidance !== "number" || !Number.isFinite(p.guidance) || p.guidance < L.guidance.min || p.guidance > L.guidance.max)) {
    throw invalid(`guidance must be a number in ${L.guidance.min}..${L.guidance.max}`, "guidance");
  }
  const seed = p.seed === undefined || p.seed === null ? null : intIn(p.seed, "seed", L.seed);
  const request: JobRequest = {
    kind: "image",
    params: {
      model: model as "sd15",
      prompt: p.prompt,
      negative: (p.negative as string | undefined) ?? "",
      width: Number(m[1]),
      height: Number(m[2]),
      steps,
      guidance: (p.guidance as number | undefined) ?? L.guidance.default,
      seed,
    },
  };
  return checked(request, {});
}

/** POST /v1/chat/completions body -> a text job (brief 2.4). */
export function chatRequest(body: unknown): JobRequest {
  if (!isObj(body)) throw invalid("the body must be a JSON object", null);
  const model = modelOf(body.model, "qwen2.5-1.5b"); // 404 model_not_found before anything else
  rejectStream(body);
  if (present(body, "n") && body.n !== 1) throw invalid("n must be 1: one job gives one answer", "n");
  for (const k of ["tools", "functions"]) {
    if (present(body, k) && !(Array.isArray(body[k]) && (body[k] as unknown[]).length === 0)) throw invalid(`${k} are not supported`, k);
  }
  for (const k of ["tool_choice", "function_call"]) {
    if (present(body, k) && body[k] !== "none") throw invalid(`${k} is not supported`, k);
  }
  if (present(body, "response_format") && !(isObj(body.response_format) && body.response_format.type === "text")) {
    throw invalid('response_format must be { "type": "text" }: structured output is not supported', "response_format");
  }
  if (body.logprobs === true) throw invalid("logprobs are not supported", "logprobs");
  if (present(body, "top_logprobs")) throw invalid("top_logprobs is not supported", "top_logprobs");
  if (present(body, "seed")) throw invalid("seed is not accepted for text: the nodes use a fixed seed and greedy decoding", "seed");
  if (present(body, "audio")) throw invalid("audio output is not supported", "audio");
  for (const k of ["temperature", "top_p"]) {
    // Accepted and ignored: decoding is greedy on the nodes (the answer says so in sparecycle.decoding).
    if (present(body, k) && (typeof body[k] !== "number" || !Number.isFinite(body[k] as number))) throw invalid(`${k} must be a number`, k);
  }
  const a = body.max_tokens;
  const c = body.max_completion_tokens;
  if (a !== undefined && a !== null && c !== undefined && c !== null && a !== c) {
    throw invalid("max_tokens and max_completion_tokens differ; send one of them", "max_completion_tokens");
  }
  const maxParam = c !== undefined && c !== null ? "max_completion_tokens" : "max_tokens";
  const maxTokens = c !== undefined && c !== null ? c : a;

  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) throw invalid("messages must be a non-empty array", "messages");
  let system: string | null = null;
  let user: string | null = null;
  let userAt = -1;
  let systems = 0;
  msgs.forEach((raw, i) => {
    if (!isObj(raw)) throw invalid("each message must be an object", `messages[${i}]`);
    const role = raw.role;
    if (role !== "system" && role !== "user") {
      throw invalid(
        `only ${CHAT_MAX_SYSTEM_MESSAGES} optional system message and ${CHAT_USER_MESSAGES} user message are supported (no multi-turn, no ${String(role)} role)`,
        `messages[${i}].role`,
      );
    }
    if (typeof raw.content !== "string") throw invalid("content must be a string; content parts are not supported", `messages[${i}].content`);
    if (role === "system") {
      if (++systems > CHAT_MAX_SYSTEM_MESSAGES || user !== null) {
        throw invalid(`at most ${CHAT_MAX_SYSTEM_MESSAGES} system message, before the user message`, `messages[${i}].role`);
      }
      system = raw.content;
    } else {
      if (user !== null) throw invalid(`exactly ${CHAT_USER_MESSAGES} user message is supported (no multi-turn)`, `messages[${i}].role`);
      user = raw.content;
      userAt = i;
    }
  });
  if (user === null) throw invalid("messages must contain one user message", "messages");
  const sysAt = system === null ? -1 : 0;
  return textRequest(
    { model, prompt: user, system, maxTokens: maxTokens ?? null },
    { prompt: `messages[${userAt}].content`, system: `messages[${sysAt}].content`, maxTokens: maxParam },
  );
}

/** POST /v1/images/generations body -> an image job and the response format (brief 2.4). */
export function imagesRequest(body: unknown): { request: JobRequest; format: ImageFormat } {
  if (!isObj(body)) throw invalid("the body must be a JSON object", null);
  const model = modelOf(body.model, "sd15");
  rejectStream(body);
  if (present(body, "partial_images") && body.partial_images !== 0) throw invalid("partial_images is not supported", "partial_images");
  if (present(body, "n") && body.n !== 1) throw invalid("n must be 1: one job gives one image", "n");
  for (const k of ["quality", "style", "background"]) if (present(body, k)) throw invalid(`${k} is not supported`, k);
  if (present(body, "output_format") && body.output_format !== "png") throw invalid('output_format must be "png"', "output_format");
  const format = present(body, "response_format") ? body.response_format : DEFAULT_IMAGE_RESPONSE_FORMAT;
  if (format !== "b64_json" && format !== "url") throw invalid('response_format must be "b64_json" or "url"', "response_format");
  const request = imageRequest({
    model,
    prompt: body.prompt,
    size: body.size,
    negative: body.negative_prompt,
    steps: body.steps,
    guidance: body.guidance,
    seed: body.seed,
  });
  return { request, format };
}

// ---- Submit with idempotency ---------------------------------------------------------------------------

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The Idempotency-Key header (1..255 visible ASCII characters) or null. */
export function idempotencyKeyOf(req: Request): string | null {
  const v = req.headers.get("idempotency-key");
  if (v === null) return null;
  if (v.length < 1 || v.length > MAX_IDEMPOTENCY_KEY_CHARS || !/^[\x21-\x7e]+$/.test(v)) {
    throw invalid(`Idempotency-Key must be 1..${MAX_IDEMPOTENCY_KEY_CHARS} visible ASCII characters`, null);
  }
  return v;
}

type ApiRequestRow = { job_id: Hex; surface: Surface; body_hash: string; response_format: ImageFormat | null; created_at: number };

/** The job an earlier create with the same key + Idempotency-Key made, or null. A different body answers 400. */
function replayOf(keyId: string, idem: string, surface: Surface, bodyHash: string): ApiRequestRow | null {
  const db = getDb();
  const row = db.prepare("SELECT job_id, surface, body_hash, response_format, created_at FROM api_requests WHERE key_id = ? AND idempotency_key = ?").get(keyId, idem) as
    | ApiRequestRow
    | undefined;
  if (!row) return null;
  if (row.created_at < nowSec() - IDEMPOTENCY_WINDOW_SECONDS) {
    db.prepare("UPDATE api_requests SET idempotency_key = NULL WHERE job_id = ?").run(row.job_id); // window over: a new job
    return null;
  }
  if (row.surface !== surface || row.body_hash !== bodyHash) {
    throw invalid("this Idempotency-Key was already used with a different request body", null, "idempotency_key_reused");
  }
  return row;
}

/**
 * Submits a key-paid job and records the create call (surface, body hash, Idempotency-Key, image format) in the same
 * transaction. With an Idempotency-Key seen before (same key, same body, within IDEMPOTENCY_WINDOW_SECONDS) no new job
 * is made: `replayed` is true and the first job is returned.
 */
export async function submitForKey(
  key: KeyViewer,
  request: JobRequest,
  o: { surface: Surface; ip: string; idempotencyKey: string | null; bodyText: string; format?: ImageFormat | null },
): Promise<{ jobId: Hex; replayed: boolean; format: ImageFormat | null }> {
  const bodyHash = sha256(o.bodyText);
  if (o.idempotencyKey) {
    const hit = replayOf(key.keyId, o.idempotencyKey, o.surface, bodyHash);
    if (hit) return { jobId: hit.job_id, replayed: true, format: hit.response_format };
  }
  const record = (db: DatabaseSync, jobId: Hex) =>
    db
      .prepare("INSERT INTO api_requests (job_id, key_id, surface, idempotency_key, body_hash, response_format, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(jobId, key.keyId, o.surface, o.idempotencyKey, bodyHash, o.format ?? null, nowSec());
  try {
    const job = await submitJob(request, o.ip, { key, onInsert: record });
    return { jobId: job.id, replayed: false, format: o.format ?? null };
  } catch (e) {
    // Two concurrent creates with one Idempotency-Key: the second transaction rolled back whole (no job, no hold).
    if (o.idempotencyKey && e instanceof Error && /UNIQUE constraint failed: api_requests/.test(e.message)) {
      const hit = replayOf(key.keyId, o.idempotencyKey, o.surface, bodyHash);
      if (hit) return { jobId: hit.job_id, replayed: true, format: hit.response_format };
    }
    throw e;
  }
}

/** The response format an image job was created with (A8 default when unknown). */
export function formatOf(jobId: string): ImageFormat {
  const row = getDb().prepare("SELECT response_format FROM api_requests WHERE job_id = ?").get(jobId) as { response_format: ImageFormat | null } | undefined;
  if (row?.response_format) return row.response_format;
  // An x402 job keeps its format with its escrow record (./x402).
  const x = getDb().prepare("SELECT response_format FROM x402_escrows WHERE job_id = ?").get(jobId) as { response_format: ImageFormat | null } | undefined;
  return x?.response_format ?? DEFAULT_IMAGE_RESPONSE_FORMAT;
}

// ---- Prefer: wait ----------------------------------------------------------------------------------------

/** Seconds asked for with `Prefer: wait=<seconds>` (RFC 7240), capped at API_MAX_WAIT_SECONDS; 0 = no wait. */
export function preferWait(req: Request): number {
  const h = req.headers.get("prefer");
  if (!h) return 0;
  for (const part of h.split(/[,;]/)) {
    const m = /^\s*wait\s*=\s*"?(\d{1,6})"?\s*$/i.exec(part);
    if (m) return Math.min(Number(m[1]), serverEnv.apiMaxWaitSeconds());
  }
  return 0;
}

/** Waits until the job has a verdict, `seconds` pass or the client goes away. */
export async function waitForVerdict(jobId: string, seconds: number, signal?: AbortSignal) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until && !signal?.aborted) {
    const s = jobStatusOf(jobId);
    if (s === null || FINAL.includes(s)) return;
    await new Promise((r) => setTimeout(r, Math.min(WAIT_POLL_MS, Math.max(0, until - Date.now()))));
  }
}

// ---- Response shapes ---------------------------------------------------------------------------------------

export const chatId = (jobId: string) => `chatcmpl-${jobId}`;
export const imageId = (jobId: string) => `img-${jobId}`;
const chatPoll = (jobId: string) => `/v1/chat/completions/${chatId(jobId)}`;
const imagePoll = (jobId: string) => `/v1/images/generations/${imageId(jobId)}`;

/** The job id inside `chatcmpl-0x…` / `img-0x…`; 404 for anything else. */
export function jobIdFrom(raw: string, prefix: "chatcmpl-" | "img-"): string {
  const m = new RegExp(`^${prefix}(0x[0-9a-f]{64})$`).exec(raw);
  if (!m) throw new OpenAIError(404, "not_found", "invalid_request_error", `No such object: ids look like ${prefix}0x… (64 hex characters).`);
  return m[1];
}

/**
 * A final outcome that was never charged, as a 422 `not_charged` error (brief 2.7); null for any other status.
 * 422 is not in the OpenAI SDKs' retry list, so a client does not resubmit by itself.
 */
export function notCharged(job: Pick<KeyJob, "id" | "status" | "note"> & Partial<Pick<KeyJob, "chargeStatus">>): OpenAIError | null {
  const outcome: Partial<Record<JobStatus, [string, string]>> = {
    disagreed: ["results_did_not_match", "The results of the two nodes did not match, so there is no answer. Nothing was charged for this job."],
    expired:
      job.note === "cancelled: API key disabled"
        ? ["job_expired", "The job was cancelled before it ran because its API key was disabled. Nothing was charged for this job."]
        : ["job_expired", "No verdict was reached within the job time limit. Nothing was charged for this job."],
    rejected: ["content_rejected", "A node's safety checker rejected the image, so there is no output. Nothing was charged for this job."],
  };
  const hit = outcome[job.status];
  if (!hit) return null;
  const x402 = job.chargeStatus === X402_CHARGE_STATUS;
  const message = x402 ? hit[1].replace("Nothing was charged for this job.", "The payment held in escrow is refunded to the payer.") : hit[1];
  const err = new OpenAIError(422, hit[0], "not_charged", message, null, { "x-should-retry": "false" });
  err.sparecycle = { job_id: job.id, status: job.status, charged: false, note: job.note, ...(x402 ? { x402: x402PaymentInfo(job.id) } : {}) };
  return err;
}

function sparecycleOf(job: KeyJob, poll: string) {
  return {
    job_id: job.id,
    status: job.status,
    price_wei: job.priceWei,
    work_units: job.workUnits,
    charge_status: job.chargeStatus,
    settled_at: job.settledAt,
    poll,
  };
}

/** chat.completion object of a key's text job: empty `choices` until agreed. */
export function chatObject(job: KeyJob) {
  const done = job.status === "agreed" && job.output;
  return {
    id: chatId(job.id),
    object: "chat.completion",
    created: job.createdAt,
    model: job.model,
    choices: done
      ? [
          {
            index: 0,
            message: { role: "assistant", content: Buffer.from(job.output!.body).toString("utf8"), refusal: null },
            finish_reason: "stop",
            logprobs: null,
          },
        ]
      : [],
    sparecycle: { ...sparecycleOf(job, chatPoll(job.id)), decoding: "greedy", finish_reason_reported: false },
  };
}

/** Absolute URL of a job's gated result (needs the same Bearer key). */
function resultUrl(req: Request, jobId: string) {
  const proto = (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(/:$/, "")).split(",")[0].trim() || "https";
  return `${proto}://${requestHost(req)}/api/v1/jobs/${jobId}/result`;
}

/** images response of a key's image job: empty `data` until agreed. */
export function imagesObject(req: Request, job: KeyJob, format: ImageFormat) {
  const done = job.status === "agreed" && job.output;
  return {
    created: job.createdAt,
    data: done ? [format === "url" ? { url: resultUrl(req, job.id) } : { b64_json: Buffer.from(job.output!.body).toString("base64") }] : [],
    output_format: "png",
    size: job.width && job.height ? `${job.width}x${job.height}` : undefined,
    sparecycle: { ...sparecycleOf(job, imagePoll(job.id)), id: imageId(job.id), response_format: format },
  };
}

/** 200 with the finished object, 202 while it runs (create only), or the 422 not_charged error. */
function answer(job: KeyJob, body: unknown, create: boolean, headers: Record<string, string>): Response {
  const nc = notCharged(job);
  if (nc) {
    nc.headers = { ...nc.headers, ...headers };
    return errorJson(nc);
  }
  return privateJson(body, create && job.status !== "agreed" ? 202 : 200, headers);
}

// ---- Handlers (routes stay thin) -------------------------------------------------------------------------

async function bodyOf(req: Request): Promise<{ text: string; json: unknown }> {
  const text = await readBody(req, POLICY.maxJobBodyBytes);
  try {
    return { text, json: text.trim() === "" ? {} : JSON.parse(text) };
  } catch {
    throw invalid("the body is not valid JSON", null);
  }
}

/**
 * Once a job is queued the create call never fails with a retryable status (an SDK retry could pay for a second job):
 * anything that goes wrong after the submit answers the plain 202 queued object.
 */
async function created(req: Request, key: KeyViewer, jobId: string, replayed: boolean, render: (job: KeyJob) => unknown) {
  const headers: Record<string, string> = replayed ? { "idempotent-replayed": "true" } : {};
  const wait = preferWait(req);
  try {
    if (wait > 0) {
      await waitForVerdict(jobId, wait, req.signal);
      headers["preference-applied"] = `wait=${wait}`;
    }
    const job = keyJob(jobId, key, { withOutput: true });
    return answer(job, render(job), true, headers);
  } catch {
    const row = getDb().prepare("SELECT created_at, price_wei, model, kind, work_units FROM jobs WHERE id = ?").get(jobId) as {
      created_at: number;
      price_wei: string;
      model: string;
      kind: "text" | "image";
      work_units: number;
    };
    const job: KeyJob = {
      id: jobId as Hex,
      kind: row.kind,
      model: row.model,
      status: "queued",
      createdAt: row.created_at,
      settledAt: null,
      workUnits: row.work_units,
      priceWei: row.price_wei,
      chargeStatus: "pending",
      note: null,
      width: null,
      height: null,
      output: null,
    };
    return privateJson(render(job), 202, headers);
  }
}

// ---- x402 (./x402; only while X402_ENABLED=1 and configured) -------------------------------------------------------

/**
 * A create call without any Authorization header while x402 is on: 402 with PAYMENT-REQUIRED, or, with a valid
 * PAYMENT-SIGNATURE, the paid job's 202 answer with PAYMENT-RESPONSE and `sparecycle.read_secret` (given once). Once the
 * job is queued nothing can turn the answer into an error: the secret is the payer's only API credential for the job.
 */
async function createX402(req: Request, surface: "chat" | "images"): Promise<Response> {
  const body = await bodyOf(req);
  const parsed = surface === "chat" ? { request: chatRequest(body.json), format: null } : imagesRequest(body.json);
  const out = await x402Pay(req, parsed.request, { surface, bodyText: body.text, format: parsed.format, ip: clientIp(req) });
  if (out.kind === "required") return privateJson(out.body, out.status, out.headers);
  const format = (out.format ?? parsed.format ?? DEFAULT_IMAGE_RESPONSE_FORMAT) as ImageFormat;
  const render = (job: KeyJob) => {
    const o = (surface === "chat" ? chatObject(job) : imagesObject(req, job, format)) as { sparecycle: Record<string, unknown> };
    o.sparecycle = { ...o.sparecycle, x402: x402PaymentInfo(job.id), read_secret: out.readSecret };
    return o;
  };
  const headers: Record<string, string> = { "payment-response": out.paymentResponse };
  try {
    const wait = preferWait(req);
    if (wait > 0) {
      await waitForVerdict(out.jobId, wait, req.signal);
      headers["preference-applied"] = `wait=${wait}`;
    }
    const job = jobView(out.jobId, { withOutput: true });
    return answer(job, render(job), true, headers);
  } catch {
    const job = jobView(out.jobId); // the plain queued answer, with the secret
    return privateJson(render({ ...job, status: "queued", settledAt: null, output: null }), 202, headers);
  }
}

/**
 * Who reads a polled job: an API key; or the read secret of an x402 job (any other Bearer token, only for a job that has
 * an x402 escrow record). For every other request this is exactly requireKey(), with the same errors in the same order.
 */
function readerOf(req: Request, rawId: string, prefix: "chatcmpl-" | "img-"): { key: KeyViewer } | { secret: string } {
  const key = keyFromRequest(req);
  if (key) return { key };
  const token = bearerToken(req);
  const id = new RegExp(`^${prefix}(0x[0-9a-f]{64})$`).exec(rawId)?.[1];
  if (token && id && isX402Job(id)) return { secret: token };
  return { key: requireKey(req) };
}

const readJob = (req: Request, r: { key: KeyViewer } | { secret: string }, id: string, withOutput = false): KeyJob =>
  "key" in r ? keyJob(id, r.key, { withOutput }) : secretJob(id, r.secret, clientIp(req), { withOutput });

/** The x402 block added to a polled x402 job. */
function withX402<T>(job: KeyJob, body: T): T {
  if (job.chargeStatus !== X402_CHARGE_STATUS) return body;
  const o = body as { sparecycle: Record<string, unknown> };
  o.sparecycle = { ...o.sparecycle, x402: x402PaymentInfo(job.id) };
  return body;
}

/** POST /v1/chat/completions */
export async function createChat(req: Request): Promise<Response> {
  if (x402Applies(req)) return createX402(req, "chat");
  const key = requireKey(req);
  const idem = idempotencyKeyOf(req);
  const body = await bodyOf(req);
  const request = chatRequest(body.json);
  const { jobId, replayed } = await submitForKey(key, request, { surface: "chat", ip: clientIp(req), idempotencyKey: idem, bodyText: body.text });
  return created(req, key, jobId, replayed, chatObject);
}

/** GET /v1/chat/completions/chatcmpl-<jobId> */
export async function pollChat(req: Request, rawId: string): Promise<Response> {
  const reader = readerOf(req, rawId, "chatcmpl-");
  const jobId = jobIdFrom(rawId, "chatcmpl-");
  let job = readJob(req, reader, jobId);
  if (job.kind !== "text") throw new OpenAIError(404, "not_found", "invalid_request_error", "No chat completion with this id.");
  const headers: Record<string, string> = {};
  const wait = preferWait(req);
  if (wait > 0 && !FINAL.includes(job.status)) {
    await waitForVerdict(jobId, wait, req.signal);
    headers["preference-applied"] = `wait=${wait}`;
  }
  job = readJob(req, reader, jobId, true);
  return answer(job, withX402(job, chatObject(job)), false, headers);
}

/** POST /v1/images/generations */
export async function createImage(req: Request): Promise<Response> {
  if (x402Applies(req)) return createX402(req, "images");
  const key = requireKey(req);
  const idem = idempotencyKeyOf(req);
  const body = await bodyOf(req);
  const { request, format } = imagesRequest(body.json);
  const sub = await submitForKey(key, request, { surface: "images", ip: clientIp(req), idempotencyKey: idem, bodyText: body.text, format });
  return created(req, key, sub.jobId, sub.replayed, (job) => imagesObject(req, job, sub.format ?? format));
}

/** GET /v1/images/generations/img-<jobId> (a Sparecycle extension: OpenAI has no such call). */
export async function pollImage(req: Request, rawId: string): Promise<Response> {
  const reader = readerOf(req, rawId, "img-");
  const jobId = jobIdFrom(rawId, "img-");
  let job = readJob(req, reader, jobId);
  if (job.kind !== "image") throw new OpenAIError(404, "not_found", "invalid_request_error", "No image generation with this id.");
  const headers: Record<string, string> = {};
  const wait = preferWait(req);
  if (wait > 0 && !FINAL.includes(job.status)) {
    await waitForVerdict(jobId, wait, req.signal);
    headers["preference-applied"] = `wait=${wait}`;
  }
  job = readJob(req, reader, jobId, true);
  return answer(job, withX402(job, imagesObject(req, job, formatOf(jobId))), false, headers);
}

/** GET /v1/models — exactly the two live models. `created` is left out: no release date is published for them. */
export function modelsList(req: Request) {
  requireKey(req);
  return {
    object: "list",
    data: MODEL_IDS.map((id) => ({
      id,
      object: "model",
      owned_by: MODELS[id].source.split("/")[0],
      sparecycle: {
        kind: MODELS[id].kind,
        label: MODELS[id].label,
        license: MODELS[id].license,
        source: MODELS[id].source,
        endpoint: MODELS[id].kind === "text" ? "/v1/chat/completions" : "/v1/images/generations",
        price_wei_per_work_unit: priceWeiPerUnit().toString(),
      },
    })),
  };
}

/** The quoted price of a request (same rule as POST /api/v1/jobs). */
export const priceOf = (request: JobRequest) => jobPriceWei(request, priceWeiPerUnit()).toString();
