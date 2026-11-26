import { deleteKey, sessionOwner, updateKey } from "@/server/apikeys";
import { handlePrivate, parseJson, privateJson, readBody, requireJson } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/v1/keys/:id { label?, dailyCapWei?, status?: "active" | "disabled" } — relabel, lower the cap, disable
 * (kill switch) or re-enable. Raising the cap answers 409 link-signature-required with a new link message; send it back
 * signed as { dailyCapWei, issued, signature }. Session only.
 */
export const PATCH = handlePrivate(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const owner = sessionOwner(req);
  requireJson(req);
  const { id } = await ctx.params;
  const body = parseJson(await readBody(req, 32 * 1024));
  return privateJson(await updateKey(owner, id, body));
});

/** DELETE /api/v1/keys/:id — stops the key at once (its queued jobs are cancelled, never charged). Session only. */
export const DELETE = handlePrivate(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const owner = sessionOwner(req);
  const { id } = await ctx.params;
  return privateJson(deleteKey(owner, id));
});
