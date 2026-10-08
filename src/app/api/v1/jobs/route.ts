import { POLICY, serverEnv } from "@/server/env";
import { clientIp, handle, json, parseJson, readBody } from "@/server/http";
import { listJobs, submitJob } from "@/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/jobs?limit=20 — recent jobs (prompt hashes only, never prompts). */
export const GET = handle(async (req: Request) => {
  const raw = Number(new URL(req.url).searchParams.get("limit") ?? "20");
  const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : 20;
  return json(listJobs(limit));
});

/** POST /api/v1/jobs — submit an SD 1.5 or Qwen2.5-1.5B job: free (JOB_RATE_LIMIT per IP per hour) or paid ({ request, payment }). */
export const POST = handle(async (req: Request) => {
  const body = parseJson(await readBody(req, POLICY.maxJobBodyBytes));
  const res = await submitJob(body, clientIp(req));
  return json(res, 201, { "x-sc-rate-limit": String(serverEnv.jobRateLimit()) });
});
