// x402 pay-per-job (src/server/x402.ts) through the real OpenAI-compatible route handlers, on a scratch DB, with an
// in-memory escrow chain that behaves like contracts/src/SparecycleX402Escrow.sol and the real LocalFacilitator (the
// scheduler as its own facilitator), plus swapped-in third-party facilitators. INTERNAL REVIEW ONLY build. Run: npm test
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { domainSeparator, toEventSelector, toFunctionSelector, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { newAccount, setupAgentApi } from "./test-support/agent-api";

let h: Awaited<ReturnType<typeof setupAgentApi>>;
let x: typeof import("./x402");
let lib: typeof import("@/lib/x402");
let merkle: typeof import("@/lib/merkle");
let abi: typeof import("@/contracts/x402Escrow");
let limits: typeof import("./limits");

const ESCROW = newAccount().address;
const ASSET = newAccount().address;
const PRICE_PER_UNIT = 3n;
const SIGNER_KEY = generatePrivateKey();

/** In-memory SparecycleX402Escrow + EIP-3009 asset. */
class FakeChain {
  balances = new Map<string, bigint>();
  used = new Set<string>();
  escrows = new Map<string, { payer: Address; amount: bigint; deadline: number; state: "held" | "forwarded" | "refunded" }>();
  calls = { fund: 0, forward: 0, refund: 0 };
  txSeq = 0;
  failFund: null | "revert" | "pending" = null;
  failSettle = false;
  onFund: (() => void) | null = null;
  now = () => Math.floor(Date.now() / 1000);
  tx = (): Hex => `0x${(++this.txSeq).toString(16).padStart(64, "0")}`;
  async fund(a: import("./x402").FundArgs, onSent: (tx: Hex) => void) {
    this.calls.fund++;
    if (this.failFund === "revert") throw new x.X402Reverted("reverted: AmountMismatch");
    const hash = this.tx();
    onSent(hash);
    if (this.failFund === "pending") throw new Error("timed out waiting for the receipt");
    const key = `${a.payer.toLowerCase()}|${a.nonce.toLowerCase()}`;
    if (this.used.has(key) || this.escrows.has(a.escrowId)) throw new x.X402Reverted("reverted");
    const bal = this.balances.get(a.payer.toLowerCase()) ?? 0n;
    if (bal < a.amount) throw new x.X402Reverted("reverted");
    this.used.add(key);
    this.balances.set(a.payer.toLowerCase(), bal - a.amount);
    const deadline = this.now() + 43_200;
    this.escrows.set(a.escrowId, { payer: a.payer, amount: a.amount, deadline, state: "held" });
    this.onFund?.();
    return { tx: hash, deadline };
  }
  private settle(id: Hex, to: "forwarded" | "refunded", onSent: (tx: Hex) => void) {
    this.calls[to === "forwarded" ? "forward" : "refund"]++;
    const e = this.escrows.get(id);
    if (this.failSettle || !e || e.state !== "held") throw new x.X402Reverted("reverted: NotHeld");
    const hash = this.tx();
    onSent(hash);
    e.state = to;
    if (to === "refunded") this.balances.set(e.payer.toLowerCase(), (this.balances.get(e.payer.toLowerCase()) ?? 0n) + e.amount);
    return Promise.resolve(hash);
  }
  forward = (id: Hex, onSent: (tx: Hex) => void) => this.settle(id, "forwarded", onSent);
  refund = (id: Hex, onSent: (tx: Hex) => void) => this.settle(id, "refunded", onSent);
  async escrowState(id: Hex) {
    const e = this.escrows.get(id);
    return e ? { state: e.state, deadline: e.deadline, amount: e.amount, payer: e.payer } : { state: "none" as const, deadline: 0, amount: 0n, payer: ESCROW };
  }
  async authorizationUsed(payer: Address, nonce: Hex) {
    return this.used.has(`${payer.toLowerCase()}|${nonce.toLowerCase()}`);
  }
  async balanceOf(payer: Address) {
    return this.balances.get(payer.toLowerCase()) ?? 0n;
  }
  /** What the preflight reads; tests change fields to break it. */
  infoOverride: Partial<import("./x402").EscrowInfo> = {};
  async info(): Promise<import("./x402").EscrowInfo> {
    return {
      asset: ASSET,
      rewards: ESCROW,
      rewardsScheduler: privateKeyToAccount(SIGNER_KEY).address,
      settleWindow: 43_200,
      maxPerJob: 10n ** 12n,
      fundingPaused: false,
      assetDomainSeparator: domainSeparator({ domain: { name: "Global Dollar", version: "1", chainId: h.m.chain.targetChain.id, verifyingContract: ASSET } }),
      ...this.infoOverride,
    };
  }
}
let chain: FakeChain;

before(async () => {
  h = await setupAgentApi();
  Object.assign(process.env, {
    X402_ENABLED: "1",
    X402_ESCROW_ADDRESS: ESCROW,
    X402_ASSET_ADDRESS: ASSET,
    X402_ASSET_NAME: "Global Dollar",
    X402_ASSET_VERSION: "1",
    X402_PRICE_PER_UNIT: PRICE_PER_UNIT.toString(),
    SCHEDULER_SIGNER_KEY: SIGNER_KEY,
  });
  x = await import("./x402");
  lib = await import("@/lib/x402");
  merkle = await import("@/lib/merkle");
  abi = await import("@/contracts/x402Escrow");
  limits = await import("./limits");
  chain = new FakeChain();
  x.setX402TestSeams({ chain, facilitator: null });
});
after(() => {
  x.setX402TestSeams({ chain: null, facilitator: null });
  for (const k of Object.keys(process.env)) if (k.startsWith("X402_")) delete process.env[k];
  h.cleanup();
});

const hello = (content = "Say hi") => ({ model: "qwen2.5-1.5b", messages: [{ role: "user", content }], max_tokens: 16 });
const chat = (body: unknown, headers: Record<string, string> = {}) =>
  h.m.routes.chat.POST(h.req("/api/v1/chat/completions", { method: "POST", body, headers }));
const images = (body: unknown, headers: Record<string, string> = {}) =>
  h.m.routes.images.POST(h.req("/api/v1/images/generations", { method: "POST", body, headers }));
const pollChat = (id: string, secret: string) => h.m.routes.chatPoll.GET(h.req(`/api/v1/chat/completions/${id}`, { headers: h.bearer(secret) }), h.ctx(id));
const decode = <T>(res: Response, name: string) => lib.decodeX402Header<T>(res.headers.get(name) ?? "");
const jobCount = () => (h.m.db.getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
const escrowRow = (jobId: string) => h.m.db.getDb().prepare("SELECT * FROM x402_escrows WHERE job_id = ?").get(jobId) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let nonceSeq = 0;

/** A funded payer. */
function payer(balance = 10n ** 9n) {
  const a = newAccount();
  chain.balances.set(a.address.toLowerCase(), balance);
  return a;
}

/** Signs an EIP-3009 authorization for `req` (overrides change what is signed or sent). */
async function sign(
  who: LocalAccount,
  req: import("@/lib/x402").PaymentRequirements,
  o: { value?: string; to?: Address; validBefore?: number; validAfter?: number; from?: Address; nonce?: Hex; accepted?: Partial<import("@/lib/x402").PaymentRequirements> } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: o.from ?? who.address,
    to: o.to ?? req.payTo,
    value: o.value ?? req.amount,
    validAfter: String(o.validAfter ?? 0),
    validBefore: String(o.validBefore ?? now + req.maxTimeoutSeconds),
    nonce: o.nonce ?? (`0x${(++nonceSeq).toString(16).padStart(64, "0")}` as Hex),
  };
  const signature = await who.signTypedData({
    domain: lib.assetDomain(req, h.m.chain.targetChain.id),
    types: lib.TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: lib.authorizationMessage(authorization),
  });
  const payload: import("@/lib/x402").PaymentPayload = { x402Version: 2, accepted: { ...req, ...o.accepted }, payload: { signature, authorization } };
  return { payload, header: lib.encodeX402Header(payload) };
}

/** The 402 for `body`, then a signed retry. */
async function payChat(who: LocalAccount, body: unknown = hello(), o: Parameters<typeof sign>[2] = {}) {
  const first = await chat(body);
  assert.equal(first.status, 402);
  const pr = decode<import("@/lib/x402").PaymentRequired>(first, "payment-required");
  const s = await sign(who, pr.accepts[0], o);
  const res = await chat(body, { "payment-signature": s.header });
  return { res, pr, ...s };
}

describe("off by default: the API answers as before", () => {
  test("X402_ENABLED unset (or incomplete) -> 401 invalid_api_key, no PAYMENT-REQUIRED", async () => {
    for (const [k, v] of [["X402_ENABLED", "0"], ["X402_PRICE_PER_UNIT", ""]] as const) {
      const keep = process.env[k];
      process.env[k] = v;
      try {
        const res = await chat(hello());
        assert.equal(res.status, 401);
        assert.equal(res.headers.get("payment-required"), null);
        assert.equal((await res.json()).error.code, "invalid_api_key");
        assert.equal(x.x402Config(), null);
      } finally {
        process.env[k] = keep;
      }
    }
  });

  test("with x402 on, an API key still pays from the balance; 402 insufficient_balance is unchanged and has no x402 header", async () => {
    const c = await h.customer(1n); // a key whose wallet cannot pay
    const res = await chat(hello(), h.bearer(c.key));
    assert.equal(res.status, 402);
    assert.equal(res.headers.get("payment-required"), null);
    const body = await res.json();
    assert.equal(body.error.code, "insufficient_balance");
    assert.equal(body.error.type, "billing_error");
    assert.ok(!("x402" in body));
    const rich = await h.customer();
    const ok = await chat(hello(), h.bearer(rich.key));
    assert.equal(ok.status, 202);
    assert.equal(ok.headers.get("payment-response"), null);
  });

  test("any Authorization header keeps the key path (an unknown bearer is 401, never a 402)", async () => {
    const res = await chat(hello(), { authorization: "Bearer not-a-key" });
    assert.equal(res.status, 401);
  });
});

describe("402 Payment Required", () => {
  test("a create without an API key answers the x402 v2 requirements for this request's price", async () => {
    const res = await chat(hello());
    assert.equal(res.status, 402);
    h.assertPrivate(res, "402");
    const pr = decode<import("@/lib/x402").PaymentRequired>(res, "payment-required");
    assert.equal(pr.x402Version, 2);
    assert.equal(pr.accepts.length, 1);
    const r = pr.accepts[0];
    const units = h.m.proto.workUnits(h.m.openai.chatRequest(hello()));
    assert.deepEqual(r, {
      scheme: "exact",
      network: `eip155:${h.m.chain.targetChain.id}`,
      amount: (BigInt(units) * PRICE_PER_UNIT).toString(),
      asset: ASSET,
      payTo: ESCROW,
      maxTimeoutSeconds: 300,
      extra: { name: "Global Dollar", version: "1", assetTransferMethod: "eip3009" },
    });
    assert.match(pr.resource.url, /\/api\/v1\/chat\/completions$/);
    assert.ok(pr.extensions?.["sparecycle-escrow"], "escrow details in an extension");
    const body = await res.json();
    assert.equal(body.error.code, "x402_payment_required");
    assert.equal(body.error.type, "payment_required");
    assert.deepEqual(body.x402, pr);
    assert.ok(!JSON.stringify(body).includes("Say hi"), "the prompt is never echoed");
  });

  test("images are priced by their own work units; a bad body is a 400/404 before any 402", async () => {
    const res = await images({ model: "sd15", prompt: "a lighthouse", size: "256x256", steps: 10 });
    assert.equal(res.status, 402);
    const pr = decode<import("@/lib/x402").PaymentRequired>(res, "payment-required");
    const units = h.m.proto.workUnits(h.m.openai.imagesRequest({ model: "sd15", prompt: "a lighthouse", size: "256x256", steps: 10 }).request);
    assert.equal(pr.accepts[0].amount, (BigInt(units) * PRICE_PER_UNIT).toString());
    assert.equal((await chat({ ...hello(), model: "gpt-4o" })).status, 404);
    assert.equal((await chat({ ...hello(), max_tokens: 9999 })).status, 400);
  });
});

describe("paying and settling", () => {
  test("a valid payment funds the escrow first, then queues the job; agreed -> forwarded; receipt sealed in the epoch tree", async () => {
    const who = payer();
    const before = { jobs: jobCount(), fund: chain.calls.fund };
    const { res, pr, header } = await payChat(who);
    assert.equal(res.status, 202);
    h.assertPrivate(res, "paid create");
    const settle = decode<import("@/lib/x402").SettleResponse>(res, "payment-response");
    assert.equal(settle.success, true);
    assert.equal(settle.payer, who.address);
    assert.equal(settle.network, pr.accepts[0].network);
    assert.match(settle.transaction, /^0x[0-9a-f]{64}$/);
    const body = await res.json();
    const jobId = body.sparecycle.job_id as string;
    assert.equal(body.object, "chat.completion");
    assert.deepEqual(body.choices, []);
    assert.match(body.sparecycle.read_secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(body.sparecycle.x402.status, "held");
    assert.equal(body.sparecycle.price_wei, null, "no wei price: the payment is in the asset");
    assert.equal(chain.calls.fund, before.fund + 1);
    assert.equal(jobCount(), before.jobs + 1);
    const row = h.m.db.getDb().prepare("SELECT payer, price_wei, charge_status, payment_sig FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { payer: who.address, price_wei: null, charge_status: "x402", payment_sig: null });
    assert.equal(h.m.payments.heldFor(who.address), 0n, "never counted against a prepaid balance");
    const e = escrowRow(jobId);
    assert.equal(e.status, "held");
    assert.equal(e.escrow_id, lib.escrowIdOf(jobId as Hex, e.escrow_salt));
    assert.equal(chain.escrows.get(e.escrow_id)?.state, "held");
    assert.equal(await chain.balanceOf(who.address), 10n ** 9n - BigInt(pr.accepts[0].amount));

    // Poll with the read secret (x402 payers have no API key).
    const early = await pollChat(body.id, body.sparecycle.read_secret);
    assert.equal(early.status, 200);
    assert.deepEqual((await early.json()).choices, []);
    assert.equal((await pollChat(body.id, "wrong-secret")).status, 403);

    assert.equal(await h.run(jobId, { text: "Hi from two nodes." }), "agreed");
    assert.match(await x.settleX402(), /forwarded/);
    assert.equal(chain.escrows.get(e.escrow_id)?.state, "forwarded");
    assert.equal(escrowRow(jobId).status, "forwarded");
    assert.equal(escrowRow(jobId).reason, "agreed");
    assert.equal(await x.settleX402(), "nothing to settle", "settled exactly once");
    assert.equal(chain.calls.forward, 1);

    const done = await pollChat(body.id, body.sparecycle.read_secret);
    const d = await done.json();
    assert.equal(d.choices[0].message.content, "Hi from two nodes.");
    assert.equal(d.sparecycle.x402.status, "forwarded");

    // Invoice: none (x402); receipt: provisional, then sealed by the epoch's x402 tree.
    const inv = await (await import("./invoices")).jobInvoice(jobId, { address: null, secret: body.sparecycle.read_secret });
    assert.equal(inv.payment, "x402");
    const receipts = await import("./receipts");
    const rc0 = receipts.jobReceipt(jobId, { address: null, secret: body.sparecycle.read_secret }) as import("./receipts").X402Receipt;
    assert.equal(rc0.format, "sparecycle-x402-receipt");
    assert.equal(rc0.state, "provisional");
    assert.equal(rc0.escrowStatus, "forwarded");
    assert.match(x.sealX402Epoch(7) ?? "", /1 escrow/);
    assert.equal(x.sealX402Epoch(7), null, "nothing left to seal");
    const rc = receipts.jobReceipt(jobId, { address: null, secret: body.sparecycle.read_secret }) as import("./receipts").X402Receipt;
    assert.equal(rc.state, "sealed");
    const li = rc.anchor!.leafInputs;
    const leaf = lib.x402LeafOf(7, {
      jobId: li.jobId,
      escrowId: li.escrowId,
      payer: li.payer,
      asset: li.asset,
      amount: BigInt(li.amount),
      verdict: "agreed",
      outcome: "forwarded",
      outputHash: li.outputHash as Hex,
      salt: li.salt,
    });
    assert.equal(leaf, rc.anchor!.leaf);
    assert.ok(merkle.verifyProof(rc.anchor!.proof, rc.anchor!.root, leaf));
    assert.equal(lib.escrowIdOf(rc.jobId, rc.escrowSalt), rc.escrowId, "the salt ties the public escrow id to the job");
    const pub = x.x402ChargesOf(7) as { x402: { root: Hex; leaves: Hex[] } };
    assert.equal(pub.x402.root, rc.anchor!.root);
    const text = JSON.stringify(pub);
    for (const secret of [jobId, rc.escrowSalt, li.salt, who.address.toLowerCase().slice(2)]) assert.ok(!text.toLowerCase().includes(secret.toLowerCase().slice(2)), "no job id, payer or salt in public data");
    assert.deepEqual(x.x402ChargesOf(8), {}, "an epoch without x402 escrows is unchanged");

    assert.ok(!h.logs.some((l) => l.includes(header) || l.includes(body.sparecycle.read_secret)), "never logged");
  });

  test("the same payment again is one uniform 409 payment_used, whatever the body: no job id, no second escrow", async () => {
    const who = payer();
    const { res, header } = await payChat(who, hello("replay me"));
    const first = await res.json();
    const funds = chain.calls.fund;
    for (const body of [hello("replay me"), hello("a guessed prompt")]) {
      const again = await chat(body, { "payment-signature": header });
      assert.equal(again.status, 409);
      const b = await again.json();
      assert.equal(b.error.code, "payment_used");
      assert.ok(!JSON.stringify(b).includes(first.sparecycle.job_id.slice(2)), "no job id: a replay cannot confirm a guessed prompt");
    }
    assert.equal(chain.calls.fund, funds);
  });

  test("refused payments: 402 x402_payment_rejected with the spec's reason; nothing funded, no job", async () => {
    const who = payer();
    const stranger = newAccount();
    const poor = payer(1n);
    const now = Math.floor(Date.now() / 1000);
    const usedNonce = `0x${"ab".repeat(32)}` as Hex;
    chain.used.add(`${who.address.toLowerCase()}|${usedNonce}`);
    const cases: [string, () => Promise<{ res: Response }>][] = [
      ["invalid_payment_requirements", () => payChat(who, hello(), { accepted: { amount: "1" } })],
      ["invalid_exact_evm_payload_authorization_value_mismatch", async () => {
        const first = await chat(hello());
        const r = decode<import("@/lib/x402").PaymentRequired>(first, "payment-required").accepts[0];
        const s = await sign(who, r, { value: "1" });
        return { res: await chat(hello(), { "payment-signature": s.header }) };
      }],
      ["invalid_exact_evm_payload_recipient_mismatch", () => payChat(who, hello(), { to: stranger.address })],
      ["invalid_exact_evm_payload_signature", () => payChat(stranger, hello(), { from: who.address })],
      ["invalid_exact_evm_payload_authorization_valid_before", () => payChat(who, hello(), { validBefore: now + 5 })],
      ["invalid_exact_evm_payload_authorization_valid_after", () => payChat(who, hello(), { validAfter: now + 600 })],
      ["invalid_network", () => payChat(who, hello(), { accepted: { network: "eip155:8453" } })],
      ["invalid_exact_evm_payload_authorization_valid_before", () => payChat(who, hello(), { validBefore: now + 3600 })],
      ["invalid_transaction_state", () => payChat(who, hello(), { nonce: usedNonce })],
      ["insufficient_funds", () => payChat(poor)],
      ["invalid_payload", async () => ({ res: await chat(hello(), { "payment-signature": "%%%not base64%%%" }) })],
    ];
    const before = { jobs: jobCount(), fund: chain.calls.fund };
    for (const [reason, run] of cases) {
      const { res } = await run();
      assert.equal(res.status, 402, reason);
      const body = await res.json();
      assert.equal(body.error.code, "x402_payment_rejected", reason);
      assert.equal(body.x402.error, reason, reason);
      assert.equal(decode<import("@/lib/x402").PaymentRequired>(res, "payment-required").error, reason);
    }
    assert.equal(chain.calls.fund, before.fund, "no escrow was funded");
    assert.equal(jobCount(), before.jobs, "no job was queued");
  });

  test("disagreed -> refunded; the poll answers 422 not_charged and says the escrow is refunded", async () => {
    const who = payer();
    const { res, pr } = await payChat(who, hello("no pair agrees"));
    const b = await res.json();
    const jobId = b.sparecycle.job_id;
    h.lastRound(jobId);
    assert.equal(await h.run(jobId, { text: "A" }, { text: "B" }), "disagreed");
    assert.match(await x.settleX402(), /refunded/);
    assert.equal(escrowRow(jobId).reason, "disagreed");
    assert.equal(await chain.balanceOf(who.address), 10n ** 9n, "all of it back");
    const poll = await pollChat(b.id, b.sparecycle.read_secret);
    assert.equal(poll.status, 422);
    const e = await poll.json();
    assert.equal(e.error.type, "not_charged");
    assert.match(e.error.message, /refunded/);
    assert.equal(e.sparecycle.x402.status, "refunded");
    assert.ok(BigInt(pr.accepts[0].amount) > 0n);
  });

  test("a funding transaction that reverts -> 402, no job; the same authorization can be tried again", async () => {
    const who = payer();
    const first = await chat(hello("revert"));
    const r = decode<import("@/lib/x402").PaymentRequired>(first, "payment-required").accepts[0];
    const s = await sign(who, r);
    chain.failFund = "revert";
    const jobs = jobCount();
    const res = await chat(hello("revert"), { "payment-signature": s.header });
    chain.failFund = null;
    assert.equal(res.status, 402);
    assert.equal((await res.json()).x402.error, "unexpected_settle_error");
    assert.equal(jobCount(), jobs);
    const retry = await chat(hello("revert"), { "payment-signature": s.header });
    assert.equal(retry.status, 202);
  });

  test("a funding transaction with an unknown outcome -> 503 payment_pending; the settle tick refunds it once it is found on-chain", async () => {
    const who = payer();
    const first = await chat(hello("pending"));
    const r = decode<import("@/lib/x402").PaymentRequired>(first, "payment-required").accepts[0];
    const s = await sign(who, r);
    chain.failFund = "pending";
    const res = await chat(hello("pending"), { "payment-signature": s.header });
    chain.failFund = null;
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "payment_pending");
    const row = h.m.db.getDb().prepare("SELECT * FROM x402_escrows WHERE status = 'funding'").get() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.ok(row.fund_tx, "the sent hash is stored");
    // It did land after all (simulated), and the request is long gone.
    chain.escrows.set(row.escrow_id, { payer: who.address, amount: BigInt(row.amount), deadline: Math.floor(Date.now() / 1000) + 43_200, state: "held" });
    assert.equal(await x.settleX402(), "nothing to settle", "too early: the request may still be running");
    h.m.db.getDb().prepare("UPDATE x402_escrows SET created_at = created_at - 600 WHERE job_id = ?").run(row.job_id);
    assert.match(await x.settleX402(), /refunded/);
    assert.equal(escrowRow(row.job_id).reason, "not-queued");
    assert.equal(h.m.db.getDb().prepare("SELECT 1 FROM jobs WHERE id = ?").get(row.job_id), undefined, "no job was ever queued");
  });

  test("funded but the job cannot be queued (a concurrent submission used the hourly limit) -> refunded at once, 429", async () => {
    const who = payer();
    const first = await chat(hello("too many"));
    const r = decode<import("@/lib/x402").PaymentRequired>(first, "payment-required").accepts[0];
    const s = await sign(who, r);
    chain.onFund = () => {
      // While the funding is mined, other submissions use up the payer's paid-jobs bucket (jobs.ts queueBucket).
      const window = Math.floor(Date.now() / 1000 / 3600) * 3600;
      const bucket = h.m.proto.sha256Hex(`${limits.ipSalt()}|payer|${who.address.toLowerCase()}`);
      h.m.db.getDb().prepare("INSERT OR REPLACE INTO rate_limits (bucket, window_start, count) VALUES (?, ?, ?)").run(bucket, window, h.m.jobs.PAID_JOBS_PER_HOUR);
    };
    const refunds = chain.calls.refund;
    const res = await chat(hello("too many"), { "payment-signature": s.header });
    chain.onFund = null;
    assert.equal(res.status, 429);
    assert.equal(chain.calls.refund, refunds + 1);
    const row = h.m.db.getDb().prepare("SELECT * FROM x402_escrows WHERE payer = ? ORDER BY created_at DESC").get(who.address) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(row.status, "refunded");
    assert.equal(row.reason, "not-queued");
    assert.equal(await chain.balanceOf(who.address), 10n ** 9n);
  });

  test("a job still running past the escrow deadline is refunded (it can no longer be forwarded)", async () => {
    const who = payer();
    const { res } = await payChat(who, hello("slow"));
    const jobId = (await res.json()).sparecycle.job_id;
    assert.equal(await x.settleX402(jobId), "nothing to settle", "still running, before the deadline");
    h.m.db.getDb().prepare("UPDATE x402_escrows SET deadline = ? WHERE job_id = ?").run(Math.floor(Date.now() / 1000) - 1, jobId);
    assert.match(await x.settleX402(jobId), /refunded/);
    assert.equal(escrowRow(jobId).reason, "deadline");
  });

  test("a settlement that fails because someone else already refunded (after the deadline) is recorded as refunded", async () => {
    const who = payer();
    const { res } = await payChat(who, hello("refunded by a stranger"));
    const jobId = (await res.json()).sparecycle.job_id;
    assert.equal(await h.run(jobId, { text: "same" }), "agreed");
    const e = chain.escrows.get(escrowRow(jobId).escrow_id)!;
    e.state = "refunded"; // a stranger called refund() after the deadline
    assert.match(await x.settleX402(), /refunded/);
    assert.equal(escrowRow(jobId).status, "refunded");
    // A failing chain leaves the escrow open for the next tick.
    const who2 = payer();
    const p2 = await payChat(who2, hello("chain down"));
    const j2 = (await p2.res.json()).sparecycle.job_id;
    assert.equal(await h.run(j2, { text: "same" }), "agreed");
    chain.failSettle = true;
    assert.match(await x.settleX402(), /forward failed/);
    chain.failSettle = false;
    assert.equal(escrowRow(j2).status, "forwarding");
    h.m.db.getDb().prepare("UPDATE x402_escrows SET updated_at = updated_at - 600 WHERE job_id = ?").run(j2);
    assert.match(await x.settleX402(), /forwarded/);
  });
});

describe("review fixes (internal security review)", () => {
  const insertFunding = (who: Address, tag: string, nonce: Hex, validBefore: number, createdAt: number) =>
    h.m.db
      .getDb()
      .prepare(
        `INSERT INTO x402_escrows (job_id, escrow_id, escrow_salt, payer, escrow, asset, network, amount, auth_nonce, valid_before, surface, body_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'eip155:1', '1', ?, ?, 'chat', 'x', 'funding', ?, ?)`,
      )
      .run(`0x${tag}1`.padEnd(66, "1"), `0x${tag}2`.padEnd(66, "2"), `0x${tag}3`.padEnd(66, "3"), who, ESCROW, ASSET, nonce, validBefore, createdAt, createdAt);

  test("preflight: an escrow that does not match the configuration takes no payments (503 x402_unavailable)", async () => {
    const bads: Partial<import("./x402").EscrowInfo>[] = [
      { asset: newAccount().address },
      { rewardsScheduler: newAccount().address },
      { assetDomainSeparator: `0x${"11".repeat(32)}` },
      { settleWindow: 3600 },
    ];
    for (const bad of bads) {
      chain.infoOverride = bad;
      x.setX402TestSeams({}); // drop the cached preflight
      const res = await chat(hello());
      assert.equal(res.status, 503, JSON.stringify(bad));
      assert.equal((await res.json()).error.code, "x402_unavailable");
    }
    chain.infoOverride = {};
    x.setX402TestSeams({});
    assert.equal((await chat(hello())).status, 402);
  });

  test("no 402 is offered above the escrow's per-job cap (400) or while funding is paused (503)", async () => {
    chain.infoOverride = { maxPerJob: 1n };
    x.setX402TestSeams({});
    const over = await chat(hello());
    assert.equal(over.status, 400);
    assert.equal((await over.json()).error.code, "x402_amount_over_cap");
    chain.infoOverride = { fundingPaused: true };
    x.setX402TestSeams({});
    const paused = await chat(hello());
    assert.equal(paused.status, 503);
    assert.equal((await paused.json()).error.code, "x402_paused");
    chain.infoOverride = {};
    x.setX402TestSeams({});
  });

  test("one funding per payer at a time: a second payment while one is in flight -> 409 payment_in_progress", async () => {
    const who = payer();
    const now = Math.floor(Date.now() / 1000);
    insertFunding(who.address, "c", `0x${"c4".repeat(32)}`, now + 300, now);
    const { res } = await payChat(who, hello("second"));
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "payment_in_progress");
    // The stale attempt is resolved from the chain: authorization unused and expired -> failed; the payer can pay again.
    h.m.db.getDb().prepare("UPDATE x402_escrows SET created_at = ?, valid_before = ? WHERE payer = ? AND status = 'funding'").run(now - 600, now - 1, who.address);
    assert.match(await x.settleX402(), /did not land/);
    assert.equal((await payChat(who, hello("second"))).res.status, 202);
  });

  test("a stale funding whose authorization was used outside fund() (front-run) is marked failed with the surplus note", async () => {
    const who = payer();
    const now = Math.floor(Date.now() / 1000);
    const nonce = `0x${"d4".repeat(32)}` as Hex;
    insertFunding(who.address, "d", nonce, now + 300, now - 600);
    assert.equal(await x.settleX402(), "nothing to settle", "unused and still valid: it may still land, wait");
    chain.used.add(`${who.address.toLowerCase()}|${nonce}`);
    assert.match(await x.settleX402(), /surplus/);
    const row = h.m.db.getDb().prepare("SELECT status, error FROM x402_escrows WHERE payer = ?").get(who.address) as { status: string; error: string };
    assert.equal(row.status, "failed");
    assert.match(row.error, /recoverSurplus/);
  });

  test("switching x402 off stops new payments but never strands open escrows: settlement and secret polling go on", async () => {
    const who = payer();
    const { res } = await payChat(who, hello("then off"));
    const b = await res.json();
    process.env.X402_ENABLED = "0";
    try {
      assert.equal((await chat(hello())).status, 401, "no new x402 payment");
      const poll = await pollChat(b.id, b.sparecycle.read_secret);
      assert.equal(poll.status, 200, "the payer still polls with the read secret");
      assert.equal(await h.run(b.sparecycle.job_id, { text: "agreed while off" }), "agreed");
      assert.match(await x.settleX402(), /forwarded/);
    } finally {
      process.env.X402_ENABLED = "1";
    }
  });

  test("a read secret on the poll route works only for x402 jobs; wrong secrets never use up the job's reads", async () => {
    const c = await h.customer();
    const keyJob = await (await chat(hello("a key job"), h.bearer(c.key))).json();
    const free = await h.m.routes.jobs.POST(h.req("/api/v1/jobs", { method: "POST", body: { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "free", maxTokens: 16 } } }));
    const fj = await free.json();
    assert.equal((await pollChat(`chatcmpl-${fj.id}`, fj.readSecret)).status, 401, "a free job's read secret is not an OpenAI-route credential");
    assert.equal((await pollChat(keyJob.id, "x".repeat(43))).status, 401, "a key job stays key-only");
    const { res } = await payChat(payer(), hello("secret poll"));
    const b = await res.json();
    for (let n = 0; n < 5; n++) assert.equal((await pollChat(b.id, `wrong-${n}`)).status, 403);
    assert.equal((await pollChat(b.id, b.sparecycle.read_secret)).status, 200);
  });
});

