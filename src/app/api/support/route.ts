import { ApiError, clientIp, handle, json, parseJson, readBody } from "@/server/http";
import { SUPPORT_LIMITS, submitSupport, supportEnabled } from "@/server/support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/support { topic, wallet?, jobId?, message } — the support form on /docs/support. Forwarded to
 * SUPPORT_WEBHOOK_URL and not stored; 503 support-off until that is set. Answers { ok: true } only, never the message.
 */
export const POST = handle(async (req: Request) => {
  if (!supportEnabled()) throw new ApiError(503, "support-off", "the support form is not switched on yet");
  // JSON only: a plain cross-site HTML form cannot send it.
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    throw new ApiError(415, "json-required", "send the form as application/json");
  }
  const body = parseJson(await readBody(req, SUPPORT_LIMITS.bodyBytes));
  return json(await submitSupport(body, clientIp(req)));
});
