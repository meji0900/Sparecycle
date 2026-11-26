// Serverless mode (next-update brief §2) through the real route handlers, on a scratch DB with stubbed chain reads:
//   - GET /api/v1/catalog without a key: exactly the models in MODELS with their catalog fields, the live price per unit,
//     LIMITS and live capacity; /v1/models stays key-only;
//   - the capacity guard: no reachable pair -> 503 no-node-pair on POST /api/v1/jobs (free, wallet-paid, key-paid), on the
//     OpenAI-compatible create and on MCP submit_job, with nothing queued, held, counted or charged; the GPU pool counts
//     while it can start (a stopped pool machine of the other owner, or a fresh pool with two owner groups), not while it
//     backs off;
//   - the wallet flow of the playground (a signed per-job payment from the prepaid balance, the same submitJob as the API);
//   - sparecycle.receipt_url in chat / image answers and in not_charged errors;
//   - a forced mismatch: three rounds on pairs that share no node, owner or GPU, then 422 not_charged and no charge;
//   - F1: no public job view carries the price, the charge status or the payer.
// Run: npm test
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { LocalAccount } from "viem";
import { newAccount, setupAgentApi, SITE } from "./test-support/agent-api";

let h: Awaited<ReturnType<typeof setupAgentApi>>;
let c: Awaited<ReturnType<Awaited<ReturnType<typeof setupAgentApi>>["customer"]>>;
let lib: {
  catalog: typeof import("@/lib/catalog");
  request: typeof import("@/lib/playground-request");
  jobPayment: typeof import("@/lib/job-payment");
  capacity: typeof import("./capacity");
  pool: typeof import("./gpu-pool");
};
before(async () => {
  h = await setupAgentApi();
  c = await h.customer();
  lib = {
    catalog: await import("@/lib/catalog"),
    request: await import("@/lib/playground-request"),
    jobPayment: await import("@/lib/job-payment"),
    capacity: await import("./capacity"),
    pool: await import("./gpu-pool"),
  };
});
after(() => h.cleanup());

const POOL_ENV = ["VAST_API_KEY", "VAST_API_URL", "GPU_POOL_INSTANCE_IDS", "GPU_POOL_ALWAYS_ON", "GPU_POOL_GROUP_OWNERS", "PROJECT_NODE_OWNERS"];
const poolState = () => (globalThis as { __sparecyclePool?: { backoffUntil: number | null; state: string } }).__sparecyclePool;

beforeEach(() => {
  // Both harness nodes online, no pool, no open work from an earlier test.
  for (const k of POOL_ENV) delete process.env[k];
  const db = h.m.db.getDb();
  db.exec("UPDATE tasks SET status = 'cancelled' WHERE status IN ('open','leased')");
  db.exec("UPDATE jobs SET status = 'expired' WHERE status IN ('queued','running','checking')");
  db.exec("UPDATE nodes SET last_seen = 0, state = NULL");
  h.setOnline([h.nodeA, h.nodeB]);
  const p = poolState();
  if (p) p.backoffUntil = null;
});

/** A pool the guard can count on, without a reachable Vast API (every pool call fails fast and is only logged). */
function poolOn(ids = "11:a,22:b") {
  Object.assign(process.env, { VAST_API_KEY: "test-key", VAST_API_URL: "http://127.0.0.1:9", GPU_POOL_INSTANCE_IDS: ids });
}

/** Registers a non-dev node (a real GPU as the scheduler sees it) with its own owner and GPU. */
async function realNode(name: string, caps = ["text:qwen2.5-1.5b", "image:sd15"]) {
  const key = newAccount();
  const owner = newAccount();
  const ownerSig = await owner.signMessage({ message: h.m.proto.linkMessage(key.address, owner.address) });
  await h.m.nodes.registerNode(key.address, { gpu: "NVIDIA GeForce RTX 3060", gpuUuid: `GPU-REAL-${name}`, vramMb: 12_288, caps, owner: owner.address, ownerSig });
  return { key, owner };
}

