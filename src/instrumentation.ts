// Next.js instrumentation hook: boots the Sparecycle scheduler (DB migrations + optional epoch autoclose timer
// when SCHEDULER_AUTOCLOSE=1). Node.js runtime only; skipped during `next build`.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { bootScheduler } = await import("./server/autoclose");
    bootScheduler();
  }
}
