// API keys per wallet (brief step 1, acceptance list 1.6) on a scratch DB with stubbed chain reads. Run: npm test
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setupAgentApi, sha256, newAccount } from "./test-support/agent-api";

let h: Awaited<ReturnType<typeof setupAgentApi>>;
before(async () => {
  h = await setupAgentApi();
});
after(() => h.cleanup());

const textJob = (prompt = "hello there", maxTokens = 16) => ({ kind: "text", params: { model: "qwen2.5-1.5b", prompt, maxTokens } });
const submit = (key: string | null, body: unknown = textJob()) =>
  h.m.routes.jobs.POST(h.req("/api/v1/jobs", { method: "POST", headers: key ? h.bearer(key) : {}, body }));
const jobRow = (id: string) =>
  h.m.db.getDb().prepare("SELECT payer, api_key_id, api_key_held, payment_sig, read_secret_hash, status, note, charge_status, price_wei FROM jobs WHERE id = ?").get(id) as Record<string, unknown>;
const priceOf = (body: unknown = textJob()) => (BigInt(h.m.proto.workUnits(h.m.proto.parseJobRequest(body))) * 1000n).toString();

describe("key management needs a wallet session", () => {
  test("every keys route answers 401 private, no-store without a session", async () => {
    const id = "0123456789abcdef";
    const calls: [string, Response][] = [
      ["GET /keys", await h.m.routes.keys.GET(h.req("/api/v1/keys"))],
      ["POST /keys", await h.m.routes.keys.POST(h.req("/api/v1/keys", { method: "POST", body: { dailyCapWei: "1" } }))],
      ["PATCH /keys/:id", await h.m.routes.key.PATCH(h.req(`/api/v1/keys/${id}`, { method: "PATCH", body: { label: "x" } }), h.ctx(id))],
      ["DELETE /keys/:id", await h.m.routes.key.DELETE(h.req(`/api/v1/keys/${id}`, { method: "DELETE" }), h.ctx(id))],
      ["POST activate", await h.m.routes.activate.POST(h.req(`/api/v1/keys/${id}/activate`, { method: "POST", body: { signature: "0x00" } }), h.ctx(id))],
      ["POST disable-all", await h.m.routes.disableAll.POST(h.req("/api/v1/keys/disable-all", { method: "POST" }))],
    ];
    for (const [label, res] of calls) {
      assert.equal(res.status, 401, label);
      h.assertPrivate(res, label);
    }
  });

  test("an API key is not a session: it cannot list or create keys", async () => {
    const c = await h.customer();
    const res = await h.m.routes.keys.GET(h.req("/api/v1/keys", { headers: h.bearer(c.key) }));
    assert.equal(res.status, 401);
  });
});

