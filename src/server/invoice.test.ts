// Billing and invoice tests on a scratch SQLite DB, in-process, no chain, no GPU (feature brief #3, #4 and the
// low-credit warning): the private per-job invoice route (401 / 403 / 404 / 200, private no-store headers), the
// output hash stored at the verdict, the "free trial, no charge" stub, no price or charge status in the public job
// views (D7), lowBalance + available on a paid submit, and a disagreed paid job that ends released and stays out of
// the epoch's charge list. Two dev-runner "nodes" are driven in-process (register -> poll -> signed result).
// The payments contract is replaced by stubs of publicClient.readContract / simulateContract (nothing is sent).
// Never prints read secrets, session ids, prompts or outputs. Run: npm test
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, mock, test } from "node:test";
import type { Address, LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Environment before any src/ import (config.ts reads NEXT_PUBLIC_* at import time).
for (const k of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|VAST_|GPU_POOL_|OUTPUT_|AUTH_|TEAM_JOB_|CHALLENGE_|GPU_ALLOWLIST_|PROJECT_NODE_)/.test(k)) delete process.env[k];
}
const dir = mkdtempSync(join(tmpdir(), "sparecycle-invoice-"));
const team = privateKeyToAccount(generatePrivateKey());
Object.assign(process.env, {
  NEXT_PUBLIC_NETWORK: "local",
  // Nothing listens on port 9: any read that slips past the stubs fails fast instead of reaching a chain.
  NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_EXPLORER_URL: "https://explorer.test.invalid",
  // A random address standing in for the payments contract: every read of it is stubbed below.
  NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS: privateKeyToAccount(generatePrivateKey()).address,
  SCHEDULER_SIGNER_KEY: generatePrivateKey(),
  DB_PATH: join(dir, "test.db"),
  SCHEDULER_ALLOW_DEV_RUNNER: "1",
  JOB_RATE_LIMIT: "1000",
  TEAM_JOB_WALLETS: team.address,
});

const { getDb, nowSec, randomHex } = await import("./db");
const { submitJob, listJobs, jobDetail, expireStaleJobs } = await import("./jobs");
const { registerNode, pollForTask } = await import("./nodes");
const { submitResult } = await import("./results");
const { chargeOpenEpoch, chargesJson, heldFor } = await import("./payments");
const { currentEpochIdLocal, ensureEpoch } = await import("./epochs");
const { jobInvoice, chargeStatusOf } = await import("./invoices");
const { ANONYMOUS } = await import("./auth");
const { linkMessage, parseJobRequest, sha256Hex, signReceipt } = await import("@/lib/protocol");
const { isLowBalance, jobPaymentMessage, jobPriceWei, jobRequestHash, LOW_CREDIT_JOBS, protocolCutWei } = await import("@/lib/job-payment");
const { publicClient, targetChain } = await import("@/lib/chain");
const { config } = await import("@/lib/config");
const invoiceRoute = await import("@/app/api/v1/jobs/[id]/invoice/route");
const resultRoute = await import("@/app/api/v1/jobs/[id]/result/route");

