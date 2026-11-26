// Idle Guard on a scratch SQLite DB: the signed heartbeat route, the stored state, no lease while paused, the public
// node list (state yes, stateSince no), older clients, and the node client's pure heartbeat / GPU-check logic.
// No chain, no GPU, no network. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { Address, LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const dir = mkdtempSync(join(tmpdir(), "sparecycle-idle-guard-"));
process.env.DB_PATH = join(dir, "test.db");
for (const k of [
  "NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS",
  "GPU_ALLOWLIST_MODE",
  "CHALLENGE_MODE",
  "PROJECT_NODE_OWNERS",
  "VAST_API_KEY",
  "SCHEDULER_ALLOW_DEV_RUNNER",
  "SPARECYCLE_SIMULATE_PAUSE",
  "SPARECYCLE_NO_BUSY_CHECK",
]) {
  delete process.env[k];
}

const { registerNode, tryLease, pollForTask, listNodes, recordHeartbeat, publicNodeState } = await import("./nodes");
type NodeRow = import("./nodes").NodeRow;
const { getDb, nowSec } = await import("./db");
const { POLICY } = await import("./env");
const { ensureEpoch } = await import("./epochs");
const { submitJob } = await import("./jobs");
const { POST: heartbeatRoute } = await import("@/app/api/v1/nodes/heartbeat/route");
const { GET: nodesRoute } = await import("@/app/api/v1/nodes/route");
const { CHALLENGE_FEATURE, linkMessage, requestNonce, signRequest } = await import("@/lib/protocol");
const { NODE_STATES, idleGuardHoursOnly, shownNodeState } = await import("@/lib/node-state");
// The node client's own modules (it ships standalone, so it keeps its own copy of the state list).
const client = await import("../../node-client/src/idle-guard");
const gpu = await import("../../node-client/src/gpu");

