// Re-check rounds (feature brief #9, 9.4, D16, D17) on a scratch SQLite DB with a fake clock, in-process, no chain, no
// GPU: a mismatch moves a paid job to a new pair with different node keys, owners and GPUs; three mismatching rounds
// end disagreed and are not charged; a round with a first lease but no verdict after 2400 s is abandoned and the next
// round goes to other nodes; a round never leased uses up nothing; no new round with less than 2400 s of the TTL left;
// nothing runs after the TTL; free trial jobs are not retried, team jobs are; rejected is never retried; work units go
// only to the final agreeing pair (agreedJobsOf, epoch totals, node stats). Dev-runner "nodes" are driven in-process
// (register -> poll -> signed result). The payments contract is replaced by stubs (nothing is sent). Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, mock, test } from "node:test";
import { PNG } from "pngjs";
import type { Hex, LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Environment before any src/ import (config.ts reads NEXT_PUBLIC_* at import time).
for (const k of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|VAST_|GPU_POOL_|OUTPUT_|AUTH_|TEAM_JOB_|CHALLENGE_|GPU_ALLOWLIST_|PROJECT_NODE_|PAID_TEST_)/.test(k)) delete process.env[k];
}
const dir = mkdtempSync(join(tmpdir(), "sparecycle-recheck-"));
const team = privateKeyToAccount(generatePrivateKey());
Object.assign(process.env, {
  NEXT_PUBLIC_NETWORK: "local",
  NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9", // nothing listens: any unstubbed chain read fails fast
  NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS: privateKeyToAccount(generatePrivateKey()).address, // every read of it is stubbed
  SCHEDULER_SIGNER_KEY: generatePrivateKey(),
  DB_PATH: join(dir, "test.db"),
  SCHEDULER_ALLOW_DEV_RUNNER: "1",
  JOB_RATE_LIMIT: "1000",
  TEAM_JOB_WALLETS: team.address,
});

// ---- fake clock (every scheduler time is nowSec() = Date.now() / 1000) ---------------------------------------
let clockMs = Math.floor(Date.now() / 1000) * 1000;
mock.method(Date, "now", () => clockMs);
/** Moves the fake clock forward by `s` seconds. */
const advance = (s: number) => (clockMs += s * 1000);

const { getDb, nowSec } = await import("./db");
const { POLICY } = await import("./env");
const { submitJob, jobDetail, listJobs, expireStaleJobs } = await import("./jobs");
const { registerNode, pollForTask, listNodes } = await import("./nodes");
const { submitResult } = await import("./results");
const { chargeOpenEpoch, chargesJson, heldFor } = await import("./payments");
const { agreedJobsOf, closeEpoch, currentEpochIdLocal, ensureEpoch, getEpochRow } = await import("./epochs");
const { jobInvoice } = await import("./invoices");
const { MAX_ROUNDS, PICKUP_TIMEOUT_SECONDS, ROUND_MAX_SECONDS } = await import("./rounds");
const { maxRoundsFor, recheckLabel } = await import("@/lib/rounds");
const { linkMessage, sha256Hex, signReceipt } = await import("@/lib/protocol");
const { jobPaymentMessage, jobPriceWei, jobRequestHash } = await import("@/lib/job-payment");
const { parseJobRequest } = await import("@/lib/protocol");
const { publicClient, targetChain } = await import("@/lib/chain");
const { config } = await import("@/lib/config");

// ---- payments contract stubs ------------------------------------------------------------------------------
const balances = new Map<string, bigint>();
const stubbed = publicClient as unknown as Record<string, (...a: unknown[]) => unknown>;
mock.method(stubbed, "readContract", async (...a: unknown[]) => {
  const { functionName, args = [] } = a[0] as { functionName: string; args?: readonly unknown[] };
  const who = String(args[0] ?? "").toLowerCase();
  switch (functionName) {
    case "balanceOf":
      return balances.get(who) ?? 0n;
    case "spendLimitPerEpoch":
    case "chargedInEpoch":
      return 0n;
    case "withdrawRequestOf":
      return [0n, 0n, 0n];
    case "canWithdraw":
      return false;
    default:
      throw new Error(`unexpected contract read ${functionName}`);
  }
});
mock.method(stubbed, "simulateContract", async () => {
  throw new Error("no chain in this test: the charge is not sent");
});

