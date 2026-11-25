import { submitChallengeResult } from "@/server/challenge";
import { POLICY } from "@/server/env";
import { handle, json, parseJson, readBody, verifyNodeRequest } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/challenges/:id/result (signed) — a node's answer to a GPU challenge:
 * { outputHash, gpuMs, signature (EIP-712 ChallengeResult), png? | text? }. Unpaid; never a job.
 */
export const POST = handle(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const text = await readBody(req, POLICY.maxNodeBodyBytes);
  const nodeKey = await verifyNodeRequest(req, text);
  return json(await submitChallengeResult(nodeKey, id, parseJson(text)));
});
