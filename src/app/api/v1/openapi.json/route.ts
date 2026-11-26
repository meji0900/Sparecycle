import { openApiDocument } from "@/lib/openapi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/openapi.json — the OpenAPI 3.1 description of this API (src/lib/openapi.ts). Public, cacheable. */
export async function GET() {
  return new Response(JSON.stringify(openApiDocument(), null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