after(() => {
  mock.restoreAll();
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---- nodes, jobs, results -------------------------------------------------------------------------------------
type Node = { key: LocalAccount; owner: LocalAccount; gpuUuid: string };
let gpuSeq = 0;

/** Registers a dev-runner node (text and image). `owner` / `gpuUuid` / `key` reuse another node's to test exclusion. */
async function mkNode(o: { owner?: LocalAccount; gpuUuid?: string; key?: LocalAccount } = {}): Promise<Node> {
  const key = o.key ?? privateKeyToAccount(generatePrivateKey());
  const owner = o.owner ?? privateKeyToAccount(generatePrivateKey());
  const gpuUuid = o.gpuUuid ?? `TEST-RECHECK-GPU-${gpuSeq++}`;
  await registerNode(key.address, {
    gpu: "TEST dev",
    gpuUuid,
    vramMb: 24_000,
    caps: ["text:qwen2.5-1.5b", "image:sd15"],
    owner: owner.address,
    ownerSig: await owner.signMessage({ message: linkMessage(key.address, owner.address) }),
    dev: true,
  });
  return { key, owner, gpuUuid };
}
const nodes = (n: number) => Promise.all(Array.from({ length: n }, () => mkNode()));

/** Every registered node polled just now (the peer check counts only nodes seen within the online window). */
const allOnline = () => getDb().prepare("UPDATE nodes SET last_seen = ?").run(nowSec());
/** Only these nodes are online. */
const onlyOnline = (...ns: Node[]) => {
  getDb().prepare("UPDATE nodes SET last_seen = 0").run();
  for (const n of ns) getDb().prepare("UPDATE nodes SET last_seen = ? WHERE node_key = ?").run(nowSec(), n.key.address);
};

type Lease = { taskId: string; jobId: Hex; epoch: number; spec: { kind: "image" | "text"; params: { width?: number; height?: number } } };
/** One node polls once (pollForTask, which also runs expireStaleJobs and the round checks). Null = nothing for it. */
async function poll(n: Node): Promise<Lease | null> {
  const a = await pollForTask(n.key.address, AbortSignal.abort());
  if (a && "challengeId" in a) throw new Error("unexpected challenge");
  return a as Lease | null;
}
async function lease(n: Node): Promise<Lease> {
  const a = await poll(n);
  assert.ok(a, "the node got a task");
  return a;
}

/**
 * An image result: a solid grey, or a left-to-right ramp getting lighter ("up") or darker ("down"). The two ramps are
 * 64 of 64 dHash bits apart (far past the 12-bit threshold); equal images agree.
 */
type Img = { img: number | "up" | "down" };
function png(w: number, h: number, v: Img["img"]) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ramp = Math.round((x / (w - 1)) * 255);
      const g = typeof v === "number" ? v : v === "up" ? ramp : 255 - ramp;
      const o = (y * w + x) * 4;
      p.data[o] = p.data[o + 1] = p.data[o + 2] = g;
      p.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(p);
}

/** Sends the node's signed dev result for its lease: `out` is the text of a text job, or an image. */
async function send(n: Node, a: Lease, out: string | Img, extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = { gpuMs: 10, epoch: a.epoch, dev: true, ...extra };
  let bytes: Uint8Array;
  if (a.spec.kind === "image") {
    assert.ok(typeof out === "object", "an image job needs an image");
    bytes = png(a.spec.params.width!, a.spec.params.height!, out.img);
    body.png = Buffer.from(bytes).toString("base64");
  } else {
    bytes = Buffer.from(out as string, "utf8");
    body.text = out;
  }
  const outputHash = sha256Hex(bytes);
  const signature = await signReceipt(n.key, targetChain.id, { jobId: a.jobId, node: n.key.address, outputHash, gpuMs: 10n, epoch: BigInt(a.epoch) });
  return submitResult(n.key.address, a.taskId, { ...body, outputHash, signature });
}

/** Two nodes lease the job's current round and send `outA` / `outB`. Returns the second answer. */
async function pair(a: Node, b: Node, outA: string | Img, outB: string | Img) {
  allOnline();
  const la = await lease(a);
  const lb = await lease(b);
  assert.equal(la.jobId, lb.jobId, "both nodes work on the same job");
  const first = await send(a, la, outA);
  assert.equal(first.status, "checking");
  return send(b, lb, outB);
}

let ipSeq = 0;
const nextIp = () => `10.4.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
const textRequest = (prompt: string) => ({ kind: "text", params: { model: "qwen2.5-1.5b", prompt, maxTokens: 16 } });
const imageRequest = (prompt: string) => ({ kind: "image", params: { model: "sd15", prompt, width: 256, height: 256, steps: 10 } });
const priceOf = (request: unknown) => jobPriceWei(parseJobRequest(request), config.jobPriceWeiPerUnit);

/** A paid job signed by `payer` exactly like the dapp signs it (balance stubbed to cover it). */
async function submitPaid(payer: LocalAccount, request: unknown) {
  balances.set(payer.address.toLowerCase(), (balances.get(payer.address.toLowerCase()) ?? 0n) + 100n * priceOf(request));
  const priceWei = priceOf(request);
  const issued = nowSec();
  const message = jobPaymentMessage({ chainId: targetChain.id, contract: config.jobPayments!, requestHash: jobRequestHash(request), priceWei, issued });
  const signature = await payer.signMessage({ message });
  return submitJob({ request, payment: { payer: payer.address, signature, issued, priceWei: priceWei.toString() } }, nextIp());
}
const newPayer = () => privateKeyToAccount(generatePrivateKey());

type JobRow = { status: string; round: number; round_started_at: number | null; settled_at: number | null; note: string | null; charge_status: string | null; output_hash: string | null; created_at: number };
const job = (id: string) => getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow;
const tasksOf = (id: string) =>
  getDb().prepare("SELECT id, slot, round, status, node_key FROM tasks WHERE job_id = ? ORDER BY slot").all(id) as {
    id: string;
    slot: number;
    round: number;
    status: string;
    node_key: string | null;
  }[];
const resultsOf = (id: string) =>
  getDb().prepare("SELECT node_key, owner, gpu_uuid, round, output FROM results WHERE job_id = ? ORDER BY round, received_at, task_id").all(id) as {
    node_key: string;
    owner: string;
    gpu_uuid: string;
    round: number;
    output: Uint8Array | null;
  }[];
const roundLog = (id: string) =>
  (
    getDb().prepare("SELECT round, node_key, outcome FROM job_rounds WHERE job_id = ? ORDER BY round, node_key").all(id) as {
      round: number;
      node_key: string;
      outcome: string;
    }[]
  ).map((r) => ({ ...r }));
const agreedCount = (n: Node) => (getDb().prepare("SELECT agreed_jobs FROM nodes WHERE node_key = ?").get(n.key.address) as { agreed_jobs: number }).agreed_jobs;

before(async () => {
  await ensureEpoch();
});

beforeEach(() => {
  // Each test starts with an empty queue: nothing left over from an earlier test can be leased or abandoned.
  const db = getDb();
  db.exec("UPDATE tasks SET status = 'cancelled' WHERE status IN ('open','leased')");
  db.exec("UPDATE jobs SET status = 'expired' WHERE status IN ('queued','running','checking')");
  db.exec("UPDATE nodes SET last_seen = 0");
});

// ---- the values (D16, 9.4) and the schema ----------------------------------------------------------------------------
test("values: 3 rounds, 1800 s pickup timeout, 2400 s per round, all rounds fit in the 21600 s TTL", () => {
  assert.equal(MAX_ROUNDS, 3);
  assert.equal(PICKUP_TIMEOUT_SECONDS, 1800);
  assert.equal(POLICY.taskLeaseSeconds, 600);
  assert.equal(ROUND_MAX_SECONDS, 2400);
  assert.equal(POLICY.jobTtlSeconds, 21_600);
  assert.ok(MAX_ROUNDS * ROUND_MAX_SECONDS <= POLICY.jobTtlSeconds);
  assert.equal(maxRoundsFor(null), 1, "free trial: one round (D17)");
  assert.equal(maxRoundsFor(team.address), 3);
  assert.equal(recheckLabel(0, 3), null);
  assert.equal(recheckLabel(1, 3), "Re-checking on another pair (round 2 of 3)");
  assert.equal(recheckLabel(2, undefined), "Re-checking on another pair (round 3 of 3)");
});

test("migration: round columns on jobs, tasks and results; the lease and round logs", () => {
  const cols = (t: string) => (getDb().prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols("jobs").includes("round") && cols("jobs").includes("round_started_at"));
  assert.ok(cols("tasks").includes("round"));
  assert.ok(cols("results").includes("round"));
  for (const c of ["job_id", "round", "task_id", "node_key", "owner", "gpu_uuid", "leased_at"]) assert.ok(cols("job_leases").includes(c), c);
  for (const c of ["job_id", "round", "node_key", "owner", "gpu_uuid", "outcome", "at"]) assert.ok(cols("job_rounds").includes(c), c);
});

// ---- a mismatch moves a paid job to a new pair ------------------------------------------------------------------------
describe("a forced mismatch on a paid job", () => {
  test("moves it to a new round on nodes whose node keys, owners and GPUs took no part in the earlier round", async () => {
    const [a, b, c, d] = await nodes(4);
    const sameOwnerAsA = await mkNode({ owner: a.owner });
    const sameGpuAsB = await mkNode();
    const payer = newPayer();
    const j = await submitPaid(payer, textRequest("re-check me"));
    const price = priceOf(textRequest("re-check me"));

    const second = await pair(a, b, "alpha beta gamma delta epsilon", "a completely different answer from b");
    assert.deepEqual(second, { ok: true, jobId: j.id, status: "queued", verdict: "disagreed", round: 1 });

    // The job is back in the queue in round 1; round 0's tasks and results stay for audit.
    const row = job(j.id);
    assert.equal(row.status, "queued");
    assert.equal(row.round, 1);
    assert.equal(row.round_started_at, null, "the new round has no lease yet");
    assert.equal(row.settled_at, null);
    assert.match(row.note ?? "", /did not match; re-checking on another pair \(round 2 of 3\)/);
    assert.deepEqual(
      tasksOf(j.id).map((t) => [t.slot, t.round, t.status]),
      [
        [0, 0, "done"],
        [1, 0, "done"],
        [2, 1, "open"],
        [3, 1, "open"],
      ],
    );
    const r0 = resultsOf(j.id);
    assert.equal(r0.length, 2);
    assert.ok(r0.every((r) => r.round === 0 && r.output === null), "kept for audit, per-node outputs dropped");
    assert.deepEqual(
      roundLog(j.id),
      [a, b].map((n) => ({ round: 0, node_key: n.key.address, outcome: "disagreed" })).sort((x, y) => (x.node_key < y.node_key ? -1 : 1)),
      "the disagreeing round is logged per node",
    );

    // The payer: still held, nothing charged, "re-checking" with the round; the public view shows the round only.
    assert.equal(heldFor(payer.address), price, "the hold stays in place");
    const inv = jobInvoice(j.id, { address: payer.address, secret: null });
    assert.ok(inv.invoice);
    assert.equal(inv.chargeStatus, "pending");
    assert.equal(inv.verdict, null);
    assert.equal(inv.chargedWei, null);
    assert.equal(inv.round, 1);
    assert.equal(inv.maxRounds, 3);
    const pub = jobDetail(j.id);
    assert.equal(pub.status, "queued");
    assert.equal(pub.round, 1);
    assert.equal(pub.maxRounds, 3);
    assert.equal(recheckLabel(pub.round, pub.maxRounds), "Re-checking on another pair (round 2 of 3)");
    const listed = listJobs(50).jobs.find((x) => x.id === j.id)!;
    assert.equal(listed.round, 1);
    const text = JSON.stringify({ pub, listed }).toLowerCase();
    for (const n of [a, b]) {
      assert.ok(!text.includes(n.key.address.toLowerCase().slice(2)), "no node key in the public views");
      assert.ok(!text.includes(n.owner.address.toLowerCase().slice(2)), "no owner in the public views");
    }

    // Exclusion: the earlier round's node keys, owner wallets and GPUs get nothing, even with free peers online.
    // (sameGpuAsB stands for a node reporting B's GPU UUID under another wallet: what the registration check can't see.)
    getDb().prepare("UPDATE nodes SET gpu_uuid = ? WHERE node_key = ?").run(b.gpuUuid, sameGpuAsB.key.address);
    const aElsewhere = await mkNode({ key: a.key }); // A's node key, re-registered under a new wallet and GPU
    allOnline();
    for (const [name, n] of [
      ["round-0 node A", a],
      ["round-0 node B", b],
      ["same owner wallet as A", sameOwnerAsA],
      ["same GPU UUID as B", sameGpuAsB],
      ["A's node key under another wallet and GPU", aElsewhere],
    ] as const) {
      assert.equal(await poll(n), null, `${name}: excluded from round 1`);
    }

    // A new round's first task needs a peer that is not excluded either: c alone (with only excluded nodes online) waits.
    onlyOnline(c, a, b, sameOwnerAsA, sameGpuAsB);
    assert.equal(await poll(c), null, "no compatible peer outside the earlier round: the round does not start");
    assert.equal(job(j.id).round_started_at, null, "and uses up nothing");

    // Two fresh nodes take round 1 and agree: the job is agreed on the final round only.
    const fin = await pair(c, d, "the same final answer", "the same final answer");
    assert.equal(fin.status, "agreed");
    assert.equal(fin.round, 1);
    const done = job(j.id);
    assert.equal(done.status, "agreed");
    assert.equal(done.round, 1);
    assert.equal(done.note, null);
    assert.equal(done.output_hash, sha256Hex(Buffer.from("the same final answer", "utf8")));
    const rs = resultsOf(j.id);
    const r1 = rs.filter((r) => r.round === 1);
    assert.deepEqual(r1.map((r) => r.node_key).sort(), [c.key.address, d.key.address].sort());
    for (const r of r1) {
      assert.ok(!r0.some((e) => e.node_key === r.node_key || e.owner.toLowerCase() === r.owner.toLowerCase() || e.gpu_uuid === r.gpu_uuid));
    }
    assert.deepEqual([a, b, c, d].map(agreedCount), [0, 0, 1, 1], "only the final pair counts an agreed job");
    assert.equal(heldFor(payer.address), price, "held until the epoch charge");
    assert.equal(jobInvoice(j.id, { address: payer.address, secret: null }).verdict, "agreed");
  });

  test("a team job is re-checked too (D17: paid and team jobs)", async () => {
    const [a, b, c, d] = await nodes(4);
    const j = await submitPaid(team, textRequest("team re-check"));
    assert.equal(jobDetail(j.id).payment, "team");
    assert.equal(jobDetail(j.id).maxRounds, 3);
    assert.equal((await pair(a, b, "one answer here", "an entirely different reply")).status, "queued");
    assert.equal(job(j.id).round, 1);
    assert.equal((await pair(c, d, "same", "same")).status, "agreed");
  });
});

// ---- three mismatching rounds --------------------------------------------------------------------------------------
test("three mismatching rounds end disagreed and the job is not charged", async () => {
  const ns = await nodes(6);
  const payer = newPayer();
  const req = imageRequest("three pairs, no match");
  const j = await submitPaid(payer, req);
  const statuses: string[] = [];
  for (let r = 0; r < MAX_ROUNDS; r++) {
    const [x, y] = [ns[2 * r], ns[2 * r + 1]];
    // The nodes of every earlier round are skipped.
    allOnline();
    for (const old of ns.slice(0, 2 * r)) assert.equal(await poll(old), null, `round ${r}: an earlier round's node gets nothing`);
    const res = await pair(x, y, { img: "up" }, { img: "down" }); // 64 dHash bits apart: never within the 12-bit threshold
    statuses.push(`${res.status}:${res.round}`);
  }
  assert.deepEqual(statuses, ["queued:1", "queued:2", "disagreed:2"]);
  const row = job(j.id);
  assert.equal(row.status, "disagreed");
  assert.equal(row.round, 2);
  assert.ok(row.settled_at);
  assert.match(row.note ?? "", /do not match \(checked on 3 pairs; none matched\)/);
  const rs = resultsOf(j.id);
  assert.deepEqual(rs.map((r) => r.round), [0, 0, 1, 1, 2, 2]);
  for (const k of ["node_key", "owner", "gpu_uuid"] as const) assert.equal(new Set(rs.map((r) => r[k].toLowerCase())).size, 6, `6 distinct ${k}s`);
  assert.equal(roundLog(j.id).length, 6, "each disagreeing round logged per node");
  assert.ok(roundLog(j.id).every((l) => l.outcome === "disagreed"));
  assert.deepEqual(
    tasksOf(j.id).map((t) => `${t.slot}:${t.round}:${t.status}`),
    ["0:0:done", "1:0:done", "2:1:done", "3:1:done", "4:2:done", "5:2:done"],
  );
  assert.ok(ns.every((n) => agreedCount(n) === 0));

  // Not charged: nothing held, the invoice says released, and the epoch charge leaves it out.
  assert.equal(heldFor(payer.address), 0n);
  const inv = jobInvoice(j.id, { address: payer.address, secret: null });
  assert.ok(inv.invoice);
  assert.equal(inv.verdict, "disagreed");
  assert.equal(inv.chargeStatus, "released");
  assert.equal(inv.chargedWei, "0");
  assert.equal(inv.outputHash, null);
  const epoch = currentEpochIdLocal();
  await chargeOpenEpoch(epoch);
  assert.equal(job(j.id).charge_status, "released");
  assert.ok(!chargesJson(epoch).jobs.some((x) => x.jobId === j.id));
  // A fourth pair online changes nothing: the job is settled.
  const extra = await nodes(2);
  allOnline();
  assert.equal(await poll(extra[0]), null);
});

