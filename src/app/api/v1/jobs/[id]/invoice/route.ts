import { viewerFromRequest } from "@/server/auth";
import { handlePrivate, privateJson } from "@/server/http";
import { jobInvoice } from "@/server/invoices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/jobs/:id/invoice — the private invoice of a paid or team job: price, protocol cut, verdict, charge
 * status, output hash (not the file), epochs and transaction links. Only for a session of the wallet that paid or
 * the job's read secret (`Authorization: Bearer`); a free trial job answers a "free trial, no charge" stub.
 * 401 (empty) / 403 / 404; always `Cache-Control: private, no-store` and `Vary: Authorization, Cookie`.
 */
export const GET = handlePrivate(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return privateJson(jobInvoice(id, viewerFromRequest(req)));
});
