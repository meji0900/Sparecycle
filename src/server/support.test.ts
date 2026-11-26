// Unit tests of the support form endpoint logic on a scratch SQLite DB: off until SUPPORT_WEBHOOK_URL is set, field
// checks, per-IP rate limit, forwarding, nothing stored, nothing echoed. No network. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "sparecycle-support-"));
process.env.DB_PATH = join(dir, "test.db");
delete process.env.SUPPORT_WEBHOOK_URL;

const { getDb } = await import("./db");
const { ApiError } = await import("./http");
const { SUPPORT_LIMITS, parseSupportRequest, submitSupport, supportEnabled, supportWebhookPayload } = await import("./support");

after(() => {
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

const MESSAGE = "My paid job has been queued for a while, is that expected? <!channel> @everyone";
const valid = { topic: "billing", wallet: "0x310e38f441296070a73549176df3ed1c3d80e22e", jobId: "", message: MESSAGE };

type Call = { url: string; body: string };
function fakeFetch(status = 204) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(null, { status });
  }) as typeof fetch;
  return { fn, calls };
}

async function rejects(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ApiError, `expected ApiError, got ${String(e)}`);
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    assert.ok(!e.message.includes("queued for a while"), "an error must never repeat the message");
    return true;
  });
}

let ip = 0;
const nextIp = () => `203.0.113.${++ip}`;

describe("support form", () => {
  beforeEach(() => {
    delete process.env.SUPPORT_WEBHOOK_URL;
  });

  test("off (503 support-off) until SUPPORT_WEBHOOK_URL is an https URL, and nothing is sent", async () => {
    const { fn, calls } = fakeFetch();
    assert.equal(supportEnabled(), false);
    await rejects(submitSupport(valid, nextIp(), fn), 503, "support-off");
    process.env.SUPPORT_WEBHOOK_URL = "http://hooks.example.invalid/plain-http";
    assert.equal(supportEnabled(), false);
    await rejects(submitSupport(valid, nextIp(), fn), 503, "support-off");
    assert.equal(calls.length, 0);
  });

  test("forwards a valid message and answers { ok: true } only", async () => {
    process.env.SUPPORT_WEBHOOK_URL = "https://hooks.example.invalid/support";
    const { fn, calls } = fakeFetch();
    const res = await submitSupport(valid, nextIp(), fn);
    assert.deepEqual(res, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://hooks.example.invalid/support");
    const sent = JSON.parse(calls[0].body) as { content: string; text: string; allowed_mentions: { parse: string[] } };
    assert.match(sent.content, /queued for a while/);
    assert.match(sent.content, /Wallet: 0x310e38F441296070a73549176Df3ED1c3d80E22E/);
    assert.match(sent.content, /Job: not given/);
    assert.deepEqual(sent.allowed_mentions.parse, [], "Discord mentions are switched off");
    assert.ok(!sent.text.includes("<!channel>"), "Slack mentions are escaped");
  });

  test("stores nothing: the message is in no table after a successful forward", async () => {
    process.env.SUPPORT_WEBHOOK_URL = "https://hooks.example.invalid/support";
    await submitSupport({ ...valid, message: "unique-marker-7f3c please check my node" }, nextIp(), fakeFetch().fn);
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all();
      assert.ok(!JSON.stringify(rows).includes("unique-marker-7f3c"), `table ${name} holds the message`);
      assert.ok(!JSON.stringify(rows).includes("203.0.113."), `table ${name} holds a raw IP address`);
    }
  });

  test("checks each field and names it, without repeating the input", async () => {
    process.env.SUPPORT_WEBHOOK_URL = "https://hooks.example.invalid/support";
    const { fn, calls } = fakeFetch();
    const cases: [Record<string, unknown>, string][] = [
      [{ ...valid, topic: "not-a-topic" }, "topic"],
      [{ ...valid, wallet: "not-a-wallet" }, "wallet"],
      [{ ...valid, jobId: "0x1234" }, "jobId"],
      [{ ...valid, message: "short" }, "message"],
      [{ ...valid, message: "x".repeat(SUPPORT_LIMITS.message.max + 1) }, "message"],
      [{ ...valid, message: "bell \u0007 character in the text" }, "message"],
    ];
    for (const [body, field] of cases) {
      await assert.rejects(submitSupport(body, nextIp(), fn), (e: unknown) => {
        assert.ok(e instanceof ApiError);
        assert.equal(e.status, 400);
        assert.equal(e.extra?.field, field);
        return true;
      });
    }
    assert.equal(calls.length, 0);
  });

  test("rate limited per IP address (429 after the hourly limit), other addresses unaffected", async () => {
    process.env.SUPPORT_WEBHOOK_URL = "https://hooks.example.invalid/support";
    const { fn } = fakeFetch();
    const one = nextIp();
    for (let i = 0; i < SUPPORT_LIMITS.perHour; i++) await submitSupport(valid, one, fn);
    await rejects(submitSupport(valid, one, fn), 429, "rate-limited");
    assert.deepEqual(await submitSupport(valid, nextIp(), fn), { ok: true });
  });

  test("a webhook that refuses or is unreachable gives 502 and nothing is kept", async () => {
    process.env.SUPPORT_WEBHOOK_URL = "https://hooks.example.invalid/support";
    await rejects(submitSupport(valid, nextIp(), fakeFetch(500).fn), 502, "support-unavailable");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await rejects(submitSupport(valid, nextIp(), down), 502, "support-unavailable");
  });

  test("the hidden trap field drops the message quietly", async () => {
    process.env.SUPPORT_WEBHOOK_URL = "https://hooks.example.invalid/support";
    const { fn, calls } = fakeFetch();
    assert.deepEqual(await submitSupport({ ...valid, website: "https://spam.example" }, nextIp(), fn), { ok: true });
    assert.equal(calls.length, 0);
  });

  test("payload and parsing helpers", () => {
    const r = parseSupportRequest({ topic: "node", message: "  my node never shows online  ", jobId: "0x" + "AB".repeat(32) });
    assert.equal(r.message, "my node never shows online");
    assert.equal(r.jobId, "0x" + "ab".repeat(32));
    assert.equal(r.wallet, null);
    const p = supportWebhookPayload(r);
    assert.match(p.content, /^Sparecycle support: Running a node/);
  });
});
