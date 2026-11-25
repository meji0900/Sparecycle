import { POLICY } from "@/server/env";
import { handle, json, readBody, verifyNodeRequest } from "@/server/http";
import { pollForTask } from "@/server/nodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/nodes/poll (signed) — 204, { taskId, jobId, epoch, spec }, or a challenge { type: "challenge", challengeId, spec } (only for nodes with the challenge feature). Long poll, a few seconds. */
export const POST = handle(async (req: Request) => {
  const text = await readBody(req, POLICY.maxJobBodyBytes);
  const nodeKey = await verifyNodeRequest(req, text);
  const task = await pollForTask(nodeKey, req.signal);
  return task ? json(task) : new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
});
