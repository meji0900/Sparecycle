// Node registration, task assignment (long poll) and the public node list.
//
// Assignment rules:
//   - a job's two tasks go to two distinct nodes with distinct owner wallets AND distinct GPU UUIDs;
//   - both tasks run on the SAME backend (cuda | vulkan | cpu), and dev-runner nodes pair only with dev-runner
//     nodes: CUDA, Vulkan and CPU kernels differ in floating point, so mixed pairs could disagree honestly;
//   - the node needs the model's capability tag, enough VRAM and a backend that runs the model (SD 1.5 = CUDA only);
//   - the first task of a job is handed out only if a compatible peer (same backend, other owner, other GPU,
//     capable, online) exists to take the second one, so a lone node can't strand a job;
//   - a lease expires after POLICY.taskLeaseSeconds and the task goes back to the queue;
//   - only nodes that pass the GPU gate get job tasks, and the peer check counts only such peers: the allowlist
//     (GPU_ALLOWLIST_MODE, src/server/gpu-allowlist.ts) and the periodic challenge (CHALLENGE_MODE,
//     src/server/challenge.ts). A due challenge is handed out before any new job task;
//   - Idle Guard: a node that reported a pause (POST /nodes/heartbeat, node client 0.4.0+) gets nothing at all (no job,
//     no challenge, no held lease back) and is not counted as the compatible peer. This is the owner's machine state,
//     kept apart from the GPU gate above. A node that never reported (older client) counts as active.
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { publicClient, targetChain } from "@/lib/chain";
import { isNodeState, NODE_STATES, type NodeState, type PublicNodeState } from "@/lib/node-state";
import {
  BACKENDS,
  CAPABILITY_TAGS,
  CHALLENGE_FEATURE,
  capabilityTagsFor,
  isBackend,
  linkMessage,
  MODELS,
  MODEL_IDS,
  modelRunsOn,
  REQUEST_WINDOW_SECONDS,
  type Backend,
  type ChallengeAssignment,
  type JobSpec,
  type JobStatus,
  type ModelId,
} from "@/lib/protocol";
import { getDb, nowSec, tx } from "./db";
import { POLICY, serverEnv } from "./env";
import { ApiError } from "./http";
import { ensureEpoch } from "./epochs";
import { expireStaleJobs } from "./jobs";
import { challengeable, eligibilityParams, eligibleSql, jobEligible, nextChallenge, type ChallengeState } from "./challenge";
import { classifyDevice, GPU_SUPPORT_URL, gpuStatusOf, sanitizeDeviceInfo, type GpuStatus } from "./gpu-allowlist";

export type NodeRow = {
  node_key: Address;
  owner: Address;
  gpu: string;
  gpu_uuid: string;
  vram_mb: number;
  caps: string;
  dev: number;
  backend: Backend;
  last_seen: number;
  agreed_jobs: number;
  family: string | null;
  gpu_status: GpuStatus | null;
  device_info: string | null;
  challenge_cap: number;
  challenge_state: ChallengeState | null;
  challenge_fails: number;
  challenge_due_at: number | null;
  cooldown_until: number | null;
  allow_until: number | null;
  /** Idle Guard state reported by the node (NULL = nothing reported since registering: active). */
  state: NodeState | null;
  /** When the reported state began (unix seconds, as the node said, never later than receipt). Never public. */
  state_since: number | null;
};

type Obj = Record<string, unknown>;

const shortText = (v: unknown, field: string, max = 128): string => {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > max) {
    throw new ApiError(400, "invalid-registration", `${field} must be text of 1..${max} characters`, { field });
  }
  return v.trim();
};

async function ownerSigValid(nodeKey: Address, owner: Address, sig: Hex): Promise<boolean> {
  const message = linkMessage(nodeKey, owner);
  try {
    if (await verifyMessage({ address: owner, message, signature: sig })) return true;
  } catch {
    /* fall through to the contract-wallet check */
  }
  try {
    // Smart-contract wallets (ERC-1271 / ERC-6492) need an RPC call.
    return await publicClient.verifyMessage({ address: owner, message, signature: sig });
  } catch {
    return false;
  }
}

