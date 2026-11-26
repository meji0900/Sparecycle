import { openApiDocument, OPENAPI_MODULES } from "@/lib/openapi";
import { holdersApi } from "@/lib/openapi-holders";
import { serverEnv } from "@/server/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/openapi.json — the OpenAPI 3.1 description of this API (src/lib/openapi.ts). Public, cacheable. The holder
 * endpoints (src/lib/openapi-holders.ts) are described only while TOKEN_HOLDERS is on, like the endpoints themselves.
 */
export async function GET() {
  const doc = openApiDocument(serverEnv.tokenHolders() ? [...OPENAPI_MODULES, holdersApi] : OPENAPI_MODULES);
  return new Response(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
