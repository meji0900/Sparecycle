import { dbHealthy } from "@/server/db";
import { json } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/v1/health — liveness of the scheduler and its SQLite database. */
export async function GET() {
  if (dbHealthy()) return json({ ok: true, db: "ok" });
  return json({ ok: false, db: "error", error: "db-unavailable", message: "the scheduler database could not be opened" }, 503);
}