/** POST /api/v1/nodes/register */
export async function registerNode(nodeKey: Address, body: unknown) {
  if (typeof body !== "object" || body === null) throw new ApiError(400, "invalid-registration", "expected a JSON object");
  const b = body as Obj;
  const gpu = shortText(b.gpu, "gpu");
  const gpuUuid = shortText(b.gpuUuid, "gpuUuid");
  const vramMb = b.vramMb;
  if (typeof vramMb !== "number" || !Number.isInteger(vramMb) || vramMb < 0 || vramMb > 1_000_000) {
    throw new ApiError(400, "invalid-registration", "vramMb must be a whole number of MB", { field: "vramMb" });
  }
  const backend = b.backend === undefined ? "cuda" : b.backend;
  if (!isBackend(backend)) {
    throw new ApiError(400, "invalid-registration", `backend must be one of ${BACKENDS.join(", ")}`, { field: "backend" });
  }
  if (!Array.isArray(b.caps) || b.caps.length === 0 || !b.caps.every((c) => typeof c === "string" && CAPABILITY_TAGS.includes(c))) {
    throw new ApiError(400, "invalid-registration", `caps must be a non-empty subset of ${CAPABILITY_TAGS.join(", ")}`, {
      field: "caps",
    });
  }
  const allowed = capabilityTagsFor(backend);
  const notHere = (b.caps as string[]).filter((c) => !allowed.includes(c));
  if (notHere.length) {
    throw new ApiError(400, "invalid-registration", `backend ${backend} can't run ${notHere.join(", ")} (allowed: ${allowed.join(", ")})`, {
      field: "caps",
    });
  }
  const caps = [...new Set(b.caps as string[])].sort();
  if (typeof b.owner !== "string" || !isAddress(b.owner)) {
    throw new ApiError(400, "invalid-registration", "owner must be a wallet address", { field: "owner" });
  }
  const owner = getAddress(b.owner);
  if (typeof b.ownerSig !== "string" || !/^0x[0-9a-fA-F]+$/.test(b.ownerSig)) {
    throw new ApiError(400, "invalid-registration", "ownerSig must be a hex signature", { field: "ownerSig" });
  }
  const dev = b.dev === true;
  if (dev && !serverEnv.allowDevRunner()) {
    throw new ApiError(403, "dev-runner-not-accepted", "this scheduler does not accept dev-runner nodes (no GPU, synthetic outputs)");
  }
  // Optional fields of node client 0.3.0+ (older bodies have neither and register exactly as before).
  const device = sanitizeDeviceInfo(b.device);
  const challengeCap = Array.isArray(b.features) && b.features.includes(CHALLENGE_FEATURE) ? 1 : 0;
  const cls = classifyDevice({ backend, gpu, device, dev });
  const allowlistMode = serverEnv.gpuAllowlistMode();
  console.log(
    `[sparecycle] gpu-allowlist ${allowlistMode}: node ${nodeKey} ${JSON.stringify(gpu)} ${backend}${device?.computeCap ? ` cc${device.computeCap}` : ""} -> ${cls.family} (${cls.status}, rule ${cls.rule})`,
  );
  if (cls.status === "blocked" && allowlistMode === "enforce") {
    throw new ApiError(403, "gpu-not-supported", `this device (${cls.family}) is not supported by the Sparecycle network`, {
      supported: GPU_SUPPORT_URL,
      family: cls.family,
    });
  }
  const gpuStatus = gpuStatusOf(cls.status);
  if (!(await ownerSigValid(nodeKey, owner, b.ownerSig as Hex))) {
    throw new ApiError(401, "bad-owner-signature", `ownerSig must be the owner's signature of: ${linkMessage(nodeKey, owner)}`);
  }
  const version = typeof b.version === "string" ? b.version.slice(0, 32) : null;
  const now = nowSec();
  const challenge = challengeable({ challenge_cap: challengeCap, backend, caps: JSON.stringify(caps), vram_mb: vramMb, dev: dev ? 1 : 0 });
  const state = tx((db) => {
    const clash = db
      .prepare("SELECT owner FROM nodes WHERE gpu_uuid = ? AND owner != ? AND node_key != ? LIMIT 1")
      .get(gpuUuid, owner, nodeKey) as { owner: string } | undefined;
    if (clash) throw new ApiError(409, "gpu-linked-to-other-wallet", "this GPU is already registered to a different owner wallet");
    // A new node key on a GPU whose other node key is suspended starts suspended too.
    const suspendedTwin = db
      .prepare("SELECT 1 AS x FROM nodes WHERE gpu_uuid = ? AND node_key != ? AND challenge_state = 'suspended' LIMIT 1")
      .get(gpuUuid, nodeKey);
    const initialState: ChallengeState | null = suspendedTwin ? "suspended" : challenge ? "pending-challenge" : null;
    // Re-registering never clears a challenge state (a cooldown or suspension sticks to the node key). It does clear the
    // Idle Guard state: a (re)start is a new session, and an older client that never sends a heartbeat must not inherit
    // a pause left behind by a newer one on the same key.
    db.prepare(
      `INSERT INTO nodes (node_key, owner, owner_sig, gpu, gpu_uuid, vram_mb, caps, dev, backend, version, registered_at, last_seen,
         family, gpu_status, device_info, challenge_cap, challenge_state, challenge_due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_key) DO UPDATE SET owner = excluded.owner, owner_sig = excluded.owner_sig, gpu = excluded.gpu,
         gpu_uuid = excluded.gpu_uuid, vram_mb = excluded.vram_mb, caps = excluded.caps, dev = excluded.dev,
         backend = excluded.backend, version = excluded.version, last_seen = excluded.last_seen,
         family = excluded.family, gpu_status = excluded.gpu_status, device_info = excluded.device_info,
         challenge_cap = excluded.challenge_cap, state = NULL, state_since = NULL,
         challenge_due_at = CASE WHEN nodes.challenge_state IS NULL THEN excluded.challenge_due_at ELSE nodes.challenge_due_at END,
         challenge_state = COALESCE(nodes.challenge_state, excluded.challenge_state)`,
    ).run(
      nodeKey,
      owner,
      b.ownerSig as string,
      gpu,
      gpuUuid,
      vramMb,
      JSON.stringify(caps),
      dev ? 1 : 0,
      backend,
      version,
      now,
      now,
      cls.family,
      gpuStatus,
      device ? JSON.stringify(device) : null,
      challengeCap,
      initialState,
      initialState ? now : null,
    );
    const row = db.prepare("SELECT challenge_state FROM nodes WHERE node_key = ?").get(nodeKey) as { challenge_state: ChallengeState | null };
    return row.challenge_state;
  });
  const epoch = await ensureEpoch().catch(() => null);
  return {
    ok: true,
    nodeKey,
    owner,
    caps,
    dev,
    backend,
    chainId: targetChain.id,
    epoch: epoch?.id ?? null,
    // Additive fields (older nodes ignore them).
    gpu: { family: cls.family, status: gpuStatus, allowlistMode, supported: GPU_SUPPORT_URL },
    challenge: { mode: serverEnv.challengeMode(), feature: challengeCap === 1, challengeable: challenge, state },
  };
}

