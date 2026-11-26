import { handle, json, parseEpochId } from "@/server/http";
import { chargesJson } from "@/server/payments";
import { x402ChargesOf } from "@/server/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/epochs/:id/charges — the per-job charge list of an epoch; its hash is in the Charged event. An epoch
 * with an x402 tree (src/server/x402.ts) also carries an `x402` block; no other epoch changes.
 */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const epochId = parseEpochId(id);
  return json({ ...chargesJson(epochId), ...x402ChargesOf(epochId) });
});
