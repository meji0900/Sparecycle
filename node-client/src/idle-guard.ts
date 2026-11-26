// Idle Guard: the state this node reports to the scheduler (signed POST /api/v1/nodes/heartbeat, node client 0.4.0+),
// so the public node list can say why a node takes no jobs instead of showing it as offline.
//
// Only the state code and when it began leave the machine: never a temperature, a VRAM figure, a process name or a PID.
// The scheduler's copy of NODE_STATES is src/lib/node-state.ts in the Sparecycle repo (a test there keeps them equal).

export const NODE_STATES = ["active", "paused-busy", "paused-hot", "paused-hours"] as const;
export type NodeState = (typeof NODE_STATES)[number];
/** Why the GPU check (gpu.ts, CUDA only) pauses the node. */
export type GpuPause = "paused-busy" | "paused-hot";

/**
 * While paused, a heartbeat goes out at least this often. Below the scheduler's 120 s online window, so a paused node
 * never looks offline. Default, not yet confirmed.
 */
export const HEARTBEAT_SECONDS = 60;
/** The periodic heartbeat is sent this much early, so two heartbeats are never more than HEARTBEAT_SECONDS apart. */
const EARLY_MS = 5_000;
/** A heartbeat the scheduler did not accept is retried after this long. */
const RETRY_MS = 5_000;

/** Local log text per state (the node prints it; the scheduler only gets the code). */
export const STATE_TEXT: Record<NodeState, string> = {
  active: "active: taking jobs",
  "paused-busy": "paused: another program is using the GPU (more than 500 MB of VRAM)",
  "paused-hot": "paused: GPU too hot (83 °C or more)",
  "paused-hours": "paused: outside --hours",
};

/** The state right now: outside --hours wins, then the GPU check (null = not busy, not hot, or not checked). */
export function currentState(insideHours: boolean, gpu: GpuPause | null): NodeState {
  if (!insideHours) return "paused-hours";
  return gpu ?? "active";
}

/** The last heartbeat the scheduler accepted. */
export type Sent = { state: NodeState; atMs: number };

/** Send a heartbeat now? On every change of state, and every HEARTBEAT_SECONDS while paused. */
export function heartbeatDue(state: NodeState, sent: Sent | null, nowMs: number): boolean {
  if (!sent || sent.state !== state) return true;
  return state !== "active" && nowMs - sent.atMs >= HEARTBEAT_SECONDS * 1000 - EARLY_MS;
}

/**
 * How long a paused node sleeps before it looks again: `recheckMs`, cut short when the next heartbeat is due, or after
 * a few seconds when the scheduler has not accepted this state yet (the heartbeat failed).
 */
export function pauseSleepMs(state: NodeState, recheckMs: number, sent: Sent | null, nowMs: number): number {
  if (!sent || sent.state !== state) return Math.min(recheckMs, RETRY_MS);
  const due = sent.atMs + HEARTBEAT_SECONDS * 1000 - EARLY_MS;
  return Math.max(1_000, Math.min(recheckMs, due - nowMs));
}

/** The heartbeat body: the state code and when it began (unix seconds). Nothing else about the machine. */
export const heartbeatBody = (state: NodeState, sinceMs: number): { state: NodeState; since: number } => ({
  state,
  since: Math.floor(sinceMs / 1000),
});
