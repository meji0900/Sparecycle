#!/usr/bin/env node
// Checks the on-demand GPU pool (src/server/gpu-pool.ts) and the project-node payout rule without Vast or a GPU:
// a mock Vast API on a local port, a scratch DB, and the scheduler's own modules.
//   node scripts/e2e-pool.mjs
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

let passed = 0;
let failed = 0;
const check = (name, ok, extra = "") => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? `  (${extra})` : ""}`);
};

// ---- mock Vast API: PUT /api/v0/instances/:id/ {state}, GET /api/v0/instances/:id/?owner=me ----
const status = { 11: "stopped", 22: "stopped", 33: "stopped", 44: "running" };
const calls = [];
/** Instances whose host is busy: Vast declines their start (success:false) and queues it. */
const busy = new Set();
const server = createServer((req, res) => {
  const m = /^\/api\/v0\/instances\/(\d+)\/(\?.*)?$/.exec(req.url ?? "");
  if (!m || req.headers.authorization !== "Bearer test-key") {
    res.writeHead(m ? 401 : 404).end();
    return;
  }
  let body = "";
  req.on("data", (d) => (body += d)).on("end", () => {
    if (req.method === "PUT") {
      const { state } = JSON.parse(body);
      calls.push({ id: m[1], state });
      if (state === "running" && busy.has(m[1])) {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end('{"success":false,"msg":"Required resources are currently unavailable, state change queued."}');
        return;
      }
      status[m[1]] = state;
      res.writeHead(200, { "content-type": "application/json" }).end('{"success":true}');
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ instances: { actual_status: status[m[1]] } }));
    }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const dir = mkdtempSync(join(tmpdir(), "sparecycle-pool-"));

const ownerA = "0x1111111111111111111111111111111111111111";
const ownerB = "0x2222222222222222222222222222222222222222";
const community = "0x3333333333333333333333333333333333333333";
Object.assign(process.env, {
  DB_PATH: join(dir, "pool.db"),
  VAST_API_URL: `http://127.0.0.1:${server.address().port}`,
  VAST_API_KEY: "test-key",
  GPU_POOL_INSTANCE_IDS: "11,22",
  GPU_POOL_IDLE_MINUTES: "10",
  PROJECT_NODE_OWNERS: `${ownerA},${ownerB}`,
  JOB_RATE_LIMIT: "100",
});