after(() => {
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

const TEXT = "text:qwen2.5-1.5b";
const PATH = "/api/v1/nodes/heartbeat";
let uuidSeq = 0;

/** Registers a node like a client would. `old: true` = a 0.2.0 body (no features); otherwise 0.3.0+ fields. */
async function register(o: { backend?: "cuda" | "vulkan" | "cpu"; old?: boolean; node?: LocalAccount; owner?: LocalAccount } = {}) {
  const node = o.node ?? privateKeyToAccount(generatePrivateKey());
  const owner = o.owner ?? privateKeyToAccount(generatePrivateKey());
  const ownerSig = await owner.signMessage({ message: linkMessage(node.address, owner.address) });
  const body: Record<string, unknown> = {
    gpu: o.backend && o.backend !== "cuda" ? "AMD Radeon RX 7600 (Vulkan)" : "NVIDIA GeForce RTX 3060",
    gpuUuid: `GPU-${node.address.slice(2, 10)}-${uuidSeq++}`,
    vramMb: 8192,
    caps: [TEXT],
    owner: owner.address,
    ownerSig,
    dev: false,
    backend: o.backend ?? "cuda",
    version: o.old ? "sparecycle-node/0.2.0" : "sparecycle-node/0.4.0",
  };
  if (!o.old) body.features = [CHALLENGE_FEATURE];
  await registerNode(node.address, body);
  return { node, owner };
}

/** A signed heartbeat through the route handler, exactly as the node client sends it (body + nonce). */
async function sendHeartbeat(
  account: LocalAccount,
  body: Record<string, unknown>,
  o: { nowMs?: number; sendBody?: string; headers?: Record<string, string> } = {},
) {
  const text = JSON.stringify({ ...body, nonce: requestNonce() });
  const headers = o.headers ?? (await signRequest(account, "POST", PATH, text, o.nowMs));
  return heartbeatRoute(new Request(`http://localhost${PATH}`, { method: "POST", headers, body: o.sendBody ?? text }));
}

const row = (a: Address) => getDb().prepare("SELECT * FROM nodes WHERE node_key = ?").get(a) as NodeRow;
const listed = (a: Address) => listNodes(null).nodes.find((n) => n.nodeKey === a)!;
const lease = async (a: Address) => tryLease(row(a), (await ensureEpoch()).id);
let ipSeq = 0;
const textJob = () =>
  submitJob({ kind: "text", params: { model: "qwen2.5-1.5b", prompt: `idle guard ${ipSeq}`, maxTokens: 16 } }, `10.9.${ipSeq >> 8}.${ipSeq++ & 255}`);
const setLastSeen = (a: Address, t: number) => getDb().prepare("UPDATE nodes SET last_seen = ? WHERE node_key = ?").run(t, a);
const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

beforeEach(() => {
  const db = getDb();
  db.exec("UPDATE tasks SET status = 'cancelled' WHERE status IN ('open','leased')");
  db.exec("UPDATE jobs SET status = 'expired' WHERE status IN ('queued','running','checking')");
  db.exec("UPDATE nodes SET last_seen = 0");
  delete process.env.CHALLENGE_MODE;
});

// ---- schema ------------------------------------------------------------------------------------------
test("the migration adds nodes.state and nodes.state_since, separate from the challenge / allowlist columns", () => {
  const cols = (getDb().prepare("PRAGMA table_info(nodes)").all() as { name: string }[]).map((c) => c.name);
  for (const c of ["state", "state_since", "challenge_state", "gpu_status"]) assert.ok(cols.includes(c), c);
});

// ---- the signed heartbeat route -------------------------------------------------------------------------
describe("POST /api/v1/nodes/heartbeat", () => {
  test("a signed heartbeat stores the state and when it began, and answers them to the node", async () => {
    const { node } = await register();
    const since = nowSec() - 30;
    const res = await sendHeartbeat(node, { state: "paused-busy", since });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, state: "paused-busy", since });
    const r = row(node.address);
    assert.equal(r.state, "paused-busy");
    assert.equal(r.state_since, since);
    assert.ok(r.last_seen >= nowSec() - 2, "a heartbeat counts as a sign of life");
  });

  test("since is optional (defaults to now) and never later than the time of receipt", async () => {
    const { node } = await register();
    const before = nowSec();
    assert.equal((await sendHeartbeat(node, { state: "paused-hours" })).status, 200);
    assert.ok(row(node.address).state_since! >= before);
    const ahead = nowSec() + 30; // inside the signed-request clock window: clamped to now
    const res = await sendHeartbeat(node, { state: "paused-hours", since: ahead });
    assert.equal(res.status, 200);
    assert.ok(row(node.address).state_since! <= nowSec());
  });

  test("only the state code is kept: extra fields (a temperature, process names) are not stored", async () => {
    const { node } = await register();
    const before = row(node.address);
    const res = await sendHeartbeat(node, { state: "paused-hot", since: nowSec(), temperature: 91, processes: ["game.exe"], pid: 4242 });
    assert.equal(res.status, 200);
    const afterRow = row(node.address);
    const changed = Object.keys(afterRow).filter((k) => afterRow[k as keyof NodeRow] !== before[k as keyof NodeRow]);
    assert.deepEqual(changed.filter((k) => k !== "last_seen").sort(), ["state", "state_since"]);
    assert.ok(!JSON.stringify(afterRow).includes("game.exe"));
    assert.ok(!JSON.stringify(listNodes(null)).includes("game.exe"));
  });

  test("an unknown state or a bad since is a 400 invalid-heartbeat; nothing changes", async () => {
    const { node } = await register();
    for (const body of [{ state: "sleeping" }, { state: "offline" }, {}, { state: "paused-hot", since: "yesterday" }, { state: "paused-hot", since: nowSec() + 3600 }, { state: "paused-hot", since: -1 }]) {
      const res = await sendHeartbeat(node, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(await errorOf(res), "invalid-heartbeat");
    }
    assert.equal(row(node.address).state, null);
  });

  test("unsigned, wrongly signed, stale and replayed requests are refused with 401", async () => {
    const { node } = await register();
    const body = JSON.stringify({ state: "paused-busy", since: nowSec(), nonce: requestNonce() });

    const unsigned = await heartbeatRoute(new Request(`http://localhost${PATH}`, { method: "POST", body }));
    assert.equal(unsigned.status, 401);
    assert.equal(await errorOf(unsigned), "missing-signature");

    // Signed over one body, sent with another (e.g. a state swapped in transit).
    const tampered = await sendHeartbeat(node, { state: "active" }, { sendBody: JSON.stringify({ state: "paused-hot", nonce: requestNonce() }) });
    assert.equal(tampered.status, 401);
    assert.equal(await errorOf(tampered), "bad-signature");

    // Another key signs, but the request claims to come from this node.
    const other = privateKeyToAccount(generatePrivateKey());
    const forged = { ...(await signRequest(other, "POST", PATH, body)), "x-sc-from": node.address };
    const forgedRes = await heartbeatRoute(new Request(`http://localhost${PATH}`, { method: "POST", headers: forged, body }));
    assert.equal(forgedRes.status, 401);
    assert.equal(await errorOf(forgedRes), "bad-signature");

    const stale = await sendHeartbeat(node, { state: "paused-busy" }, { nowMs: Date.now() - 5 * 60_000 });
    assert.equal(stale.status, 401);
    assert.equal(await errorOf(stale), "stale-request");

    const headers = await signRequest(node, "POST", PATH, body);
    const first = await heartbeatRoute(new Request(`http://localhost${PATH}`, { method: "POST", headers, body }));
    assert.equal(first.status, 200);
    const replay = await heartbeatRoute(new Request(`http://localhost${PATH}`, { method: "POST", headers, body }));
    assert.equal(replay.status, 401);
    assert.equal(await errorOf(replay), "replayed-request");
  });

  test("a key that never registered gets 403 not-registered; a body over 1 KB gets 413", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const res = await sendHeartbeat(stranger, { state: "active" });
    assert.equal(res.status, 403);
    assert.equal(await errorOf(res), "not-registered");
    const { node } = await register();
    const big = await sendHeartbeat(node, { state: "active", pad: "x".repeat(2048) });
    assert.equal(big.status, 413);
  });
});

