#!/usr/bin/env node
// Route and unit tests of private job outputs (docs/private-outputs.md), in-process, no chain, no GPU:
//
//   node scripts/test-private-outputs.mjs          (npm run test:private-outputs)
//
// Runs the real route handlers (src/app/api/v1/**/route.ts) and scheduler code against a scratch SQLite DB under
// data/ (deleted afterwards). Two dev-runner "nodes" are driven in-process (register -> poll -> signed result).
// Covered: the OUTPUT_AUTH=enforce matrix (401/403/404/409/200), read secrets, wallet sign-in (nonce single use,
// domain / chain / signature checks, expired session, logout), the team-wallet rule, legacy jobs, the per-viewer
// rate limit, private no-store headers on every route, the retired /output route, node isolation (node signatures
// are no credentials, a settled job's spec is never handed out, per-node outputs are dropped at the verdict and at
// expiry). The ERC-1271 sign-in path needs a chain and is covered by scripts/e2e-local.mjs.
//
// Never prints read secrets, session ids, prompts or outputs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_DIR = join(ROOT, "data", `test-private-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(RUN_DIR, { recursive: true });

// Environment before any src/ import (config.ts reads NEXT_PUBLIC_* at import time).
for (const k of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|VAST_|GPU_POOL_|OUTPUT_|AUTH_)/.test(k)) delete process.env[k];
}
const team = privateKeyToAccount(generatePrivateKey());
Object.assign(process.env, {
  NEXT_PUBLIC_NETWORK: "local",
  // Nothing listens on port 9: the smart-wallet fallback of a failed EOA check fails fast instead of reaching a chain.
  NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9",
  DB_PATH: join(RUN_DIR, "test.db"),
  SCHEDULER_ALLOW_DEV_RUNNER: "1",
  JOB_RATE_LIMIT: "1000",
  TEAM_JOB_WALLETS: team.address,
});

const SITE = "http://127.0.0.1:3261";
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const route = (rel) => srcImport(`app/api/v1/${rel}/route.ts`);

let m; // modules
let nodeA, nodeB;
let ipCounter = 0;
const nextIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

before(async () => {
  m = {
    db: await srcImport("server/db.ts"),
    jobs: await srcImport("server/jobs.ts"),
    nodes: await srcImport("server/nodes.ts"),
    results: await srcImport("server/results.ts"),
    proto: await srcImport("lib/protocol.ts"),
    chain: await srcImport("lib/chain.ts"),
    result: await route("jobs/[id]/result"),
    output: await route("jobs/[id]/output"),
    detail: await route("jobs/[id]"),
    jobsRoute: await route("jobs"),
    nonce: await route("auth/nonce"),
    verify: await route("auth/verify"),
    logout: await route("auth/logout"),
    poll: await route("nodes/poll"),
  };
  const mkNode = async (name) => {
    const key = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    const ownerSig = await owner.signMessage({ message: m.proto.linkMessage(key.address, owner.address) });
    await m.nodes.registerNode(key.address, {
      gpu: `TEST ${name}`,
      gpuUuid: `TEST-GPU-${name}`,
      vramMb: 24_000,
      caps: ["text:qwen2.5-1.5b"],
      owner: owner.address,
      ownerSig,
      dev: true,
    });
    return { key, owner };
  };
  nodeA = await mkNode("A");
  nodeB = await mkNode("B");
});

