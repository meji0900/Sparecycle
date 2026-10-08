import { handle, json } from "@/server/http";
import { epochsJson } from "@/server/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/epochs — every epoch the scheduler knows, newest first. */
export const GET = handle(async () => json(await epochsJson()));