// ---- online and offline ------------------------------------------------------------------------------
describe("online = a recent heartbeat or poll", () => {
  test("a paused node that keeps sending heartbeats stays online and shows its reason", async () => {
    const { node } = await register();
    setLastSeen(node.address, 0);
    assert.equal(listed(node.address).online, false);
    assert.equal((await sendHeartbeat(node, { state: "paused-hot", since: nowSec() })).status, 200);
    assert.equal(listed(node.address).online, true);
    assert.equal(listed(node.address).state, "paused-hot");
  });

  test("a paused node that goes quiet for longer than the online window shows offline, not its old reason", async () => {
    const { node } = await register();
    await sendHeartbeat(node, { state: "paused-busy", since: nowSec() });
    setLastSeen(node.address, nowSec() - POLICY.onlineWindowSeconds - 1);
    assert.equal(listed(node.address).online, false);
    assert.equal(listed(node.address).state, "offline");
  });

  test("older clients (no heartbeat): active while polling, offline when quiet, exactly as before", async () => {
    const { node } = await register({ old: true });
    assert.equal(row(node.address).state, null);
    assert.equal(listed(node.address).state, "active");
    assert.equal(listed(node.address).online, true);
    setLastSeen(node.address, nowSec() - POLICY.onlineWindowSeconds - 1);
    assert.equal(listed(node.address).state, "offline");
    await pollForTask(node.address, AbortSignal.abort());
    assert.equal(listed(node.address).state, "active", "a poll counts as a sign of life");
  });

  test("re-registering clears a reported pause, so an older client on the same key is not stuck paused", async () => {
    const node = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    await register({ node, owner });
    await sendHeartbeat(node, { state: "paused-hours", since: nowSec() });
    assert.equal(row(node.address).state, "paused-hours");
    await register({ node, owner, old: true });
    assert.equal(row(node.address).state, null);
    assert.equal(row(node.address).state_since, null);
    assert.equal(listed(node.address).state, "active");
  });
});

