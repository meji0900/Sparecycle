import { serverEnv } from "@/server/env";
import { closeEpoch } from "@/server/epochs";
import { handle, json, requireAdmin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/epochs/close (Authorization: Bearer $SCHEDULER_ADMIN_TOKEN) — closes the open epoch: reads the
 * pot, allocates it, publishes the tree and posts the root when SCHEDULER_SIGNER_KEY is set. If the previous
 * epoch's root is still unposted, retries that post instead.
 */
export const POST = handle(async (req: Request) => {
  requireAdmin(req, serverEnv.adminToken());
  return json(await closeEpoch());
});