describe("facilitators behind one interface", () => {
  test("a swapped-in facilitator decides verify (mock); its refusal is the 402 reason", async () => {
    const calls: string[] = [];
    x.setX402TestSeams({
      facilitator: {
        name: "mock",
        verify: async () => {
          calls.push("verify");
          return { isValid: false, invalidReason: "mock_refused", invalidMessage: "no" };
        },
        settle: async () => {
          calls.push("settle");
          return { success: false, transaction: "", network: "x" };
        },
      },
    });
    try {
      const { res } = await payChat(payer(), hello("mock"));
      assert.equal(res.status, 402);
      assert.equal((await res.json()).x402.error, "mock_refused");
      assert.deepEqual(calls, ["verify"], "settle is never called after a failed verify");
    } finally {
      x.setX402TestSeams({ facilitator: null });
    }
  });

  test("RemoteVerifyFacilitator: a third party's /verify runs after the local checks; settlement stays local (into the escrow)", async () => {
    const local = new x.LocalFacilitator(h.m.chain.targetChain.id, chain as unknown as import("./x402").EscrowChain);
    const remote = new x.RemoteVerifyFacilitator("https://facilitator.example", local);
    const realFetch = globalThis.fetch;
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    let answer = { isValid: false, invalidReason: "remote_refused" };
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    x.setX402TestSeams({ facilitator: remote });
    try {
      const refused = await payChat(payer(), hello("remote 1"));
      assert.equal(refused.res.status, 402);
      assert.equal((await refused.res.json()).x402.error, "remote_refused");
      assert.equal(seen[0].url, "https://facilitator.example/verify");
      assert.equal(seen[0].body.x402Version, 2);
      assert.ok(seen[0].body.paymentPayload && seen[0].body.paymentRequirements);
      answer = { isValid: true } as typeof answer;
      const funds = chain.calls.fund;
      const ok = await payChat(payer(), hello("remote 2"));
      assert.equal(ok.res.status, 202);
      assert.equal(chain.calls.fund, funds + 1, "funded by the scheduler into the escrow");
      assert.ok(!seen.some((s) => s.url.endsWith("/settle")), "no third-party settle: it would pay payTo without an escrow record");
      // A bad local signature never reaches the third party.
      const n = seen.length;
      await payChat(newAccount(), hello("remote 3"), { from: payer().address });
      assert.equal(seen.length, n);
    } finally {
      globalThis.fetch = realFetch;
      x.setX402TestSeams({ facilitator: null });
    }
  });
});

