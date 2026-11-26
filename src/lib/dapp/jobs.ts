import type { Tone } from "@/components/ui/status";
import { recheckLabel } from "@/lib/rounds";
import type { ApiJob } from "./api";

export const MODEL_LABEL: Record<string, string> = {
  sd15: "Stable Diffusion 1.5",
  "qwen2.5-1.5b": "Qwen2.5-1.5B-Instruct",
};

export const modelLabel = (m: string) => MODEL_LABEL[m] ?? m;

/** Check status of a job as a tag: shape + words, never colour alone. */
export function jobTag(job: Pick<ApiJob, "status" | "eligible" | "paid" | "round" | "maxRounds">): { tone: Tone; label: string } {
  // A paid job checked again on another pair (src/server/rounds.ts): say so while it waits or runs.
  const recheck = TERMINAL.includes(job.status) ? null : recheckLabel(job.round, job.maxRounds);
  if (recheck) return { tone: "neutral", label: recheck };
  switch (job.status) {
    case "queued":
      return { tone: "neutral", label: "Queued" };
    case "running":
      return { tone: "neutral", label: "Running on two nodes" };
    case "checking":
      return { tone: "neutral", label: "Comparing results" };
    case "agreed":
      if (job.paid) return { tone: "live", label: "Paid in a posted root" };
      if (job.eligible) return { tone: "live", label: "Agreed, eligible" };
      return { tone: "live", label: "Agreed" };
    case "disagreed":
      return { tone: "warn", label: "Disagreed, unpaid" };
    case "expired":
      return { tone: "off", label: "Expired, unpaid" };
    case "rejected":
      return { tone: "error", label: "Rejected (safety check), unpaid" };
    default:
      return { tone: "neutral", label: String(job.status) };
  }
}

export const TERMINAL: ApiJob["status"][] = ["agreed", "disagreed", "expired", "rejected"];

/**
 * Where a job is in the lifecycle strip:
 * 0 queued, 1 running on two nodes, 2 results compared, 3 agreed or disagreed, 4 eligible in the epoch root,
 * 5 paid in a posted root (every step done).
 */
export function lifecycleStage(job: Pick<ApiJob, "status" | "eligible" | "paid">): number {
  switch (job.status) {
    case "queued":
      return 0;
    case "running":
      return 1;
    case "checking":
      return 2;
    case "agreed":
      return job.paid ? 5 : job.eligible ? 4 : 3;
    default:
      return 3;
  }
}