after(() => {
  try {
    m?.db.getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---- helpers ------------------------------------------------------------------------------------------------
const aborted = () => AbortSignal.abort();
const setMode = (mode) => {
  if (mode === "off") delete process.env.OUTPUT_AUTH;
  else process.env.OUTPUT_AUTH = mode;
};

async function submitText(prompt) {
  return m.jobs.submitJob({ kind: "text", params: { model: "qwen2.5-1.5b", prompt, maxTokens: 16 } }, nextIp());
}

/** One node takes a task (poll) and sends a signed dev result with `text`. */
async function work(node, text) {
  const a = await m.nodes.pollForTask(node.key.address, aborted());
  assert.ok(a, "the node got a task");
  const output = Buffer.from(text, "utf8");
  const outputHash = m.proto.sha256Hex(output);
  const signature = await m.proto.signReceipt(node.key, m.chain.targetChain.id, {
    jobId: a.jobId,
    node: node.key.address,
    outputHash,
    gpuMs: 10n,
    epoch: BigInt(a.epoch),
  });
  return m.results.submitResult(node.key.address, a.taskId, { outputHash, signature, gpuMs: 10, epoch: a.epoch, text, dev: true });
}

/** Cancels the open and leased tasks of every job except `id`, so the next polls pick only that job. */
const only = (id) => m.db.getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id != ? AND status IN ('open','leased')").run(id);

/** Submits a free text job and runs it on both nodes; `texts` equal = agreed. Returns { id, readSecret, status }. */
async function runJob(texts = ["same answer", "same answer"]) {
  const job = await submitText(`private prompt ${Math.random()}`);
  only(job.id);
  await work(nodeA, texts[0]);
  const r = await work(nodeB, texts[1]);
  return { ...job, status: r.status };
}

const setPayer = (id, payer) => m.db.getDb().prepare("UPDATE jobs SET payer = ?, price_wei = '1', charge_status = 'pending' WHERE id = ?").run(payer, id);

function req(path, { method = "GET", headers = {}, body, site = SITE } = {}) {
  return new Request(`${site}${path}`, { method, headers, body });
}
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const bearer = (secret) => ({ authorization: `Bearer ${secret}` });
const getResult = (id, headers = {}) => m.result.GET(req(`/api/v1/jobs/${id}/result`, { headers }), ctx(id));
const getOutput = (id, headers = {}) => m.output.GET(req(`/api/v1/jobs/${id}/output`, { headers }), ctx(id));
const getDetail = async (id, headers = {}) => {
  const res = await m.detail.GET(req(`/api/v1/jobs/${id}`, { headers }), ctx(id));
  return { res, body: await res.json() };
};

function assertPrivate(res, label) {
  const cc = res.headers.get("cache-control") ?? "";
  assert.equal(cc, "private, no-store", `${label}: cache-control`);
  assert.ok(!/public|immutable/i.test(cc), `${label}: never public`);
  assert.equal(res.headers.get("vary"), "Authorization, Cookie", `${label}: vary`);
}

/** Signs in `account` through the real nonce + verify routes. Returns { res, cookie (header value), message }. */
async function signIn(account, { site = SITE, domain, chainId, signer, message: given } = {}) {
  const nres = await m.nonce.GET(req("/api/v1/auth/nonce", { site, headers: { "x-forwarded-for": nextIp() } }));
  assertPrivate(nres, "nonce");
  const { nonce, chainId: serverChain, statement } = await nres.json();
  const host = new URL(site).host;
  const message =
    given ??
    createSiweMessage({
      address: account.address,
      chainId: chainId ?? serverChain,
      domain: domain ?? host,
      nonce,
      uri: `${new URL(site).origin}/playground`,
      version: "1",
      issuedAt: new Date(),
      expirationTime: new Date(Date.now() + 10 * 60_000),
      statement,
    });
  const signature = await (signer ?? account).signMessage({ message });
  const res = await m.verify.POST(
    req("/api/v1/auth/verify", { site, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) }),
  );
  const setCookie = res.headers.get("set-cookie") ?? "";
  const value = /^sc_session=([^;]*)/.exec(setCookie)?.[1] ?? "";
  return { res, setCookie, cookie: value ? { cookie: `sc_session=${value}` } : {}, value, message, signature };
}

// ---- tests ----------------------------------------------------------------------------------------------------
describe("submit", () => {
  test("every job gets a read secret; only its sha256 is stored", async () => {
    const job = await submitText("a secret prompt");
    assert.match(job.readSecret, /^[A-Za-z0-9_-]{43}$/);
    const row = m.db.getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
    assert.equal(row.read_secret_hash, sha256(job.readSecret));
    assert.ok(!JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? null : v)).includes(job.readSecret), "secret not stored in clear");
  });

  test("POST /api/v1/jobs answers with the read secret and private headers", async () => {
    const res = await m.jobsRoute.POST(
      req("/api/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": nextIp() },
        body: JSON.stringify({ kind: "text", params: { model: "qwen2.5-1.5b", prompt: "route submit", maxTokens: 16 } }),
      }),
    );
    assert.equal(res.status, 201);
    assertPrivate(res, "POST /jobs");
    const body = await res.json();
    assert.match(body.readSecret, /^[A-Za-z0-9_-]{43}$/);
  });
});