const jobCount = () => (h.m.db.getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
const rateCount = () => (h.m.db.getDb().prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits").get() as { n: number }).n;
const catalog = async () => {
  const res = await h.m.routes.catalog.GET();
  assert.equal(res.status, 200);
  return (await res.json()) as import("@/lib/catalog").Catalog;
};
const capOf = async (model: string) => (await catalog()).models.find((m) => m.id === model)!.capacity;
const textReq = (prompt = "Say hi") => lib.request.textJobRequest({ prompt, system: "", maxTokens: 16 });
const imageReq = (prompt = "a red bicycle") =>
  lib.request.imageJobRequest({ prompt, negative: "", width: 256, height: 256, steps: 10, guidance: 7, seed: null });

/** A wallet-paid job body exactly as the playground sends it: the request and an EIP-191 signature over it at the price. */
async function paidBody(payer: LocalAccount, request: ReturnType<typeof textReq> | ReturnType<typeof imageReq>) {
  const priceWei = lib.jobPayment.jobPriceWei(h.m.proto.parseJobRequest(request), h.m.payments.priceWeiPerUnit());
  const issued = Math.floor(Date.now() / 1000);
  const message = lib.jobPayment.jobPaymentMessage({
    chainId: h.m.chain.targetChain.id,
    contract: h.payments,
    requestHash: lib.jobPayment.jobRequestHash(request),
    priceWei,
    issued,
  });
  return { request, payment: { payer: payer.address, signature: await payer.signMessage({ message }), issued, priceWei: priceWei.toString() } };
}
const postJob = (body: unknown, headers: Record<string, string> = {}) => h.m.routes.jobs.POST(h.req("/api/v1/jobs", { method: "POST", body, headers }));
const chat = (body: unknown, key = c.key) => h.m.routes.chat.POST(h.req("/api/v1/chat/completions", { method: "POST", body, headers: h.bearer(key) }));
const images = (body: unknown, key = c.key) => h.m.routes.images.POST(h.req("/api/v1/images/generations", { method: "POST", body, headers: h.bearer(key) }));
const hello = { model: "qwen2.5-1.5b", messages: [{ role: "user", content: "Say hi" }], max_tokens: 16 };
async function mcpSubmit(args: Record<string, unknown>) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "submit_job",
      arguments: args,
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
    },
  };
  const headers = { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "submit_job", ...h.bearer(c.key) };
  const res = await h.m.routes.mcp.POST(h.req("/api/v1/mcp", { method: "POST", headers, body }));
  return (await res.json()).result as { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, string> };
}

