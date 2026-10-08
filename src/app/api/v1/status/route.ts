import { handle, json } from "@/server/http";
import { statusJson } from "@/server/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/status — current epoch, node and job counters, last settled root, trust model. */
export const GET = handle(async () => json(await statusJson()));
