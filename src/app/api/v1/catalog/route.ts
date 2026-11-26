import { catalogJson } from "@/server/catalog";
import { handle, json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/catalog (also /v1/catalog) — the public model catalog, no key: exactly the models the scheduler runs, with
 * the live price per work unit, how units are counted, limits, and live capacity per model (machines ready, on standby,
 * and whether a pair with different owners can be reached now). /v1/models stays OpenAI-shaped and needs an API key.
 */
export const GET = handle(async () => json(catalogJson()));