describe("ABI", () => {
  test("src/contracts/x402Escrow.ts matches the compiled contract (when contracts/out exists)", (t) => {
    const file = join(process.cwd(), "contracts", "out", "SparecycleX402Escrow.sol", "SparecycleX402Escrow.json");
    if (!existsSync(file)) return t.skip("run forge build first");
    const compiled = JSON.parse(readFileSync(file, "utf8")).abi as { type: string; name?: string; inputs?: { type: string }[] }[];
    const sig = (e: { name?: string; inputs?: { type: string; components?: unknown }[] }) => `${e.name}(${(e.inputs ?? []).map((i) => i.type).join(",")})`;
    const mine = new Set(
      abi.x402EscrowAbi.filter((e) => e.type === "function" || e.type === "event" || e.type === "error").map((e) => (e.type === "event" ? toEventSelector(sig(e as never)) : toFunctionSelector(sig(e as never)))),
    );
    const theirs = compiled
      .filter((e) => (e.type === "function" || e.type === "event" || e.type === "error") && !/owner|Ownership|Ownable|Reentrancy|SafeERC20/i.test(e.name ?? ""))
      .map((e) => (e.type === "event" ? toEventSelector(sig(e)) : toFunctionSelector(sig(e))));
    for (const s of theirs) assert.ok(mine.has(s), `compiled entry ${s} missing from src/contracts/x402Escrow.ts`);
    for (const s of mine) assert.ok(theirs.includes(s), `TS ABI entry ${s} not in the compiled contract`);
  });
});