describe("GET /api/v1/catalog", () => {
  test("no key: exactly the models in MODELS, with label, kind, license, source, live price, units, limits and capacity", async () => {
    const res = await h.m.routes.catalog.GET();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const cat = (await res.json()) as import("@/lib/catalog").Catalog;
    const { MODELS, MODEL_IDS, LIMITS, workUnits } = h.m.proto;
    assert.equal(cat.object, "catalog");
    assert.deepEqual(
      cat.models.map((m) => m.id),
      MODEL_IDS,
      "every model the scheduler runs, nothing else",
    );
    const perUnit = h.m.payments.priceWeiPerUnit();
    assert.equal(cat.pricing.priceWeiPerUnit, perUnit.toString());
    assert.equal(cat.pricing.paidJobs, true);
    for (const m of cat.models) {
      const src = MODELS[m.id];
      assert.equal(m.kind, src.kind);
      assert.equal(m.label, src.label);
      assert.equal(m.license, src.license);
      assert.equal(m.source, src.source);
      assert.equal(m.sourceUrl, `https://huggingface.co/${src.source}`);
      assert.deepEqual(m.backends, [...src.backends]);
      assert.equal(m.price.priceWeiPerUnit, perUnit.toString(), "the live price per unit");
      assert.ok(m.price.units.length > 20, "how units are counted");
      const ex = lib.catalog.CATALOG_INFO[m.id].example.request;
      assert.equal(m.price.example.units, workUnits(ex));
      assert.equal(m.price.example.priceWei, (BigInt(workUnits(ex)) * perUnit).toString());
      assert.deepEqual(m.limits, JSON.parse(JSON.stringify(LIMITS[src.kind])));
      assert.deepEqual(Object.keys(m.capacity).sort(), ["pair", "pairReachable", "ready", "retryAfter", "standby"]);
    }
  });

  test("a model in MODELS without catalog fields fails here (CATALOG_INFO covers MODELS exactly, every field filled)", () => {
    const { MODEL_IDS } = h.m.proto;
    assert.deepEqual(Object.keys(lib.catalog.CATALOG_INFO).sort(), [...MODEL_IDS].sort());
    for (const id of MODEL_IDS) {
      const info = lib.catalog.CATALOG_INFO[id];
      assert.ok(info, `${id}: no catalog entry in src/lib/catalog.ts`);
      for (const k of ["name", "summary", "endpoint", "output", "units"] as const) assert.ok(info[k]?.trim(), `${id}: ${k} is empty`);
      assert.ok(info.notes.length > 0, `${id}: no notes`);
      assert.equal(info.example.request.params.model, id, `${id}: the example request is for another model`);
      h.m.proto.parseJobRequest(info.example.request); // a valid request of this model
    }
  });

  test("also at /v1/catalog through the /v1 rewrite; /v1/models stays OpenAI-shaped and key-only", async () => {
    const nextConfig = (await import("../../next.config")).default;
    const rewrites = await (nextConfig.rewrites as () => Promise<{ source: string; destination: string }[]>)();
    assert.ok(rewrites.some((r) => r.source === "/v1/:path*" && r.destination === "/api/v1/:path*"));
    const noKey = await h.m.routes.models.GET(h.req("/api/v1/models"));
    assert.equal(noKey.status, 401);
    assert.equal((await noKey.json()).error.code, "invalid_api_key");
    const withKey = await (await h.m.routes.models.GET(h.req("/api/v1/models", { headers: h.bearer(c.key) }))).json();
    assert.equal(withKey.object, "list");
  });

  test("project-run until an outside owner's node passes the GPU gate and takes part in an agreed job (N17)", async () => {
    // Dev runners (local tests only) are no real machines and never count as outside owners.
    let cat = await catalog();
    assert.equal(cat.network.operators, "project-run");
    assert.match(cat.network.note, /run by the Sparecycle project/);
    // A real GPU of an outside owner registers and passes the gate: a registration alone changes nothing.
    const outside = await realNode("OUTSIDE");
    assert.equal((await catalog()).network.operators, "project-run");
    // Once it has taken part in an agreed job, the wording changes.
    h.m.db.getDb().prepare("UPDATE nodes SET agreed_jobs = 1 WHERE node_key = ?").run(outside.key.address);
    cat = await catalog();
    assert.equal(cat.network.operators, "mixed");
    process.env.PROJECT_NODE_OWNERS = outside.owner.address;
    assert.equal((await catalog()).network.operators, "project-run");
    h.setOnline([], [outside.key]);
  });
});

