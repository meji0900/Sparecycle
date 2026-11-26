// Live capacity per model: the public catalog (GET /api/v1/catalog, ./catalog) and the capacity guard of job creation
// (next-update brief §2 item 4, decision N24, Default, not yet confirmed by Fabio: no reachable pair -> 503 no-node-pair,
// nothing queued, held or charged).
//
// A job needs two machines with different owner wallets and different GPUs on the same backend (./nodes). Per model:
//   ready    nodes online now (a poll or heartbeat within POLICY.onlineWindowSeconds, or a live lease), not paused
//            (Idle Guard), past the GPU gate (eligibleSql), that can run the model (capability tag, VRAM, a backend that
//            runs it; dev-runner nodes only on a scheduler that accepts them).
//   standby  offline project-run machines the bootstrap GPU pool starts when a job waits, that can run the model: the
//            set the home page shows as standby (src/lib/gpu-counts.ts: the most recently seen offline project nodes, at
//            most as many as the pool has machines that are not online).
//   pair     "online": two ready nodes form a pair (same backend and dev flag, different owners, different GPUs).
//            "pool":   no pair is online, but the pool can bring one up. The pool is configured and not waiting out the
//                      back-off after a start where fewer than two owners came up, and either the ready nodes plus EVERY
//                      registered offline project node that could run the model (a stopped pool machine of the other
//                      owner counts) form a pair, or no project node has registered yet and the pool has at least two
//                      owner groups (a fresh pool brings two owners up by itself).
//            null:     nothing can be reached; job creation answers 503 no-node-pair.
// No new state: everything is read from the nodes table and the pool's in-memory state at call time.
import { MODELS, MODEL_IDS, modelRunsOn, isBackend, type ModelId } from "@/lib/protocol";
import type { CatalogCapacity, PairState } from "@/lib/catalog";
import { eligibilityParams, eligibleSql } from "./challenge";
import { getDb, nowSec } from "./db";
import { POLICY, serverEnv } from "./env";
import { ApiError } from "./http";

/** What the capacity rules need to know about the GPU pool (gpu-pool.ts poolStartInfo; passed in to avoid an import cycle). */
export type PoolStart = {
  configured: boolean;
  /** Configured and not backing off after a start where fewer than two owner groups came up. */
  canStart: boolean;
  /** Distinct owner groups of GPU_POOL_INSTANCE_IDS. */
  groups: number;
  /** Pool machines in GPU_POOL_INSTANCE_IDS. */
  instances: number;
  /** While backing off: seconds until the pool may start again. */
  retryAfter: number | null;
};

export const NO_POOL: PoolStart = { configured: false, canStart: false, groups: 0, instances: 0, retryAfter: null };

type NodeRow = {
  node_key: string;
  owner: string;
  gpu_uuid: string;
  backend: string;
  dev: number;
  caps: string;
  vram_mb: number;
  last_seen: number;
  agreed_jobs: number;
  online: number;
  active: number;
  eligible: number;
};

/** Every registered node with its live flags (online, not paused, past the GPU gate). Small table: read whole. */
function nodeRows(now: number): NodeRow[] {
  return getDb()
    .prepare(
      `SELECT n.node_key, lower(n.owner) AS owner, n.gpu_uuid, n.backend, n.dev, n.caps, n.vram_mb, n.last_seen, n.agreed_jobs,
         (n.last_seen >= $online OR EXISTS (SELECT 1 FROM tasks t WHERE t.node_key = n.node_key AND t.status = 'leased'
            AND t.lease_expires >= $now)) AS online,
         (COALESCE(n.state, 'active') = 'active') AS active,
         (${eligibleSql("n")}) AS eligible
       FROM nodes n`,
    )
    .all({ online: now - POLICY.onlineWindowSeconds, now, ...eligibilityParams() }) as NodeRow[];
}

/** Can this node take a job of `model`? Capability tag, VRAM, a backend that runs it, the GPU gate, dev only when accepted. */
function canRun(n: NodeRow, model: ModelId, allowDev: boolean): boolean {
  const m = MODELS[model];
  if (!n.eligible || (n.dev && !allowDev) || n.vram_mb < m.vramMb || !isBackend(n.backend) || !modelRunsOn(model, n.backend)) return false;
  try {
    return (JSON.parse(n.caps) as string[]).includes(m.tag);
  } catch {
    return false;
  }
}

/** Do two of these nodes form a pair (same backend and dev flag, different owners, different GPUs)? */
export function hasPair(nodes: Pick<NodeRow, "owner" | "gpu_uuid" | "backend" | "dev">[]): boolean {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (a.backend === b.backend && a.dev === b.dev && a.owner !== b.owner && a.gpu_uuid !== b.gpu_uuid) return true;
    }
  }
  return false;
}