// ---- leasing -----------------------------------------------------------------------------------------
describe("a paused node never gets a lease", () => {
  test("no job for a paused node, and a paused node is not counted as the compatible peer", async () => {
    const a = await register();
    const b = await register();
    await textJob();
    await sendHeartbeat(a.node, { state: "paused-busy", since: nowSec() });
    assert.equal(await lease(a.node.address), null, "paused: no job");
    assert.equal(await pollForTask(a.node.address, AbortSignal.abort()), null, "paused: the poll hands out nothing either");
    assert.equal(await lease(b.node.address), null, "the only peer is paused, so the first task is not handed out");
    await sendHeartbeat(a.node, { state: "active", since: nowSec() });
    const first = await lease(b.node.address);
    assert.ok(first, "peer active again: first task leased");
    const second = await lease(a.node.address);
    assert.equal(second?.jobId, first.jobId);
  });

  test("every paused reason blocks leasing; hours-only (vulkan) nodes pause the same way", async () => {
    for (const state of ["paused-busy", "paused-hot", "paused-hours"] as const) {
      const a = await register({ backend: "vulkan" });
      await register({ backend: "vulkan" });
      await textJob();
      await sendHeartbeat(a.node, { state, since: nowSec() });
      assert.equal(await lease(a.node.address), null, state);
    }
  });

  test("a paused node gets no GPU challenge either", async () => {
    process.env.CHALLENGE_MODE = "observe";
    const a = await register();
    assert.equal(row(a.node.address).challenge_state, "pending-challenge");
    await sendHeartbeat(a.node, { state: "paused-hot", since: nowSec() });
    assert.equal(await pollForTask(a.node.address, AbortSignal.abort()), null);
    await sendHeartbeat(a.node, { state: "active", since: nowSec() });
    const c = await pollForTask(a.node.address, AbortSignal.abort());
    assert.equal(c && "type" in c ? c.type : null, "challenge", "active again: the due challenge is handed out");
    assert.equal(row(a.node.address).challenge_state, "pending-challenge", "the Idle Guard state never touches the challenge state");
  });
});

// ---- the public list ---------------------------------------------------------------------------------
describe("GET /api/v1/nodes", () => {
  test("returns state for every node and no stateSince or other pause timestamp (D9)", async () => {
    const { node } = await register();
    const since = nowSec() - 4321;
    await sendHeartbeat(node, { state: "paused-busy", since });
    const res = await nodesRoute();
    assert.equal(res.status, 200);
    const text = await res.text();
    const nodes = (JSON.parse(text) as { nodes: Record<string, unknown>[] }).nodes;
    assert.ok(nodes.length > 0);
    for (const n of nodes) {
      assert.ok(["active", "paused-busy", "paused-hot", "paused-hours", "offline"].includes(n.state as string), String(n.state));
      assert.ok(!Object.keys(n).some((k) => /since/i.test(k)), `no *since* field: ${Object.keys(n).join(",")}`);
    }
    assert.equal(nodes.find((n) => n.nodeKey === node.address)?.state, "paused-busy");
    assert.ok(!text.includes(String(since)), "the pause start time is not in the public response");
  });

  test("publicNodeState / shownNodeState map old and new shapes the same way", () => {
    assert.equal(publicNodeState(null, true), "active");
    assert.equal(publicNodeState("paused-hot", true), "paused-hot");
    assert.equal(publicNodeState("paused-hot", false), "offline");
    assert.equal(publicNodeState("garbage", true), "active");
    // A scheduler without `state` (older deploy): online -> active, else offline.
    assert.equal(shownNodeState({ online: true }), "active");
    assert.equal(shownNodeState({ online: false }), "offline");
    assert.equal(shownNodeState({ online: true, state: "paused-hours" }), "paused-hours");
    assert.equal(idleGuardHoursOnly("vulkan"), true);
    assert.equal(idleGuardHoursOnly("cpu"), true);
    assert.equal(idleGuardHoursOnly("cuda"), false);
    assert.equal(idleGuardHoursOnly(undefined), false);
  });
});

