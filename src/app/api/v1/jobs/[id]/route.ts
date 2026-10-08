import { handle, json } from "@/server/http";
import { jobDetail } from "@/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/jobs/:id — status, timestamps, parameters (without the prompt) and the output URL when agreed. */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return json(jobDetail(id));
});
