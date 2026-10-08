import { POLICY } from "@/server/env";
import { handle, json, parseJson, readBody, verifyNodeRequest } from "@/server/http";
import { registerNode } from "@/server/nodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/v1/nodes/register (signed) — { gpu, gpuUuid, vramMb, caps, owner, ownerSig }. */
export const POST = handle(async (req: Request) => {
  const text = await readBody(req, POLICY.maxJobBodyBytes);
  const nodeKey = await verifyNodeRequest(req, text);
  return json(await registerNode(nodeKey, parseJson(text)));
});
