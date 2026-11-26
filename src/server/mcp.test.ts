// MCP server (brief step 3, acceptance list 3.3) with a scripted JSON-RPC client against the real route handler, on a
// scratch DB with stubbed chain reads. Both protocol eras: modern 2026-07-28 (per-request _meta, no handshake) and
// legacy initialize-based revisions. Run: npm test
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { PNG } from "pngjs";
import { setupAgentApi, SITE } from "./test-support/agent-api";

let h: Awaited<ReturnType<typeof setupAgentApi>>;
let c: Awaited<ReturnType<Awaited<ReturnType<typeof setupAgentApi>>["customer"]>>;
before(async () => {
  h = await setupAgentApi();
  c = await h.customer();
});
after(() => h.cleanup());

const MODERN = "2026-07-28";
let seq = 0;
type Rpc = { status: number; body: Record<string, any> | null; res: Response }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A modern request: _meta in the body, mirrored headers. */
async function modern(method: string, params: Record<string, unknown> = {}, o: { key?: string | null; headers?: Record<string, string>; version?: string } = {}): Promise<Rpc> {
  const version = o.version ?? MODERN;
  const body = {
    jsonrpc: "2.0",
    id: ++seq,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": { name: "sparecycle-test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": version,
    "mcp-method": method,
    ...(method === "tools/call" ? { "mcp-name": String(params.name) } : {}),
    ...(o.key === null ? {} : h.bearer(o.key ?? c.key)),
    ...o.headers,
  };
  const res = await h.m.routes.mcp.POST(h.req("/api/v1/mcp", { method: "POST", headers, body }));
  return { status: res.status, body: await h.json(res), res };
}

/** A legacy request (no _meta); `id: null` sends a notification. */
async function legacy(method: string, params: Record<string, unknown> = {}, o: { key?: string | null; version?: string | null; id?: number | null } = {}): Promise<Rpc> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (o.id !== null) body.id = o.id ?? ++seq;
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    ...(o.version === null ? {} : { "mcp-protocol-version": o.version ?? "2025-11-25" }),
    ...(o.key === null ? {} : h.bearer(o.key ?? c.key)),
  };
  const res = await h.m.routes.mcp.POST(h.req("/api/v1/mcp", { method: "POST", headers, body }));
  return { status: res.status, body: await h.json(res), res };
}

const call = (name: string, args: Record<string, unknown> = {}, key?: string | null) => modern("tools/call", { name, arguments: args }, { key });
const textOf = (r: Rpc) => r.body!.result.content[0].text as string;

describe("protocol", () => {
  test("legacy handshake: initialize negotiates, notifications answer 202, ping, tools/list", async () => {
    const init = await legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }, { version: null });
    assert.equal(init.status, 200);
    h.assertPrivate(init.res, "initialize");
    assert.equal(init.body!.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.body!.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.body!.result.serverInfo.name, "sparecycle");
    assert.equal(init.res.headers.get("mcp-session-id"), null, "stateless: no session");
    const newer = await legacy("initialize", { protocolVersion: "2099-01-01", capabilities: {} }, { version: null });
    assert.equal(newer.body!.result.protocolVersion, "2025-11-25", "unknown version -> the newest legacy one");
    const note = await legacy("notifications/initialized", {}, { id: null });
    assert.equal(note.status, 202);
    assert.equal(note.body, null);
    assert.deepEqual((await legacy("ping")).body!.result, {});
    const list = await legacy("tools/list");
    assert.deepEqual(
      list.body!.result.tools.map((t: { name: string }) => t.name),
      ["submit_job", "get_job_status", "get_job_result", "get_balance"],
    );
    assert.equal((await legacy("tools/list", {}, { version: null })).status, 200, "no header = 2025-03-26");
    assert.equal((await legacy("tools/list", {}, { version: "1999-01-01" })).status, 400);
    assert.equal((await legacy("resources/list")).body!.error.code, -32601);
  });

  test("modern: server/discover, header checks, unsupported version, unknown method", async () => {
    const d = await modern("server/discover");
    assert.equal(d.status, 200);
    assert.equal(d.body!.result.resultType, "complete");
    assert.ok(d.body!.result.supportedVersions.includes(MODERN));
    assert.equal(d.body!.result._meta["io.modelcontextprotocol/serverInfo"].name, "sparecycle");
    const list = await modern("tools/list");
    assert.equal(list.body!.result.resultType, "complete");
    assert.equal(list.body!.result.tools.length, 4);
    for (const t of list.body!.result.tools) {
      assert.equal(t.inputSchema.type, "object", `${t.name}: JSON schema`);
      assert.ok(t.description.length > 20);
    }
    const mismatch = await modern("tools/list", {}, { headers: { "mcp-method": "tools/call" } });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body!.error.code, -32020);
    const noHeader = await modern("tools/list", {}, { headers: { "mcp-protocol-version": "2026-01-01" } });
    assert.equal(noHeader.body!.error.code, -32020);
    const old = await modern("tools/list", {}, { version: "2030-01-01" });
    assert.equal(old.status, 400);
    assert.equal(old.body!.error.code, -32022);
    assert.ok(old.body!.error.data.supported.includes(MODERN));
    const unknown = await modern("prompts/list");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body!.error.code, -32601);
    const badName = await call("withdraw", {});
    assert.equal(badName.body!.error.code, -32602, "no withdraw tool");
    const nameHeader = await modern("tools/call", { name: "get_balance", arguments: {} }, { headers: { "mcp-name": "submit_job" } });
    assert.equal(nameHeader.body!.error.code, -32020);
  });

  test("GET and DELETE answer 405; batches and bad JSON are refused; a foreign Origin gets 403", async () => {
    assert.equal((await h.m.routes.mcp.GET()).status, 405);
    assert.equal((await h.m.routes.mcp.DELETE()).status, 405);
    const post = (body: string, headers: Record<string, string> = {}) =>
      h.m.routes.mcp.POST(h.req("/api/v1/mcp", { method: "POST", body, headers: { ...h.bearer(c.key), "content-type": "application/json", ...headers } }));
    assert.equal((await post("[]")).status, 400);
    assert.equal(((await (await post("{nope")).json()) as { error: { code: number } }).error.code, -32700);
    assert.equal((await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }), { origin: "https://evil.example" })).status, 403);
  });
});