describe("live capacity", () => {
  test("two owners online: pair online, two ready; one owner: no pair; same owner twice: still no pair; paused: not ready", async () => {
    let cap = await capOf("qwen2.5-1.5b");
    assert.deepEqual([cap.pair, cap.ready, cap.pairReachable], ["online", 2, true]);
    h.setOnline([], [h.nodeB]);
    cap = await capOf("qwen2.5-1.5b");
    assert.deepEqual([cap.pair, cap.ready, cap.pairReachable], [null, 1, false]);
    assert.equal(cap.standby, 0);
    // A second node of nodeA's owner (another key, another GPU): one owner alone is no pair.
    const twinKey = newAccount();
    const ownerKey = newAccount();
    const ownerSig = await ownerKey.signMessage({ message: h.m.proto.linkMessage(twinKey.address, ownerKey.address) });
    await h.m.nodes.registerNode(twinKey.address, { gpu: "TEST twin", gpuUuid: "TEST-GPU-TWIN", vramMb: 24_000, caps: ["text:qwen2.5-1.5b"], owner: ownerKey.address, ownerSig, dev: true });
    h.m.db.getDb().prepare("UPDATE nodes SET owner = ? WHERE node_key = ?").run(h.ownerOf(h.nodeA), twinKey.address);
    cap = await capOf("qwen2.5-1.5b");
    assert.deepEqual([cap.pair, cap.ready], [null, 2]);
    h.setOnline([], [twinKey]);
    // A paused node (Idle Guard) is online but takes nothing: not ready, not part of a pair.
    h.setOnline([h.nodeB]);
    h.m.db.getDb().prepare("UPDATE nodes SET state = 'paused-hot' WHERE node_key = ?").run(h.nodeB.address);
    cap = await capOf("sd15");
    assert.deepEqual([cap.pair, cap.ready], [null, 1]);
  });

  test("the GPU pool: a stopped pool machine of the other owner makes the pair reachable; not while the pool backs off", async () => {
    h.setOnline([], [h.nodeB]);
    poolOn();
    process.env.PROJECT_NODE_OWNERS = h.ownerOf(h.nodeB);
    let cap = await capOf("sd15");
    // nodeB (offline, project-run) can be started by the pool: a pair with nodeA. Dev runners are never shown as standby.
    assert.deepEqual([cap.pair, cap.ready, cap.standby, cap.retryAfter], ["pool", 1, 0, null]);
    // A stopped project GPU is shown as standby (at most as many as the pool has machines that are not online).
    const pooled = await realNode("POOL");
    h.setOnline([], [pooled.key]);
    process.env.PROJECT_NODE_OWNERS = [h.ownerOf(h.nodeB), pooled.owner.address].join(",");
    cap = await capOf("sd15");
    assert.deepEqual([cap.pair, cap.standby], ["pool", 1]);
    poolOn("11:a");
    assert.equal((await capOf("sd15")).standby, 1);
    process.env.GPU_POOL_INSTANCE_IDS = "";
    assert.deepEqual([(await capOf("sd15")).pair, (await capOf("sd15")).standby], [null, 0], "no pool: nothing on standby, no pair");
    poolOn();
    // The pool waits after a start where fewer than two owners came up: nothing can be reached until then.
    const t = h.m.db.nowSec();
    lib.pool.poolStartInfo(t); // creates the pool state
    poolState()!.backoffUntil = t + 600;
    cap = await capOf("sd15");
    assert.equal(cap.pair, null);
    assert.ok(cap.retryAfter! > 590 && cap.retryAfter! <= 600, String(cap.retryAfter));
    assert.equal((await catalog()).network.pool.canStart, false);
  });

  test("a fresh pool (no project node registered yet) with two owner groups counts; with one group it does not", async () => {
    h.setOnline([], [h.nodeA, h.nodeB]);
    process.env.PROJECT_NODE_OWNERS = newAccount().address; // a project wallet with no node registered
    poolOn("11,22");
    assert.equal((await capOf("qwen2.5-1.5b")).pair, "pool");
    poolOn("11:a,12:a");
    assert.equal((await capOf("qwen2.5-1.5b")).pair, null);
    poolOn("11:a");
    assert.equal((await capOf("qwen2.5-1.5b")).pair, null);
  });

  test("the pool's own trigger uses the same pair rule: a model is uncovered while no pair is online", async () => {
    assert.equal(lib.capacity.pairOnline("sd15"), true);
    h.m.db.getDb().prepare("UPDATE nodes SET state = 'paused-busy' WHERE node_key = ?").run(h.nodeA.address);
    assert.equal(lib.capacity.pairOnline("sd15"), false, "two owners online, one paused: no pair, the pool starts");
    assert.deepEqual([...lib.capacity.readyOwners("sd15")], [h.ownerOf(h.nodeB).toLowerCase()]);
  });
});

