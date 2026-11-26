// OpenAI-compatible API (brief step 2, acceptance list 2.9) through the real route handlers, on a scratch DB with
// stubbed chain reads. The official SDKs and the /v1 rewrite are checked against `next start` (docs/agent-api-testing.md).
// Run: npm test
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PNG } from "pngjs";
import { setupAgentApi } from "./test-support/agent-api";

let h: Awaited<ReturnType<typeof setupAgentApi>>;
let c: Awaited<ReturnType<Awaited<ReturnType<typeof setupAgentApi>>["customer"]>>;
before(async () => {
  h = await setupAgentApi();
  c = await h.customer();
});
after(() => h.cleanup());

type Init = { headers?: Record<string, string>; key?: string | null };
const chat = (body: unknown, o: Init = {}) =>
  h.m.routes.chat.POST(h.req("/api/v1/chat/completions", { method: "POST", body, headers: { ...(o.key === null ? {} : h.bearer(o.key ?? c.key)), ...o.headers } }));
const pollChat = (id: string, o: Init = {}) =>
  h.m.routes.chatPoll.GET(h.req(`/api/v1/chat/completions/${id}`, { headers: { ...(o.key === null ? {} : h.bearer(o.key ?? c.key)), ...o.headers } }), h.ctx(id));
const images = (body: unknown, o: Init = {}) =>
  h.m.routes.images.POST(h.req("/api/v1/images/generations", { method: "POST", body, headers: { ...(o.key === null ? {} : h.bearer(o.key ?? c.key)), ...o.headers } }));
const pollImages = (id: string, o: Init = {}) =>
  h.m.routes.imagesPoll.GET(h.req(`/api/v1/images/generations/${id}`, { headers: { ...(o.key === null ? {} : h.bearer(o.key ?? c.key)), ...o.headers } }), h.ctx(id));
