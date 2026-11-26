import { handleOpenAI, pollChat } from "@/server/openai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/chat/completions/chatcmpl-<jobId> (also /v1/…, what `chat.completions.retrieve(id)` calls) — the job as
 * a chat.completion: empty `choices` until two nodes agree; 422 `not_charged` when they did not. Only for the key that
 * submitted the job.
 */
export const GET = handleOpenAI(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  return pollChat(req, id);
});
