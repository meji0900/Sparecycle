// Railway healthcheck (railway.json → deploy.healthcheckPath). Always 200 while the server is up; `sweep` shows the
// last automatic sweep run (SWEEP_AUTORUN_MINUTES) so a monitor can watch it. Secret-free.
import { lastSweepStatus } from "@/server/sweep";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ok: true,
    network: process.env.NEXT_PUBLIC_NETWORK ?? "mainnet",
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    sweep: lastSweepStatus(),
  });
}
