import { adminChallenge, adminChallengeReport } from "@/server/challenge";
import { serverEnv } from "@/server/env";
import { handle, json, parseJson, readBody, requireAdmin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GPU challenge operator endpoint (Authorization: Bearer $SCHEDULER_ADMIN_TOKEN).
 *   GET  ?nodeKey=0x…  -> the node's challenge state, recent challenges and the admin audit log
 *   POST { nodeKey, action: "reissue" | "allow" | "revoke-allow", hours?, note? } -> writes an audit log row
 * It never assigns, changes or deletes jobs, tasks or results.
 */
export const GET = handle(async (req: Request) => {
  requireAdmin(req, serverEnv.adminToken());
  return json(adminChallengeReport(new URL(req.url).searchParams.get("nodeKey")));
});

export const POST = handle(async (req: Request) => {
  requireAdmin(req, serverEnv.adminToken());
  const text = await readBody(req, 4096);
  return json(adminChallenge(parseJson(text)));
});