describe("OUTPUT_AUTH=enforce: the route matrix", () => {
  let free, queued;
  before(async () => {
    setMode("enforce");
    free = await runJob();
    assert.equal(free.status, "agreed");
    queued = await submitText("still queued");
  });
  after(() => setMode("off"));

  test("anonymous -> 401 with an empty body and private headers", async () => {
    const res = await getResult(free.id);
    assert.equal(res.status, 401);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
    assertPrivate(res, "401");
  });

  test("free job, right secret -> 200 with the output and private, no-store", async () => {
    const res = await getResult(free.id, bearer(free.readSecret));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/plain/);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString("utf8"), "same answer");
    assertPrivate(res, "200");
  });

  test("free job, wrong secret -> 403", async () => {
    const res = await getResult(free.id, bearer("x".repeat(43)));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "forbidden");
    assertPrivate(res, "403");
  });

  test("another job's secret -> 403", async () => {
    const res = await getResult(free.id, bearer(queued.readSecret));
    assert.equal(res.status, 403);
  });

  test("the secret in the query string is not a credential", async () => {
    const res = await m.result.GET(req(`/api/v1/jobs/${free.id}/result?secret=${free.readSecret}`), ctx(free.id));
    assert.equal(res.status, 401);
  });

  test("unknown id -> 404, malformed id -> 400", async () => {
    const unknown = `0x${"ab".repeat(32)}`;
    const res = await getResult(unknown, bearer(free.readSecret));
    assert.equal(res.status, 404);
    assertPrivate(res, "404");
    const bad = await getResult("0x1234", bearer(free.readSecret));
    assert.equal(bad.status, 400);
  });

  test("not agreed -> 409 no-output", async () => {
    const res = await getResult(queued.id, bearer(queued.readSecret));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "no-output");
    assertPrivate(res, "409");
  });

  test("the retired /output route -> 410, private no-store, with and without credentials", async () => {
    for (const h of [{}, bearer(free.readSecret)]) {
      const res = await getOutput(free.id, h);
      assert.equal(res.status, 410);
      assertPrivate(res, "410");
    }
  });

  test("job detail: output URL only for an authorized caller, outputAvailable always", async () => {
    const anon = await getDetail(free.id);
    assertPrivate(anon.res, "detail");
    assert.equal(anon.body.output, null);
    assert.equal(anon.body.outputAvailable, true);
    assert.equal(anon.body.outputType, "text/plain; charset=utf-8");
    const mine = await getDetail(free.id, bearer(free.readSecret));
    assert.equal(mine.body.output, `/api/v1/jobs/${free.id}/result`);
    const other = await getDetail(free.id, bearer(queued.readSecret));
    assert.equal(other.body.output, null);
    const q = await getDetail(queued.id, bearer(queued.readSecret));
    assert.equal(q.body.outputAvailable, false);
    assert.equal(q.body.output, null);
    assert.ok(!JSON.stringify(anon.body).includes("private prompt"), "no prompt in the detail");
  });
});

