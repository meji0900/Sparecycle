import { handle } from "@/server/http";
import { jobOutput } from "@/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/jobs/:id/output — the agreed output: image/png or text/plain. */
export const GET = handle(async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const out = jobOutput(id);
  return new Response(Buffer.from(out.body), {
    status: 200,
    headers: {
      "content-type": out.type,
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": `inline; filename="${id.slice(0, 18)}.${out.type === "image/png" ? "png" : "txt"}"`,
    },
  });
});
