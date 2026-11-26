/**
 * How many GPUs are working, ready, paused and on standby, from the public node list and the pool status.
 * Shared by the landing hero and the "network right now" panel so both show the same numbers.
 */
import { shownNodeState, type PublicNodeState } from "@/lib/node-state";

export type CountNode = {
  nodeKey: string;
  online: boolean;
  /** Running a job right now; absent on older schedulers. */
  working?: boolean;
  state?: PublicNodeState;
  lastSeen?: number;
  dev?: boolean;
  project?: boolean;
};

export type PoolInfo = { configured: false } | { configured: true; state: string; instances: number } | undefined;

export type GpuCounts = {
  online: number;
  working: number;
  ready: number;
  paused: number;
  standby: number;
  /** Node keys shown as standby: offline Sparecycle GPUs that the pool starts when a job waits. */
  standbyKeys: Set<string>;
};

export function gpuCounts(all: CountNode[], pool: PoolInfo): GpuCounts {
  const nodes = all.filter((n) => !n.dev);
  const online = nodes.filter((n) => n.online);
  const working = online.filter((n) => n.working).length;
  const paused = online.filter((n) => !n.working && shownNodeState(n).startsWith("paused")).length;
  // Standby: offline Sparecycle GPUs, at most as many as the pool has machines not already online. The most recently
  // seen go first, so an old node record that is no longer in the pool shows as offline instead.
  let standbyKeys = new Set<string>();
  if (pool?.configured) {
    const cap = Math.max(0, pool.instances - online.filter((n) => n.project).length);
    const offline = nodes.filter((n) => !n.online && n.project).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    standbyKeys = new Set(offline.slice(0, cap).map((n) => n.nodeKey));
  }
  return {
    online: online.length,
    working,
    ready: online.length - working - paused,
    paused,
    standby: standbyKeys.size,
    standbyKeys,
  };
}