describe("wallet sign-in", () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  let paidJob;
  before(async () => {
    setMode("enforce");
    paidJob = await runJob(["paid answer", "paid answer"]);
    setPayer(paidJob.id, payer.address);
  });
  after(() => setMode("off"));

  test("sign-in sets an HttpOnly, SameSite=Strict session cookie; only its hash is stored", async () => {
    const s = await signIn(payer);
    assert.equal(s.res.status, 200);
    assertPrivate(s.res, "verify");
    const body = await s.res.json();
    assert.equal(body.address, payer.address);
    assert.match(s.setCookie, /HttpOnly/);
    assert.match(s.setCookie, /SameSite=Strict/);
    assert.match(s.setCookie, /Path=\/api\/v1/);
    assert.match(s.setCookie, /Max-Age=43200/);
    assert.doesNotMatch(s.setCookie, /Secure/, "Secure is off only on http://127.0.0.1");
    const rows = m.db.getDb().prepare("SELECT id_hash, expires_at, created_at FROM sessions WHERE address = ?").all(payer.address);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id_hash, sha256(s.value));
    assert.notEqual(rows[0].id_hash, s.value);
    assert.equal(rows[0].expires_at - rows[0].created_at, 12 * 3600);
  });

  test("the cookie is Secure on a real host", async () => {
    const s = await signIn(payer, { site: "https://sparecycle.example" });
    assert.equal(s.res.status, 200);
    assert.match(s.setCookie, /; Secure/);
  });

  test("payer session -> 200 with private, no-store", async () => {
    const s = await signIn(payer);
    const res = await getResult(paidJob.id, s.cookie);
    assert.equal(res.status, 200);
    assertPrivate(res, "payer 200");
    const d = await getDetail(paidJob.id, s.cookie);
    assert.equal(d.body.output, `/api/v1/jobs/${paidJob.id}/result`);
  });

  test("another wallet's session -> 403", async () => {
    const s = await signIn(stranger);
    assert.equal(s.res.status, 200);
    const res = await getResult(paidJob.id, s.cookie);
    assert.equal(res.status, 403);
  });

  test("a paid job's own read secret also works", async () => {
    const res = await getResult(paidJob.id, bearer(paidJob.readSecret));
    assert.equal(res.status, 200);
  });

  test("a session can't read a free job (no payer)", async () => {
    const free = await runJob(["free answer", "free answer"]);
    const s = await signIn(payer);
    assert.equal((await getResult(free.id, s.cookie)).status, 403);
  });

  test("team job: only the team wallet's session reads it", async () => {
    const t = await runJob(["team answer", "team answer"]);
    setPayer(t.id, team.address);
    const d = await getDetail(t.id);
    assert.equal(d.body.payment, "team");
    assert.equal((await getResult(t.id, (await signIn(team)).cookie)).status, 200);
    assert.equal((await getResult(t.id, (await signIn(payer)).cookie)).status, 403);
  });

  test("nonce reuse is rejected", async () => {
    const first = await signIn(payer);
    assert.equal(first.res.status, 200);
    const again = await m.verify.POST(
      req("/api/v1/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: first.message, signature: first.signature }),
      }),
    );
    assert.equal(again.status, 401);
    assert.equal((await again.json()).error, "bad-nonce");
  });

  test("a nonce the scheduler never issued is rejected", async () => {
    const message = createSiweMessage({
      address: payer.address,
      chainId: m.chain.targetChain.id,
      domain: "127.0.0.1:3261",
      nonce: "abcdefgh12345678",
      uri: SITE,
      version: "1",
      issuedAt: new Date(),
    });
    const s = await signIn(payer, { message });
    assert.equal(s.res.status, 401);
    assert.equal((await s.res.json()).error, "bad-nonce");
  });

  test("wrong domain, wrong chain and a forged signature are rejected", async () => {
    const dom = await signIn(payer, { domain: "evil.example" });
    assert.equal(dom.res.status, 401);
    assert.equal((await dom.res.json()).error, "wrong-domain");
    const chain = await signIn(payer, { chainId: 1 });
    assert.equal(chain.res.status, 401);
    assert.equal((await chain.res.json()).error, "wrong-chain");
    const forged = await signIn(payer, { signer: stranger });
    assert.equal(forged.res.status, 401);
    assert.equal((await forged.res.json()).error, "bad-signature");
    assert.equal(forged.setCookie, "");
  });

  test("a non-JSON sign-in (e.g. a cross-site form) is refused", async () => {
    const res = await m.verify.POST(req("/api/v1/auth/verify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "message=x" }));
    assert.equal(res.status, 415);
  });

  test("an expired session is rejected (401, like no session)", async () => {
    const s = await signIn(payer);
    assert.equal((await getResult(paidJob.id, s.cookie)).status, 200);
    m.db.getDb().prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").run(Math.floor(Date.now() / 1000) - 1, sha256(s.value));
    assert.equal((await getResult(paidJob.id, s.cookie)).status, 401);
  });

  test("logout ends the session and clears the cookie", async () => {
    const s = await signIn(payer);
    const res = await m.logout.POST(req("/api/v1/auth/logout", { method: "POST", headers: s.cookie }));
    assert.equal(res.status, 200);
    assertPrivate(res, "logout");
    assert.match(res.headers.get("set-cookie"), /^sc_session=; .*Max-Age=0/);
    assert.equal((await getResult(paidJob.id, s.cookie)).status, 401);
  });
});

