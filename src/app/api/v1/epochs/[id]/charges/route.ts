import { handle, json, parseEpochId } from "@/server/http";
import { chargesJson } from "@/server/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/epochs/:id/charges — the per-job charge list of an epoch; its hash is in the Charged event. */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return json(chargesJson(parseEpochId(id)));
});
