// OpenAPI 3.1 fragments for the agent API (API keys, OpenAI-compatible routes, MCP endpoint). Not a full document:
// the integrator merges `agentApiPaths` into the paths of /api/v1/openapi.json and `agentApiComponents` into its
// components. Paths are under /api/v1; the same routes answer under /v1 through a rewrite.
import { LIMITS } from "./protocol";

const json = (schema: object, description = "OK") => ({ description, content: { "application/json": { schema } } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const keyErr = (description: string) => json(ref("KeyError"), description);
const oaiErr = (description: string) => json(ref("OpenAIError"), description);
const PRIVATE = { "Cache-Control": { description: "Always `private, no-store`.", schema: { type: "string" } } };
const session = [{ walletSession: [] }];
const apiKey = [{ apiKey: [] }];
const idParam = { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{16}$" }, description: "Key id (16 hex characters)." };
const preferHeader = {
  name: "Prefer",
  in: "header",
  required: false,
  schema: { type: "string", example: "wait=20" },
  description: "RFC 7240 `wait=<seconds>`: hold the request until the job has a verdict, capped by API_MAX_WAIT_SECONDS.",
};
const idemHeader = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  schema: { type: "string", minLength: 1, maxLength: 255 },
  description: "Same key + same body within the job TTL returns the first job instead of queuing another one.",
};
const notCharged = oaiErr("Not charged: `results_did_not_match`, `job_expired` or `content_rejected` (type `not_charged`).");
/**
 * x402 pay-per-job (src/server/x402.ts): answered only where the scheduler has X402_ENABLED=1 (off by default). Capped
 * launch, INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED.
 */
const X402_NOTE =
  "Only where x402 is switched on (X402_ENABLED, off by default; capped launch, INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED): a request with no Authorization header at all is paid per job with x402 v2 instead of an API key.";
const paymentSignatureHeader = {
  name: "PAYMENT-SIGNATURE",
  in: "header",
  required: false,
  schema: { type: "string", description: "base64 of the JSON X402PaymentPayload" },
  description: `${X402_NOTE} The x402 payment for this request: an EIP-3009 TransferWithAuthorization to the escrow (payTo) for exactly the quoted amount.`,
};
const x402Created = "With x402: also a PAYMENT-RESPONSE header (base64 X402SettleResponse; `transaction` = the escrow funding) and `sparecycle.read_secret` (given once: send it as Bearer on the poll URL).";
const x402Responses = {
  402: oaiErr(
    `\`insufficient_balance\` (an API key whose wallet cannot pay). ${X402_NOTE} Without any Authorization header: \`x402_payment_required\` or \`x402_payment_rejected\`, with a PAYMENT-REQUIRED header (base64 X402PaymentRequired, also in the body's \`x402\` field).`,
  ),
  409: oaiErr("x402 only: `payment_used` (that authorization already paid; one answer for every replay), `payment_in_progress`, `payment_refunded`."),
};

export const agentApiPaths = {
  "/api/v1/keys": {
    get: {
      summary: "List the signed-in wallet's API keys",
      tags: ["API keys"],
      security: session,
      responses: { 200: { ...json(ref("ApiKeyList")), headers: PRIVATE }, 401: { description: "No wallet session (empty body)." } },
    },
    post: {
      summary: "Create a pending API key and get its link message",
      tags: ["API keys"],
      security: session,
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["dailyCapWei"],
              properties: { label: { type: "string", maxLength: 64 }, dailyCapWei: { type: "string", pattern: "^\\d{1,30}$" } },
            },
          },
        },
      },
      responses: {
        201: json(ref("PendingKey"), "Pending key; the wallet signs `linkMessage` (EIP-191), then POST /api/v1/keys/{id}/activate."),
        401: { description: "No wallet session (empty body)." },
        409: keyErr("`max-keys`: the wallet has the maximum number of active or pending keys."),
        429: keyErr("`rate-limited`: too many key creations this hour."),
        503: keyErr("`payments-off` or `api-keys-off`."),
      },
    },
  },
  "/api/v1/keys/{id}/activate": {
    post: {
      summary: "Activate a pending key with the wallet's link signature; returns the full key once",
      tags: ["API keys"],
      security: session,
      parameters: [idParam],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", required: ["signature"], properties: { signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$" } } } } },
      },
      responses: {
        200: json({ allOf: [ref("ApiKey"), { type: "object", properties: { key: { type: "string", description: "sck_<keyId>_<secret>. Shown once." }, shownOnce: { const: true } } }] }),
        400: keyErr("`bad-link-signature`."),
        401: { description: "No wallet session (empty body)." },
        404: keyErr("`unknown-key`."),
        409: keyErr("`not-pending` or `max-keys`."),
        410: keyErr("`pending-key-expired`: create a new key."),
      },
    },
  },
  "/api/v1/keys/{id}": {
    patch: {
      summary: "Relabel, lower or raise the daily cap, disable or re-enable a key",
      description:
        "Raising the cap answers 409 `link-signature-required` with `linkMessage` and `issued`; sign the message and send `{ dailyCapWei, issued, signature }`.",
      tags: ["API keys"],
      security: session,
      parameters: [idParam],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                label: { type: "string", maxLength: 64 },
                dailyCapWei: { type: "string", pattern: "^\\d{1,30}$" },
                status: { enum: ["active", "disabled"] },
                issued: { type: "integer" },
                signature: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        200: json({ allOf: [ref("ApiKey"), { type: "object", properties: { cancelledJobs: { type: "integer" } } }] }),
        400: keyErr("`invalid-key`, `bad-link-signature` or `stale-link-signature`."),
        401: { description: "No wallet session (empty body)." },
        404: keyErr("`unknown-key`."),
        409: keyErr("`link-signature-required` (with linkMessage, issued), `max-keys`, `not-active`."),
      },
    },
    delete: {
      summary: "Delete a key (kill switch: queued jobs are cancelled and never charged)",
      tags: ["API keys"],
      security: session,
      parameters: [idParam],
      responses: {
        200: json({ type: "object", properties: { ok: { const: true }, keyId: { type: "string" }, status: { const: "deleted" }, cancelledJobs: { type: "integer" } } }),
        401: { description: "No wallet session (empty body)." },
        404: keyErr("`unknown-key`."),
      },
    },
  },
  "/api/v1/keys/disable-all": {
    post: {
      summary: "Disable every active key of the signed-in wallet",
      tags: ["API keys"],
      security: session,
      responses: {
        200: json({ type: "object", properties: { ok: { const: true }, disabled: { type: "integer" }, cancelledJobs: { type: "integer" } } }),
        401: { description: "No wallet session (empty body)." },
      },
    },
  },
  "/api/v1/chat/completions": {
    post: {
      summary: "Create a chat completion job (qwen2.5-1.5b); async, 202 by default",
      tags: ["OpenAI-compatible"],
      security: apiKey,
      description: `${X402_NOTE} See X402PaymentRequired.`,
      parameters: [preferHeader, idemHeader, paymentSignatureHeader],
      requestBody: { required: true, content: { "application/json": { schema: ref("ChatCompletionRequest") } } },
      responses: {
        200: json(ref("ChatCompletion"), "Agreed within the Prefer: wait time."),
        202: json(ref("ChatCompletion"), "Queued: `choices` is empty; poll `sparecycle.poll`. " + x402Created),
        400: oaiErr("`invalid_request` (param set), `streaming_not_supported`, `idempotency_key_reused`; x402 only: `x402_amount_over_cap`."),
        401: oaiErr("`invalid_api_key`."),
        ...x402Responses,
        404: oaiErr("`model_not_found`."),
        422: notCharged,
        429: oaiErr("`key_daily_cap_reached` or `rate_limited`."),
        503: oaiErr("`queue_full`, `payments_off`, `api_keys_off`; x402 only: `x402_unavailable`, `x402_paused`, `payment_pending`."),
      },
    },
  },
  "/api/v1/chat/completions/{id}": {
    get: {
      summary: "Poll a chat completion job (what chat.completions.retrieve calls)",
      description: "With the API key that created it; an x402 job with its read secret (Bearer) instead.",
      tags: ["OpenAI-compatible"],
      security: apiKey,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^chatcmpl-0x[0-9a-f]{64}$" } }, preferHeader],
      responses: {
        200: json(ref("ChatCompletion"), "`choices` filled once two nodes agree, empty before."),
        401: oaiErr("`invalid_api_key`."),
        403: oaiErr("`forbidden`: another key's job."),
        404: oaiErr("`not_found`."),
        422: notCharged,
      },
    },
  },
  "/api/v1/images/generations": {
    post: {
      summary: "Create an image job (sd15); async, 202 by default",
      tags: ["OpenAI-compatible"],
      security: apiKey,
      description: `${X402_NOTE} See X402PaymentRequired.`,
      parameters: [preferHeader, idemHeader, paymentSignatureHeader],
      requestBody: { required: true, content: { "application/json": { schema: ref("ImageRequest") } } },
      responses: {
        200: json(ref("ImagesResponse"), "Agreed within the Prefer: wait time."),
        202: json(ref("ImagesResponse"), "Queued: `data` is empty; poll `sparecycle.poll`. " + x402Created),
        400: oaiErr("`invalid_request` (param set), `streaming_not_supported`, `idempotency_key_reused`; x402 only: `x402_amount_over_cap`."),
        401: oaiErr("`invalid_api_key`."),
        ...x402Responses,
        404: oaiErr("`model_not_found`."),
        422: notCharged,
        429: oaiErr("`key_daily_cap_reached` or `rate_limited`."),
        503: oaiErr("`queue_full`; x402 only: `x402_unavailable`, `x402_paused`, `payment_pending`."),
      },
    },
  },
  "/api/v1/images/generations/{id}": {
    get: {
      summary: "Poll an image job (Sparecycle extension)",
      description: "With the API key that created it; an x402 job with its read secret (Bearer) instead.",
      tags: ["OpenAI-compatible"],
      security: apiKey,
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^img-0x[0-9a-f]{64}$" } }, preferHeader],
      responses: {
        200: json(ref("ImagesResponse"), "`data` filled once two nodes agree (b64_json or url, as chosen at create)."),
        401: oaiErr("`invalid_api_key`."),
        403: oaiErr("`forbidden`."),
        404: oaiErr("`not_found`."),
        422: notCharged,
      },
    },
  },
  "/api/v1/models": {
    get: {
      summary: "The two models",
      tags: ["OpenAI-compatible"],
      security: apiKey,
      responses: {
        200: json({
          type: "object",
          properties: {
            object: { const: "list" },
            data: {
              type: "array",
              items: { type: "object", properties: { id: { enum: ["qwen2.5-1.5b", "sd15"] }, object: { const: "model" }, owned_by: { type: "string" }, sparecycle: { type: "object" } } },
            },
          },
        }),
        401: oaiErr("`invalid_api_key`."),
      },
    },
  },
  "/api/v1/mcp": {
    post: {
      summary: "MCP server (Streamable HTTP, stateless, JSON answers)",
      description:
        "One JSON-RPC 2.0 message per POST. Tools: submit_job, get_job_status, get_job_result, get_balance. Protocol 2026-07-28 (per-request _meta, server/discover) and the initialize-based 2025-11-25, 2025-06-18 and 2025-03-26.",
      tags: ["MCP"],
      security: apiKey,
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["jsonrpc"], properties: { jsonrpc: { const: "2.0" } } } } } },
      responses: {
        200: json({ type: "object", description: "JSON-RPC response." }),
        202: { description: "A notification was accepted (no body)." },
        400: json({ type: "object" }, "JSON-RPC error: -32700, -32600, -32602, -32020 header mismatch, -32022 unsupported protocol version."),
        401: json({ type: "object" }, "Missing, unknown or disabled API key (JSON-RPC error -31001)."),
        403: { description: "Origin not allowed." },
        404: json({ type: "object" }, "Unknown method (modern protocol): JSON-RPC error -32601."),
      },
    },
    get: { summary: "Not offered (no standalone SSE stream)", tags: ["MCP"], responses: { 405: { description: "Method Not Allowed." } } },
    delete: { summary: "Not offered (no sessions)", tags: ["MCP"], responses: { 405: { description: "Method Not Allowed." } } },
  },
} as const;