describe("legacy jobs (created before read secrets)", () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  before(() => setMode("enforce"));
  after(() => setMode("off"));

  test("a legacy free job is unreadable by anyone", async () => {
    const j = await runJob(["legacy", "legacy"]);
    m.db.getDb().prepare("UPDATE jobs SET read_secret_hash = NULL WHERE id = ?").run(j.id);
    assert.equal((await getResult(j.id)).status, 401);
    assert.equal((await getResult(j.id, bearer(j.readSecret))).status, 403);
    assert.equal((await getResult(j.id, (await signIn(payer)).cookie)).status, 403);
  });

  test("a legacy paid job is readable by the payer's session", async () => {
    const j = await runJob(["legacy paid", "legacy paid"]);
    m.db.getDb().prepare("UPDATE jobs SET read_secret_hash = NULL WHERE id = ?").run(j.id);
    setPayer(j.id, payer.address);
    assert.equal((await getResult(j.id, (await signIn(payer)).cookie)).status, 200);
    assert.equal((await getResult(j.id, bearer(j.readSecret))).status, 403);
  });
});

describe("OUTPUT_AUTH=off (default)", () => {
  test("the result and the old output route serve without credentials, with private headers", async () => {
    setMode("off");
    const j = await runJob(["open answer", "open answer"]);
    for (const res of [await getResult(j.id), await getOutput(j.id)]) {
      assert.equal(res.status, 200);
      assertPrivate(res, "off 200");
    }
    const d = await getDetail(j.id);
    assert.equal(d.body.output, `/api/v1/jobs/${j.id}/result`);
    assert.equal(d.body.outputAvailable, true);
  });
});

describe("per-viewer rate limit", () => {
  test("reads past OUTPUT_RATE_LIMIT -> 429; other viewers are unaffected", async () => {
    setMode("enforce");
    process.env.OUTPUT_RATE_LIMIT = "3";
    try {
      const j = await runJob(["limited", "limited"]);
      for (let i = 0; i < 3; i++) assert.equal((await getResult(j.id, bearer(j.readSecret))).status, 200);
      const over = await getResult(j.id, bearer(j.readSecret));
      assert.equal(over.status, 429);
      assertPrivate(over, "429");
      const other = await runJob(["other", "other"]);
      assert.equal((await getResult(other.id, bearer(other.readSecret))).status, 200);
    } finally {
      delete process.env.OUTPUT_RATE_LIMIT;
      setMode("off");
    }
  });
});

