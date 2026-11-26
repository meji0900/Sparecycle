// Idle Guard state pill and the "hours only" note for Vulkan / CPU nodes. No hooks: usable from server and client
// components alike (the /nodes legend renders on the server, the live lists in the browser).
import { StatusTag, type Tone } from "@/components/ui/status";
import { relativeTime } from "@/lib/format";
import { IDLE_GUARD_HOURS_ONLY, idleGuardHoursOnly, NODE_STATE_LABEL, shownNodeState, type PublicNodeState } from "@/lib/node-state";
import { cn } from "@/lib/utils";

/** Shape + word per state (never colour alone): active = filled dot, paused = hollow dot, too hot = warning. */
export const NODE_STATE_TONE: Record<PublicNodeState, Tone> = {
  active: "live",
  "paused-busy": "neutral",
  "paused-hot": "warn",
  "paused-hours": "neutral",
  offline: "off",
};

/**
 * The state of one node from GET /api/v1/nodes. Older schedulers send no `state`: online shows as active, the rest as
 * offline. `now` (ms) adds "seen … ago" to offline nodes; a paused node never shows when its pause began (D9).
 */
export function NodeStatePill({
  node,
  now,
  className,
}: {
  node: { online: boolean; state?: PublicNodeState | null; lastSeen?: number };
  now?: number | null;
  className?: string;
}) {
  const state = shownNodeState(node);
  const seen = state === "offline" && now != null && node.lastSeen ? `, seen ${relativeTime(node.lastSeen * 1000, now)}` : "";
  return (
    <StatusTag tone={NODE_STATE_TONE[state]} className={className}>
      {NODE_STATE_LABEL[state]}
      {seen}
    </StatusTag>
  );
}

/** "Idle Guard: hours only (busy/heat check is NVIDIA-only)" for Vulkan and CPU nodes; nothing for CUDA. */
export function IdleGuardNote({ backend, className }: { backend?: string; className?: string }) {
  if (!idleGuardHoursOnly(backend)) return null;
  return <span className={cn("block text-xs text-faint", className)}>{IDLE_GUARD_HOURS_ONLY}</span>;
}