// ---- not picked up: abandonment with a fake clock ----------------------------------------------------------------
describe("a round with a first lease but no verdict", () => {
  test("is abandoned 2400 s after its first lease and the next round starts on other nodes", async () => {
    const [n7, n8, n9, n10] = await nodes(4);
    const payer = newPayer();
    const j = await submitPaid(payer, textRequest("nobody finishes"));
    advance(300); // queue wait before the first lease does not count
    onlyOnline(n7, n8);
    const l7 = await lease(n7);
    const t0 = nowSec();
    assert.equal(job(j.id).round_started_at, t0, "the round's clock starts at its first lease");
    assert.equal(job(j.id).status, "running");

    // n7 lets its lease expire (10 min); n10 takes the same task: a requeue inside the round, the round's clock stays.
    advance(POLICY.taskLeaseSeconds + 100);
    onlyOnline(n10, n8);
    const l10 = await lease(n10);
    assert.equal(l10.taskId, l7.taskId);
    assert.equal(job(j.id).round_started_at, t0);

    // One second before the limit nothing happens; at round_started_at + 2400 s the round is abandoned.
    advance(t0 + ROUND_MAX_SECONDS - 1 - nowSec());
    expireStaleJobs();
    assert.equal(job(j.id).round, 0);
    assert.equal(job(j.id).status, "running");
    advance(1);
    onlyOnline(n7, n8, n9, n10);
    const l8 = await lease(n8); // the poll runs the round check first, then leases round 1
    const row = job(j.id);
    assert.equal(row.round, 1);
    assert.equal(row.status, "running");
    assert.equal(row.round_started_at, nowSec());
    assert.match(row.note ?? "", /no verdict within 40 minutes of its first lease; re-checking on another pair \(round 2 of 3\)/);
    assert.equal(l8.jobId, j.id);
    assert.deepEqual(
      tasksOf(j.id).filter((t) => t.round === 0).map((t) => t.status),
      ["cancelled", "cancelled"],
    );
    assert.deepEqual(
      roundLog(j.id).map((l) => [l.node_key, l.outcome]).sort(),
      [
        [n10.key.address, "abandoned"],
        [n7.key.address, "abandoned"],
      ].sort(),
      "both nodes that held a lease in the abandoned round are logged",
    );

    // The abandoned round's nodes are excluded (also n7, which only let its lease expire); late results are refused.
    assert.equal(await poll(n7), null);
    assert.equal(await poll(n10), null);
    await assert.rejects(send(n10, l10, "too late"), (e: { status?: number; code?: string }) => e.status === 409 && e.code === "not-your-task");
    const l9 = await lease(n9);
    assert.equal(l9.jobId, j.id);
    await send(n8, l8, "finally");
    assert.equal((await send(n9, l9, "finally")).status, "agreed");
    assert.deepEqual(
      agreedJobsOf(currentEpochIdLocal())
        .filter((x) => x.owners.some((o) => o === n8.owner.address || o === n9.owner.address))
        .map((x) => [...x.owners].sort()),
      [[n8.owner.address, n9.owner.address].sort()],
    );
  });

  test("a round that never got a lease uses up nothing: the job waits, then expires at the TTL", async () => {
    const payer = newPayer();
    const j = await submitPaid(payer, textRequest("no pair online"));
    advance(5 * 3600); // no compatible pair online for 5 hours
    expireStaleJobs();
    assert.equal(job(j.id).round, 0);
    assert.equal(job(j.id).status, "queued");
    assert.equal(job(j.id).round_started_at, null);
    advance(POLICY.jobTtlSeconds - 5 * 3600 + 1);
    expireStaleJobs();
    assert.equal(job(j.id).status, "expired");
    assert.equal(job(j.id).round, 0);
  });

  test("is not abandoned when less than one full round of the TTL is left: it runs until a verdict or the TTL", async () => {
    const [a, b] = await nodes(2);
    const payer = newPayer();
    const j = await submitPaid(payer, textRequest("late start"));
    advance(POLICY.jobTtlSeconds - ROUND_MAX_SECONDS - 100); // 2500 s left
    onlyOnline(a, b);
    await lease(a);
    advance(ROUND_MAX_SECONDS); // first lease + 2400 s: only 100 s of the TTL left
    expireStaleJobs();
    assert.equal(job(j.id).round, 0, "no new round: it would not fit in the TTL");
    assert.equal(job(j.id).status, "running");
    advance(101);
    expireStaleJobs();
    assert.equal(job(j.id).status, "expired", "expireStaleJobs stays the hard stop");
  });

  test("a free trial job's round is never abandoned (no re-check for free jobs, D17)", async () => {
    const [a, b] = await nodes(2);
    const j = await submitJob(textRequest("free and slow"), nextIp());
    onlyOnline(a, b);
    await lease(a);
    advance(ROUND_MAX_SECONDS + 600);
    expireStaleJobs();
    assert.equal(job(j.id).round, 0);
    assert.equal(job(j.id).status, "running");
  });
});