function getNode(nodeKey: Address): NodeRow {
  const row = getDb().prepare("SELECT * FROM nodes WHERE node_key = ?").get(nodeKey) as NodeRow | undefined;
  if (!row) throw new ApiError(403, "not-registered", "register this node first (POST /api/v1/nodes/register)");
  return row;
}

// ---- Idle Guard --------------------------------------------------------------------------------------
/** SQL: the node (table alias `n`) has not reported a pause. NULL (never reported, older client) counts as active. */
const activeSql = (n: string) => `COALESCE(${n}.state, 'active') = 'active'`;

/** Has this node reported a pause? Read fresh, so a heartbeat that just arrived counts. */
export function nodePaused(nodeKey: Address): boolean {
  const row = getDb().prepare("SELECT state FROM nodes WHERE node_key = ?").get(nodeKey) as { state: string | null } | undefined;
  return (row?.state ?? "active") !== "active";
}

/**
 * POST /api/v1/nodes/heartbeat — body `{ state, since }`: the node's own state and when it began (unix seconds,
 * optional, default now). Counts as a sign of life like a poll (the node stays online while paused). Only the state
 * code is accepted and stored; no temperature, process or PID is asked for. Answers the stored `{ ok, state, since }`
 * to the node itself; `since` never appears in the public list (D9).
 */
