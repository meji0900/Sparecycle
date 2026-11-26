import { errorResponse, handle, json, requireAdmin } from "@/server/http";
import { serverEnv } from "@/server/env";
import { holderAccountJson, holderEpochsJson } from "@/server/holder-api";
import { slashingDetailJson, slashingListJson } from "@/server/slashing";
import { tokenPayloadsJson } from "@/server/token-work";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Unknown /api/v1 paths answer with a JSON 404 instead of an HTML page. */
const notFound = async () => errorResponse(404, "not-found", "no such scheduler endpoint");

/**
 * GET also serves the token-feature endpoints that exist only behind their flag (docs/token-features.md), so that with
 * the flag off (the default) they are exactly the unknown path they were before, and the OpenAPI description is
 * unchanged: GET slashing and GET slashing/:id with TOKEN_SLASHING=on (src/server/slashing.ts), and the operator's
 * GET admin/token-payloads (Bearer SCHEDULER_ADMIN_TOKEN) with TOKEN_BURNS, TOKEN_HOLDERS or TOKEN_SLASHING on
 * (src/server/token-work.ts), and the public GET holders/epochs and GET holders/:address with TOKEN_HOLDERS=on
 * (src/server/holder-api.ts).
 */
export const GET = handle(async (req: Request, ctx: { params: Promise<{ path: string[] }> }) => {
  const { path } = await ctx.params;
  if (serverEnv.tokenSlashing() && path[0] === "slashing") {
    if (path.length === 1) return json(slashingListJson(true));
    if (path.length === 2) return json(slashingDetailJson(true, path[1]));
  }
  if (serverEnv.tokenHolders() && path[0] === "holders" && path.length === 2) {
    return json(path[1] === "epochs" ? holderEpochsJson() : await holderAccountJson(path[1]));
  }
  const anyTokenWork = serverEnv.tokenBurns() || serverEnv.tokenHolders() || serverEnv.tokenSlashing();
  if (anyTokenWork && path.length === 2 && path[0] === "admin" && path[1] === "token-payloads") {
    requireAdmin(req, serverEnv.adminToken());
    return json(tokenPayloadsJson());
  }
  return notFound();
});
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