// ---- the TTL (9.4) ------------------------------------------------------------------------------------------------
describe("the job TTL bounds every round", () => {
  test("a mismatch with exactly 2400 s of the TTL left starts a new round; with 2399 s left it is final", async () => {
    const ns = await nodes(4);
    const payer = newPayer();
    const fits = await submitPaid(payer, textRequest("2400 s left"));
    const tight = await submitPaid(payer, textRequest("2399 s left"));
    advance(POLICY.jobTtlSeconds - ROUND_MAX_SECONDS); // both created at the same second; 2400 s left now
    getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id = ?").run(tight.id);
    assert.equal((await pair(ns[0], ns[1], "first answer here", "something else entirely")).status, "queued");
    assert.equal(job(fits.id).round, 1);

    getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id = ?").run(fits.id);
    getDb().prepare("UPDATE tasks SET status = 'open' WHERE job_id = ?").run(tight.id);
    advance(1); // 2399 s left
    const res = await pair(ns[2], ns[3], "first answer here", "something else entirely");
    assert.equal(res.status, "disagreed");
    assert.equal(job(tight.id).round, 0);
    assert.equal(job(tight.id).note, "the two results do not match");
    assert.equal(tasksOf(tight.id).length, 2, "no tasks for another round");
  });

  test("no round runs after jobTtlSeconds: a job waiting in round 1 ends expired", async () => {
    const ns = await nodes(4);
    const payer = newPayer();
    const j = await submitPaid(payer, textRequest("expires in round 1"));
    assert.equal((await pair(ns[0], ns[1], "answer number one", "a different answer")).status, "queued");
    advance(POLICY.jobTtlSeconds + 1);
    allOnline();
    assert.equal(await poll(ns[2]), null, "nothing is handed out past the TTL");
    const row = job(j.id);
    assert.equal(row.status, "expired");
    assert.equal(row.round, 1);
    assert.ok(tasksOf(j.id).filter((t) => t.round === 1).every((t) => t.status === "cancelled"));
    assert.equal(heldFor(payer.address), 0n);
    const inv = jobInvoice(j.id, { address: payer.address, secret: null });
    assert.ok(inv.invoice);
    assert.equal(inv.chargeStatus, "released");
  });
});