// ---- payments contract stubs ------------------------------------------------------------------------------
const balances = new Map<string, bigint>();
const withdrawals = new Map<string, bigint>();
type ReadArgs = { functionName: string; args?: readonly unknown[] };
const stubbed = publicClient as unknown as Record<string, (...a: unknown[]) => unknown>;
mock.method(stubbed, "readContract", async (...a: unknown[]) => {
  const { functionName, args = [] } = a[0] as ReadArgs;
  const who = String(args[0] ?? "").toLowerCase();
  switch (functionName) {
    case "balanceOf":
      return balances.get(who) ?? 0n;
    case "spendLimitPerEpoch":
    case "chargedInEpoch":
      return 0n;
    case "withdrawRequestOf":
      return [withdrawals.get(who) ?? 0n, 0n, 0n];
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

// ---- nodes and jobs ---------------------------------------------------------------------------------------
type Node = { key: LocalAccount; owner: LocalAccount };
let nodeA: Node;
let nodeB: Node;
let ipSeq = 0;
const nextIp = () => `10.1.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

before(async () => {
  const mkNode = async (name: string): Promise<Node> => {
    const key = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    const ownerSig = await owner.signMessage({ message: linkMessage(key.address, owner.address) });
    await registerNode(key.address, {
      gpu: `TEST ${name}`,
      gpuUuid: `TEST-INVOICE-GPU-${name}`,
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
  await ensureEpoch();
});

const textRequest = (prompt: string) => ({ kind: "text", params: { model: "qwen2.5-1.5b", prompt, maxTokens: 16 } });
const priceOf = (request: unknown) => jobPriceWei(parseJobRequest(request), config.jobPriceWeiPerUnit);

/** A paid job signed by `payer` exactly like the dapp signs it. */
async function submitPaid(payer: LocalAccount, request: unknown) {
  const priceWei = priceOf(request);
  const issued = nowSec();
  const message = jobPaymentMessage({ chainId: targetChain.id, contract: config.jobPayments!, requestHash: jobRequestHash(request), priceWei, issued });
  const signature = await payer.signMessage({ message });
  return submitJob({ request, payment: { payer: payer.address, signature, issued, priceWei: priceWei.toString() } }, nextIp());
}

/** Cancels the open and leased tasks of every job except `id`, so the next polls pick only that job. */
const only = (id: string) => getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id != ? AND status IN ('open','leased')").run(id);

/** One node takes the task (poll) and sends a signed dev result with `text`. */
async function work(node: Node, text: string) {
  const a = await pollForTask(node.key.address, AbortSignal.abort());
  assert.ok(a && "taskId" in a, "the node got a job task");
  const outputHash = sha256Hex(Buffer.from(text, "utf8"));
  const signature = await signReceipt(node.key, targetChain.id, {
    jobId: a.jobId as `0x${string}`,
    node: node.key.address,
    outputHash,
    gpuMs: 10n,
    epoch: BigInt(a.epoch),
  });
  return submitResult(node.key.address, a.taskId, { outputHash, signature, gpuMs: 10, epoch: a.epoch, text, dev: true });
}

/** Runs job `id` on both nodes; equal texts agree, different texts disagree. Returns the verdict. */
async function run(id: string, texts: [string, string]) {
  only(id);
  await work(nodeA, texts[0]);
  return (await work(nodeB, texts[1])).status;
}

// ---- HTTP helpers -----------------------------------------------------------------------------------------
const SITE = "http://127.0.0.1:3302";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

/** A live wallet session, written straight to the sessions table (the sign-in flow has its own tests). */
function sessionFor(address: Address): Record<string, string> {
  const id = randomBytes(32).toString("base64url");
  getDb().prepare("INSERT INTO sessions (id_hash, address, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(id), address, nowSec(), nowSec() + 3600);
  return { cookie: `sc_session=${id}` };
}

const getInvoice = (id: string, headers: Record<string, string> = {}) =>
  invoiceRoute.GET(new Request(`${SITE}/api/v1/jobs/${id}/invoice`, { headers }), ctx(id));

function assertPrivate(res: Response, label: string) {
  assert.equal(res.headers.get("cache-control"), "private, no-store", `${label}: cache-control`);
  assert.equal(res.headers.get("vary"), "Authorization, Cookie", `${label}: vary`);
}

// ---- tests ------------------------------------------------------------------------------------------------
describe("POST /api/v1/jobs: lowBalance and available on paid jobs", () => {
  test("a well funded payer: available after the hold, lowBalance false", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const request = textRequest("funded");
    const price = priceOf(request);
    balances.set(payer.address.toLowerCase(), 100n * price);
    const res = await submitPaid(payer, request);
    assert.equal(res.priceWei, price.toString());
    assert.equal(res.available, (99n * price).toString());
    assert.equal(res.lowBalance, false);
    assert.equal(heldFor(payer.address), price);
  });

  test(`fewer than ${LOW_CREDIT_JOBS} jobs left: lowBalance true, and a pending withdrawal counts as spent`, async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const request = textRequest("almost empty");
    const price = priceOf(request);
    balances.set(payer.address.toLowerCase(), 10n * price);
    withdrawals.set(payer.address.toLowerCase(), 6n * price);
    const res = await submitPaid(payer, request);
    assert.equal(res.available, (3n * price).toString());
    assert.equal(res.lowBalance, true);
  });

  test("free jobs carry neither field", async () => {
    const res = await submitJob(textRequest("free"), nextIp());
    assert.equal(res.priceWei, null);
    assert.equal("available" in res, false);
    assert.equal("lowBalance" in res, false);
  });

  test(`isLowBalance: below ${LOW_CREDIT_JOBS} x the price is low, exactly ${LOW_CREDIT_JOBS} x is not`, () => {
    assert.equal(isLowBalance(BigInt(LOW_CREDIT_JOBS) * 7n - 1n, 7n), true);
    assert.equal(isLowBalance(BigInt(LOW_CREDIT_JOBS) * 7n, 7n), false);
    assert.equal(isLowBalance(0n, 0n), false, "no price, no warning");
  });
});

describe("GET /api/v1/jobs/:id/invoice", () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  let paid: Awaited<ReturnType<typeof submitPaid>>;
  let price: bigint;

  before(async () => {
    const request = textRequest("an invoiced job");
    price = priceOf(request);
    balances.set(payer.address.toLowerCase(), 1000n * price);
    paid = await submitPaid(payer, request);
    assert.equal(await run(paid.id, ["the same answer", "the same answer"]), "agreed");
  });

  test("no credentials -> 401 with an empty body and private headers", async () => {
    const res = await getInvoice(paid.id);
    assert.equal(res.status, 401);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
    assertPrivate(res, "401");
  });

  test("another wallet's session -> 403; another job's read secret -> 403", async () => {
    const res = await getInvoice(paid.id, sessionFor(stranger.address));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "forbidden");
    assertPrivate(res, "403");
    const other = await submitJob(textRequest("someone else"), nextIp());
    assert.equal((await getInvoice(paid.id, bearer(other.readSecret))).status, 403);
  });

  test("unknown id -> 404, malformed id -> 400, both private", async () => {
    const unknown = `0x${"cd".repeat(32)}`;
    const res = await getInvoice(unknown, sessionFor(payer.address));
    assert.equal(res.status, 404);
    assertPrivate(res, "404");
    const bad = await getInvoice("0x1234", sessionFor(payer.address));
    assert.equal(bad.status, 400);
    assertPrivate(bad, "400");
  });

  test("the payer's session -> 200 with every field; the job's read secret reads the same invoice", async () => {
    const res = await getInvoice(paid.id, sessionFor(payer.address));
    assert.equal(res.status, 200);
    assertPrivate(res, "200");
    const inv = (await res.json()) as Record<string, unknown>;
    const cut = protocolCutWei(price);
    assert.equal(cut, (price * 500n) / 10_000n);
    assert.deepEqual(
      { ...inv, generatedAt: 0 },
      {
        version: 1,
        jobId: paid.id,
        model: "qwen2.5-1.5b",
        kind: "text",
        status: "agreed",
        verdict: "agreed",
        createdAt: inv.createdAt,
        settledAt: inv.settledAt,
        generatedAt: 0,
        payment: "paid",
        invoice: true,
        payer: payer.address,
        priceWei: price.toString(),
        chargedWei: null,
        protocolCutBps: 500,
        protocolCutWei: cut.toString(),
        protocolCutNote: inv.protocolCutNote,
        toPotWei: (price - cut).toString(),
        toPotNote: inv.toPotNote,
        chargeStatus: "pending",
        reason: null,
        epochId: currentEpochIdLocal(),
        epochStatus: "open",
        chargedEpoch: null,
        outputHash: sha256Hex(Buffer.from("the same answer", "utf8")),
        links: { chargeTx: null, epochRootTx: null },
      },
    );
    assert.equal(typeof inv.settledAt, "number");
    assert.match(String(inv.protocolCutNote), /rounded/);
    assert.match(String(inv.protocolCutNote), /per epoch batch/);
    const bySecret = await getInvoice(paid.id, bearer(paid.readSecret));
    assert.equal(bySecret.status, 200);
    assert.equal(((await bySecret.json()) as { priceWei: string }).priceWei, price.toString());
  });

  test("the output hash equals the sha256 of the bytes the payer downloads", async () => {
    const out = await resultRoute.GET(new Request(`${SITE}/api/v1/jobs/${paid.id}/result`, { headers: bearer(paid.readSecret) }), ctx(paid.id));
    assert.equal(out.status, 200);
    const bytes = new Uint8Array(await out.arrayBuffer());
    const inv = jobInvoice(paid.id, { address: payer.address, secret: null });
    assert.equal(inv.invoice && inv.outputHash, sha256Hex(bytes));
    assert.equal(getDb().prepare("SELECT output_hash FROM jobs WHERE id = ?").get(paid.id)?.output_hash, sha256Hex(bytes));
  });

  test("a team job: the team wallet's session reads it, marked team", async () => {
    const request = textRequest("a team test job");
    balances.set(team.address.toLowerCase(), 1000n * priceOf(request));
    const job = await submitPaid(team, request);
    const res = await getInvoice(job.id, sessionFor(team.address));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { payment: string }).payment, "team");
    assert.equal((await getInvoice(job.id, sessionFor(payer.address))).status, 403);
  });

  test("a free trial job: its read secret gets a 'free trial, no charge' stub; a wallet session gets 403", async () => {
    const free = await submitJob(textRequest("free invoice"), nextIp());
    const res = await getInvoice(free.id, bearer(free.readSecret));
    assert.equal(res.status, 200);
    assertPrivate(res, "free stub");
    const stub = (await res.json()) as Record<string, unknown>;
    assert.equal(stub.payment, "free");
    assert.equal(stub.invoice, false);
    assert.equal(stub.note, "free trial, no charge");
    for (const k of ["priceWei", "protocolCutWei", "chargeStatus", "outputHash", "payer"]) assert.equal(k in stub, false, `no ${k} in the stub`);
    assert.equal((await getInvoice(free.id, sessionFor(payer.address))).status, 403);
  });

  test("charged: charge and epoch-root transactions linked through the explorer", async () => {
    const epoch = currentEpochIdLocal();
    const chargeTx = randomHex(32);
    const rootTx = randomHex(32);
    const db = getDb();
    db.prepare("INSERT INTO charges (epoch_id, list_json, list_hash, total_wei, status, tx, created_at) VALUES (?, '[]', ?, '0', 'done', ?, ?)").run(
      epoch,
      randomHex(32),
      chargeTx,
      nowSec(),
    );
    db.prepare("UPDATE jobs SET charge_status = 'charged', charged_epoch = ? WHERE id = ?").run(epoch, paid.id);
    db.prepare("UPDATE epochs SET status = 'posted', posted_tx = ? WHERE id = ?").run(rootTx, epoch);
    try {
      const inv = jobInvoice(paid.id, { address: payer.address, secret: null });
      assert.ok(inv.invoice);
      assert.equal(inv.chargeStatus, "charged");
      assert.equal(inv.chargedEpoch, epoch);
      assert.equal(inv.chargedWei, price.toString());
      assert.deepEqual(inv.links, {
        chargeTx: { hash: chargeTx, url: `https://explorer.test.invalid/tx/${chargeTx}` },
        epochRootTx: { hash: rootTx, url: `https://explorer.test.invalid/tx/${rootTx}` },
      });
    } finally {
      // Back to an open, uncharged epoch for the tests below.
      db.prepare("DELETE FROM charges WHERE epoch_id = ?").run(epoch);
      db.prepare("UPDATE jobs SET charge_status = 'pending', charged_epoch = NULL WHERE id = ?").run(paid.id);
      db.prepare("UPDATE epochs SET status = 'open', posted_tx = NULL WHERE id = ?").run(epoch);
    }
  });

  test("an expired paid job: verdict expired, not charged, no output hash", async () => {
    const job = await submitPaid(payer, textRequest("never picked up"));
    getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id = ?").run(job.id);
    getDb().prepare("UPDATE jobs SET created_at = created_at - 7 * 3600 WHERE id = ?").run(job.id);
    const inv = jobInvoice(job.id, { address: payer.address, secret: null });
    assert.ok(inv.invoice);
    assert.equal(inv.verdict, "expired");
    assert.equal(inv.chargeStatus, "released");
    assert.equal(inv.chargedWei, "0");
    assert.equal(inv.outputHash, null);
  });

  test("the invoice is never readable without credentials, whatever OUTPUT_AUTH says", async () => {
    process.env.OUTPUT_AUTH = "off";
    try {
      assert.equal((await getInvoice(paid.id)).status, 401);
      assert.throws(() => jobInvoice(paid.id, ANONYMOUS), (e: unknown) => (e as { status?: number }).status === 401);
    } finally {
      delete process.env.OUTPUT_AUTH;
    }
  });
});

