import { viewerFromRequest } from "@/server/auth";
import { handlePrivate, privateJson } from "@/server/http";
import { jobDetail } from "@/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/jobs/:id — status, timestamps, parameters (without the prompt), `outputAvailable`, and the output URL
 * when the caller may read it (OUTPUT_AUTH=enforce: read secret or paying wallet's session).
 */
export const GET = handlePrivate(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return privateJson(jobDetail(id, viewerFromRequest(req)));
});