describe("capacity guard: 503 no-node-pair, nothing queued, held, counted or charged", () => {
  test("POST /api/v1/jobs: free, wallet-paid and key-paid jobs; Retry-After while the pool backs off", async () => {
    h.setOnline([], [h.nodeB]);
    const before = { jobs: jobCount(), rate: rateCount(), held: h.m.payments.heldFor(c.wallet.address), spent: h.m.apikeys.keySpend(c.keyId).spent };
    const free = await postJob(textReq());
    assert.equal(free.status, 503);
    h.assertPrivate(free, "503");
    const fb = await free.json();
    assert.equal(fb.error, "no-node-pair");
    assert.equal(fb.model, "qwen2.5-1.5b");
    assert.match(fb.message, /Nothing was queued, held or charged/);

    const paid = await postJob(await paidBody(c.wallet, imageReq()));
    assert.equal(paid.status, 503);
    assert.equal((await paid.json()).error, "no-node-pair");
    const keyed = await postJob(textReq(), h.bearer(c.key));
    assert.equal(keyed.status, 503);

    assert.equal(jobCount(), before.jobs, "nothing queued");
    assert.equal(rateCount(), before.rate, "no rate-limit slot used");
    assert.equal(h.m.payments.heldFor(c.wallet.address), before.held, "nothing held");
    assert.equal(h.m.apikeys.keySpend(c.keyId).spent, before.spent, "nothing counted against the key's daily cap");

    poolOn();
    process.env.PROJECT_NODE_OWNERS = h.ownerOf(h.nodeB);
    const t = h.m.db.nowSec();
    lib.pool.poolStartInfo(t);
    poolState()!.backoffUntil = t + 900;
    const waiting = await postJob(textReq());
    assert.equal(waiting.status, 503);
    const ra = Number(waiting.headers.get("retry-after"));
    assert.ok(ra > 890 && ra <= 900, String(ra));
    assert.equal((await waiting.json()).retryAfter, ra);
    assert.equal(jobCount(), before.jobs);
  });

  test("the pool can bring the pair up: the job is accepted (free and paid)", async () => {
    h.setOnline([], [h.nodeB]);
    poolOn();
    process.env.PROJECT_NODE_OWNERS = h.ownerOf(h.nodeB);
    const free = await postJob(textReq("pool free"));
    assert.equal(free.status, 201, JSON.stringify(await free.clone().json()));
    const paid = await postJob(await paidBody(c.wallet, imageReq("pool paid")));
    assert.equal(paid.status, 201);
  });

  test("OpenAI shape on /v1 (chat and images) and a tool error on MCP, with nothing queued", async () => {
    h.setOnline([], [h.nodeA, h.nodeB]);
    const n = jobCount();
    for (const res of [await chat(hello), await images({ model: "sd15", prompt: "a lighthouse", size: "256x256" })]) {
      assert.equal(res.status, 503);
      h.assertPrivate(res, "openai 503");
      assert.equal(res.headers.get("x-should-retry"), "false");
      const b = await res.json();
      assert.equal(b.error.code, "no_node_pair");
      assert.equal(b.error.type, "server_error");
      assert.equal(typeof b.error.message, "string");
      assert.ok(["qwen2.5-1.5b", "sd15"].includes(b.sparecycle.model));
    }
    const r = await mcpSubmit({ kind: "text", model: "qwen2.5-1.5b", prompt: "hi" });
    assert.equal(r.isError, true);
    assert.equal(JSON.parse(r.content[0].text).error.code, "no_node_pair");
    assert.equal(jobCount(), n);
  });

  test("a pair online again: accepted at once", async () => {
    const res = await chat(hello);
    assert.equal(res.status, 202);
  });
});

