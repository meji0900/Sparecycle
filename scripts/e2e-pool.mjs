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
