import { viewerFromRequest } from "@/server/auth";
import { handlePrivate, privateJson } from "@/server/http";
import { jobReceipt } from "@/server/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/jobs/:id/receipt — the payer's receipt of a paid or team job: provisional from the verdict on, sealed
 * once the charge that commits its leaf to the jobs root (the Charged event's listHash) is confirmed. Both nodes'
 * EIP-712 receipts, the leaf inputs, the Merkle proof, the charge transaction and its epoch. Same credentials as the
 * invoice; a free trial job answers a "free trial, no charge" stub. 401 (empty) / 403 / 404 / 409 no-verdict; always
 * `Cache-Control: private, no-store` and `Vary: Authorization, Cookie`.
 */
export const GET = handlePrivate(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return privateJson(jobReceipt(id, viewerFromRequest(req)));
});
