import { handle, json, parseJson, readBody, verifyNodeRequest } from "@/server/http";
import { recordHeartbeat } from "@/server/nodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A heartbeat is `{ state, since, nonce }`: well under 1 KB. */
const MAX_HEARTBEAT_BYTES = 1024;

/**
 * POST /api/v1/nodes/heartbeat (signed, node client 0.4.0+) — `{ state: "active" | "paused-busy" | "paused-hot" |
 * "paused-hours", since }` -> `{ ok, state, since }`. Sent on every state change and at least every 60 s while paused,
 * so a paused node stays online and shows why it takes no jobs. Only the state code is sent, never a reading.
 */
export const POST = handle(async (req: Request) => {
  const text = await readBody(req, MAX_HEARTBEAT_BYTES);
  const nodeKey = await verifyNodeRequest(req, text);
  return json(recordHeartbeat(nodeKey, parseJson(text)));
});