describe("the playground's wallet flow and receipt links", () => {
  test("a signed-in wallet runs sd15 and qwen2.5-1.5b from its prepaid balance through the same submitJob as the API", async () => {
    const wallet = newAccount();
    h.chain.balance.set(wallet.address.toLowerCase(), 10n ** 15n);
    const session = await h.signIn(wallet);
    for (const request of [imageReq("a playground lighthouse"), textReq("A playground question.")]) {
      const res = await postJob(await paidBody(wallet, request));
      assert.equal(res.status, 201);
      const sub = await res.json();
      assert.equal(sub.priceWei, lib.jobPayment.jobPriceWei(h.m.proto.parseJobRequest(request), h.m.payments.priceWeiPerUnit()).toString());
      const row = h.m.db.getDb().prepare("SELECT payer, price_wei, charge_status, api_key_id, payment_sig FROM jobs WHERE id = ?").get(sub.id) as Record<string, string | null>;
      assert.equal(row.payer, wallet.address);
      assert.equal(row.charge_status, "pending", "charged at the epoch close exactly like an API job");
      assert.equal(row.api_key_id, null, "no API key");
      assert.ok(row.payment_sig);
      assert.equal(await h.run(sub.id, request.kind === "image" ? { shade: 40 } : { text: "Hello from two nodes." }), "agreed");
      // The wallet's session reads the result and the receipt (no read secret needed on another device).
      const out = await h.m.routes.result.GET(h.req(`/api/v1/jobs/${sub.id}/result`, { headers: session }), h.ctx(sub.id));
      assert.equal(out.status, 200);
      const rc = await h.m.routes.receipt.GET(h.req(`/api/v1/jobs/${sub.id}/receipt`, { headers: session }), h.ctx(sub.id));
      assert.equal(rc.status, 200);
      const receipt = await rc.json();
      assert.equal(receipt.state, "provisional");
      assert.equal(receipt.payer, wallet.address);
      assert.equal(receipt.nodes.length, 2, "both nodes' signed results");
      const detail = await (await h.m.routes.job.GET(h.req(`/api/v1/jobs/${sub.id}`), h.ctx(sub.id))).json();
      assert.equal(detail.maxRounds, 3, "re-check rounds as for every paid job");
    }
  });

  test("chat and image answers carry sparecycle.receipt_url, readable with the same key", async () => {
    const res = await chat(hello);
    assert.equal(res.status, 202);
    const body = await res.json();
    const jobId = body.sparecycle.job_id;
    assert.equal(body.sparecycle.receipt_url, `${SITE}/api/v1/jobs/${jobId}/receipt`);
    assert.equal(await h.run(jobId, { text: "Hi." }), "agreed");
    const done = await (await h.m.routes.chatPoll.GET(h.req(`/api/v1/chat/completions/${body.id}`, { headers: h.bearer(c.key) }), h.ctx(body.id))).json();
    assert.equal(done.choices[0].message.content, "Hi.");
    assert.equal(done.sparecycle.receipt_url, body.sparecycle.receipt_url);
    const rc = await h.m.routes.receipt.GET(h.req(`/api/v1/jobs/${jobId}/receipt`, { headers: h.bearer(c.key) }), h.ctx(jobId));
    assert.equal(rc.status, 200);
    assert.equal((await rc.json()).jobId, jobId);

    const img = await (await images({ model: "sd15", prompt: "a teapot", size: "256x256", steps: 10 })).json();
    assert.equal(img.sparecycle.receipt_url, `${SITE}/api/v1/jobs/${img.sparecycle.job_id}/receipt`);
  });
});