export function recordHeartbeat(nodeKey: Address, body: unknown): { ok: true; state: NodeState; since: number } {
  const node = getNode(nodeKey);
  if (node.dev && !serverEnv.allowDevRunner()) {
    throw new ApiError(403, "dev-runner-not-accepted", "this scheduler does not accept dev-runner nodes");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "invalid-heartbeat", "expected a JSON object");
  }
  const b = body as Obj;
  if (!isNodeState(b.state)) {
    throw new ApiError(400, "invalid-heartbeat", `state must be one of ${NODE_STATES.join(", ")}`, { field: "state" });
  }
  const now = nowSec();
  let since = now;
  if (b.since !== undefined) {
    if (typeof b.since !== "number" || !Number.isInteger(b.since) || b.since < 0 || b.since > now + REQUEST_WINDOW_SECONDS) {
      throw new ApiError(400, "invalid-heartbeat", "since must be unix seconds, not in the future", { field: "since" });
    }
    since = Math.min(b.since, now);
  }
  getDb().prepare("UPDATE nodes SET state = ?, state_since = ?, last_seen = ? WHERE node_key = ?").run(b.state, since, now, nodeKey);
  return { ok: true, state: b.state, since };
}

export type Assignment = { taskId: string; jobId: string; epoch: number; spec: JobSpec; chainId: number; leaseExpiresAt: number };

/** SQL CASE giving each model's VRAM need (for the peer check). Built from MODELS, no user input. */
const VRAM_CASE = `CASE j.model ${MODEL_IDS.map((m) => `WHEN '${m}' THEN ${MODELS[m].vramMb}`).join(" ")} ELSE 1000000000 END`;

/**
 * Job statuses whose spec a node may receive. The SQL below already filters on them; this second check makes sure a
 * settled job (agreed | disagreed | expired | rejected) is never handed to a node, whatever the query returns.
 */
const SERVABLE: readonly JobStatus[] = ["queued", "running", "checking"];

/** A live job lease this node already holds (e.g. it restarted): hand the same task back. */
function heldLease(node: NodeRow): Assignment | null {
  const now = nowSec();
  const held = getDb()
    .prepare(
      `SELECT t.id, t.job_id, t.epoch, t.lease_expires, j.spec, j.status FROM tasks t JOIN jobs j ON j.id = t.job_id
       WHERE t.node_key = ? AND t.status = 'leased' AND t.lease_expires >= ? AND j.status IN ('running','checking') LIMIT 1`,
    )
    .get(node.node_key, now) as { id: string; job_id: string; epoch: number; lease_expires: number; spec: string; status: JobStatus } | undefined;
  if (!held || !SERVABLE.includes(held.status)) return null;
  return {
    taskId: held.id,
    jobId: held.job_id,
    epoch: held.epoch,
    spec: JSON.parse(held.spec) as JobSpec,
    chainId: targetChain.id,
    leaseExpiresAt: held.lease_expires,
  };
}