const hello = (extra: Record<string, unknown> = {}) => ({ model: "qwen2.5-1.5b", messages: [{ role: "user", content: "Say hi" }], max_tokens: 16, ...extra });
const errOf = async (res: Response) => (await res.json()).error as { message: string; type: string; param: string | null; code: string };
const jobCount = () => (h.m.db.getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;

describe("chat completions", () => {
  test("create answers 202 in the chat.completion shape; poll returns the agreed text", async () => {
    const res = await chat(hello({ temperature: 0.7, top_p: 0.9 }));
    assert.equal(res.status, 202);
    h.assertPrivate(res, "create");
    const body = await res.json();
    assert.equal(body.object, "chat.completion");
    assert.equal(body.model, "qwen2.5-1.5b");
    assert.deepEqual(body.choices, []);
    assert.match(body.id, /^chatcmpl-0x[0-9a-f]{64}$/);
    assert.equal(body.sparecycle.status, "queued");
    assert.equal(body.sparecycle.decoding, "greedy", "temperature accepted, decoding stays greedy");
    assert.equal(body.sparecycle.finish_reason_reported, false);
    assert.equal(body.sparecycle.poll, `/v1/chat/completions/${body.id}`);
    assert.match(body.sparecycle.price_wei, /^\d+$/);
    assert.ok(!("usage" in body), "no invented usage");
    assert.ok(!JSON.stringify(body).includes("Say hi"), "the prompt is never echoed");

    const early = await pollChat(body.id);
    assert.equal(early.status, 200);
    assert.deepEqual((await early.json()).choices, []);

    assert.equal(await h.run(body.sparecycle.job_id, { text: "Hi there." }), "agreed");
    const done = await pollChat(body.id);
    assert.equal(done.status, 200);
    h.assertPrivate(done, "poll");
    const d = await done.json();
    assert.equal(d.choices.length, 1);
    assert.equal(d.choices[0].message.role, "assistant");
    assert.equal(d.choices[0].message.content, "Hi there.");
    assert.equal(d.choices[0].finish_reason, "stop");
    assert.equal(d.sparecycle.finish_reason_reported, false);
    assert.equal(d.sparecycle.status, "agreed");
    assert.ok(!("usage" in d));
  });

  test("parameters outside LIMITS are refused with `param` set", async () => {
    const cases: [unknown, number, string, string?][] = [
      [hello({ max_tokens: 600 }), 400, "max_tokens"],
      [hello({ max_tokens: undefined, max_completion_tokens: 8 }), 400, "max_completion_tokens"],
      [hello({ messages: [{ role: "user", content: "x".repeat(2001) }] }), 400, "messages[0].content"],
      [hello({ messages: [{ role: "system", content: "s".repeat(501) }, { role: "user", content: "hi" }] }), 400, "messages[0].content"],
      [hello({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }), 400, "messages[0].content"],
      [hello({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }), 400, "messages[1].role"],
      [hello({ n: 2 }), 400, "n"],
      [hello({ tools: [{ type: "function", function: { name: "f" } }] }), 400, "tools"],
      [hello({ response_format: { type: "json_object" } }), 400, "response_format"],
      [hello({ logprobs: true }), 400, "logprobs"],
      [hello({ seed: 1 }), 400, "seed"],
      [hello({ stream: true }), 400, "stream", "streaming_not_supported"],
      [hello({ model: "gpt-4o" }), 404, "model", "model_not_found"],
      [hello({ model: "sd15" }), 400, "model"],
    ];
    const before = jobCount();
    for (const [body, status, param, code] of cases) {
      const res = await chat(body);
      assert.equal(res.status, status, `${param}: status`);
      h.assertPrivate(res, param);
      const e = await errOf(res);
      assert.equal(e.param, param, `${param}: param`);
      assert.equal(e.code, code ?? "invalid_request", `${param}: code`);
      assert.equal(e.type, "invalid_request_error");
    }
    assert.equal(jobCount(), before, "no job was queued for any refused request");
  });

  test("no key or a bad key -> 401; another key -> 403; no key or other key can read the result", async () => {
    const res = await chat(hello());
    const body = await res.json();
    assert.equal(await h.run(body.sparecycle.job_id, { text: "private" }), "agreed");
    const none = await pollChat(body.id, { key: null });
    assert.equal(none.status, 401);
    h.assertPrivate(none, "no key");
    assert.equal((await errOf(none)).code, "invalid_api_key");
    assert.equal((await errOf(await chat(hello(), { key: null }))).type, "authentication_error");
    const other = await h.customer();
    const forbidden = await pollChat(body.id, { key: other.key });
    assert.equal(forbidden.status, 403);
    const fe = await errOf(forbidden);
    assert.equal(fe.code, "forbidden");
    assert.equal(fe.type, "permission_error");
    assert.ok(!JSON.stringify(fe).includes("private"));
    // A per-job read secret or a session is not accepted on these routes.
    assert.equal((await pollChat(body.id, { key: null, headers: c.session })).status, 401);
    // Unknown ids answer 404 in the OpenAI shape.
    assert.equal((await errOf(await pollChat("chatcmpl-0x" + "0".repeat(64)))).code, "not_found");
    assert.equal((await pollChat("nope")).status, 404);
  });

  test("results did not match / no verdict in time -> 422 not_charged on poll, and nothing is charged", async () => {
    const res = await chat(hello());
    const body = await res.json();
    h.lastRound(body.sparecycle.job_id); // a final mismatch (an earlier round would go to another pair)
    assert.equal(await h.run(body.sparecycle.job_id, { text: "one" }, { text: "two" }), "disagreed");
    const poll = await pollChat(body.id);
    assert.equal(poll.status, 422);
    assert.equal(poll.headers.get("x-should-retry"), "false");
    const pb = await poll.json();
    assert.equal(pb.error.code, "results_did_not_match");
    assert.equal(pb.error.type, "not_charged");
    assert.match(pb.error.message, /Nothing was charged/);
    assert.equal(pb.sparecycle.charged, false);
    assert.ok(!("choices" in pb), "no made-up answer");

    const slow = await (await chat(hello())).json();
    h.m.db.getDb().prepare("UPDATE jobs SET created_at = created_at - ? WHERE id = ?").run(7 * 3600, slow.sparecycle.job_id);
    const expired = await pollChat(slow.id);
    assert.equal(expired.status, 422);
    assert.equal((await errOf(expired)).code, "job_expired");
    const row = h.m.db.getDb().prepare("SELECT status, api_key_held FROM jobs WHERE id = ?").get(body.sparecycle.job_id) as { status: string; api_key_held: number };
    assert.equal(row.status, "disagreed");
    assert.equal((await h.m.payments.readAccount(c.wallet.address)).held >= 0n, true);
    assert.ok(!(h.m.db.getDb().prepare("SELECT 1 FROM jobs WHERE id = ? AND charge_status = 'charged'").get(body.sparecycle.job_id)));
  });

  test("Prefer: wait holds the create until the job agrees (200), capped at API_MAX_WAIT_SECONDS", async () => {
    const pending = chat(hello({ messages: [{ role: "user", content: "wait for me" }] }), { headers: { prefer: "wait=5" } });
    // Let the create queue its job, then run it on both nodes while the request waits.
    let jobId: string | undefined;
    for (let i = 0; i < 50 && !jobId; i++) {
      await new Promise((r) => setTimeout(r, 20));
      jobId = (h.m.db.getDb().prepare("SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined)?.id;
    }
    assert.ok(jobId);
    await h.run(jobId!, { text: "waited answer" });
    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("preference-applied"), "wait=5");
    assert.equal((await res.json()).choices[0].message.content, "waited answer");

    process.env.API_MAX_WAIT_SECONDS = "1";
    const t0 = Date.now();
    const capped = await chat(hello(), { headers: { prefer: "respond-async, wait=100" } });
    process.env.API_MAX_WAIT_SECONDS = "";
    assert.equal(capped.status, 202);
    assert.equal(capped.headers.get("preference-applied"), "wait=1");
    assert.ok(Date.now() - t0 < 5000, "capped at API_MAX_WAIT_SECONDS");
  });

  test("Idempotency-Key: a retried create returns the first job; another body with the same key is refused", async () => {
    const before = jobCount();
    const idem = { "idempotency-key": "retry-test-1" };
    const a = await (await chat(hello(), { headers: idem })).json();
    const retry = await chat(hello(), { headers: idem });
    assert.equal(retry.status, 202);
    assert.equal(retry.headers.get("idempotent-replayed"), "true");
    assert.equal((await retry.json()).id, a.id);
    assert.equal(jobCount(), before + 1, "one job only");
    const reused = await chat(hello({ max_tokens: 32 }), { headers: idem });
    assert.equal(reused.status, 400);
    assert.equal((await errOf(reused)).code, "idempotency_key_reused");
    // Concurrent duplicates (a client timeout and its retry racing): still one job.
    const idem2 = { "idempotency-key": "retry-test-2" };
    const [r1, r2, r3] = await Promise.all([chat(hello(), { headers: idem2 }), chat(hello(), { headers: idem2 }), chat(hello(), { headers: idem2 })]);
    const ids = new Set([(await r1.json()).id, (await r2.json()).id, (await r3.json()).id]);
    assert.equal(ids.size, 1);
    assert.equal(jobCount(), before + 2);
    // The same Idempotency-Key from another API key is another job.
    const other = await h.customer();
    const o = await (await chat(hello(), { headers: idem, key: other.key })).json();
    assert.notEqual(o.id, a.id);
  });

  test("errors keep the OpenAI shape and status table (402, 429)", async () => {
    const poor = await h.customer(1n);
    const broke = await chat(hello(), { key: poor.key });
    assert.equal(broke.status, 402);
    const be = await errOf(broke);
    assert.equal(be.code, "insufficient_balance");
    assert.equal(be.type, "billing_error");
    const capped = await h.customer(10n ** 15n, "1");
    const cap = await chat(hello(), { key: capped.key });
    assert.equal(cap.status, 429);
    assert.equal(cap.headers.get("x-should-retry"), "false");
    const ce = await errOf(cap);
    assert.equal(ce.code, "key_daily_cap_reached");
    assert.equal(ce.type, "rate_limit_error");
  });
});

describe("images", () => {
  test("images.generate: 202, then b64_json of a PNG of the requested size", async () => {
    const res = await images({ model: "sd15", prompt: "a red bicycle", size: "320x256", steps: 10, negative_prompt: "blurry", guidance: 6.5, seed: 42 });
    assert.equal(res.status, 202);
    h.assertPrivate(res, "images create");
    const body = await res.json();
    assert.deepEqual(body.data, []);
    assert.match(body.sparecycle.poll, /^\/v1\/images\/generations\/img-0x[0-9a-f]{64}$/);
    const id = body.sparecycle.id as string;
    assert.equal(await h.run(body.sparecycle.job_id, { shade: 40 }), "agreed");
    const done = await pollImages(id);
    assert.equal(done.status, 200);
    const d = await done.json();
    const png = PNG.sync.read(Buffer.from(d.data[0].b64_json, "base64"));
    assert.equal(png.width, 320);
    assert.equal(png.height, 256);
    assert.equal(d.size, "320x256");
  });

  test('response_format "url" points to the gated /result, readable with the same key only', async () => {
    const body = await (await images({ model: "sd15", prompt: "a lighthouse", size: "256x256", steps: 10, response_format: "url" })).json();
    assert.equal(await h.run(body.sparecycle.job_id, { shade: 10 }), "agreed");
    const d = await (await pollImages(body.sparecycle.id)).json();
    const url = new URL(d.data[0].url);
    assert.equal(url.pathname, `/api/v1/jobs/${body.sparecycle.job_id}/result`);
    const get = (key: string) => h.m.routes.result.GET(h.req(url.pathname, { headers: h.bearer(key) }), h.ctx(body.sparecycle.job_id));
    const ok = await get(c.key);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal((await get((await h.customer()).key)).status, 403);
  });

  test("image limits, unsupported fields and the safety checker", async () => {
    const bad: [unknown, string][] = [
      [{ model: "sd15", prompt: "x", size: "1024x1024" }, "size"],
      [{ model: "sd15", prompt: "x", n: 2 }, "n"],
      [{ model: "sd15", prompt: "x", quality: "hd" }, "quality"],
      [{ model: "sd15", prompt: "x", style: "vivid" }, "style"],
      [{ model: "sd15", prompt: "x", background: "transparent" }, "background"],
      [{ model: "sd15", prompt: "x", steps: 50 }, "steps"],
      [{ model: "sd15", prompt: "x", negative_prompt: "n".repeat(301) }, "negative_prompt"],
      [{ model: "sd15", prompt: "" }, "prompt"],
      [{ model: "sd15", prompt: "x", response_format: "png" }, "response_format"],
    ];
    for (const [body, param] of bad) {
      const res = await images(body);
      assert.equal(res.status, 400, param);
      assert.equal((await errOf(res)).param, param);
    }
    assert.equal((await errOf(await images({ model: "dall-e-3", prompt: "x" }))).code, "model_not_found");
    const body = await (await images({ model: "sd15", prompt: "something", size: "256x256", steps: 10 })).json();
    assert.equal(await h.run(body.sparecycle.job_id, { shade: 0, nsfw: true }), "rejected");
    const res = await pollImages(body.sparecycle.id);
    assert.equal(res.status, 422);
    const e = await errOf(res);
    assert.equal(e.code, "content_rejected");
    assert.equal(e.type, "not_charged");
  });
});

describe("models", () => {
  test("models.list returns exactly qwen2.5-1.5b and sd15", async () => {
    const res = await h.m.routes.models.GET(h.req("/api/v1/models", { headers: h.bearer(c.key) }));
    assert.equal(res.status, 200);
    h.assertPrivate(res, "models");
    const body = await res.json();
    assert.equal(body.object, "list");
    assert.deepEqual(body.data.map((m: { id: string }) => m.id).sort(), ["qwen2.5-1.5b", "sd15"]);
    assert.ok(body.data.every((m: { object: string; created?: number }) => m.object === "model" && !("created" in m)), "no invented dates");
    assert.equal((await h.m.routes.models.GET(h.req("/api/v1/models"))).status, 401);
  });
});