test("a forced mismatch: three rounds on pairs that share no node, owner or GPU, then 422 not_charged with the receipt link, and no charge", async () => {
  const extra = await Promise.all([h.mkNode("R1"), h.mkNode("R2"), h.mkNode("R3"), h.mkNode("R4")]);
  const pairs = [[h.nodeA, h.nodeB], [extra[0], extra[1]], [extra[2], extra[3]]] as const;
  h.setOnline([h.nodeA, h.nodeB, ...extra]);
  const before = h.m.apikeys.keySpend(c.keyId).spent;
  const heldBefore = h.m.payments.heldFor(c.wallet.address);
  const created = await (await chat({ ...hello, messages: [{ role: "user", content: "no pair agrees" }] })).json();
  const jobId: string = created.sparecycle.job_id;
  const verdicts: string[] = [];
  for (const [r, [x, y]] of pairs.entries()) {
    const res = await h.runOn(jobId, x, y, { text: `pair ${r} says yes` }, { text: `pair ${r} says something else entirely` });
    verdicts.push(`${res.status}:${res.round ?? r}`);
  }
  assert.deepEqual(verdicts, ["queued:1", "queued:2", "disagreed:2"]);
  const rs = h.m.db.getDb().prepare("SELECT round, node_key, owner, gpu_uuid FROM results WHERE job_id = ? ORDER BY round").all(jobId) as Record<string, string | number>[];
  assert.deepEqual(rs.map((r) => r.round), [0, 0, 1, 1, 2, 2]);
  for (const k of ["node_key", "owner", "gpu_uuid"]) assert.equal(new Set(rs.map((r) => String(r[k]).toLowerCase())).size, 6, `6 distinct ${k}s`);

  const poll = await h.m.routes.chatPoll.GET(h.req(`/api/v1/chat/completions/${created.id}`, { headers: h.bearer(c.key) }), h.ctx(created.id));
  assert.equal(poll.status, 422);
  const pb = await poll.json();
  assert.equal(pb.error.type, "not_charged");
  assert.equal(pb.error.code, "results_did_not_match");
  assert.equal(pb.sparecycle.charged, false);
  assert.equal(pb.sparecycle.receipt_url, `${SITE}/api/v1/jobs/${jobId}/receipt`);
  // Not charged: nothing held, the key's day counter gets the price back, the receipt says not charged, no charged leaf.
  assert.equal(h.m.payments.heldFor(c.wallet.address), heldBefore);
  assert.equal(h.m.apikeys.keySpend(c.keyId).spent, before);
  const rc = await (await h.m.routes.receipt.GET(h.req(`/api/v1/jobs/${jobId}/receipt`, { headers: h.bearer(c.key) }), h.ctx(jobId))).json();
  assert.equal(rc.verdict, "disagreed");
  assert.notEqual(rc.chargeStatus, "charged");
  const leaves = h.m.db.getDb().prepare("SELECT charge_status FROM charge_leaves WHERE job_id = ?").all(jobId) as { charge_status: string }[];
  assert.ok(leaves.every((l) => l.charge_status !== "charged"), JSON.stringify(leaves));
});

test("F1: no public job view carries the price, the charge status or the payer", async () => {
  const wallet = newAccount();
  h.chain.balance.set(wallet.address.toLowerCase(), 10n ** 15n);
  const sub = await (await postJob(await paidBody(wallet, textReq("a paid job for the F1 check")))).json();
  await h.run(sub.id, { text: "fine" });
  const keyed = await (await chat(hello)).json();
  const list = await (await h.m.routes.jobs.GET(h.req("/api/v1/jobs?limit=100"))).json();
  const detail = await (await h.m.routes.job.GET(h.req(`/api/v1/jobs/${sub.id}`), h.ctx(sub.id))).json();
  const keyedDetail = await (await h.m.routes.job.GET(h.req(`/api/v1/jobs/${keyed.sparecycle.job_id}`), h.ctx(keyed.sparecycle.job_id))).json();
  assert.ok(list.jobs.some((j: { id: string }) => j.id === sub.id));
  for (const view of [list, detail, keyedDetail]) {
    const text = JSON.stringify(view);
    for (const field of ["priceWei", "price_wei", "chargeStatus", "charge_status", "payer"]) assert.ok(!text.includes(`"${field}"`), `${field} in a public view`);
    assert.ok(!text.toLowerCase().includes(wallet.address.slice(2).toLowerCase()), "the payer's address in a public view");
    assert.ok(!text.toLowerCase().includes(c.wallet.address.slice(2).toLowerCase()), "the key owner's address in a public view");
  }
  assert.equal(detail.payment, "paid");
});