describe("create, sign, activate", () => {
  test("pending until a valid link signature; the secret is shown once; the DB holds only sha256", async () => {
    const wallet = newAccount();
    h.chain.balance.set(wallet.address.toLowerCase(), 10n ** 15n);
    const session = await h.signIn(wallet);
    const c = await h.m.routes.keys.POST(h.req("/api/v1/keys", { method: "POST", headers: session, body: { label: "bot", dailyCapWei: "5000000" } }));
    assert.equal(c.status, 201);
    h.assertPrivate(c, "create");
    const pending = await c.json();
    assert.equal(pending.status, "pending");
    assert.match(pending.keyId, /^[0-9a-f]{16}$/);
    assert.match(pending.fingerprint, /^[0-9a-f]{16}$/);
    assert.ok(!("key" in pending), "no secret before the signature");
    assert.equal(
      pending.linkMessage,
      [
        "Sparecycle: allow one API key to pay for jobs from my balance",
        `Chain: ${h.m.chain.targetChain.id}`,
        `Payments contract: ${h.payments.toLowerCase()}`,
        `Key: sck_${pending.keyId}`,
        `Key fingerprint: ${pending.fingerprint}`,
        "Daily cap: 5000000 wei per UTC day",
        `Issued: ${pending.issued}`,
        "This key cannot withdraw. Revoke it at any time.",
      ].join("\n"),
    );

    // A signature from another wallet: refused, the key stays pending.
    const wrong = await newAccount().signMessage({ message: pending.linkMessage });
    const bad = await h.m.routes.activate.POST(h.req(`/api/v1/keys/${pending.keyId}/activate`, { method: "POST", headers: session, body: { signature: wrong } }), h.ctx(pending.keyId));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "bad-link-signature");
    assert.equal(h.m.db.getDb().prepare("SELECT status FROM api_keys WHERE key_id = ?").get(pending.keyId)!.status, "pending");
    // A pending key pays for nothing.
    assert.equal((await submit(`sck_${pending.keyId}_${"A".repeat(43)}`)).status, 401);

    const signature = await wallet.signMessage({ message: pending.linkMessage });
    const a = await h.m.routes.activate.POST(h.req(`/api/v1/keys/${pending.keyId}/activate`, { method: "POST", headers: session, body: { signature } }), h.ctx(pending.keyId));
    assert.equal(a.status, 200);
    h.assertPrivate(a, "activate");
    const active = await a.json();
    assert.equal(active.status, "active");
    assert.match(active.key, /^sck_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    assert.ok(active.key.startsWith(`sck_${pending.keyId}_`));
    assert.equal(sha256(active.key).slice(0, 16), pending.fingerprint, "the fingerprint binds the signature to this key");

    // Shown once: a second activation is refused and the list never carries it.
    const again = await h.m.routes.activate.POST(h.req(`/api/v1/keys/${pending.keyId}/activate`, { method: "POST", headers: session, body: { signature } }), h.ctx(pending.keyId));
    assert.equal(again.status, 409);
    assert.ok(!JSON.stringify(await again.json()).includes(active.key));
    const list = await (await h.m.routes.keys.GET(h.req("/api/v1/keys", { headers: session }))).json();
    assert.equal(list.keys.length, 1);
    assert.ok(!JSON.stringify(list).includes(active.key.slice(21)));

    // Storage: only sha256(full key); the secret appears in no column of any row.
    const row = h.m.db.getDb().prepare("SELECT * FROM api_keys WHERE key_id = ?").get(pending.keyId) as Record<string, unknown>;
    assert.equal(row.key_hash, sha256(active.key));
    assert.ok(!JSON.stringify(row).includes(active.key.slice(21)), "secret not stored");
    assert.equal(row.link_signature, signature.toLowerCase());
  });

  test("ERC-1271 smart wallet: sign-in and link signature checked through the chain", async () => {
    const owner = newAccount();
    const smart = newAccount().address; // a contract wallet address; its isValidSignature accepts `owner` (stubbed)
    h.chain.smartWallets.set(smart.toLowerCase(), owner);
    h.chain.balance.set(smart.toLowerCase(), 10n ** 15n);
    const session = await h.signIn({ address: smart }, owner);
    const k = await h.makeKey(session, owner);
    assert.equal(k.active.status, "active");
    const res = await submit(k.key);
    assert.equal(res.status, 201);
    const job = await res.json();
    assert.equal(jobRow(job.id).payer, smart);
  });

  test("a wallet can hold at most MAX_KEYS (10) active or pending keys", async () => {
    const wallet = newAccount();
    const session = await h.signIn(wallet);
    for (let i = 0; i < h.m.libKeys.MAX_KEYS; i++) await h.makeKey(session, wallet, "1000", `k${i}`);
    const res = await h.m.routes.keys.POST(h.req("/api/v1/keys", { method: "POST", headers: session, body: { dailyCapWei: "1000" } }));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, "max-keys");
    // Disabling one frees a slot; re-enabling it while full is refused.
    const list = await (await h.m.routes.keys.GET(h.req("/api/v1/keys", { headers: session }))).json();
    const first = list.keys[0].keyId;
    const off = await h.m.routes.key.PATCH(h.req(`/api/v1/keys/${first}`, { method: "PATCH", headers: session, body: { status: "disabled" } }), h.ctx(first));
    assert.equal(off.status, 200);
    await h.makeKey(session, wallet, "1000", "k10");
    const on = await h.m.routes.key.PATCH(h.req(`/api/v1/keys/${first}`, { method: "PATCH", headers: session, body: { status: "active" } }), h.ctx(first));
    assert.equal(on.status, 409);
  });

  test("another wallet's key is invisible (404)", async () => {
    const a = await h.customer();
    const other = await h.signIn(newAccount());
    const res = await h.m.routes.key.PATCH(h.req(`/api/v1/keys/${a.keyId}`, { method: "PATCH", headers: other, body: { status: "disabled" } }), h.ctx(a.keyId));
    assert.equal(res.status, 404);
  });
});