/** Addition to POST /api/v1/jobs: it also accepts `Authorization: Bearer sck_…` with the request itself (no payment block). */
export const agentApiJobsNote =
  "POST /api/v1/jobs also accepts `Authorization: Bearer sck_…` (security: apiKey) with the job request itself and no `payment` block: the job is paid from the key's wallet, within the key's daily cap (429 `key-daily-cap`), and gets no readSecret. 401 `invalid-api-key` for an unknown or disabled key.";

const sparecycleBlock = {
  type: "object",
  properties: {
    job_id: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
    status: { enum: ["queued", "running", "checking", "agreed", "disagreed", "expired", "rejected"] },
    price_wei: { type: "string" },
    work_units: { type: "integer" },
    charge_status: { type: ["string", "null"] },
    settled_at: { type: ["integer", "null"] },
    poll: { type: "string" },
  },
} as const;

export const agentApiComponents = {
  securitySchemes: {
    apiKey: { type: "http", scheme: "bearer", description: "A Sparecycle API key `sck_<keyId>_<secret>`." },
  },
  schemas: {
    KeyError: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } }, required: ["error", "message"] },
    OpenAIError: {
      type: "object",
      properties: {
        error: {
          type: "object",
          properties: { message: { type: "string" }, type: { type: "string" }, param: { type: ["string", "null"] }, code: { type: "string" } },
          required: ["message", "type", "param", "code"],
        },
        sparecycle: { type: "object" },
        x402: { $ref: "#/components/schemas/X402PaymentRequired" },
      },
      required: ["error"],
    },
    X402PaymentRequirements: {
      type: "object",
      description: "x402 v2 PaymentRequirements, scheme exact on EVM (EIP-3009). INTERNAL REVIEW ONLY — NOT EXTERNALLY AUDITED.",
      properties: {
        scheme: { const: "exact" },
        network: { type: "string", description: "CAIP-2, e.g. eip155:4663", example: "eip155:4663" },
        amount: { type: "string", pattern: "^\\d+$", description: "Atomic units of the asset: the request's work units x the x402 price per work unit." },
        asset: { type: "string", description: "The EIP-3009 payment asset." },
        payTo: { type: "string", description: "The escrow contract (SparecycleX402Escrow), never a wallet." },
        maxTimeoutSeconds: { type: "integer" },
        extra: {
          type: "object",
          properties: { name: { type: "string" }, version: { type: "string" }, assetTransferMethod: { const: "eip3009" } },
          required: ["name", "version"],
        },
      },
      required: ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds", "extra"],
    },
    X402PaymentRequired: {
      type: "object",
      description:
        "x402 v2 PaymentRequired (PAYMENT-REQUIRED header, base64 JSON). The `sparecycle-escrow` extension says how the payment is held: in the escrow before the job is queued, forwarded only when two nodes agree, refunded otherwise.",
      properties: {
        x402Version: { const: 2 },
        error: { type: "string", description: "Why a sent payment was refused (x402 reason code)." },
        resource: { type: "object", properties: { url: { type: "string" }, description: { type: "string" }, mimeType: { type: "string" }, serviceName: { type: "string" } } },
        accepts: { type: "array", items: { $ref: "#/components/schemas/X402PaymentRequirements" } },
        extensions: { type: "object" },
      },
      required: ["x402Version", "resource", "accepts"],
    },
    X402SettleResponse: {
      type: "object",
      description: "x402 v2 SettleResponse (PAYMENT-RESPONSE header, base64 JSON): the payment is held in the escrow; `transaction` funded it.",
      properties: {
        success: { type: "boolean" },
        transaction: { type: "string" },
        network: { type: "string" },
        payer: { type: "string" },
        amount: { type: "string" },
      },
      required: ["success", "transaction", "network"],
    },
    ApiKey: {
      type: "object",
      properties: {
        keyId: { type: "string" },
        prefix: { type: "string" },
        fingerprint: { type: "string" },
        label: { type: "string" },
        status: { enum: ["pending", "active", "disabled"] },
        dailyCapWei: { type: "string" },
        spentTodayWei: { type: "string" },
        remainingTodayWei: { type: "string" },
        day: { type: "string", description: "UTC day, YYYY-MM-DD." },
        nextResetAt: { type: "integer", description: "Next 00:00 UTC, unix seconds." },
        createdAt: { type: "integer" },
        activatedAt: { type: ["integer", "null"] },
        lastUsedAt: { type: ["integer", "null"] },
        disabledAt: { type: ["integer", "null"] },
      },
    },
    ApiKeyList: {
      type: "object",
      properties: { owner: { type: "string" }, keys: { type: "array", items: ref("ApiKey") }, maxKeys: { type: "integer" }, day: { type: "string" }, nextResetAt: { type: "integer" } },
    },
    PendingKey: {
      type: "object",
      properties: {
        keyId: { type: "string" },
        prefix: { type: "string" },
        fingerprint: { type: "string" },
        label: { type: "string" },
        status: { const: "pending" },
        dailyCapWei: { type: "string" },
        linkMessage: { type: "string" },
        issued: { type: "integer" },
        expiresAt: { type: "integer" },
      },
    },
    ChatCompletionRequest: {
      type: "object",
      required: ["model", "messages"],
      properties: {
        model: { const: "qwen2.5-1.5b" },
        messages: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: { type: "object", required: ["role", "content"], properties: { role: { enum: ["system", "user"] }, content: { type: "string" } } },
        },
        max_tokens: { type: "integer", minimum: LIMITS.text.maxTokens.min, maximum: LIMITS.text.maxTokens.max },
        max_completion_tokens: { type: "integer", minimum: LIMITS.text.maxTokens.min, maximum: LIMITS.text.maxTokens.max },
        temperature: { type: "number", description: "Accepted and ignored: decoding is greedy." },
        top_p: { type: "number", description: "Accepted and ignored: decoding is greedy." },
        stream: { const: false },
        n: { const: 1 },
      },
    },
    ChatCompletion: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^chatcmpl-0x[0-9a-f]{64}$" },
        object: { const: "chat.completion" },
        created: { type: "integer" },
        model: { type: "string" },
        choices: {
          type: "array",
          maxItems: 1,
          items: {
            type: "object",
            properties: {
              index: { const: 0 },
              message: { type: "object", properties: { role: { const: "assistant" }, content: { type: "string" }, refusal: { type: "null" } } },
              finish_reason: { const: "stop" },
              logprobs: { type: "null" },
            },
          },
        },
        sparecycle: {
          allOf: [sparecycleBlock, { type: "object", properties: { decoding: { const: "greedy" }, finish_reason_reported: { const: false } } }],
        },
      },
      description: "No `usage` object: the scheduler does not count tokens.",
    },
    ImageRequest: {
      type: "object",
      required: ["model", "prompt"],
      properties: {
        model: { const: "sd15" },
        prompt: { type: "string", minLength: LIMITS.image.prompt.min, maxLength: LIMITS.image.prompt.max },
        size: { type: "string", description: `<w>x<h>, each side ${LIMITS.image.side.min}..${LIMITS.image.side.max} in steps of ${LIMITS.image.side.step}; default 512x512` },
        n: { const: 1 },
        response_format: { enum: ["b64_json", "url"] },
        negative_prompt: { type: "string", maxLength: LIMITS.image.negative.max },
        steps: { type: "integer", minimum: LIMITS.image.steps.min, maximum: LIMITS.image.steps.max },
        guidance: { type: "number", minimum: LIMITS.image.guidance.min, maximum: LIMITS.image.guidance.max },
        seed: { type: "integer", minimum: LIMITS.image.seed.min, maximum: LIMITS.image.seed.max },
      },
    },
    ImagesResponse: {
      type: "object",
      properties: {
        created: { type: "integer" },
        data: {
          type: "array",
          maxItems: 1,
          items: { type: "object", properties: { b64_json: { type: "string" }, url: { type: "string", format: "uri" } } },
        },
        output_format: { const: "png" },
        size: { type: "string" },
        sparecycle: {
          allOf: [sparecycleBlock, { type: "object", properties: { id: { type: "string", pattern: "^img-0x[0-9a-f]{64}$" }, response_format: { enum: ["b64_json", "url"] } } }],
        },
      },
    },
  },
} as const;
