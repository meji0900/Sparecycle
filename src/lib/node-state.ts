// Idle Guard: the state a node reports about its own machine (node client 0.4.0+, signed POST /api/v1/nodes/heartbeat)
// and how the node list shows it. This is the owner's machine talking, kept apart from the scheduler's verdicts on a
// node (GPU allowlist `gpuStatus`, challenge `challengeState`). Browser-safe: used by the scheduler and the UI.
//
// The node client keeps its own copy of NODE_STATES in node-client/src/idle-guard.ts (it ships standalone);
// src/server/idle-guard.test.ts fails if the two lists drift.

/** What a node may report. A node that never reported (older client) counts as "active". */
export const NODE_STATES = ["active", "paused-busy", "paused-hot", "paused-hours"] as const;
export type NodeState = (typeof NODE_STATES)[number];
export const isNodeState = (v: unknown): v is NodeState => typeof v === "string" && (NODE_STATES as readonly string[]).includes(v);

/**
 * `state` in GET /api/v1/nodes: the reported state while the node is online, otherwise "offline". The public list never
 * carries when a pause started (D9: default, not yet confirmed).
 */
export type PublicNodeState = NodeState | "offline";

export const NODE_STATE_LABEL: Record<PublicNodeState, string> = {
  active: "Active",
  "paused-busy": "Paused: owner is using the GPU",
  "paused-hot": "Paused: GPU too hot",
  "paused-hours": "Paused: outside chosen hours",
  offline: "Offline",
};

/** One line per state, for legends and docs. */
export const NODE_STATE_MEANING: Record<PublicNodeState, string> = {
  active: "Online and ready to take jobs.",
  "paused-busy": "Another program uses more than 500 MB of the GPU's memory. The node takes no jobs until it is done.",
  "paused-hot": "The GPU is at 83 °C or hotter. The node takes no jobs until it cools down.",
  "paused-hours": "Outside the hours the owner chose with --hours. The node waits for the next window.",
  offline: "No poll or heartbeat in the last two minutes: switched off, disconnected, or an older client that is paused.",
};

/** The busy/heat check reads nvidia-smi, so it only runs on CUDA nodes; Vulkan and CPU nodes pause on --hours only. */
export const IDLE_GUARD_HOURS_ONLY = "Idle Guard: hours only (busy/heat check is NVIDIA-only)";
export const idleGuardHoursOnly = (backend: string | undefined) => backend === "vulkan" || backend === "cpu";

/** A node's state as shown, also for schedulers that predate `state` (online -> active, else offline, as before). */
export const shownNodeState = (n: { state?: PublicNodeState | null; online: boolean }): PublicNodeState =>
  n.online ? (n.state && n.state !== "offline" ? n.state : "active") : "offline";
