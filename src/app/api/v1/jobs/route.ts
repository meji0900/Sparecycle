import { keyFromRequest } from "@/server/apikeys";
import { POLICY, serverEnv } from "@/server/env";
import { clientIp, handle, handlePrivate, json, parseJson, privateJson, readBody } from "@/server/http";
import { listJobs, submitJob } from "@/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/jobs?limit=20 — recent jobs (prompt hashes only, never prompts). */
export const GET = handle(async (req: Request) => {
  const raw = Number(new URL(req.url).searchParams.get("limit") ?? "20");
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : 20;
  return json(listJobs(limit));
});

/**
 * POST /api/v1/jobs — submit an SD 1.5 or Qwen2.5-1.5B job: free (JOB_RATE_LIMIT per IP per hour), paid
 * ({ request, payment }) or paid with an API key (`Authorization: Bearer sck_…`, the request itself, no payment block).
 * The answer carries the job's `readSecret` (shown once, never stored in clear); a key-paid job has none (read it with
 * the key). An unknown or disabled key answers 401 invalid-api-key.
 */
export const POST = handlePrivate(async (req: Request) => {
  const key = keyFromRequest(req);
  const body = parseJson(await readBody(req, POLICY.maxJobBodyBytes));
  const res = await submitJob(body, clientIp(req), { key });
  return privateJson(res, 201, { "x-sc-rate-limit": String(serverEnv.jobRateLimit()) });
});