try {
  const { getDb, nowSec } = await srcImport("server/db.ts");
  const { submitJob } = await srcImport("server/jobs.ts");
  const { poolTick, poolStatus } = await srcImport("server/gpu-pool.ts");
  const { allocate } = await srcImport("server/payouts.ts");
  const { listNodes } = await srcImport("server/nodes.ts");
  const db = getDb();
  const t0 = nowSec();
  const waitFor = async (pred, ms = 3000) => {
    for (let i = 0; i < ms / 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 50));
    return pred();
  };

  await poolTick(t0);
  check("idle pool with no jobs stays off", calls.length === 0 && poolStatus().state === "stopped", JSON.stringify(poolStatus()));

  await submitJob({ kind: "text", params: { model: "qwen2.5-1.5b", prompt: "hello", maxTokens: 16 } }, "127.0.0.1");
  const started = await waitFor(() => calls.filter((c) => c.state === "running").length === 2);
  check("a queued job with no nodes online starts both instances", started, JSON.stringify(calls));

  await poolTick(t0 + 60);
  check("no second start while the first is booting", calls.length === 2);

  // The two pool nodes come online (owners A and B), the job gets agreed.
  const addNode = (key, owner) =>
    db
      .prepare(
        `INSERT INTO nodes (node_key, owner, owner_sig, gpu, gpu_uuid, vram_mb, caps, registered_at, last_seen)
         VALUES (?, ?, '0x', 'RTX 3060', ?, 12288, '["image:sd15","text:qwen2.5-1.5b"]', ?, ?)`,
      )
      .run(key, owner, `uuid-${key}`, t0, nowSec());
  addNode("0xaaaa000000000000000000000000000000000001", ownerA);
  addNode("0xbbbb000000000000000000000000000000000002", ownerB);
  await poolTick(t0 + 120);
  check("covered jobs don't start anything more", calls.length === 2);

  db.prepare("UPDATE jobs SET status = 'agreed'").run();
  await poolTick(t0 + 120 + 5 * 60);
  check("still on before the idle window ends", calls.length === 2 && poolStatus().state === "running");
  await poolTick(t0 + 120 + 10 * 60 + 1);
  check(
    "stopped after 10 minutes without open jobs",
    calls.filter((c) => c.state === "stopped").length === 2 && poolStatus().state === "stopped",
    JSON.stringify(calls.slice(2)),
  );

  const s = JSON.stringify(poolStatus());
  check("status shows no key and no instance ids", !s.includes("test-key") && !/"(ids|instanceIds)"/.test(s) && !s.includes("[11"), s);

  const nodes = listNodes(null).nodes;
  check("pool nodes are marked as project nodes", nodes.length === 2 && nodes.every((n) => n.project === true));

  const exclude = new Set([ownerA.toLowerCase(), ownerB.toLowerCase()]);
  const alloc = allocate({ pot: 1000n, capPerUnit: null, jobs: [{ units: 100, owners: [community, ownerA] }], exclude });
  check(
    "a project owner gets no payout; its half stays in the pot",
    alloc.entries.length === 1 && alloc.entries[0].account.toLowerCase() === community && alloc.entries[0].amount === 500n && alloc.reserved === 500n,
    JSON.stringify(alloc, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
  const both = allocate({ pot: 1000n, capPerUnit: null, jobs: [{ units: 100, owners: [ownerA, ownerB] }], exclude });
  check("a job done by two project nodes reserves nothing", both.entries.length === 0 && both.reserved === 0n);

  // ---- a host is busy: Vast declines a start (success:false) ----
  // Owner B has a spare machine (33). The pool nodes go offline and a new job waits.
  process.env.GPU_POOL_INSTANCE_IDS = "11:a,22:b,33:b";
  db.prepare("UPDATE nodes SET last_seen = 0").run();
  db.prepare("UPDATE jobs SET status = 'queued'").run();
  const since = (n) => calls.slice(n);
  const tA = t0 + 3000;
  busy.add("22");
  let mark = calls.length;
  await poolTick(tA);
  let c = since(mark);
  check(
    "a declined start is cancelled at once, and the pool runs on the other owner's spare",
    c.filter((x) => x.state === "running").length === 3 &&
      c.some((x) => x.id === "22" && x.state === "stopped") &&
      !c.some((x) => x.id !== "22" && x.state === "stopped") &&
      poolStatus().state === "running" &&
      poolStatus().error === null,
    JSON.stringify(c),
  );

  // Both owner-B machines busy: owner A alone cannot run a job, so everything is stopped and the pool backs off.
  busy.add("33");
  mark = calls.length;
  const tB = tA + 6 * 60;
  await poolTick(tB);
  c = since(mark);
  const stoppedIds = new Set(c.filter((x) => x.state === "stopped").map((x) => x.id));
  check(
    "fewer than two owners up: every machine is stopped (declined starts cancelled)",
    stoppedIds.has("11") && stoppedIds.has("22") && stoppedIds.has("33") && poolStatus().state === "stopped",
    JSON.stringify(c),
  );
  const err = String(poolStatus().error ?? "");
  check("the status says why, without instance ids", err.includes("could not start") && !/(11|22|33)/.test(err), err);
  mark = calls.length;
  await poolTick(tB + 10 * 60);
  check("no new start during the back-off", since(mark).length === 0, JSON.stringify(since(mark)));
  busy.clear();
  mark = calls.length;
  await poolTick(tB + 15 * 60 + 1);
  c = since(mark);
  check(
    "after the back-off it tries again and runs",
    c.filter((x) => x.state === "running").length === 3 && poolStatus().state === "running" && poolStatus().error === null,
    JSON.stringify(c),
  );

  // ---- an always-on machine (44, owner B) stays up; the pool starts only what is missing and never stops it ----
  process.env.GPU_POOL_INSTANCE_IDS = "11:a,22:b,33:b,44:b";
  process.env.GPU_POOL_ALWAYS_ON = "44";
  db.prepare("UPDATE jobs SET status = 'agreed'").run();
  const tC = tB + 15 * 60 + 1 + 11 * 60;
  mark = calls.length;
  await poolTick(tC);
  c = since(mark);
  check(
    "idle stop leaves the always-on machine running",
    ["11", "22", "33"].every((id) => c.some((x) => x.id === id && x.state === "stopped")) &&
      !c.some((x) => x.id === "44") &&
      status[44] === "running" &&
      poolStatus().state === "stopped",
    JSON.stringify(c),
  );
  check("status counts the always-on machine without its id", poolStatus().alwaysOn === 1 && !JSON.stringify(poolStatus()).includes("44"));

  // A new job: Vast declines the repeated start of 44 (its host is busy with it already), but 44 is running, so it
  // counts for owner B; only owner A's machine is started and B's spares stay off.
  db.prepare("UPDATE jobs SET status = 'queued'").run();
  busy.add("44");
  mark = calls.length;
  await poolTick(tC + 60);
  c = since(mark);
  check(
    "a declined but running always-on machine covers its owner; only the other owner is started",
    c.some((x) => x.id === "11" && x.state === "running") &&
      !c.some((x) => x.id === "22" || x.id === "33") &&
      !c.some((x) => x.id === "44" && x.state === "stopped") &&
      poolStatus().state === "running",
    JSON.stringify(c),
  );

  // Owner A's host is busy: one owner alone cannot run a job, but the always-on machine is still never stopped.
  busy.add("11");
  status[11] = "stopped";
  mark = calls.length;
  await poolTick(tC + 60 + 6 * 60);
  c = since(mark);
  check(
    "the back-off stop also leaves the always-on machine running",
    c.some((x) => x.id === "11" && x.state === "stopped") && !c.some((x) => x.id === "44" && x.state === "stopped") && status[44] === "running",
    JSON.stringify(c),
  );

  // ---- the capacity guard of job creation (src/server/capacity.ts) and the pool ----
  const { modelCapacity } = await srcImport("server/capacity.ts");
  const { poolStartInfo } = await srcImport("server/gpu-pool.ts");
  const jobsNow = () => db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
  const tryJob = async (prompt) => {
    try {
      return { ok: true, job: await submitJob({ kind: "text", params: { model: "qwen2.5-1.5b", prompt, maxTokens: 16 } }, "127.0.0.2") };
    } catch (e) {
      return { ok: false, e };
    }
  };
  // The pool backs off (owner A's host was busy) and no pool node is online: no pair can be reached.
  const n0 = jobsNow();
  const refused = await tryJob("while the pool backs off");
  check(
    "while the pool backs off and no pair is online: 503 no-node-pair with retryAfter, nothing queued",
    !refused.ok && refused.e.status === 503 && refused.e.code === "no-node-pair" && refused.e.extra?.retryAfter > 0 && jobsNow() === n0,
    refused.ok ? "accepted" : `${refused.e.code} ${JSON.stringify(refused.e.extra)}`,
  );
  check("the catalog capacity says so too (pair null, retryAfter)", modelCapacity(poolStartInfo()).sd15.pair === null && poolStartInfo().canStart === false);
  // The back-off is over: the stopped machines of owners A and B (registered, offline, project-run) can be started.
  globalThis.__sparecyclePool.backoffUntil = null;
  const cap = modelCapacity(poolStartInfo());
  check("pool can start: pair reachable through the pool for both models", cap.sd15.pair === "pool" && cap["qwen2.5-1.5b"].pair === "pool", JSON.stringify(cap));
  const accepted = await tryJob("the pool brings a pair up");
  check("so the job is accepted and queued", accepted.ok && jobsNow() === n0 + 1, accepted.ok ? accepted.job.id : accepted.e.code);
  // Let the nudge of that submit run out before the next scripted tick.
  await waitFor(() => !globalThis.__sparecyclePool.ticking);

  // ---- GPU_POOL_GROUP_OWNERS: a group whose owner is already online is not started; only the missing group is woken ----
  delete process.env.GPU_POOL_ALWAYS_ON;
  process.env.GPU_POOL_INSTANCE_IDS = "11:a,22:b,33:b";
  process.env.GPU_POOL_GROUP_OWNERS = `a:${ownerA},b:${ownerB}`;
  busy.clear();
  db.prepare("UPDATE nodes SET last_seen = ? WHERE owner = ?").run(nowSec(), ownerA); // owner A's node is online
  globalThis.__sparecyclePool.state = "stopped";
  globalThis.__sparecyclePool.backoffUntil = null;
  const tD = tC + 60 + 6 * 60 + 15 * 60 + 2 * 60;
  mark = calls.length;
  await poolTick(tD);
  c = since(mark);
  check(
    "owner A online: only owner B's machines are started (22, 33), not owner A's (11)",
    c.some((x) => x.id === "22" && x.state === "running") && c.some((x) => x.id === "33" && x.state === "running") && !c.some((x) => x.id === "11") &&
      poolStatus().state === "running",
    JSON.stringify(c),
  );

  // ---- an always-on machine that Vast stopped is started again without any job waiting, every 5 minutes ----
  delete process.env.GPU_POOL_GROUP_OWNERS;
  process.env.GPU_POOL_INSTANCE_IDS = "11:a,22:b,44:b";
  process.env.GPU_POOL_ALWAYS_ON = "44";
  db.prepare("UPDATE jobs SET status = 'agreed'").run(); // nothing waits
  status[44] = "stopped";
  busy.add("44"); // its host is taken: Vast queues the start
  globalThis.__sparecyclePool.lastKeepAt = null;
  const tE = tD + 60 * 60;
  mark = calls.length;
  await poolTick(tE);
  c = since(mark);
  check(
    "no job waiting: the stopped always-on machine is asked to start, and the declined start is not cancelled",
    c.some((x) => x.id === "44" && x.state === "running") && !c.some((x) => x.id === "44" && x.state === "stopped"),
    JSON.stringify(c),
  );
  mark = calls.length;
  await poolTick(tE + 60);
  check("within 5 minutes it is not asked again", !since(mark).some((x) => x.id === "44"), JSON.stringify(since(mark)));
  busy.delete("44");
  mark = calls.length;
  await poolTick(tE + 5 * 60 + 1);
  check("after 5 minutes it is asked again and runs", since(mark).some((x) => x.id === "44" && x.state === "running") && status[44] === "running", JSON.stringify(since(mark)));
  mark = calls.length;
  await poolTick(tE + 11 * 60);
  check("a running always-on machine is left alone", !since(mark).some((x) => x.id === "44"), JSON.stringify(since(mark)));
} finally {
  server.close();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the SQLite file locked until exit; the OS temp folder is cleaned later */
  }
}

console.log(`\nchecks passed: ${passed}/${passed + failed}`);
process.exitCode = failed ? 1 : 0;
