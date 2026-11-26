import { activateKey, sessionOwner } from "@/server/apikeys";
import { handlePrivate, parseJson, privateJson, readBody, requireJson } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/keys/:id/activate { signature } — the wallet's EIP-191 signature over the key's link message (EOA,
 * ERC-1271 or ERC-6492). Answers the full key `sck_…` exactly once; it is never stored or shown again. Session only.
 */
export const POST = handlePrivate(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const owner = sessionOwner(req);
  requireJson(req);
  const { id } = await ctx.params;
  const body = parseJson(await readBody(req, 32 * 1024));
  return privateJson(await activateKey(owner, id, body));
});
