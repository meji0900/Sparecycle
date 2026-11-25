import { viewerFromRequest } from "@/server/auth";
import { clientIp, handlePrivate, privateBinary } from "@/server/http";
import { jobOutput } from "@/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/jobs/:id/result — the agreed output (image/png or text/plain). With OUTPUT_AUTH=enforce only for the
 * job's read secret (`Authorization: Bearer`) or a session of the paying wallet (cookie); 401 / 403 / 404 / 409
 * otherwise. Node request signatures are not credentials. Always `Cache-Control: private, no-store`.
 */
export const GET = handlePrivate(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const out = jobOutput(id, viewerFromRequest(req), { ip: clientIp(req) });
  return privateBinary(out.body, out.type, {
    "content-disposition": `inline; filename="${id.slice(0, 18)}.${out.type === "image/png" ? "png" : "txt"}"`,
    "x-content-type-options": "nosniff",
  });
});

export const HEAD = GET;
