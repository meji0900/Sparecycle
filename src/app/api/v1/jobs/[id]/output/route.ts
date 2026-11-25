import { ANONYMOUS } from "@/server/auth";
import { serverEnv } from "@/server/env";
import { clientIp, handlePrivate, privateBinary, privateJson } from "@/server/http";
import { jobOutput } from "@/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/jobs/:id/output — retired; outputs moved to /api/v1/jobs/:id/result. With OUTPUT_AUTH=enforce this
 * answers 410 Gone. With OUTPUT_AUTH=off it still serves the agreed output to anyone, but never with a public cache
 * header again (`Cache-Control: private, no-store`).
 */
export const GET = handlePrivate(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  if (serverEnv.outputAuth() === "enforce") {
    return privateJson({ error: "gone", message: "outputs moved to /api/v1/jobs/:id/result, readable only with the job's read secret or the paying wallet's sign-in" }, 410);
  }
  const out = jobOutput(id, ANONYMOUS, { ip: clientIp(req), mode: "off" });
  return privateBinary(out.body, out.type, {
    "content-disposition": `inline; filename="${id.slice(0, 18)}.${out.type === "image/png" ? "png" : "txt"}"`,
    "x-content-type-options": "nosniff",
  });
});

export const HEAD = GET;