describe("paying with a key", () => {
  test("POST /api/v1/jobs with Bearer sck_ and no payment block queues a paid job", async () => {
    const c = await h.customer();
    const res = await submit(c.key);
    assert.equal(res.status, 201);
    h.assertPrivate(res, "submit");
    const body = await res.json();
    assert.equal(body.priceWei, priceOf());
    assert.ok(!("readSecret" in body), "key jobs get no read secret (A4)");
    const row = jobRow(body.id);
    assert.equal(row.payer, c.wallet.address);
    assert.equal(row.api_key_id, c.keyId);
    assert.equal(row.payment_sig, null);
    assert.equal(row.read_secret_hash, null);
    assert.equal(row.charge_status, "pending");
    const list = await (await h.m.routes.keys.GET(h.req("/api/v1/keys", { headers: c.session }))).json();
    assert.equal(list.keys[0].spentTodayWei, priceOf());
    assert.equal(list.keys[0].day, new Date().toISOString().slice(0, 10));
    assert.equal(list.nextResetAt % 86_400, 0, "resets at 00:00 UTC");
  });

  test("a payment block together with a key is refused", async () => {
    const c = await h.customer();
    const res = await submit(c.key, { request: textJob(), payment: {} });
    assert.equal(res.status, 400);
  });

  test("over the UTC-day cap -> 429 key-daily-cap; low balance -> 402; disabled key -> 401 at once", async () => {
    const price = BigInt(priceOf());
    const c = await h.customer(10n ** 15n, (price * 2n).toString());
    assert.equal((await submit(c.key)).status, 201);
    assert.equal((await submit(c.key)).status, 201);
    const capped = await submit(c.key);
    assert.equal(capped.status, 429);
    const cb = await capped.json();
    assert.equal(cb.error, "key-daily-cap");
    assert.equal(cb.spentTodayWei, (price * 2n).toString());

    const poor = await h.customer(price - 1n);
    const broke = await submit(poor.key);
    assert.equal(broke.status, 402);
    assert.equal((await broke.json()).error, "insufficient-balance");

    const d = await h.customer();
    const off = await h.m.routes.key.PATCH(h.req(`/api/v1/keys/${d.keyId}`, { method: "PATCH", headers: d.session, body: { status: "disabled" } }), h.ctx(d.keyId));
    assert.equal(off.status, 200);
    const refused = await submit(d.key);
    assert.equal(refused.status, 401);
    assert.equal((await refused.json()).error, "invalid-api-key");
    // A forged secret for a real key id is refused too.
    assert.equal((await submit(`sck_${c.keyId}_${"B".repeat(43)}`)).status, 401);
  });

  test("the held balance counts key jobs: two keys of one wallet cannot overspend it", async () => {
    const price = BigInt(priceOf());
    const c = await h.customer(price * 2n);
    const second = await h.makeKey(c.session, c.wallet);
    assert.equal((await submit(c.key)).status, 201);
    assert.equal((await submit(second.key)).status, 201);
    assert.equal((await submit(second.key)).status, 402);
  });

  test("disagreed / expired / rejected jobs give their price back to the daily counter and are never charged", async () => {
    const price = BigInt(priceOf());
    const c = await h.customer(10n ** 15n, price.toString());
    const j1 = await (await submit(c.key)).json();
    assert.equal((await submit(c.key)).status, 429, "cap used by the first job");
    assert.equal(await h.run(j1.id, { text: "one" }, { text: "two" }), "disagreed");
    const j2 = await (await submit(c.key)).json();
    assert.ok(j2.id, "the disagreed job's price came back");
    // expired: past the TTL
    h.m.db.getDb().prepare("UPDATE jobs SET created_at = created_at - ? WHERE id = ?").run(7 * 3600, j2.id);
    h.m.jobs.expireStaleJobs();
    assert.equal(jobRow(j2.id).status, "expired");
    assert.equal(jobRow(j2.id).api_key_held, 0, "the expired job's price left the counter of its own UTC day");
    const img = { kind: "image", params: { model: "sd15", prompt: "a lighthouse", width: 256, height: 256, steps: 10 } };
    const capImg = await h.customer(10n ** 15n, priceOf(img));
    const j3 = await (await submit(capImg.key, img)).json();
    assert.equal(await h.run(j3.id, { shade: 0, nsfw: true }, { shade: 0 }), "rejected");
    const list = await (await h.m.routes.keys.GET(h.req("/api/v1/keys", { headers: capImg.session }))).json();
    assert.equal(list.keys[0].spentTodayWei, "0");
    assert.equal((await submit(capImg.key, img)).status, 201);
    const held = await h.m.payments.readAccount(c.wallet.address);
    assert.equal(held.held, 0n, "nothing held for settled-without-agreement jobs");
  });

  test("the kill switch moves queued key jobs to expired (cancelled) and they are never charged; apiKeyId in the charge list", async () => {
    const c = await h.customer();
    const keep = await h.makeKey(c.session, c.wallet);
    const queued = await (await submit(c.key)).json();
    const agreed = await (await submit(keep.key)).json();
    assert.equal(await h.run(agreed.id, { text: "same" }), "agreed");
    const off = await h.m.routes.key.PATCH(h.req(`/api/v1/keys/${c.keyId}`, { method: "PATCH", headers: c.session, body: { status: "disabled" } }), h.ctx(c.keyId));
    const offBody = await off.json();
    assert.equal(offBody.cancelledJobs, 1);
    const row = jobRow(queued.id);
    assert.equal(row.status, "expired");
    assert.equal(row.note, "cancelled: API key disabled");
    assert.equal((await h.m.payments.readAccount(c.wallet.address)).held, BigInt(priceOf()), "only the agreed job stays held");

    // Charge: the cancelled job is released, the agreed one is listed with its apiKeyId. (The charge transaction itself
    // fails here: there is no chain; the list is stored before sending.)
    process.env.SCHEDULER_SIGNER_KEY = `0x${"11".repeat(32)}`;
    const epoch = h.m.db.getDb().prepare("SELECT MAX(id) AS id FROM epochs").get() as { id: number };
    await h.m.payments.chargeOpenEpoch(epoch.id);
    delete process.env.SCHEDULER_SIGNER_KEY;
    assert.equal(jobRow(queued.id).charge_status, "released");
    const charge = h.m.db.getDb().prepare("SELECT list_json FROM charges WHERE epoch_id = ?").get(epoch.id) as { list_json: string };
    const list = JSON.parse(charge.list_json) as { jobId: string; apiKeyId: string | null }[];
    assert.ok(list.every((e) => "apiKeyId" in e), "every entry carries apiKeyId");
    assert.equal(list.find((e) => e.jobId === agreed.id)?.apiKeyId, keep.keyId);
    assert.ok(!list.some((e) => e.jobId === queued.id), "the cancelled job is never charged");
  });

  test("delete and disable-all stop keys at once", async () => {
    const c = await h.customer();
    const second = await h.makeKey(c.session, c.wallet);
    const del = await h.m.routes.key.DELETE(h.req(`/api/v1/keys/${c.keyId}`, { method: "DELETE", headers: c.session }), h.ctx(c.keyId));
    assert.equal(del.status, 200);
    assert.equal((await submit(c.key)).status, 401);
    const list = await (await h.m.routes.keys.GET(h.req("/api/v1/keys", { headers: c.session }))).json();
    assert.ok(!list.keys.some((k: { keyId: string }) => k.keyId === c.keyId), "deleted keys leave the list");
    const all = await h.m.routes.disableAll.POST(h.req("/api/v1/keys/disable-all", { method: "POST", headers: c.session }));
    assert.equal((await all.json()).disabled, 1);
    assert.equal((await submit(second.key)).status, 401);
  });

  test("lowering the cap needs only the session; raising it needs a new link signature (A3)", async () => {
    const c = await h.customer(10n ** 15n, "1000000");
    const patch = (body: unknown) => h.m.routes.key.PATCH(h.req(`/api/v1/keys/${c.keyId}`, { method: "PATCH", headers: c.session, body }), h.ctx(c.keyId));
    const lower = await patch({ dailyCapWei: "500000", label: "lower" });
    assert.equal(lower.status, 200);
    assert.equal((await lower.json()).dailyCapWei, "500000");
    const ask = await patch({ dailyCapWei: "2000000" });
    assert.equal(ask.status, 409);
    const need = await ask.json();
    assert.equal(need.error, "link-signature-required");
    assert.match(need.linkMessage, /Daily cap: 2000000 wei per UTC day/);
    const forged = await newAccount().signMessage({ message: need.linkMessage });
    assert.equal((await patch({ dailyCapWei: "2000000", issued: need.issued, signature: forged })).status, 400);
    const signature = await c.wallet.signMessage({ message: need.linkMessage });
    const raised = await patch({ dailyCapWei: "2000000", issued: need.issued, signature });
    assert.equal(raised.status, 200);
    assert.equal((await raised.json()).dailyCapWei, "2000000");
    // The same signature can't be replayed for a later raise.
    await patch({ dailyCapWei: "1000" });
    assert.equal((await patch({ dailyCapWei: "2000000", issued: need.issued, signature })).status, 400);
  });
});