describe("auth", () => {
  test("without a key or with a disabled key every call fails with an auth error", async () => {
    for (const r of [await modern("tools/list", {}, { key: null }), await legacy("initialize", { protocolVersion: "2025-11-25" }, { key: null }), await call("get_balance", {}, null)]) {
      assert.equal(r.status, 401);
      assert.equal(r.res.headers.get("www-authenticate"), 'Bearer realm="sparecycle"');
      assert.equal(r.body!.error.code, h.m.mcp.MCP_AUTH_ERROR);
      h.assertPrivate(r.res, "401");
    }
    const d = await h.customer();
    await h.m.routes.key.PATCH(h.req(`/api/v1/keys/${d.keyId}`, { method: "PATCH", headers: d.session, body: { status: "disabled" } }), h.ctx(d.keyId));
    assert.equal((await call("get_balance", {}, d.key)).status, 401);
    assert.equal((await legacy("notifications/initialized", {}, { id: null, key: d.key })).status, 401);
  });
});

describe("tools", () => {
  test("submit_job -> get_job_status -> get_job_result (text)", async () => {
    const s = await call("submit_job", { kind: "text", model: "qwen2.5-1.5b", prompt: "Name a colour.", max_tokens: 16 });
    assert.equal(s.status, 200);
    const sub = s.body!.result.structuredContent;
    assert.match(sub.job_id, /^0x[0-9a-f]{64}$/);
    assert.equal(sub.status, "queued");
    assert.match(sub.price_wei, /^\d+$/);
    assert.equal(sub.receipt_url, `${SITE}/api/v1/jobs/${sub.job_id}/receipt`);
    assert.deepEqual(JSON.parse(textOf(s)), sub);
    const row = h.m.db.getDb().prepare("SELECT api_key_id, payer FROM jobs WHERE id = ?").get(sub.job_id) as { api_key_id: string; payer: string };
    assert.equal(row.api_key_id, c.keyId);
    assert.equal(row.payer, c.wallet.address);

    const early = await call("get_job_result", { job_id: sub.job_id });
    assert.equal(early.body!.result.isError, undefined);
    assert.equal(JSON.parse(textOf(early)).ready, false);
    assert.equal(await h.run(sub.job_id, { text: "Teal." }), "agreed");
    const st = await call("get_job_status", { job_id: sub.job_id });
    assert.equal(st.body!.result.structuredContent.status, "agreed");
    assert.equal(st.body!.result.structuredContent.charge_status, "pending");
    assert.ok(st.body!.result.structuredContent.settled_at > 0);
    assert.equal(st.body!.result.structuredContent.receipt_url, sub.receipt_url);
    const r = await call("get_job_result", { job_id: sub.job_id });
    // The answer first, then the job's receipt link in its own JSON block.
    assert.deepEqual(r.body!.result.content, [
      { type: "text", text: "Teal." },
      { type: "text", text: JSON.stringify({ sparecycle: { job_id: sub.job_id, status: "agreed", receipt_url: sub.receipt_url } }) },
    ]);
    // The link works with the same key: the provisional receipt of the agreed job.
    const rc = await h.m.routes.receipt.GET(h.req(`/api/v1/jobs/${sub.job_id}/receipt`, { headers: h.bearer(c.key) }), h.ctx(sub.job_id));
    assert.equal(rc.status, 200);
    assert.equal((await rc.json()).state, "provisional");
  });

  test("image results arrive as image content (PNG, base64)", async () => {
    const s = await call("submit_job", { kind: "image", model: "sd15", prompt: "a teapot", size: "256x320", steps: 10 });
    const jobId = s.body!.result.structuredContent.job_id;
    assert.equal(await h.run(jobId, { shade: 90 }), "agreed");
    const r = await call("get_job_result", { job_id: jobId });
    const item = r.body!.result.content[0];
    assert.equal(item.type, "image");
    assert.equal(item.mimeType, "image/png");
    assert.equal(JSON.parse(r.body!.result.content[1].text).sparecycle.receipt_url, `${SITE}/api/v1/jobs/${jobId}/receipt`);
    const png = PNG.sync.read(Buffer.from(item.data, "base64"));
    assert.equal(png.width, 256);
    assert.equal(png.height, 320);
  });

  test("another key's job -> forbidden; bad input -> tool error", async () => {
    const other = await h.customer();
    const s = await call("submit_job", { kind: "text", model: "qwen2.5-1.5b", prompt: "mine" }, other.key);
    const jobId = s.body!.result.structuredContent.job_id;
    for (const tool of ["get_job_status", "get_job_result"]) {
      const r = await call(tool, { job_id: jobId });
      assert.equal(r.body!.result.isError, true, tool);
      assert.equal(JSON.parse(textOf(r)).error.code, "forbidden");
    }
    const bad = await call("submit_job", { kind: "text", model: "sd15", prompt: "x" });
    assert.equal(bad.body!.result.isError, true);
    const mixed = await call("submit_job", { kind: "text", model: "qwen2.5-1.5b", prompt: "x", size: "256x256" });
    assert.equal(JSON.parse(textOf(mixed)).error.param, "size");
    const unknownModel = await call("submit_job", { kind: "image", model: "sdxl", prompt: "x" });
    assert.equal(JSON.parse(textOf(unknownModel)).error.code, "model_not_found");
  });

  test("not-charged outcomes, the daily cap and the kill switch behave as in steps 1 and 2", async () => {
    const s = await call("submit_job", { kind: "text", model: "qwen2.5-1.5b", prompt: "disagree" });
    const jobId = s.body!.result.structuredContent.job_id;
    h.lastRound(jobId); // a final mismatch (an earlier round would go to another pair)
    assert.equal(await h.run(jobId, { text: "a" }, { text: "b" }), "disagreed");
    const r = await call("get_job_result", { job_id: jobId });
    assert.equal(r.body!.result.isError, true);
    const e = JSON.parse(textOf(r)).error;
    assert.equal(e.code, "results_did_not_match");
    assert.equal(e.type, "not_charged");
    assert.equal(e.receipt_url, `${SITE}/api/v1/jobs/${jobId}/receipt`);
    assert.equal(e.charged, false);

    const tight = await h.customer(10n ** 15n, "1");
    const capped = await call("submit_job", { kind: "text", model: "qwen2.5-1.5b", prompt: "x" }, tight.key);
    assert.equal(JSON.parse(textOf(capped)).error.code, "key_daily_cap_reached");

    const k = await h.customer();
    const q = await call("submit_job", { kind: "text", model: "qwen2.5-1.5b", prompt: "queued" }, k.key);
    const qid = q.body!.result.structuredContent.job_id;
    await h.m.routes.disableAll.POST(h.req("/api/v1/keys/disable-all", { method: "POST", headers: k.session }));
    assert.equal((await call("get_job_status", { job_id: qid }, k.key)).status, 401);
    const row = h.m.db.getDb().prepare("SELECT status, note FROM jobs WHERE id = ?").get(qid) as { status: string; note: string };
    assert.equal(row.status, "expired");
    assert.equal(row.note, "cancelled: API key disabled");
  });

  test("get_balance: the wallet's account plus the key's cap and spent today; no tool can withdraw or create keys", async () => {
    const b = await call("get_balance");
    const sc = b.body!.result.structuredContent;
    assert.equal(sc.address, c.wallet.address);
    assert.equal(sc.balance_wei, (10n ** 15n).toString());
    assert.match(sc.available_wei, /^\d+$/);
    assert.equal(sc.spend_limit_per_epoch_wei, "0");
    assert.equal(sc.pending_withdrawal, null);
    assert.equal(sc.key.key_id, c.keyId);
    assert.match(sc.key.spent_today_wei, /^\d+$/);
    assert.equal(sc.key.next_reset_at % 86_400, 0);
    assert.deepEqual([...h.m.mcp.MCP_TOOL_NAMES], ["submit_job", "get_job_status", "get_job_result", "get_balance"]);
    assert.ok(!h.m.mcp.MCP_TOOLS.some((t) => /withdraw|key/i.test(t.name)));
  });
});