describe("D7: no price, charge status, payer or output hash in the public job views", () => {
  test("GET /api/v1/jobs and GET /api/v1/jobs/:id keep payment, status, timestamps and epochId only", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const request = textRequest("public view");
    balances.set(payer.address.toLowerCase(), 1000n * priceOf(request));
    const job = await submitPaid(payer, request);
    assert.equal(await run(job.id, ["public view answer", "public view answer"]), "agreed");
    const row = listJobs(100).jobs.find((j) => j.id === job.id) as Record<string, unknown> | undefined;
    const detail = jobDetail(job.id) as Record<string, unknown>;
    for (const view of [row, detail]) {
      assert.ok(view);
      for (const k of ["priceWei", "chargeStatus", "payer", "outputHash", "chargedEpoch", "protocolCutWei"]) assert.equal(k in view, false, `no ${k}`);
      assert.equal(view.payment, "paid");
      assert.equal(view.status, "agreed");
      assert.equal(view.epochId, currentEpochIdLocal());
      assert.equal(typeof view.createdAt, "number");
      assert.equal(typeof view.settledAt, "number");
      assert.ok(!JSON.stringify(view).includes(payer.address.toLowerCase().slice(2)), "the payer's address is not in the public view");
    }
  });
});

describe("a disagreed paid job is never charged (brief §3.2 step 5)", () => {
  test("it shows released at once, ends released at the epoch close, and is absent from chargesJson", async () => {
    expireStaleJobs();
    getDb().prepare("UPDATE jobs SET charge_status = 'released' WHERE charge_status = 'pending'").run(); // a clean slate for this epoch
    const payer = privateKeyToAccount(generatePrivateKey());
    const reqA = textRequest("matched and charged");
    const reqB = textRequest("did not match");
    balances.set(payer.address.toLowerCase(), 1000n * priceOf(reqA));
    const agreed = await submitPaid(payer, reqA);
    assert.equal(await run(agreed.id, ["alpha beta gamma delta", "alpha beta gamma delta"]), "agreed");
    const disagreed = await submitPaid(payer, reqB);
    assert.equal(await run(disagreed.id, ["alpha beta gamma delta", "completely different words here and more"]), "disagreed");

    // Before the close: no longer held, and the invoice already says not charged.
    assert.equal(heldFor(payer.address), priceOf(reqA), "only the agreed job is still held");
    const early = jobInvoice(disagreed.id, { address: payer.address, secret: null });
    assert.ok(early.invoice);
    assert.equal(early.verdict, "disagreed");
    assert.equal(early.chargeStatus, "released");
    assert.equal(early.chargedWei, "0");
    assert.equal(early.reason, "the two results do not match");
    assert.equal(early.outputHash, null);
    assert.equal(getDb().prepare("SELECT output_hash FROM jobs WHERE id = ?").get(disagreed.id)?.output_hash, null);

    // The epoch close: the charge list is built and stored before the (stubbed, failing) transaction.
    const epoch = currentEpochIdLocal();
    const summary = await chargeOpenEpoch(epoch);
    assert.match(summary, /^charge failed: /);
    const status = (id: string) => (getDb().prepare("SELECT charge_status FROM jobs WHERE id = ?").get(id) as { charge_status: string }).charge_status;
    assert.equal(status(disagreed.id), "released");
    assert.equal(status(agreed.id), "pending", "the agreed job stays due for the next attempt");
    const list = chargesJson(epoch);
    const ids = list.jobs.map((j) => j.jobId);
    assert.ok(ids.includes(agreed.id), "the agreed job is in the charge list");
    assert.ok(!ids.includes(disagreed.id), "the disagreed job is not");
    assert.equal(list.totalWei, priceOf(reqA).toString());
    const late = jobInvoice(disagreed.id, { address: payer.address, secret: null });
    assert.ok(late.invoice);
    assert.equal(late.chargeStatus, "released");
    assert.equal(late.chargedEpoch, null);
  });

  test("chargeStatusOf: settled without agreement reads released, whatever is stored", () => {
    for (const s of ["disagreed", "expired", "rejected"] as const) assert.equal(chargeStatusOf(s, "pending"), "released");
    assert.equal(chargeStatusOf("agreed", "pending"), "pending");
    assert.equal(chargeStatusOf("running", "pending"), "pending");
    assert.equal(chargeStatusOf("agreed", "charged"), "charged");
    assert.equal(chargeStatusOf("agreed", "unpaid"), "unpaid");
  });
});
