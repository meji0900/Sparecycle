import { createPendingKey, listKeys, sessionOwner } from "@/server/apikeys";
import { handlePrivate, parseJson, privateJson, readBody, requireJson } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/keys — the signed-in wallet's API keys: label, prefix, cap, spent today (UTC), status. Session only. */
export const GET = handlePrivate(async (req: Request) => privateJson(listKeys(sessionOwner(req))));

/**
 * POST /api/v1/keys { label?, dailyCapWei } — creates a pending key and answers its id, fingerprint and the link
 * message the wallet signs (then POST /api/v1/keys/:id/activate). Session only; the secret is not in this answer.
 */
export const POST = handlePrivate(async (req: Request) => {
  const owner = sessionOwner(req);
  requireJson(req);
  const body = parseJson(await readBody(req, 4 * 1024));
  return privateJson(createPendingKey(owner, body), 201);
});