// ---- the node client (pure parts) --------------------------------------------------------------------
describe("node client Idle Guard", () => {
  test("the client's state list equals the scheduler's", () => {
    assert.deepEqual([...client.NODE_STATES], [...NODE_STATES]);
  });

  test("HEARTBEAT_SECONDS is 60, below the scheduler's online window", () => {
    assert.equal(client.HEARTBEAT_SECONDS, 60);
    assert.ok(client.HEARTBEAT_SECONDS < POLICY.onlineWindowSeconds);
  });

  test("outside --hours wins over the GPU check; no reason means active", () => {
    assert.equal(client.currentState(false, "paused-hot"), "paused-hours");
    assert.equal(client.currentState(true, "paused-hot"), "paused-hot");
    assert.equal(client.currentState(true, "paused-busy"), "paused-busy");
    assert.equal(client.currentState(true, null), "active");
  });

  test("a heartbeat goes out on every change, and again while paused, never while active and unchanged", () => {
    const t = 1_000_000;
    assert.equal(client.heartbeatDue("active", null, t), true, "first report");
    assert.equal(client.heartbeatDue("active", { state: "active", atMs: t }, t + 3_600_000), false);
    assert.equal(client.heartbeatDue("paused-busy", { state: "active", atMs: t }, t + 1), true, "change");
    assert.equal(client.heartbeatDue("paused-busy", { state: "paused-busy", atMs: t }, t + 30_000), false);
    assert.equal(client.heartbeatDue("paused-busy", { state: "paused-busy", atMs: t }, t + 60_000), true);
  });

  test("while paused, heartbeats are never more than HEARTBEAT_SECONDS apart (30 s and 60 s rechecks, 2 s per check)", () => {
    for (const [state, recheckMs] of [["paused-busy", 30_000], ["paused-hours", 60_000]] as const) {
      let now = 0;
      let sent: { state: typeof state; atMs: number } = { state, atMs: 0 };
      let maxGap = 0;
      for (let i = 0; i < 200; i++) {
        now += client.pauseSleepMs(state, recheckMs, sent, now) + 2_000; // sleep, then nvidia-smi and the call itself
        if (client.heartbeatDue(state, sent, now)) {
          maxGap = Math.max(maxGap, now - sent.atMs);
          sent = { state, atMs: now };
        }
      }
      assert.ok(maxGap > 0 && maxGap <= client.HEARTBEAT_SECONDS * 1000, `${state}: max gap ${maxGap} ms`);
    }
  });

  test("a failed heartbeat is retried within seconds, not after the full recheck", () => {
    assert.equal(client.pauseSleepMs("paused-hot", 30_000, null, 0), 5_000);
    assert.equal(client.pauseSleepMs("paused-hot", 30_000, { state: "active", atMs: 0 }, 1), 5_000);
  });

  test("the heartbeat body is the state code and its start time, nothing else", async () => {
    const body = client.heartbeatBody("paused-hot", 1_764_150_000_999);
    assert.deepEqual(Object.keys(body).sort(), ["since", "state"]);
    assert.deepEqual(body, { state: "paused-hot", since: 1_764_150_000 });
    // ... and the scheduler accepts exactly that body.
    const { node } = await register();
    assert.equal((await sendHeartbeat(node, client.heartbeatBody("paused-hot", Date.now()))).status, 200);
    assert.equal(recordHeartbeat(node.address, client.heartbeatBody("active", Date.now())).state, "active");
  });

  test("the GPU check returns a reason code; thresholds stay 83 °C and 500 MB (D10)", async () => {
    assert.equal(gpu.HOT_CELSIUS, 83);
    assert.equal(gpu.BUSY_VRAM_MB, 500);
    assert.equal(gpu.hotFromSmi("83\n"), true);
    assert.equal(gpu.hotFromSmi("82\n90\n"), false, "first GPU only, as before");
    assert.equal(gpu.hotFromSmi("[N/A]"), false);
    assert.equal(gpu.hotFromSmi(""), false);
    const own = new Set([100, 200]);
    assert.equal(gpu.busyFromSmi("100, 3000\n200, 1800\n", own), false, "our own processes never count");
    assert.equal(gpu.busyFromSmi("300, 500\n", own), false, "500 MB is not more than 500 MB");
    assert.equal(gpu.busyFromSmi("300, 501\n", own), true);
    assert.equal(gpu.busyFromSmi("", own), false);
    process.env.SPARECYCLE_SIMULATE_PAUSE = "hot";
    assert.equal(await gpu.gpuBusyOrHot(own), "paused-hot");
    process.env.SPARECYCLE_SIMULATE_PAUSE = "busy";
    assert.equal(await gpu.gpuBusyOrHot(own), "paused-busy");
    delete process.env.SPARECYCLE_SIMULATE_PAUSE;
    process.env.SPARECYCLE_NO_BUSY_CHECK = "1";
    assert.equal(await gpu.gpuBusyOrHot(own), null);
    delete process.env.SPARECYCLE_NO_BUSY_CHECK;
  });
});
