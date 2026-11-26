// OpenAPI module: the scheduler endpoints that exist today (README "API" table, docs/SPEC.md and the route files
// under src/app/api/v1). Limits come from src/lib/protocol.ts so the description cannot drift from validation.
import { agentApiJobsNote } from "./openapi-agent";
import type { OpenApiModule } from "./openapi";
import { JOB_PAYMENT_WINDOW_SECONDS } from "./job-payment";
import { JOBS_HASH_RULE, JOBS_LEAF_RULE, LEAF_CHARGE_STATUS, LEAF_VERDICT } from "./job-receipt";
import { JOB_STATUSES, LIMITS, MODEL_IDS } from "./protocol";
import { POLICY } from "@/server/env";

type Obj = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Obj, description: string) => ({ description, content: { "application/json": { schema } } });
const error = (description: string) => ({ description, content: { "application/json": { schema: ref("Error") } } });
const nullable = (schema: Obj) => ({ oneOf: [schema, { type: "null" }] });
const jobIdParam = { $ref: "#/components/parameters/JobId" };
const epochIdParam = { $ref: "#/components/parameters/EpochId" };
const sessionHours = POLICY.sessionSeconds / 3600;

const I = LIMITS.image;
const T = LIMITS.text;

export const coreApi: OpenApiModule = {
  name: "core",
  tags: [
    { name: "Jobs", description: "Submit a job, follow its status, read its result." },
    { name: "Epochs", description: "Six-hour payout periods: payout trees, Merkle proofs and charge lists." },
    { name: "Models", description: "The public model catalog: what runs, what it costs per work unit, the limits and live capacity. No key." },
    { name: "Network", description: "Scheduler status, nodes and health." },
    { name: "Payments", description: "Prepaid balances in the SparecycleJobPayments contract." },
    { name: "Sign-in", description: "Gasless wallet sign-in (EIP-4361) to read results of jobs the wallet paid for." },
    { name: "Nodes (signed)", description: "Called by the node client. Every request is signed by the node key." },
    { name: "Operator", description: "Operator endpoints. Bearer SCHEDULER_ADMIN_TOKEN; 503 when none is configured." },
    { name: "Meta", description: "This API description." },
  ],
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        summary: "Scheduler and database liveness",
        tags: ["Network"],
        responses: {
          "200": json({ type: "object", properties: { ok: { const: true }, db: { const: "ok" } } }, "The scheduler and its database answer."),
          "503": json({ type: "object", properties: { ok: { const: false }, db: { const: "error" }, error: { type: "string" } } }, "The database could not be opened."),
        },
      },
    },
    "/status": {
      get: {
        operationId: "getStatus",
        summary: "Open epoch, node and job counters, last settled root, trust model",
        tags: ["Network"],
        responses: { "200": json(ref("Status"), "Current status.") },
      },
    },
    "/epochs": {
      get: {
        operationId: "listEpochs",
        summary: "Every epoch the scheduler knows, newest first",
        tags: ["Epochs"],
        responses: {
          "200": json({ type: "object", required: ["epochs"], properties: { epochs: { type: "array", items: ref("Epoch") } } }, "Epochs."),
        },
      },
    },
    "/epochs/{id}/tree": {
      parameters: [epochIdParam],
      get: {
        operationId: "getEpochTree",
        summary: "The published payout tree of a closed epoch",
        tags: ["Epochs"],
        responses: {
          "200": json(ref("EpochTree"), "Every leaf of the epoch's Merkle tree (one per owner wallet)."),
          "400": error("The epoch id is not a non-negative integer."),
          "404": error("unknown-epoch"),
          "409": error("epoch-open: the tree is published when the epoch closes."),
        },
      },
    },
    "/epochs/{id}/proof": {
      parameters: [epochIdParam],
      get: {
        operationId: "getEpochProof",
        summary: "Amount, leaf and Merkle proof for claim(epochId, amount, proof)",
        tags: ["Epochs"],
        parameters: [{ name: "account", in: "query", required: true, schema: ref("Address"), description: "The owner wallet." }],
        responses: {
          "200": json(ref("EpochProof"), "The account's payout and its proof."),
          "400": error("invalid-account or an invalid epoch id."),
          "404": error("unknown-epoch, or not-in-root when the account has no payout in this epoch."),
          "409": error("epoch-open"),
        },
      },
    },
    "/epochs/{id}/charges": {
      parameters: [epochIdParam],
      get: {
        operationId: "getEpochCharges",
        summary: "What an epoch's charge committed: per-customer totals and the jobs-tree leaves (v2), or the per-job list (v1)",
        description: [
          `hashRule "${JOBS_HASH_RULE}" (every charge since job receipts): listHash, the listHash of the Charged event of SparecycleJobPayments for that epoch, is the root of a Merkle tree over the paid and team jobs that reached a final charge status since the last confirmed charge (charged, released = not charged, unpaid). The answer lists each customer's total (equal to the CustomerCharged events) and the sorted leaves, so anyone can rebuild the root; it names no job ids, per-job payers or prices, and each leaf includes a random salt that only the payer's receipt carries, so a leaf cannot be matched to a job from public data. A payer proves their own job with its receipt (GET /jobs/{id}/receipt).`,
          "",
          `Leaf: ${JOBS_LEAF_RULE}. Codes: verdict agreed ${LEAF_VERDICT.agreed}, disagreed ${LEAF_VERDICT.disagreed}, expired ${LEAF_VERDICT.expired}, rejected ${LEAF_VERDICT.rejected}; chargeStatus charged ${LEAF_CHARGE_STATUS.charged}, released ${LEAF_CHARGE_STATUS.released}, unpaid ${LEAF_CHARGE_STATUS.unpaid}.`,
          "",
          "Charges stored before job receipts keep their v1 answer unchanged: the per-job list, whose keccak256 (UTF-8 JSON) is the listHash. status is \"none\" when nothing was charged in the epoch (no Charged event, so no on-chain anchor for receipts of that epoch).",
        ].join("\n"),
        tags: ["Epochs", "Payments"],
        responses: { "200": json(ref("Charges"), "The charge."), "400": error("The epoch id is not a non-negative integer.") },
      },
    },
    "/jobs": {
      get: {
        operationId: "listJobs",
        summary: "Recent jobs (prompt hashes only, never prompts)",
        tags: ["Jobs"],
        parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } }],
        responses: {
          "200": json({ type: "object", required: ["jobs"], properties: { jobs: { type: "array", items: ref("Job") } } }, "Newest first."),
        },
      },
      post: {
        operationId: "submitJob",
        summary: "Submit a job: a free trial job, or a paid job from a prepaid balance",
        description: [
          "Free trial: send the job request itself. Limited per IP address per hour (JOB_RATE_LIMIT; the x-sc-rate-limit header of the answer gives the limit).",
          "",
          "Paid: send { request, payment }. payment.signature is an EIP-191 personal_sign by payment.payer of this message (lines joined by \\n):",
          "",
          "    Sparecycle: pay for one job from my balance",
          "    Chain: <chain id>",
          "    Payments contract: <payments contract address, lowercase>",
          "    Job request: <sha256 of JSON.stringify(request), 0x-prefixed lowercase hex>",
          "    Price: <priceWei> wei",
          "    Issued: <issued, unix seconds>",
          "",
          `The signature is accepted for ${JOB_PAYMENT_WINDOW_SECONDS} seconds after issued. priceWei must equal the job's work units times priceWeiPerUnit (GET /payments/account); otherwise 409 price-changed returns the right price.`,
          "",
          "The answer carries the job's readSecret once: keep it to read the result (GET /jobs/{id}/result with Authorization: Bearer <readSecret>). The scheduler stores only its hash.",
          "",
          agentApiJobsNote,
        ].join("\n"),
        tags: ["Jobs"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { oneOf: [ref("JobRequest"), ref("PaidJobRequest")] },
              examples: {
                freeText: {
                  summary: "Free trial text job",
                  value: { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "Name three uses for an idle GPU.", maxTokens: 64 } },
                },
                freeImage: {
                  summary: "Free trial image job",
                  value: { kind: "image", params: { model: "sd15", prompt: "a lighthouse at dusk, watercolor", width: 512, height: 512, steps: 15 } },
                },
              },
            },
          },
        },
        responses: {
          "201": json(ref("SubmitJobResponse"), "Queued. Sent with Cache-Control: private, no-store."),
          "400": error("invalid-job (with field), invalid-payment or stale-payment."),
          "401": error("bad-payment-signature"),
          "402": error("insufficient-balance (with available and priceWei)."),
          "409": error("price-changed (with priceWei) or payment-used."),
          "429": error("rate-limited (with retryAfter, unix seconds)."),
          "503": error(
            "no-node-pair (with model, and retryAfter in seconds when the GPU pool is waiting to try again): no two machines with different owners can take this model now, neither online nor through the GPU pool. Nothing is queued, held, counted against a limit or charged. Also queue-full, or payments-off when paid jobs are not enabled.",
          ),
        },
      },
    },
    "/jobs/{id}": {
      parameters: [jobIdParam],
      get: {
        operationId: "getJob",
        summary: "A job's status, timestamps and parameters (never the prompt)",
        description:
          "output is the result URL when the job is agreed and the caller may read it (the job's read secret, or a session of the wallet that paid). Always Cache-Control: private, no-store.",
        tags: ["Jobs"],
        security: [{}, { readSecret: [] }, { walletSession: [] }],
        responses: { "200": json(ref("JobDetail"), "The job."), "400": error("invalid-job-id"), "404": error("unknown-job") },
      },
    },
    "/jobs/{id}/result": {
      parameters: [jobIdParam],
      get: {
        operationId: "getJobResult",
        summary: "The result of an agreed job (image/png or text/plain), for its owner only",
        description:
          "Send the job's read secret (Authorization: Bearer <readSecret>) or the session cookie of the wallet that paid. Anonymous requests get an empty 401. Rate limited per viewer. Always Cache-Control: private, no-store and Vary: Authorization, Cookie.",
        tags: ["Jobs"],
        security: [{ readSecret: [] }, { walletSession: [] }],
        responses: {
          "200": {
            description: "The result.",
            content: { "image/png": { schema: { type: "string", contentMediaType: "image/png" } }, "text/plain": { schema: { type: "string" } } },
          },
          "401": { description: "No credentials were sent (empty body)." },
          "403": error("These credentials cannot read this job."),
          "404": error("unknown-job, or no-output when the output was not stored."),
          "409": error("no-output: the job is not agreed."),
          "429": error("rate-limited"),
        },
      },
      head: {
        operationId: "headJobResult",
        summary: "Same checks as GET, without the body",
        tags: ["Jobs"],
        security: [{ readSecret: [] }, { walletSession: [] }],
        responses: { "200": { description: "Readable." }, "401": { description: "No credentials." }, "403": { description: "Not allowed." } },
      },
    },
    "/jobs/{id}/invoice": {
      parameters: [jobIdParam],
      get: {
        operationId: "getJobInvoice",
        summary: "The private invoice of a paid or team job (a stub for a free trial job)",
        description:
          "Price, rounded 5% protocol cut (charged per epoch batch), verdict, charge status, output hash (sha256 of the agreed output, not the file), epochs, the charge and root transactions, and round / maxRounds (a paid job re-checked on another pair: the price stays held, the verdict and charge are the final round's). Same credentials as /jobs/{id}/result, enforced whatever OUTPUT_AUTH says. A free trial job answers { payment: \"free\", invoice: false, note: \"free trial, no charge\" }. Always Cache-Control: private, no-store and Vary: Authorization, Cookie.",
        tags: ["Jobs"],
        security: [{ readSecret: [] }, { walletSession: [] }],
        responses: {
          "200": json({ type: "object", description: "The invoice (version 1), or the free trial stub." }, "The invoice."),
          "400": error("bad-id"),
          "401": { description: "No credentials were sent (empty body)." },
          "403": error("These credentials cannot read this job's invoice."),
          "404": error("unknown-job"),
        },
      },
    },
    "/jobs/{id}/receipt": {
      parameters: [jobIdParam],
      get: {
        operationId: "getJobReceipt",
        summary: "The payer's receipt of a paid or team job, checkable against the Charged event (a stub for a free trial job)",
        description: [
          "Available from the verdict on. state is \"provisional\" until the charge that commits the job's leaf to a jobs root is confirmed on-chain, then \"sealed\": anchor then holds the leaf inputs (with the leaf's random salt, served only here), the leaf, the Merkle proof and the jobs root (the listHash of the Charged event of epochId, sent in chargeTx). nodes holds both nodes' EIP-712 receipts (domain Sparecycle v1: jobId, node, outputHash, gpuMs, epoch).",
          "",
          "pending.reason of a provisional receipt: waiting-for-charge, charge-unconfirmed, no-anchor (the epoch close after the verdict charged nothing, so there is no Charged event to anchor it; it goes into the next charge's jobs root) or charged-before-receipts (charged in a v1 charge list, no proof).",
          "",
          "The epoch payout root (GET /epochs/{id}/tree) covers node payouts only, never jobs. Save the receipt as a file and check it in a browser against the chain's public RPC, without this API (the Verify panel on the Jobs page). Same credentials as /jobs/{id}/invoice, enforced whatever OUTPUT_AUTH says. Always Cache-Control: private, no-store and Vary: Authorization, Cookie.",
        ].join("\n"),
        tags: ["Jobs"],
        security: [{ readSecret: [] }, { walletSession: [] }],
        responses: {
          "200": json({ oneOf: [ref("JobReceipt"), ref("FreeReceiptStub")] }, "The receipt, or the free trial stub."),
          "400": error("invalid-job-id"),
          "401": { description: "No credentials were sent (empty body)." },
          "403": error("These credentials cannot read this job's receipt."),
          "404": error("unknown-job"),
          "409": error("no-verdict: the two results are not compared yet."),
        },
      },
    },
    "/jobs/{id}/output": {
      parameters: [jobIdParam],
      get: {
        operationId: "getJobOutputRetired",
        summary: "Retired: use /jobs/{id}/result",
        description: "Answers 410 while results are private (OUTPUT_AUTH=enforce, the live setting).",
        deprecated: true,
        tags: ["Jobs"],
        responses: { "410": error("gone: results moved to /jobs/{id}/result.") },
      },
      head: {
        operationId: "headJobOutputRetired",
        summary: "Retired: use /jobs/{id}/result",
        deprecated: true,
        tags: ["Jobs"],
        responses: { "410": { description: "Gone." } },
      },
    },
    "/catalog": {
      get: {
        operationId: "getCatalog",
        summary: "The model catalog: price per unit, how units are counted, limits and live capacity (no key)",
        description: [
          "Exactly the models the scheduler runs (MODELS in src/lib/protocol.ts), also served at /v1/catalog. /models (OpenAI list shape) stays behind an API key.",
          "",
          "price.priceWeiPerUnit is the price every job is quoted at right now; price.units says how a job's work units are counted; limits are the accepted request ranges.",
          "",
          "capacity.ready: machines online now that can run the model. capacity.standby: stopped project-run machines the GPU pool starts when a job waits. capacity.pair: \"online\" (two machines with different owners are online), \"pool\" (the GPU pool can bring a pair up, a minute or two), or null: no pair can be reached now, and creating a job of this model answers 503 no-node-pair (nothing queued, held or charged).",
          "",
          "network.operators is \"project-run\" until a node of an outside owner passes the GPU gate and takes part in an agreed job.",
        ].join("\n"),
        tags: ["Models"],
        responses: { "200": json(ref("Catalog"), "The catalog, read live (Cache-Control: no-store).") },
      },
    },
    "/nodes": {
      get: {
        operationId: "listNodes",
        summary: "Registered nodes: owner wallet, GPU, backend, online state",
        tags: ["Network"],
        responses: {
          "200": json({ type: "object", required: ["nodes"], properties: { nodes: { type: "array", items: ref("Node") } } }, "Registered nodes."),
        },
      },
    },
    "/payments/account": {
      get: {
        operationId: "getPaymentsAccount",
        summary: "A customer's balance, held amount, available amount, spend limit and pending withdrawal",
        tags: ["Payments"],
        parameters: [{ name: "address", in: "query", required: true, schema: ref("Address") }],
        responses: { "200": json(ref("Account"), "The account, read from the payments contract."), "400": error("invalid-address") },
      },
    },
    "/auth/nonce": {
      get: {
        operationId: "getSignInNonce",
        summary: "A single-use nonce for an EIP-4361 (Sign-In with Ethereum) message",
        tags: ["Sign-in"],
        responses: { "200": json(ref("SignInNonce"), "The nonce and the statement to sign."), "429": error("rate-limited") },
      },
    },
    "/auth/verify": {
      post: {
        operationId: "signIn",
        summary: "Check a signed EIP-4361 message and start a session",
        description: `Sets the HttpOnly session cookie sc_session (SameSite=Strict, ${sessionHours} hours). No transaction, no gas. The body must be application/json.`,
        tags: ["Sign-in"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["message", "signature"], properties: { message: { type: "string" }, signature: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": json(
            { type: "object", required: ["ok", "address", "expiresAt"], properties: { ok: { const: true }, address: ref("Address"), expiresAt: { type: "integer" } } },
            "Signed in.",
          ),
          "400": error("invalid-sign-in"),
          "401": error("The signature, nonce, domain or chain id did not check out."),
          "415": error("json-required"),
        },
      },
    },
    "/auth/logout": {
      post: {
        operationId: "signOut",
        summary: "End the session and clear the cookie",
        tags: ["Sign-in"],
        security: [{ walletSession: [] }],
        responses: { "200": json({ type: "object", properties: { ok: { const: true } } }, "Signed out.") },
      },
    },
    "/nodes/register": {
      post: {
        operationId: "registerNode",
        summary: "Register a node key, its owner wallet and its GPU",
        description:
          "The owner signs \"Sparecycle: link node <nodeKey, lowercase> to wallet <owner, lowercase>\" once (node client: link-message).",
        tags: ["Nodes (signed)"],
        security: [{ nodeSignature: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["gpu", "gpuUuid", "vramMb", "caps", "owner", "ownerSig"],
                properties: {
                  gpu: { type: "string" },
                  gpuUuid: { type: "string" },
                  vramMb: { type: "integer" },
                  caps: { type: "array", items: { type: "string" } },
                  owner: ref("Address"),
                  ownerSig: { type: "string" },
                  backend: { enum: ["cuda", "vulkan", "cpu"] },
                },
              },
            },
          },
        },
        responses: { "200": json({ type: "object" }, "Registered."), "401": error("Bad or replayed node signature."), "403": error("e.g. gpu-not-supported.") },
      },
    },
    "/nodes/poll": {
      post: {
        operationId: "pollForTask",
        summary: "Long poll for a task (or a GPU challenge)",
        tags: ["Nodes (signed)"],
        security: [{ nodeSignature: [] }],
        responses: {
          "200": json({ type: "object", description: "{ taskId, jobId, epoch, spec, chainId, leaseExpiresAt } or { type: \"challenge\", challengeId, spec }." }, "A task."),
          "204": { description: "Nothing to do right now." },
          "401": error("Bad or replayed node signature."),
        },
      },
    },
    "/nodes/heartbeat": {
      post: {
        operationId: "nodeHeartbeat",
        summary: "Idle Guard: the state a node reports about its own machine",
        description:
          "Node client 0.4.0+. Body { state: active | paused-busy | paused-hot | paused-hours, since? } (since in unix seconds, not in the future). Sent on every state change and at least every 60 s while paused, so a paused node stays online but gets no task. Only the state is sent: no temperatures, process names or PIDs. GET /nodes shows the state, never when the pause started.",
        tags: ["Nodes (signed)"],
        security: [{ nodeSignature: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["state"],
                properties: { state: { type: "string", enum: ["active", "paused-busy", "paused-hot", "paused-hours"] }, since: { type: "integer" } },
              },
            },
          },
        },
        responses: {
          "200": json({ type: "object", description: "{ ok: true, state, since }" }, "Recorded."),
          "400": error("invalid-heartbeat"),
          "401": error("Bad, stale or replayed node signature."),
          "403": error("not-registered"),
          "413": error("Body too large."),
        },
      },
    },
    "/tasks/{taskId}/result": {
      parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string", pattern: "^0x[0-9a-f]{32}$" } }],
      post: {
        operationId: "submitTaskResult",
        summary: "Submit a task's signed result",
        tags: ["Nodes (signed)"],
        security: [{ nodeSignature: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["outputHash", "gpuMs", "epoch", "signature"],
                properties: {
                  outputHash: ref("Hash"),
                  gpuMs: { type: "integer" },
                  epoch: { type: "integer" },
                  signature: { type: "string", description: "EIP-712 receipt signed by the node key." },
                  png: { type: "string", description: "Base64 PNG (image jobs)." },
                  text: { type: "string", description: "Text output (text jobs)." },
                },
              },
            },
          },
        },
        responses: {
          "200": json(
            {
              type: "object",
              properties: {
                ok: { const: true },
                jobId: { type: "string" },
                status: {
                  type: "string",
                  description:
                    "The job's status after this result: checking (waiting for the other result), agreed, disagreed or rejected, or queued when the two results of a paid or team job did not match and it goes to another pair.",
                },
                verdict: { const: "disagreed", description: "Only with status queued: this round's two results did not match." },
                round: { type: "integer", description: "The job's re-check round after this result (0 = the first pair)." },
              },
            },
            "Accepted.",
          ),
        },
      },
    },
    "/challenges/{id}/result": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      post: {
        operationId: "submitChallengeResult",
        summary: "Submit the answer to a GPU challenge (unpaid, never a job)",
        tags: ["Nodes (signed)"],
        security: [{ nodeSignature: [] }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": json({ type: "object" }, "Recorded.") },
      },
    },
    "/epochs/close": {
      post: {
        operationId: "closeEpoch",
        summary: "Close the open epoch and post its root (or retry an unposted root)",
        tags: ["Operator"],
        security: [{ adminToken: [] }],
        responses: { "200": json({ type: "object" }, "Closed."), "401": error("unauthorized"), "503": error("admin-not-configured") },
      },
    },
    "/admin/challenges": {
      get: {
        operationId: "getChallengeReport",
        summary: "A node's GPU challenge state, recent challenges and the admin audit log",
        tags: ["Operator"],
        security: [{ adminToken: [] }],
        parameters: [{ name: "nodeKey", in: "query", required: true, schema: ref("Address") }],
        responses: { "200": json({ type: "object" }, "Report."), "401": error("unauthorized"), "503": error("admin-not-configured") },
      },
      post: {
        operationId: "adminChallengeAction",
        summary: "Re-issue a challenge, temporarily allow a node, or revoke that (audit-logged)",
        tags: ["Operator"],
        security: [{ adminToken: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["nodeKey", "action"],
                properties: { nodeKey: ref("Address"), action: { enum: ["reissue", "allow", "revoke-allow"] }, hours: { type: "number" }, note: { type: "string" } },
              },
            },
          },
        },
        responses: { "200": json({ type: "object" }, "Done."), "401": error("unauthorized"), "503": error("admin-not-configured") },
      },
    },
    "/openapi.json": {
      get: {
        operationId: "getOpenApi",
        summary: "This API description (OpenAPI 3.1)",
        tags: ["Meta"],
        responses: { "200": json({ type: "object" }, "The OpenAPI document.") },
      },
    },
  },
  components: {
    securitySchemes: {
      readSecret: {
        type: "http",
        scheme: "bearer",
        description: "The job's read secret, returned once by POST /jobs as readSecret.",
      },
      walletSession: {
        type: "apiKey",
        in: "cookie",
        name: "sc_session",
        description: `Session of a signed-in wallet (POST /auth/verify), HttpOnly, ${sessionHours} hours. Reads results of jobs that wallet paid for.`,
      },
      nodeSignature: {
        type: "apiKey",
        in: "header",
        name: "x-sc-sig",
        description:
          "Node requests carry x-sc-from (the node key), x-sc-ts (unix seconds) and x-sc-sig: an EIP-191 signature by the node key over sparecycle|METHOD|PATH|TS|sha256(body). 60-second window; each signature is accepted once.",
      },
      adminToken: { type: "http", scheme: "bearer", description: "SCHEDULER_ADMIN_TOKEN (operator only)." },
    },
    parameters: {
      JobId: { name: "id", in: "path", required: true, schema: ref("JobId") },
      EpochId: { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 0 } },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error", "message"],
        properties: { error: { type: "string", description: "kebab-case code" }, message: { type: "string" } },
        additionalProperties: true,
      },
      Address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
      Hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
      JobId: { type: "string", pattern: "^0x[0-9a-f]{64}$" },
      Wei: { type: "string", pattern: "^[0-9]+$", description: "An amount in wei, as a decimal string." },
      JobStatus: { enum: [...JOB_STATUSES] },
      ImageJobRequest: {
        type: "object",
        required: ["kind", "params"],
        properties: {
          kind: { const: "image" },
          params: {
            type: "object",
            required: ["model", "prompt", "width", "height", "steps"],
            properties: {
              model: { const: "sd15" },
              prompt: { type: "string", minLength: I.prompt.min, maxLength: I.prompt.max },
              negative: { type: "string", minLength: I.negative.min, maxLength: I.negative.max },
              width: { type: "integer", minimum: I.side.min, maximum: I.side.max, multipleOf: I.side.step },
              height: { type: "integer", minimum: I.side.min, maximum: I.side.max, multipleOf: I.side.step },
              steps: { type: "integer", minimum: I.steps.min, maximum: I.steps.max },
              guidance: { type: "number", minimum: I.guidance.min, maximum: I.guidance.max, default: I.guidance.default },
              seed: { oneOf: [{ type: "integer", minimum: I.seed.min, maximum: I.seed.max }, { type: "null" }], description: "Left out: the scheduler picks one, so both nodes render the same image." },
            },
          },
        },
      },
      TextJobRequest: {
        type: "object",
        required: ["kind", "params"],
        properties: {
          kind: { const: "text" },
          params: {
            type: "object",
            required: ["model", "prompt", "maxTokens"],
            properties: {
              model: { const: "qwen2.5-1.5b" },
              prompt: { type: "string", minLength: T.prompt.min, maxLength: T.prompt.max },
              system: { type: "string", minLength: T.system.min, maxLength: T.system.max },
              maxTokens: { type: "integer", minimum: T.maxTokens.min, maximum: T.maxTokens.max },
            },
          },
        },
      },
      JobRequest: { oneOf: [ref("ImageJobRequest"), ref("TextJobRequest")], discriminator: { propertyName: "kind" } },
      Payment: {
        type: "object",
        required: ["payer", "signature", "issued", "priceWei"],
        properties: {
          payer: ref("Address"),
          signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" },
          issued: { type: "integer", description: "Unix seconds when signed." },
          priceWei: ref("Wei"),
        },
      },
      PaidJobRequest: { type: "object", required: ["request", "payment"], properties: { request: ref("JobRequest"), payment: ref("Payment") } },
      SubmitJobResponse: {
        type: "object",
        required: ["id", "status", "readSecret"],
        properties: {
          id: ref("JobId"),
          status: { const: "queued" },
          priceWei: nullable(ref("Wei")),
          readSecret: { type: "string", description: "Shown once. Keep it to read the result." },
        },
      },
      Job: {
        type: "object",
        required: ["id", "status", "createdAt"],
        properties: {
          id: ref("JobId"),
          model: { type: "string" },
          kind: { enum: ["image", "text"] },
          status: ref("JobStatus"),
          createdAt: { type: "integer" },
          settledAt: nullable({ type: "integer" }),
          promptHash: ref("Hash"),
          workUnits: { type: "integer" },
          epochId: nullable({ type: "integer" }),
          eligible: { type: "boolean" },
          paid: { type: "boolean", description: "Its epoch's root is posted with a non-zero pot." },
          payment: { enum: ["free", "paid", "team"] },
          round: {
            type: "integer",
            minimum: 0,
            description:
              "Re-check round, 0-based. 0 = the first pair of nodes. A paid or team job whose two results do not match, or whose pair gives no verdict within 40 minutes of its first lease, runs again on two nodes whose node keys, owner wallets and GPUs took no part in an earlier round (round 1, then 2), when two such nodes are registered; otherwise the mismatch is final at once. Only the final round's verdict counts and only its two nodes are paid. While round > 0 and the job is queued, running or checking, it is being re-checked on another pair; its price stays held and nothing is charged until a final agreed.",
          },
          maxRounds: {
            type: "integer",
            description: "The most pairs this job can be checked on: 3 for paid and team jobs, 1 for free trial jobs (no re-check).",
          },
        },
      },
      JobDetail: {
        allOf: [
          ref("Job"),
          {
            type: "object",
            properties: {
              params: { type: "object", description: "Size, steps, guidance and seed, or maxTokens. Never the prompt." },
              note: nullable({ type: "string" }),
              output: nullable({ type: "string", description: "The result URL, when the caller may read it." }),
              outputAvailable: { type: "boolean" },
              outputType: nullable({ type: "string" }),
            },
          },
        ],
      },
      Status: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          epoch: { type: "object", properties: { id: { type: "integer" }, startedAt: { type: "integer" }, endsAt: { type: "integer" }, length: { type: "integer" } } },
          nodes: { type: "object" },
          jobs: { type: "object" },
          lastSettled: nullable({ type: "object" }),
          rootPosting: { enum: ["configured", "not-configured"] },
          trust: { const: "centralized-scheduler" },
          outputAuth: { enum: ["off", "enforce"] },
        },
      },
      Epoch: {
        type: "object",
        properties: {
          id: { type: "integer" },
          startedAt: { type: "integer" },
          endedAt: nullable({ type: "integer" }),
          root: nullable(ref("Hash")),
          reserved: ref("Wei"),
          potAtClose: nullable(ref("Wei")),
          leaves: nullable({ type: "integer" }),
          postedTx: nullable(ref("Hash")),
          status: { enum: ["open", "closed-unposted", "posted"] },
        },
      },
      EpochTree: {
        type: "object",
        properties: {
          id: { type: "integer" },
          root: ref("Hash"),
          reserved: ref("Wei"),
          status: { type: "string" },
          postedTx: nullable(ref("Hash")),
          leaves: {
            type: "array",
            items: { type: "object", properties: { account: ref("Address"), amount: ref("Wei"), leaf: ref("Hash") } },
          },
        },
      },
      EpochProof: {
        type: "object",
        properties: {
          epochId: { type: "integer" },
          account: ref("Address"),
          amount: ref("Wei"),
          leaf: ref("Hash"),
          proof: { type: "array", items: ref("Hash") },
          root: ref("Hash"),
        },
      },
      Charges: {
        type: "object",
        description: `hashRule "${JOBS_HASH_RULE}": customers + leaves (no per-job list). Older charges (v1): jobs + the v1 hashRule text. status "none": nothing charged.`,
        properties: {
          epochId: { type: "integer" },
          status: { enum: ["none", "sending", "done", "failed"] },
          listHash: nullable(ref("Hash")),
          totalWei: ref("Wei"),
          tx: nullable(ref("Hash")),
          hashRule: { type: "string", description: `"${JOBS_HASH_RULE}", or the v1 rule "keccak256(utf8(JSON.stringify(jobs))) with jobs sorted by jobId".` },
          customers: {
            type: "array",
            description: "v2: each customer's total for the epoch, equal to its CustomerCharged event.",
            items: { type: "object", properties: { customer: ref("Address"), amountWei: ref("Wei") } },
          },
          leaves: { type: "array", items: ref("Hash"), description: "v2: the sorted leaves of the jobs tree; their root is listHash." },
          leafRule: { type: "string" },
          codes: { type: "object", description: "v2: the uint8 codes of verdict and chargeStatus in a leaf." },
          jobs: {
            type: "array",
            description: "v1 only, served as stored.",
            items: { type: "object", properties: { jobId: ref("JobId"), payer: ref("Address"), priceWei: ref("Wei"), apiKeyId: nullable({ type: "string" }) } },
          },
        },
      },
      JobReceipt: {
        type: "object",
        description: "Version 1 of a job receipt. Every field is checked by the Verify panel; a receipt with other fields is refused.",
        required: [
          "format",
          "version",
          "state",
          "chainId",
          "paymentsContract",
          "jobId",
          "payer",
          "priceWei",
          "verdict",
          "chargeStatus",
          "outputHash",
          "nodes",
          "epochId",
          "chargeTx",
          "anchor",
          "pending",
        ],
        properties: {
          format: { const: "sparecycle-job-receipt" },
          version: { const: 1 },
          state: { enum: ["provisional", "sealed"] },
          chainId: { type: "integer" },
          paymentsContract: ref("Address"),
          jobId: ref("JobId"),
          payer: ref("Address"),
          priceWei: ref("Wei"),
          verdict: { enum: ["agreed", "disagreed", "expired", "rejected"] },
          chargeStatus: { enum: ["pending", "charged", "released", "unpaid"], description: "pending only while provisional." },
          outputHash: nullable({ ...ref("Hash"), description: "sha256 of the kept output of an agreed job." }),
          nodes: {
            type: "array",
            maxItems: 2,
            items: {
              type: "object",
              properties: {
                node: ref("Address"),
                outputHash: ref("Hash"),
                gpuMs: { type: "integer" },
                epoch: { type: "integer" },
                signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$", description: "EIP-712 Receipt, domain Sparecycle v1, the chain id above." },
              },
            },
          },
          epochId: nullable({ type: "integer", description: "The epoch whose charge committed the leaf (sealed)." }),
          chargeTx: nullable(ref("Hash")),
          anchor: nullable({
            type: "object",
            properties: {
              hashRule: { const: JOBS_HASH_RULE },
              leafInputs: {
                type: "object",
                properties: {
                  epochId: { type: "integer" },
                  jobId: ref("JobId"),
                  payer: ref("Address"),
                  priceWei: ref("Wei"),
                  verdict: { type: "integer", description: "uint8 code" },
                  chargeStatus: { type: "integer", description: "uint8 code" },
                  outputHash: { ...ref("Hash"), description: "0x00…00 unless agreed." },
                  salt: { ...ref("Hash"), description: "The leaf's 32 random bytes. Only in this receipt, never public: keep the receipt private." },
                },
              },
              leaf: ref("Hash"),
              proof: { type: "array", items: ref("Hash") },
              listHash: ref("Hash"),
            },
          }),
          pending: nullable({
            type: "object",
            properties: {
              reason: { enum: ["waiting-for-charge", "charge-unconfirmed", "no-anchor", "charged-before-receipts"] },
              epochId: nullable({ type: "integer" }),
            },
          }),
        },
      },
      FreeReceiptStub: {
        type: "object",
        properties: { jobId: ref("JobId"), payment: { const: "free" }, receipt: { const: false }, note: { type: "string" } },
      },
      Node: {
        type: "object",
        properties: {
          owner: ref("Address"),
          nodeKey: ref("Address"),
          gpu: { type: "string" },
          vramMb: { type: "integer" },
          caps: { type: "array", items: { type: "string" } },
          backend: { enum: ["cuda", "vulkan", "cpu"] },
          online: { type: "boolean" },
          working: { type: "boolean", description: "Running a job right now (holds a live lease)." },
          lastSeen: { type: "integer" },
          agreedJobs: { type: "integer" },
          epochAgreedJobs: { type: "integer" },
          project: { type: "boolean", description: "Run by Sparecycle (bootstrap GPU pool): never paid." },
        },
      },
      Account: {
        type: "object",
        properties: {
          address: ref("Address"),
          contract: nullable(ref("Address")),
          priceWeiPerUnit: ref("Wei"),
          balance: ref("Wei"),
          held: { ...ref("Wei"), description: "Held for this wallet's jobs that have no verdict yet." },
          available: { ...ref("Wei"), description: "balance minus held minus a pending withdrawal: what new jobs can use." },
          spendLimitPerEpoch: { ...ref("Wei"), description: "0 = no limit." },
          withdrawal: nullable({
            type: "object",
            properties: {
              amount: ref("Wei"),
              epoch: { type: "integer" },
              requestedAt: { type: "integer" },
              ready: { type: "boolean", description: "canWithdraw on the contract: withdraw() would succeed now." },
            },
          }),
        },
      },
      CatalogModel: {
        type: "object",
        required: ["id", "kind", "label", "license", "source", "price", "limits", "capacity"],
        properties: {
          id: { enum: [...MODEL_IDS] },
          kind: { enum: ["image", "text"] },
          name: { type: "string" },
          label: { type: "string" },
          summary: { type: "string" },
          license: { type: "string" },
          source: { type: "string", description: "Hugging Face repository of the weights." },
          sourceUrl: { type: "string", format: "uri" },
          endpoint: { enum: ["/v1/chat/completions", "/v1/images/generations"] },
          output: { enum: ["image/png", "text/plain"] },
          backends: { type: "array", items: { enum: ["cuda", "vulkan", "cpu"] } },
          vramMb: { type: "integer" },
          price: {
            type: "object",
            properties: {
              priceWeiPerUnit: ref("Wei"),
              units: { type: "string", description: "How work units are counted, in words." },
              example: { type: "object", properties: { label: { type: "string" }, units: { type: "integer" }, priceWei: ref("Wei") } },
            },
          },
          limits: { type: "object", additionalProperties: { type: "object", additionalProperties: { type: "number" } } },
          notes: { type: "array", items: { type: "string" } },
          capacity: {
            type: "object",
            properties: {
              ready: { type: "integer" },
              standby: { type: "integer" },
              pair: { enum: ["online", "pool", null] },
              pairReachable: { type: "boolean" },
              retryAfter: nullable({ type: "integer" }),
            },
          },
        },
      },
      Catalog: {
        type: "object",
        required: ["object", "models", "pricing", "network"],
        properties: {
          object: { const: "catalog" },
          generatedAt: { type: "integer" },
          pricing: {
            type: "object",
            properties: {
              currency: { const: "ETH" },
              priceWeiPerUnit: ref("Wei"),
              paidJobs: { type: "boolean" },
              freeJobsPerHour: { type: "integer" },
              charged: { type: "string" },
            },
          },
          network: {
            type: "object",
            properties: {
              operators: { enum: ["project-run", "mixed"] },
              note: { type: "string" },
              pool: {
                type: "object",
                properties: { configured: { type: "boolean" }, canStart: { type: "boolean" }, retryAfter: nullable({ type: "integer" }) },
              },
            },
          },
          models: { type: "array", items: ref("CatalogModel") },
        },
      },
      SignInNonce: {
        type: "object",
        properties: {
          nonce: { type: "string" },
          expiresAt: { type: "integer" },
          chainId: { type: "integer" },
          version: { const: "1" },
          statement: { type: "string" },
        },
      },
    },
  },
};