// ---- free and rejected jobs ----------------------------------------------------------------------------------------
test("a free trial job's mismatch ends disagreed as today (no re-check, D17), and is logged per node", async () => {
  const [a, b, c] = await nodes(3);
  const j = await submitJob(textRequest("free mismatch"), nextIp());
  assert.equal(jobDetail(j.id).payment, "free");
  assert.equal(jobDetail(j.id).maxRounds, 1);
  const res = await pair(a, b, "free answer one", "a totally different free answer");
  assert.equal(res.status, "disagreed");
  assert.equal(job(j.id).round, 0);
  assert.equal(job(j.id).note, "the two results do not match");
  assert.equal(tasksOf(j.id).length, 2);
  assert.equal(roundLog(j.id).length, 2);
  allOnline();
  assert.equal(await poll(c), null);
});

test("rejected is never retried, even for a paid job in its first round", async () => {
  const [a, b, c, d] = await nodes(4);
  const payer = newPayer();
  const j = await submitPaid(payer, imageRequest("flagged"));
  allOnline();
  const la = await lease(a);
  const lb = await lease(b);
  await send(a, la, { img: 128 }, { nsfw: true });
  const res = await send(b, lb, { img: 128 });
  assert.equal(res.status, "rejected");
  assert.equal(job(j.id).round, 0);
  assert.equal(tasksOf(j.id).length, 2);
  allOnline();
  assert.equal(await poll(c), null);
  assert.equal(await poll(d), null);
  assert.equal(heldFor(payer.address), 0n);
  assert.equal(roundLog(j.id).length, 0, "a rejection is not a disagreement");
});

