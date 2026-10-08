import { handle, json, parseEpochId } from "@/server/http";
import { proofJson } from "@/server/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/epochs/:id/proof?account=0x… — amount, leaf and Merkle proof for claim(epochId, amount, proof). */
export const GET = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return json(proofJson(parseEpochId(id), new URL(req.url).searchParams.get("account")));
});