describe("reading results with a key", () => {
  test("a key reads its own jobs on /result; 403 for other jobs of the same wallet; read secrets still work", async () => {
    const c = await h.customer();
    const other = await h.makeKey(c.session, c.wallet);
    const mine = await (await submit(c.key)).json();
    assert.equal(await h.run(mine.id, { text: "agreed text" }), "agreed");
    const theirs = await (await submit(other.key)).json();
    assert.equal(await h.run(theirs.id, { text: "other text" }), "agreed");
    const get = (id: string, headers: Record<string, string>) => h.m.routes.result.GET(h.req(`/api/v1/jobs/${id}/result`, { headers }), h.ctx(id));

    const ok = await get(mine.id, h.bearer(c.key));
    assert.equal(ok.status, 200);
    h.assertPrivate(ok, "result");
    assert.equal(await ok.text(), "agreed text");
    assert.equal((await get(theirs.id, h.bearer(c.key))).status, 403, "another key of the same wallet");
    // The wallet session reads every job of the wallet.
    assert.equal((await get(theirs.id, c.session)).status, 200);
    // A disabled key reads nothing (no credentials -> 401).
    await h.m.routes.key.PATCH(h.req(`/api/v1/keys/${c.keyId}`, { method: "PATCH", headers: c.session, body: { status: "disabled" } }), h.ctx(c.keyId));
    assert.equal((await get(mine.id, h.bearer(c.key))).status, 401);

    // No regression: a free job's per-job read secret still works on /result.
    const free = await (await submit(null)).json();
    assert.match(free.readSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await h.run(free.id, { text: "free text" }), "agreed");
    const viaSecret = await get(free.id, h.bearer(free.readSecret));
    assert.equal(viaSecret.status, 200);
    assert.equal(await viaSecret.text(), "free text");
    assert.equal((await get(free.id, h.bearer(other.key))).status, 403, "a key can't read a free job");
  });
});

describe("what a key can never do", () => {
  test("no API route or server module can withdraw for a payer", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !p.includes("test-support")) files.push(p);
      }
    };
    walk(join(process.cwd(), "src", "app", "api"));
    walk(join(process.cwd(), "src", "server"));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      assert.ok(!/functionName:\s*"(requestWithdraw|withdraw|cancelWithdraw)"/.test(src), `${f} calls a withdraw function`);
    }
    assert.ok(!h.m.mcp.MCP_TOOL_NAMES.some((n) => /withdraw|key/i.test(n)), "no withdraw or key tool");
  });

  test("the UI banner shows while the on-chain spend limit is 0", () => {
    assert.equal(h.m.libKeys.spendLimitWarning("0"), true);
    assert.equal(h.m.libKeys.spendLimitWarning("1000"), false);
    assert.equal(h.m.libKeys.spendLimitWarning(null), false);
  });

  test("no log line ever carried a key or its secret", () => {
    const secrets = h.m.db.getDb().prepare("SELECT key_id FROM api_keys").all() as { key_id: string }[];
    assert.ok(secrets.length > 0);
    assert.ok(!h.logs.some((l) => /sck_[0-9a-f]{16}_/.test(l)), "no full key in the logs");
  });
});
