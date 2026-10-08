import { handle, json } from "@/server/http";
import { openEpochRow } from "@/server/epochs";
import { listNodes } from "@/server/nodes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/nodes — registered nodes only. */
export const GET = handle(async () => json(listNodes(openEpochRow()?.id ?? null)));