/** One job assignment attempt (synchronous, in a transaction). Only for nodes that pass the GPU gate and are not paused. */
export function tryLease(node: NodeRow, epochId: number): Assignment | null {
  return tx((db) => {
    const now = nowSec();
    if (nodePaused(node.node_key)) return null;
    if (!jobEligible(node.node_key, now)) return null;
    const caps = JSON.parse(node.caps) as string[];
    const backend: Backend = isBackend(node.backend) ? node.backend : "cuda";
    const models = MODEL_IDS.filter(
      (m: ModelId) => caps.includes(MODELS[m].tag) && node.vram_mb >= MODELS[m].vramMb && modelRunsOn(m, backend),
    );
    if (!models.length) return null;
    const params: Record<string, string | number> = {
      now,
      online: now - POLICY.onlineWindowSeconds,
      node: node.node_key,
      owner: node.owner,
      gpu: node.gpu_uuid,
      backend,
      dev: node.dev ? 1 : 0,
      allowDev: serverEnv.allowDevRunner() ? 1 : 0,
      ...eligibilityParams(),
    };
    models.forEach((m, i) => (params[`m${i}`] = m));
    const cand = db
      .prepare(
        `SELECT t.id, t.job_id, j.spec, j.status FROM tasks t JOIN jobs j ON j.id = t.job_id
         WHERE j.status IN ('queued','running','checking')
           AND j.model IN (${models.map((_, i) => `$m${i}`).join(",")})
           AND (t.status = 'open' OR (t.status = 'leased' AND t.lease_expires < $now))
           -- the sibling task, if held or done, must be on another node / owner / GPU and on the same backend class
           AND NOT EXISTS (
             SELECT 1 FROM tasks o WHERE o.job_id = t.job_id AND o.id != t.id
               AND (o.status = 'done' OR (o.status = 'leased' AND o.lease_expires >= $now))
               AND (o.node_key = $node OR o.owner = $owner OR o.gpu_uuid = $gpu
                    OR COALESCE(o.backend, 'cuda') != $backend OR COALESCE(o.dev, 0) != $dev))
           -- first task of a job: only when a compatible peer is online to take the second one
           AND (
             EXISTS (SELECT 1 FROM tasks o WHERE o.job_id = t.job_id AND o.id != t.id
                       AND (o.status = 'done' OR (o.status = 'leased' AND o.lease_expires >= $now)))
             OR EXISTS (SELECT 1 FROM nodes p
                       WHERE p.backend = $backend AND p.dev = $dev AND (p.dev = 0 OR $allowDev = 1)
                         AND p.node_key != $node AND p.owner != $owner AND p.gpu_uuid != $gpu
                         AND p.last_seen >= $online
                         AND ${activeSql("p")}
                         AND ${eligibleSql("p")}
                         AND p.caps LIKE '%"' || j.kind || ':' || j.model || '"%'
                         AND p.vram_mb >= ${VRAM_CASE})
           )
         ORDER BY j.created_at ASC, t.slot ASC LIMIT 1`,
      )
      .get(params) as { id: string; job_id: string; spec: string; status: JobStatus } | undefined;
    if (!cand || !SERVABLE.includes(cand.status)) return null;
    const expires = now + POLICY.taskLeaseSeconds;
    db.prepare(
      `UPDATE tasks SET status = 'leased', node_key = ?, owner = ?, gpu_uuid = ?, backend = ?, dev = ?, epoch = ?, leased_at = ?,
         lease_expires = ?, attempts = attempts + 1 WHERE id = ?`,
    ).run(node.node_key, node.owner, node.gpu_uuid, backend, node.dev ? 1 : 0, epochId, now, expires, cand.id);
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ? AND status = 'queued'").run(cand.job_id);
    return {
      taskId: cand.id,
      jobId: cand.job_id,
      epoch: epochId,
      spec: JSON.parse(cand.spec) as JobSpec,
      chainId: targetChain.id,
      leaseExpiresAt: expires,
    };
  });
}

/** Nodes registered before the allowlist existed are classified from their stored name at their first poll. */
function classifyIfNeeded(node: NodeRow) {
  if (node.gpu_status !== null) return;
  const backend: Backend = isBackend(node.backend) ? node.backend : "cuda";
  const device = node.device_info ? sanitizeDeviceInfo(JSON.parse(node.device_info)) : null;
  const cls = classifyDevice({ backend, gpu: node.gpu, device, dev: node.dev === 1 });
  node.family = cls.family;
  node.gpu_status = gpuStatusOf(cls.status);
  getDb().prepare("UPDATE nodes SET family = ?, gpu_status = ? WHERE node_key = ?").run(node.family, node.gpu_status, node.node_key);
  console.log(`[sparecycle] gpu-allowlist: classified existing node ${node.node_key} ${JSON.stringify(node.gpu)} ${backend} -> ${cls.family} (${cls.status})`);
}

