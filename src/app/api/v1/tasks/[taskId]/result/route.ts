import { POLICY } from "@/server/env";
import { handle, json, parseJson, readBody, verifyNodeRequest } from "@/server/http";
import { submitResult } from "@/server/results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/tasks/:taskId/result (signed) — { outputHash, gpuMs, epoch, signature, png? | text? }. */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ taskId: string }> }) => {
  const { taskId } = await ctx.params;
  const text = await readBody(req, POLICY.maxNodeBodyBytes);
  const nodeKey = await verifyNodeRequest(req, text);
  return json(await submitResult(nodeKey, taskId, parseJson(text)));
});