/** Owner wallets of project-run nodes (PROJECT_NODE_OWNERS and the paid-test project wallets), lowercase. */
export const projectOwnerSet = (): Set<string> => new Set([...serverEnv.projectOwners(), ...serverEnv.paidTestOwners()]);

/** Nodes online now that may take a job of `model` (online, not paused, past the GPU gate, able to run it). */
function readyFor(rows: NodeRow[], model: ModelId, allowDev: boolean) {
  return rows.filter((n) => n.online && n.active && canRun(n, model, allowDev));
}

/** Is a pair online for `model` right now? (gpu-pool.ts starts the pool for open jobs of models without one.) */
export function pairOnline(model: ModelId, now = nowSec()): boolean {
  return hasPair(readyFor(nodeRows(now), model, serverEnv.allowDevRunner()));
}

/** Owner wallets (lowercase) with a node online now that may take a job of `model`. */
export function readyOwners(model: ModelId, now = nowSec()): Set<string> {
  return new Set(readyFor(nodeRows(now), model, serverEnv.allowDevRunner()).map((n) => n.owner));
}

/** Live capacity of every model in MODELS (the catalog's `capacity` and the guard below). */
export function modelCapacity(pool: PoolStart, now = nowSec()): Record<ModelId, CatalogCapacity> {
  const rows = nodeRows(now);
  const allowDev = serverEnv.allowDevRunner();
  const project = projectOwnerSet();
  const isProject = (n: NodeRow) => project.has(n.owner);
  // Standby as the home page counts it: offline project GPUs (no dev runners), most recently seen first, at most as many
  // as the pool has machines not already online.
  const real = rows.filter((n) => !n.dev);
  const onlineProject = real.filter((n) => n.online && isProject(n)).length;
  const cap = pool.configured ? Math.max(0, pool.instances - onlineProject) : 0;
  const standbyKeys = new Set(
    real
      .filter((n) => !n.online && isProject(n))
      .sort((a, b) => b.last_seen - a.last_seen)
      .slice(0, cap)
      .map((n) => n.node_key),
  );
  const noProjectNodes = !rows.some(isProject);
  const out = {} as Record<ModelId, CatalogCapacity>;
  for (const model of MODEL_IDS) {
    const ready = readyFor(rows, model, allowDev);
    // Every registered offline project node the pool might start (not only the standby shown): a pool machine of the
    // other owner that has been stopped for a while still counts.
    const startable = pool.canStart ? rows.filter((n) => !n.online && isProject(n) && canRun(n, model, allowDev)) : [];
    let pair: PairState = null;
    if (hasPair(ready)) pair = "online";
    else if (pool.canStart && (hasPair([...ready, ...startable]) || (noProjectNodes && pool.groups >= 2))) pair = "pool";
    out[model] = {
      ready: ready.length,
      standby: rows.filter((n) => standbyKeys.has(n.node_key) && canRun(n, model, allowDev)).length,
      pair,
      pairReachable: pair !== null,
      retryAfter: pair === null && pool.configured && pool.retryAfter !== null ? pool.retryAfter : null,
    };
  }
  return out;
}

/**
 * Network wording (decision N17, Default, not yet confirmed by Fabio): "project-run" until a node of an outside owner
 * passes the GPU gate and has taken part in at least one agreed job (a registration alone does not change the wording).
 */
export function operatorsOf(now = nowSec()): "project-run" | "mixed" {
  const project = projectOwnerSet();
  return nodeRows(now).some((n) => !n.dev && n.eligible && n.agreed_jobs > 0 && !project.has(n.owner)) ? "mixed" : "project-run";
}

/** Error code of the capacity guard (scheduler JSON shape; `no_node_pair` in the OpenAI shape and MCP). */
export const NO_NODE_PAIR = "no-node-pair";

/**
 * The capacity guard of job creation: throws 503 no-node-pair when no pair of machines with different owners can take a
 * job of `model` now, neither online nor through the GPU pool. Called before anything is held, counted or queued.
 */
export function assertPairReachable(model: ModelId, pool: PoolStart, now = nowSec()) {
  const c = modelCapacity(pool, now)[model];
  if (c.pairReachable) return;
  throw new ApiError(
    503,
    NO_NODE_PAIR,
    `no two machines with different owners can take a ${model} job right now${c.retryAfter !== null ? `; the GPU pool tries again in about ${Math.max(1, Math.ceil(c.retryAfter / 60))} min` : ""}. Nothing was queued, held or charged`,
    { model, ...(c.retryAfter !== null ? { retryAfter: c.retryAfter } : {}) },
  );
}
