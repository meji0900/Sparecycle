// Job receipts on a scratch SQLite DB, in-process, no chain, no GPU (feature brief #8, option B): the receipt route's
// access rules (401 / 403 / 404 / 400 / 409 / 200, private no-store headers, the free stub), a provisional receipt at
// the verdict with both node signatures, the jobs tree committed as the charge's listHash (charged, released and team
// jobs), sealed receipts that verify against a Charged event built from the published charge, D15 (an epoch without a
// charge: "no-anchor", then carried into the next charged epoch's root), and v1 charge lists served unchanged.
// The payments contract is replaced by stubs of publicClient.readContract / simulateContract / getTransactionReceipt;
// a charge is confirmed through the real crash-recovery path (a 'sending' row whose transaction receipt is found).
// Never prints read secrets, session ids, prompts or outputs. Run: npm test
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Environment before any src/ import (config.ts reads NEXT_PUBLIC_* at import time).
for (const k of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|VAST_|GPU_POOL_|OUTPUT_|AUTH_|TEAM_JOB_|CHALLENGE_|GPU_ALLOWLIST_|PROJECT_NODE_)/.test(k)) delete process.env[k];
}
const dir = mkdtempSync(join(tmpdir(), "sparecycle-receipts-"));
const team = privateKeyToAccount(generatePrivateKey());
Object.assign(process.env, {
  NEXT_PUBLIC_NETWORK: "local",
  // Nothing listens on port 9: any read that slips past the stubs fails fast instead of reaching a chain.
  NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_EXPLORER_URL: "https://explorer.test.invalid",
  NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS: privateKeyToAccount(generatePrivateKey()).address,
  SCHEDULER_SIGNER_KEY: generatePrivateKey(),
  DB_PATH: join(dir, "test.db"),
  SCHEDULER_ALLOW_DEV_RUNNER: "1",
  JOB_RATE_LIMIT: "1000",
  TEAM_JOB_WALLETS: team.address,
});

const { getDb, nowSec, randomHex } = await import("./db");
const { submitJob } = await import("./jobs");
const { registerNode, pollForTask } = await import("./nodes");
const { submitResult } = await import("./results");
const { chargeOpenEpoch, chargesJson } = await import("./payments");
const { currentEpochIdLocal, ensureEpoch } = await import("./epochs");
const { jobReceipt } = await import("./receipts");
const { ANONYMOUS } = await import("./auth");
const { linkMessage, parseJobRequest, sha256Hex, signReceipt } = await import("@/lib/protocol");
const { jobPaymentMessage, jobPriceWei, jobRequestHash } = await import("@/lib/job-payment");
const { buildTree } = await import("@/lib/merkle");
const { jobLeafOf, verifyReceipt } = await import("@/lib/job-receipt");
const { jobPaymentsAbi } = await import("@/contracts/jobPayments");
const { publicClient, targetChain } = await import("@/lib/chain");
const { config } = await import("@/lib/config");
const receiptRoute = await import("@/app/api/v1/jobs/[id]/receipt/route");
type JobReceipt = import("@/lib/job-receipt").JobReceipt;
type ReceiptChainClient = import("@/lib/job-receipt").ReceiptChainClient;