/** POST /api/v1/nodes/poll — waits up to POLICY.pollWaitMs for work (a held lease, a due challenge or a job). */
export async function pollForTask(nodeKey: Address, signal?: AbortSignal): Promise<Assignment | ChallengeAssignment | null> {
  const node = getNode(nodeKey);
  if (node.dev && !serverEnv.allowDevRunner()) {
    throw new ApiError(403, "dev-runner-not-accepted", "this scheduler does not accept dev-runner nodes");
  }
  const touch = () => getDb().prepare("UPDATE nodes SET last_seen = ? WHERE node_key = ?").run(nowSec(), nodeKey);
  touch();
  classifyIfNeeded(node);
  expireStaleJobs();
  const epoch = await ensureEpoch();
  const deadline = Date.now() + POLICY.pollWaitMs;
  for (;;) {
    // A paused node gets nothing (a 0.4.0+ client does not poll while paused; this covers a stray poll).
    const a = nodePaused(nodeKey) ? null : (heldLease(node) ?? nextChallenge(node.node_key) ?? tryLease(node, epoch.id));
    if (a) return a;
    if (Date.now() >= deadline || signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  touch();
  return null;
}

/** GET /api/v1/nodes — registered nodes only (no GPU UUIDs, no signatures). */
export function listNodes(epochId: number | null) {
  const now = nowSec();
  const rows = getDb()
    .prepare(
      `SELECT n.*,
         (SELECT COUNT(*) FROM tasks t WHERE t.node_key = n.node_key AND t.status = 'leased' AND t.lease_expires >= ?) AS live_leases,
         (SELECT COUNT(*) FROM results r JOIN jobs j ON j.id = r.job_id
            WHERE r.node_key = n.node_key AND j.status = 'agreed' AND j.epoch_id = ?) AS epoch_agreed
       FROM nodes n ORDER BY n.registered_at ASC`,
    )
    .all(now, epochId ?? -1) as (NodeRow & { live_leases: number; epoch_agreed: number })[];
  const project = serverEnv.projectOwners();
  const paidTest = serverEnv.paidTestOwners();
  return {
    nodes: rows.map((r) => {
      const online = r.last_seen >= now - POLICY.onlineWindowSeconds || r.live_leases > 0;
      return {
        owner: r.owner,
        nodeKey: r.node_key,
        gpu: r.gpu,
        vramMb: r.vram_mb,
        caps: JSON.parse(r.caps) as string[],
        backend: r.backend,
        /** Polled or sent a heartbeat within POLICY.onlineWindowSeconds, or holds a live lease. */
        online,
        /**
         * Idle Guard: the node's own state while online, else "offline". Only the reason is public, never when a pause
         * began: state_since stays private (D9).
         */
        state: publicNodeState(r.state, online),
        lastSeen: r.last_seen,
        agreedJobs: r.agreed_jobs,
        epochAgreedJobs: r.epoch_agreed,
        dev: r.dev === 1,
        /** GPU allowlist family and status (null = registered before the allowlist and not polled since). */
        gpuFamily: r.family,
        gpuStatus: r.gpu_status,
        /** Periodic challenge state (null = the node does not take challenges). */
        challengeState: r.challenge_state,
        /** Run by the project (bootstrap GPU pool): never paid. */
        project: project.has(r.owner.toLowerCase()),
        /** A project node that is paid, for the team's openly labelled payout test. */
        paidTest: paidTest.has(r.owner.toLowerCase()),
      };
    }),
  };
}

/** The public Idle Guard state: what the node reported (NULL = active) while it is online, otherwise "offline". */
export function publicNodeState(state: string | null, online: boolean): PublicNodeState {
  if (!online) return "offline";
  return isNodeState(state) ? state : "active";
}

export function nodeCounts() {
  const now = nowSec();
  const rows = getDb()
    .prepare(
      `SELECT n.backend AS backend, COUNT(*) AS registered,
         SUM(CASE WHEN n.last_seen >= ? OR EXISTS (SELECT 1 FROM tasks t WHERE t.node_key = n.node_key AND t.status = 'leased'
           AND t.lease_expires >= ?) THEN 1 ELSE 0 END) AS online
       FROM nodes n GROUP BY n.backend`,
    )
    .all(now - POLICY.onlineWindowSeconds, now) as { backend: string; registered: number; online: number }[];
  const byBackend = Object.fromEntries(BACKENDS.map((b) => [b, { registered: 0, online: 0 }])) as Record<
    Backend,
    { registered: number; online: number }
  >;
  let registered = 0;
  let online = 0;
  for (const r of rows) {
    registered += r.registered;
    online += r.online ?? 0;
    if (isBackend(r.backend)) byBackend[r.backend] = { registered: r.registered, online: r.online ?? 0 };
  }
  return { registered, online, byBackend };
}