// ---- payouts: only the final agreeing pair ----------------------------------------------------------------------------
test("work units are paid only for the final agreeing pair (agreedJobsOf, epoch totals, node stats)", async () => {
  // A fresh epoch with this job only.
  advance(POLICY.jobTtlSeconds + 1);
  await closeEpoch();
  const epoch = currentEpochIdLocal();
  const [p1, p2, p3, p4] = await nodes(4);
  const payer = newPayer();
  const req = textRequest("paid to the final pair");
  const j = await submitPaid(payer, req);
  assert.equal((await pair(p1, p2, "round zero answer", "round zero, other answer")).status, "queued");
  assert.equal((await pair(p3, p4, "agreed in round one", "agreed in round one")).status, "agreed");
  assert.equal(resultsOf(j.id).length, 4, "results from two rounds");

  const units = parseJobRequest(req).kind === "text" ? jobDetail(j.id).workUnits : 0;
  const jobs = agreedJobsOf(epoch);
  assert.equal(jobs.length, 1, "the retried job is counted (four results, two of them in the final round)");
  assert.equal(jobs[0].units, units);
  assert.deepEqual([...jobs[0].owners].sort(), [p3.owner.address, p4.owner.address].sort());

  const stats = listNodes(epoch).nodes;
  const epochAgreed = (n: Node) => stats.find((x) => x.nodeKey === n.key.address)!.epochAgreedJobs;
  assert.deepEqual([p1, p2, p3, p4].map(epochAgreed), [0, 0, 1, 1]);
  assert.deepEqual([p1, p2, p3, p4].map(agreedCount), [0, 0, 1, 1]);

  advance(POLICY.jobTtlSeconds + 1);
  const closed = await closeEpoch();
  assert.equal(closed.epoch.id, epoch);
  assert.equal(closed.epoch.agreedJobs, 1);
  assert.equal(getEpochRow(epoch)!.total_units, units);
});

