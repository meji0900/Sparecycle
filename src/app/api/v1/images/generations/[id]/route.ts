import { handleOpenAI, pollImage } from "@/server/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/images/generations/img-<jobId> (also /v1/…) — a Sparecycle extension (the OpenAI SDKs have no such
 * call): empty `data` until two nodes agree, then `b64_json` or `url`; 422 `not_charged` when they did not. Only for
 * the key that submitted the job.
 */
export const GET = handleOpenAI(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return pollImage(req, id);
});