describe("node isolation", () => {
  test("a node's signed request is not a credential for outputs", async () => {
    setMode("enforce");
    try {
      const j = await runJob(["node cannot read", "node cannot read"]);
      for (const node of [nodeA, nodeB]) {
        const path = `/api/v1/jobs/${j.id}/result`;
        const headers = await m.proto.signRequest(node.key, "GET", path, "");
        const res = await getResult(j.id, headers);
        assert.equal(res.status, 401, "node signature ignored");
        const old = await getOutput(j.id, await m.proto.signRequest(node.key, "GET", `/api/v1/jobs/${j.id}/output`, ""));
        assert.equal(old.status, 410);
        const d = await getDetail(j.id, await m.proto.signRequest(node.key, "GET", `/api/v1/jobs/${j.id}`, ""));
        assert.equal(d.body.output, null);
      }
    } finally {
      setMode("off");
    }
  });

  test("poll never returns the spec of a settled job", async () => {
    for (const settled of ["agreed", "disagreed", "expired", "rejected"]) {
      // A held lease on a job that has since settled.
      const held = await submitText(`held ${settled}`);
      only(held.id);
      const a = await m.nodes.pollForTask(nodeA.key.address, aborted());
      assert.equal(a.jobId, held.id);
      m.db.getDb().prepare("UPDATE jobs SET status = ? WHERE id = ?").run(settled, held.id);
      assert.equal(await m.nodes.pollForTask(nodeA.key.address, aborted()), null, `${settled}: held lease not re-served`);
      assert.equal(await m.nodes.pollForTask(nodeB.key.address, aborted()), null, `${settled}: open sibling task not served`);
      m.db.getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id = ?").run(held.id);
    }
  });

  test("the signed poll route answers 204 for a settled job", async () => {
    const j = await submitText("poll route");
    only(j.id);
    m.db.getDb().prepare("UPDATE jobs SET status = 'agreed' WHERE id = ?").run(j.id);
    const body = JSON.stringify({ nonce: m.proto.requestNonce() });
    const headers = await m.proto.signRequest(nodeA.key, "POST", "/api/v1/nodes/poll", body);
    const ac = new AbortController();
    ac.abort();
    const res = await m.poll.POST(new Request(`${SITE}/api/v1/nodes/poll`, { method: "POST", headers, body, signal: ac.signal }));
    assert.equal(res.status, 204);
    m.db.getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id = ?").run(j.id);
  });

  test("results.output is NULL after the verdict (agreed and disagreed)", async () => {
    for (const texts of [["same", "same"], ["alpha beta gamma", "completely different words here"]]) {
      const j = await runJob(texts);
      assert.equal(j.status, texts[0] === texts[1] ? "agreed" : "disagreed");
      const left = m.db.getDb().prepare("SELECT COUNT(*) AS n FROM results WHERE job_id = ? AND output IS NOT NULL").get(j.id).n;
      const kept = m.db.getDb().prepare("SELECT COUNT(*) AS n FROM results WHERE job_id = ?").get(j.id).n;
      assert.equal(kept, 2, "hashes and fingerprints kept");
      assert.equal(left, 0, `${j.status}: per-node outputs dropped`);
    }
  });

  test("results.output is NULL after a job expires with one result in", async () => {
    const j = await submitText("expires");
    only(j.id);
    await work(nodeA, "half done");
    const db = m.db.getDb();
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM results WHERE job_id = ? AND output IS NOT NULL").get(j.id).n, 1);
    db.prepare("UPDATE jobs SET created_at = created_at - 7 * 3600 WHERE id = ?").run(j.id);
    m.jobs.expireStaleJobs();
    assert.equal(db.prepare("SELECT status FROM jobs WHERE id = ?").get(j.id).status, "expired");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM results WHERE job_id = ? AND output IS NOT NULL").get(j.id).n, 0);
  });
});
