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
const status = { 11: "stopped", 22: "stopped" };
const calls = [];
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