// ---- payments contract stubs ------------------------------------------------------------------------------
const balances = new Map<string, bigint>();
const minedTx = new Set<string>();
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
mock.method(stubbed, "getTransactionReceipt", async (...a: unknown[]) => {
  const { hash } = a[0] as { hash: string };
  if (!minedTx.has(hash)) throw new Error("not found");
  return { status: "success" };
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

// ---- nodes, jobs, epochs ----------------------------------------------------------------------------------
type Node = { key: LocalAccount; owner: LocalAccount };
let nodeA: Node;
let nodeB: Node;
let ipSeq = 0;
const nextIp = () => `10.2.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

before(async () => {
  const mkNode = async (name: string): Promise<Node> => {
    const key = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    const ownerSig = await owner.signMessage({ message: linkMessage(key.address, owner.address) });
    await registerNode(key.address, {
      gpu: `TEST ${name}`,
      gpuUuid: `TEST-RECEIPT-GPU-${name}`,
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

async function submitPaid(payer: LocalAccount, request: unknown) {
  const priceWei = priceOf(request);
  const issued = nowSec();
  const message = jobPaymentMessage({ chainId: targetChain.id, contract: config.jobPayments!, requestHash: jobRequestHash(request), priceWei, issued });
  const signature = await payer.signMessage({ message });
  return submitJob({ request, payment: { payer: payer.address, signature, issued, priceWei: priceWei.toString() } }, nextIp());
}

const only = (id: string) => getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id != ? AND status IN ('open','leased')").run(id);

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

/** Runs job `id` on both nodes; equal texts agree, different texts disagree. */
async function run(id: string, texts: [string, string]) {
  only(id);
  await work(nodeA, texts[0]);
  return (await work(nodeB, texts[1])).status;
}

const SAME = "alpha beta gamma delta";
const OTHER = "completely different words here and more";

/** A funded payer with one paid job run to `verdict`. */
async function paidJob(payer: LocalAccount, prompt: string, verdict: "agreed" | "disagreed") {
  const request = textRequest(prompt);
  balances.set(payer.address.toLowerCase(), (balances.get(payer.address.toLowerCase()) ?? 0n) + 1000n * priceOf(request));
  const job = await submitPaid(payer, request);
  assert.equal(await run(job.id, verdict === "agreed" ? [SAME, SAME] : [SAME, OTHER]), verdict);
  return { ...job, price: priceOf(request) };
}

/**
 * Charges the open epoch for real up to the transaction (stored list + jobs tree, then the stubbed send fails), and
 * confirms it the way a restart would: the row is 'sending' with a transaction whose receipt is found.
 */
async function chargeAndConfirm(epoch: number) {
  const first = await chargeOpenEpoch(epoch);
  assert.match(first, /^charge failed: /);
  const tx = randomHex(32);
  getDb().prepare("UPDATE charges SET status = 'sending', tx = ? WHERE epoch_id = ?").run(tx, epoch);
  minedTx.add(tx);
  assert.equal(await chargeOpenEpoch(epoch), `epoch ${epoch} charge confirmed (${tx})`);
  return tx;
}

/** Closes the open local epoch in the DB (the local clock never runs chargeOpenEpoch itself) and opens the next. */
function closeLocal(epoch: number, at = nowSec()) {
  getDb().prepare("UPDATE epochs SET status = 'closed-unposted', closed_at = ?, ended_at = ? WHERE id = ?").run(at, at, epoch);
  getDb().prepare("INSERT INTO epochs (id, clock, status, started_at, length, provisional) VALUES (?, 'scheduler-local', 'open', ?, 21600, 0)").run(epoch + 1, at);
}

/** A chain that holds exactly what the scheduler published for `epoch`: Charged + one CustomerCharged per customer. */
function chainOf(epoch: number): ReceiptChainClient {
  const word = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v]);
  return {
    getChainId: async () => targetChain.id,
    getTransactionReceipt: async ({ hash }) => {
      const c = chargesJson(epoch) as { tx: Hex | null; listHash: Hex; customers?: { customer: Address; amountWei: string }[]; totalWei: string };
      if (!c.tx || hash.toLowerCase() !== c.tx.toLowerCase()) throw Object.assign(new Error("not found"), { name: "TransactionReceiptNotFoundError" });
      const logs = [
        ...(c.customers ?? []).map((x) => ({
          address: config.jobPayments!,
          topics: encodeEventTopics({ abi: jobPaymentsAbi, eventName: "CustomerCharged", args: { epochId: BigInt(epoch), customer: x.customer } }) as Hex[],
          data: word(BigInt(x.amountWei)),
        })),
        {
          address: config.jobPayments!,
          topics: encodeEventTopics({ abi: jobPaymentsAbi, eventName: "Charged", args: { epochId: BigInt(epoch), listHash: c.listHash } }) as Hex[],
          data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [BigInt(c.totalWei), 0n, 0n]),
        },
      ];
      return { status: "success", blockNumber: 7n, logs };
    },
  };
}
const verifyOn = (epoch: number, receipt: unknown) =>
  verifyReceipt(JSON.parse(JSON.stringify(receipt)), { client: chainOf(epoch), chainId: targetChain.id, paymentsContract: config.jobPayments! });

// ---- HTTP helpers -----------------------------------------------------------------------------------------
const SITE = "http://127.0.0.1:3303";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
function sessionFor(address: Address): Record<string, string> {
  const id = randomBytes(32).toString("base64url");
  getDb().prepare("INSERT INTO sessions (id_hash, address, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(id), address, nowSec(), nowSec() + 3600);
  return { cookie: `sc_session=${id}` };
}
const getReceipt = (id: string, headers: Record<string, string> = {}) =>
  receiptRoute.GET(new Request(`${SITE}/api/v1/jobs/${id}/receipt`, { headers }), ctx(id));
function assertPrivate(res: Response, label: string) {
  assert.equal(res.headers.get("cache-control"), "private, no-store", `${label}: cache-control`);
  assert.equal(res.headers.get("vary"), "Authorization, Cookie", `${label}: vary`);
}
const asPayer = (payer: Address) => ({ address: payer, secret: null });

// ---- tests ------------------------------------------------------------------------------------------------
describe("GET /api/v1/jobs/:id/receipt: who can read it", () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  let job: Awaited<ReturnType<typeof paidJob>>;

  before(async () => {
    job = await paidJob(payer, "a receipt for the payer only", "agreed");
  });

  test("no credentials -> 401 with an empty body and private headers", async () => {
    const res = await getReceipt(job.id);
    assert.equal(res.status, 401);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
    assertPrivate(res, "401");
  });

  test("another wallet's session or another job's read secret -> 403", async () => {
    const res = await getReceipt(job.id, sessionFor(stranger.address));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as { error: string }).error, "forbidden");
    assertPrivate(res, "403");
    const other = await submitJob(textRequest("someone else"), nextIp());
    assert.equal((await getReceipt(job.id, bearer(other.readSecret!))).status, 403);
  });

  test("unknown id -> 404, malformed id -> 400, both private", async () => {
    const unknown = await getReceipt(`0x${"cd".repeat(32)}`, sessionFor(payer.address));
    assert.equal(unknown.status, 404);
    assertPrivate(unknown, "404");
    const bad = await getReceipt("0x1234", sessionFor(payer.address));
    assert.equal(bad.status, 400);
    assertPrivate(bad, "400");
  });

  test("the payer's session and the job's read secret -> 200, the same receipt", async () => {
    const bySession = await getReceipt(job.id, sessionFor(payer.address));
    assert.equal(bySession.status, 200);
    assertPrivate(bySession, "200");
    const bySecret = await getReceipt(job.id, bearer(job.readSecret!));
    assert.equal(bySecret.status, 200);
    assert.deepEqual(await bySecret.json(), await bySession.json());
  });

  test("no verdict yet -> 409 no-verdict; a free trial job -> a stub, no receipt", async () => {
    const request = textRequest("still queued");
    balances.set(payer.address.toLowerCase(), (balances.get(payer.address.toLowerCase()) ?? 0n) + priceOf(request));
    const queued = await submitPaid(payer, request);
    const res = await getReceipt(queued.id, sessionFor(payer.address));
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, "no-verdict");
    getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id = ?").run(queued.id);

    const free = await submitJob(textRequest("free receipt"), nextIp());
    const stub = await getReceipt(free.id, bearer(free.readSecret!));
    assert.equal(stub.status, 200);
    assertPrivate(stub, "free stub");
    assert.deepEqual(await stub.json(), { jobId: free.id, payment: "free", receipt: false, note: "free trial, no charge: no receipt" });
  });

  test("never readable without credentials, whatever OUTPUT_AUTH says", async () => {
    process.env.OUTPUT_AUTH = "off";
    try {
      assert.equal((await getReceipt(job.id)).status, 401);
      assert.throws(() => jobReceipt(job.id, ANONYMOUS), (e: unknown) => (e as { status?: number }).status === 401);
    } finally {
      delete process.env.OUTPUT_AUTH;
    }
  });
});

describe("a receipt from the verdict to the sealed charge", () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  let agreed: Awaited<ReturnType<typeof paidJob>>;
  let disagreed: Awaited<ReturnType<typeof paidJob>>;
  let teamJob: Awaited<ReturnType<typeof paidJob>>;
  let epoch: number;

  before(async () => {
    agreed = await paidJob(payer, "matched, charged and sealed", "agreed");
    disagreed = await paidJob(payer, "did not match, released and sealed", "disagreed");
    teamJob = await paidJob(team, "a team test job", "agreed");
    epoch = currentEpochIdLocal();
  });

  test("provisional as soon as the verdict is set, with both node signatures", async () => {
    const r = jobReceipt(agreed.id, asPayer(payer.address)) as JobReceipt;
    assert.equal(r.state, "provisional");
    assert.equal(r.verdict, "agreed");
    assert.equal(r.chargeStatus, "pending");
    assert.equal(r.outputHash, sha256Hex(Buffer.from(SAME, "utf8")));
    assert.deepEqual(r.pending, { reason: "waiting-for-charge", epochId: epoch });
    assert.equal(r.anchor, null);
    assert.deepEqual(r.nodes.map((n) => n.node).sort(), [nodeA.key.address, nodeB.key.address].sort(), "both nodes' receipts");
    const v = await verifyOn(epoch, r);
    assert.equal(v.outcome, "provisional", JSON.stringify(v.checks));
    assert.equal(v.checks.find((c) => c.id === "signatures")?.status, "pass");
    const d = jobReceipt(disagreed.id, asPayer(payer.address)) as JobReceipt;
    assert.equal(d.chargeStatus, "released", "not charged from the verdict on");
    assert.equal(d.outputHash, null);
    assert.equal(d.nodes.length, 2);
  });

  test("the charge commits the jobs root as listHash; while unconfirmed the receipt says so", async () => {
    const first = await chargeOpenEpoch(epoch);
    assert.match(first, /^charge failed: /);
    const stored = getDb().prepare("SELECT hash_rule, list_hash, status FROM charges WHERE epoch_id = ?").get(epoch) as {
      hash_rule: string;
      list_hash: Hex;
      status: string;
    };
    assert.equal(stored.hash_rule, "v2-jobs-merkle");
    const leaves = (getDb().prepare("SELECT leaf, job_id FROM charge_leaves WHERE epoch_id = ?").all(epoch) as { leaf: Hex; job_id: string }[]);
    assert.equal(buildTree(leaves.map((l) => l.leaf)).root, stored.list_hash, "listHash = root of the stored leaves");
    for (const id of [agreed.id, disagreed.id, teamJob.id]) assert.ok(leaves.some((l) => l.job_id === id), `job ${id.slice(0, 10)} in the tree`);
    // A failed (unsent) attempt is replaced, leaves and all, on the next try.
    assert.match(await chargeOpenEpoch(epoch), /^charge failed: /);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM charge_leaves WHERE epoch_id = ?").get(epoch) as { n: number }).n, leaves.length);

    getDb().prepare("UPDATE charges SET status = 'sending', tx = ? WHERE epoch_id = ?").run(randomHex(32), epoch);
    const r = jobReceipt(agreed.id, asPayer(payer.address)) as JobReceipt;
    assert.equal(r.state, "provisional");
    assert.deepEqual(r.pending, { reason: "charge-unconfirmed", epochId: epoch });
    getDb().prepare("UPDATE charges SET status = 'failed', tx = NULL WHERE epoch_id = ?").run(epoch);
  });

  test("sealed once the charge is confirmed: charged, released and team receipts verify against the Charged event", async () => {
    const tx = await chargeAndConfirm(epoch);
    for (const [job, who, verdict, chargeStatus] of [
      [agreed, payer.address, "agreed", "charged"],
      [disagreed, payer.address, "disagreed", "released"],
      [teamJob, team.address, "agreed", "charged"],
    ] as const) {
      const r = jobReceipt(job.id, asPayer(who)) as JobReceipt;
      assert.equal(r.state, "sealed");
      assert.equal(r.epochId, epoch);
      assert.equal(r.chargeTx, tx);
      assert.equal(r.verdict, verdict);
      assert.equal(r.chargeStatus, chargeStatus);
      assert.equal(r.pending, null);
      assert.equal(r.anchor?.listHash, chargesJson(epoch).listHash);
      assert.equal(
        r.anchor?.leaf,
        jobLeafOf(epoch, { jobId: job.id, payer: who, priceWei: job.price, verdict, chargeStatus, outputHash: verdict === "agreed" ? sha256Hex(Buffer.from(SAME, "utf8")) : null }),
      );
      const v = await verifyOn(epoch, r);
      assert.equal(v.outcome, "verified", `${verdict}/${chargeStatus}: ${JSON.stringify(v.checks)}`);
    }
    // The route answers the same sealed receipt.
    const res = await getReceipt(agreed.id, bearer(agreed.readSecret!));
    assert.equal(((await res.json()) as JobReceipt).state, "sealed");
  });

  test("a changed price on the sealed receipt no longer verifies", async () => {
    const r = jobReceipt(agreed.id, asPayer(payer.address)) as JobReceipt;
    const changed = { ...r, priceWei: "1" };
    assert.equal((await verifyOn(epoch, changed)).outcome, "failed");
  });

  test("the v2 charge list: per-customer totals and leaf hashes, no job ids (D7)", () => {
    const c = chargesJson(epoch) as Record<string, unknown> & { customers: { customer: string; amountWei: string }[]; leaves: Hex[]; listHash: Hex };
    assert.equal(c.hashRule, "v2-jobs-merkle");
    assert.equal(c.status, "done");
    assert.ok(!("jobs" in c), "no per-job list");
    const json = JSON.stringify(c);
    for (const id of [agreed.id, disagreed.id, teamJob.id]) assert.ok(!json.includes(id.slice(2)), "no job id in the public list");
    assert.equal(buildTree(c.leaves).root, c.listHash, "the leaves rebuild the listHash");
    const totalOf = (who: string) => c.customers.find((x) => x.customer.toLowerCase() === who.toLowerCase())?.amountWei;
    assert.equal(totalOf(team.address), teamJob.price.toString());
    assert.equal(BigInt(totalOf(payer.address) ?? "0") >= agreed.price, true);
    assert.equal(
      c.customers.reduce((s, x) => s + BigInt(x.amountWei), 0n).toString(),
      c.totalWei,
      "the totals add up to the charged total",
    );
    assert.deepEqual(c.codes, { verdict: { agreed: 1, disagreed: 2, expired: 3, rejected: 4 }, chargeStatus: { charged: 1, released: 2, unpaid: 3 } });
  });
});

describe("D15: an epoch that charges nothing has no on-chain anchor", () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  let released: Awaited<ReturnType<typeof paidJob>>;
  let quiet: number;

  test("only a not-charged job in the epoch: no charge, the receipt says no-anchor (not a failure)", async () => {
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE charge_status = 'pending' AND status = 'agreed'").get() as { n: number }).n,
      0,
      "a clean slate: nothing due",
    );
    // The epoch charged above is over (closed a little earlier, so it is not "after" the verdict below).
    closeLocal(currentEpochIdLocal(), nowSec() - 60);
    quiet = currentEpochIdLocal();
    released = await paidJob(payer, "released in a quiet epoch", "disagreed");
    assert.equal(await chargeOpenEpoch(quiet), "no paid jobs to charge");
    assert.equal(chargesJson(quiet).status, "none");
    const before = jobReceipt(released.id, asPayer(payer.address)) as JobReceipt;
    assert.deepEqual(before.pending, { reason: "waiting-for-charge", epochId: quiet }, "the epoch is still open");
    closeLocal(quiet);
    const r = jobReceipt(released.id, asPayer(payer.address)) as JobReceipt;
    assert.equal(r.state, "provisional");
    assert.deepEqual(r.pending, { reason: "no-anchor", epochId: quiet });
    const v = await verifyReceipt(JSON.parse(JSON.stringify(r)), {
      client: { getChainId: async () => targetChain.id, getTransactionReceipt: async () => assert.fail("no RPC call for a provisional receipt") },
      chainId: targetChain.id,
      paymentsContract: config.jobPayments!,
    });
    assert.equal(v.outcome, "no-anchor");
  });

  test("the next epoch that charges a job also commits the earlier not-charged job; its receipt then verifies", async () => {
    const next = currentEpochIdLocal();
    assert.equal(next, quiet + 1);
    const charged = await paidJob(payer, "charged in the next epoch", "agreed");
    await chargeAndConfirm(next);
    const r = jobReceipt(released.id, asPayer(payer.address)) as JobReceipt;
    assert.equal(r.state, "sealed");
    assert.equal(r.epochId, next, "anchored in the next charged epoch");
    assert.equal(r.chargeStatus, "released");
    assert.equal((await verifyOn(next, r)).outcome, "verified");
    assert.equal(((jobReceipt(charged.id, asPayer(payer.address)) as JobReceipt).epochId), next);
    // A job is committed once: a later charge does not take it again.
    closeLocal(next);
    await paidJob(payer, "one more", "agreed");
    await chargeAndConfirm(next + 1);
    const later = getDb().prepare("SELECT COUNT(*) AS n FROM charge_leaves WHERE job_id = ?").get(released.id) as { n: number };
    assert.equal(later.n, 1);
  });

  test("a job that settles while a charging close runs just missed that root: waiting, not no-anchor", async () => {
    const charging = currentEpochIdLocal();
    assert.equal(chargesJson(charging).status, "done");
    const late = await paidJob(payer, "settled during the close", "disagreed");
    closeLocal(charging);
    const r = jobReceipt(late.id, asPayer(payer.address)) as JobReceipt;
    assert.deepEqual(r.pending, { reason: "waiting-for-charge", epochId: charging + 1 });
  });
});

describe("charges stored before job receipts (v1)", () => {
  test("served exactly as stored, and a job charged then gets a 'charged before receipts' receipt", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const job = await paidJob(payer, "charged in a v1 list", "agreed");
    const epoch = 900;
    const list = [{ jobId: job.id, payer: payer.address, priceWei: job.price.toString(), apiKeyId: null }];
    const listHash = keccak256(toHex(JSON.stringify(list)));
    const tx = randomHex(32);
    // As a v8 scheduler stored it: no hash_rule given (the column default is 'v1').
    getDb()
      .prepare("INSERT INTO charges (epoch_id, list_json, list_hash, total_wei, status, tx, created_at) VALUES (?, ?, ?, ?, 'done', ?, ?)")
      .run(epoch, JSON.stringify(list), listHash, job.price.toString(), tx, nowSec());
    getDb().prepare("UPDATE jobs SET charge_status = 'charged', charged_epoch = ? WHERE id = ?").run(epoch, job.id);
    assert.deepEqual(chargesJson(epoch), {
      epochId: epoch,
      status: "done",
      listHash,
      totalWei: job.price.toString(),
      tx,
      jobs: list,
      hashRule: "keccak256(utf8(JSON.stringify(jobs))) with jobs sorted by jobId",
    });
    const r = jobReceipt(job.id, asPayer(payer.address)) as JobReceipt;
    assert.equal(r.state, "provisional");
    assert.deepEqual(r.pending, { reason: "charged-before-receipts", epochId: epoch });
    assert.equal(r.chargeStatus, "charged");
  });

  test("an epoch with no charge row answers status none", () => {
    assert.deepEqual(chargesJson(12345), { epochId: 12345, status: "none", jobs: [], totalWei: "0", listHash: null, tx: null });
  });
});
