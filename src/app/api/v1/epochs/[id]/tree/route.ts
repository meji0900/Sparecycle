import { handle, json, parseEpochId } from "@/server/http";
import { treeJson } from "@/server/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/epochs/:id/tree — the published payout tree of a closed epoch. */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return json(treeJson(parseEpochId(id)));
});
