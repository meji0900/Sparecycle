// SparecycleJobPaymentsV2 on the scheduler (TOKEN_PAYMENTS_V2, ./payments-v2), on a scratch SQLite DB, in-process: no
// chain, no GPU. Both payments contracts are stubs of publicClient.readContract / simulateContract /
// getTransactionReceipt that model the parts the scheduler reads (V2's previewSpareLeg and postSparePrice rules
// included); the scheduler key's broadcasts go through the module's test seam.
//   - pure rules: credits-first availability, SPARE availability, the pool price, minEthOut, the charge plan
//   - routing: a payment is charged on the contract it was signed for (V1 or V2), an API key's job V2 first; holds
//     follow V2's credits-first rule; SPARE jobs are refused until the Safe sets a reference price
//   - charging: per epoch a V1 charge for V1 jobs and one V2 charge (charge or chargeWithSpare) for V2 jobs, each with
//     its own jobs root; the SPARE price posted once per epoch from the pool; SPARE jobs wait (no reference, paused
//     price, a sale that would not fill) with a reason and are never charged at a wrong price; unpaid after 8 closes
//   - receipts version 2 (contract, asset, SPARE price) verify against V2's Charged and CustomerChargedSpare events;
//     invoices say why a SPARE job waits
//   - flag off: the account, charges, receipt and invoice answers are exactly the V1 ones
// Run: npm test
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, getAddress, toEventSelector, toFunctionSelector, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Environment before any src/ import (config.ts reads NEXT_PUBLIC_* at import time).
for (const k of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|VAST_|GPU_POOL_|OUTPUT_|AUTH_|TEAM_JOB_|CHALLENGE_|GPU_ALLOWLIST_|PROJECT_NODE_|TOKEN_)/.test(k)) delete process.env[k];
}
const dir = mkdtempSync(join(tmpdir(), "sparecycle-payments-v2-"));
const V1 = privateKeyToAccount(generatePrivateKey()).address;
const V2 = privateKeyToAccount(generatePrivateKey()).address;
const SPARE_TOKEN = privateKeyToAccount(generatePrivateKey()).address;
Object.assign(process.env, {
  NEXT_PUBLIC_NETWORK: "local",
  // Nothing listens on port 9: any read that slips past the stubs fails fast instead of reaching a chain.
  NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9",
  NEXT_PUBLIC_EXPLORER_URL: "https://explorer.test.invalid",
  NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS: V1,
  TOKEN_PAYMENTS_V2: "on",
  TOKEN_JOB_PAYMENTS_V2_ADDRESS: V2,
  SCHEDULER_SIGNER_KEY: generatePrivateKey(),
  DB_PATH: join(dir, "test.db"),
  SCHEDULER_ALLOW_DEV_RUNNER: "1",
  JOB_RATE_LIMIT: "1000",
});

const { getDb, nowSec, randomHex } = await import("./db");
const { submitJob } = await import("./jobs");
const { registerNode, pollForTask } = await import("./nodes");
const { submitResult } = await import("./results");
const { chargeOpenEpoch, chargesJson, accountJson } = await import("./payments");
const v2 = await import("./payments-v2");
const { ensureEpoch } = await import("./epochs");
const { jobReceipt } = await import("./receipts");
const { jobInvoice } = await import("./invoices");
const { linkMessage, sha256Hex, signReceipt, parseJobRequest } = await import("@/lib/protocol");
const { jobPaymentMessage, jobPriceWei, jobRequestHash, spareForWei } = await import("@/lib/job-payment");
const { verifyReceipt } = await import("@/lib/job-receipt");
const { jobPaymentsV2Abi } = await import("@/contracts/jobPaymentsV2");
const { publicClient, targetChain } = await import("@/lib/chain");
const { config } = await import("@/lib/config");
type ReceiptChainClient = import("@/lib/job-receipt").ReceiptChainClient;
type JobReceipt = import("@/lib/job-receipt").JobReceipt;

const Q96 = 1n << 96n;
const E18 = 10n ** 18n;
/** Test price: 0.0001 ETH per SPARE (wei per 1e18 SPARE units); the pool's sqrtPriceX96 for it is 100 x 2^96. */
const PRICE = 10n ** 14n;
const SQRT_AT_PRICE = 100n * Q96;

// ---- the two payments contracts ----------------------------------------------------------------------------------
type EpochPrice = { price: bigint; referencePrice: bigint; posted: boolean; accepted: boolean };
const chain = {
  v1: new Map<string, bigint>(),
  bal: new Map<string, bigint>(),
  cred: new Map<string, bigint>(),
  spare: new Map<string, bigint>(),
  withdraw: new Map<string, bigint>(),
  ref: 0n,
  cap: E18,
  split: [350, 0, 150] as [number, number, number],
  prices: new Map<number, EpochPrice>(),
  sqrtP: SQRT_AT_PRICE,
  failSim: new Set<string>(),
  simulated: [] as { address: string; functionName: string; args: readonly unknown[] }[],
  sent: [] as { functionName: string; args: readonly unknown[]; hash: Hex }[],
  mined: new Set<string>(),
};
const same = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();
const get = (m: Map<string, bigint>, who: string) => m.get(who.toLowerCase()) ?? 0n;
const add = (m: Map<string, bigint>, who: string, v: bigint) => m.set(who.toLowerCase(), get(m, who) + v);

function preview(epochId: bigint, ethLeg: bigint, value: bigint, minOut: bigint) {
  const p = chain.prices.get(Number(epochId));
  if (!p?.posted) return [1, 0n, 0n, 0n, 0n] as const;
  if (!p.accepted) return [2, 0n, 0n, 0n, 0n] as const;
  if (value > chain.cap) return [3, 0n, 0n, 0n, 0n] as const;
  const spareIn = spareForWei(value, p.price);
  const sold = spareIn - (spareIn * BigInt(chain.split[1])) / 10_000n;
  const floor = (((sold * p.price) / E18) * 9_600n) / 10_000n;
  const pot = value - (value * 500n) / 10_000n;
  const burner = (ethLeg * BigInt(chain.split[1])) / 10_000n;
  const holder = (ethLeg * BigInt(chain.split[2])) / 10_000n;
  const cover = (ethLeg * 500n) / 10_000n - burner - holder + burner;
  if (minOut < floor) return [4, spareIn, floor, pot, cover] as const;
  if (minOut + cover < pot) return [5, spareIn, floor, pot, cover] as const;
  return [0, spareIn, floor, pot, cover] as const;
}

const stubbed = publicClient as unknown as Record<string, (...a: unknown[]) => unknown>;
mock.method(stubbed, "readContract", async (...a: unknown[]) => {
  const { address, functionName, args = [] } = a[0] as { address: string; functionName: string; args?: readonly unknown[] };
  const who = String(args[0] ?? "");
  if (functionName === "getSlot0") return [chain.sqrtP, 0, 0, 0];
  if (functionName === "getLiquidity") return 10n ** 22n;
  if (same(address, V1)) {
    switch (functionName) {
      case "balanceOf":
        return get(chain.v1, who);
      case "spendLimitPerEpoch":
      case "chargedInEpoch":
        return 0n;
      case "withdrawRequestOf":
        return [0n, 0n, 0n];
      case "canWithdraw":
        return false;
    }
  }
  if (same(address, V2)) {
    switch (functionName) {
      case "balanceOf":
        return get(chain.bal, who);
      case "creditOf":
        return get(chain.cred, who);
      case "spareBalanceOf":
        return get(chain.spare, who);
      case "spendLimitPerEpoch":
      case "spareSpendLimitPerEpoch":
      case "chargedInEpoch":
      case "spareChargedInEpoch":
      case "spareEthChargedInEpoch":
        return 0n;
      case "withdrawRequestOf":
        return [get(chain.withdraw, who), 0n, 0n];
      case "spareWithdrawRequestOf":
        return [0n, 0n, 0n];
      case "canWithdraw":
      case "canWithdrawSpare":
        return false;
      case "spare":
        return SPARE_TOKEN;
      case "referenceSparePrice":
        return chain.ref;
      case "spareCapEthPerEpoch":
        return chain.cap;
      case "currentSplit":
        return chain.split;
      case "sparePriceOf":
        return chain.prices.get(Number(args[0])) ?? { price: 0n, referencePrice: 0n, posted: false, accepted: false };
      case "previewSpareLeg":
        return preview(args[0] as bigint, args[1] as bigint, args[2] as bigint, args[3] as bigint);
    }
  }
  throw new Error(`unexpected contract read ${functionName} on ${address}`);
});
mock.method(stubbed, "simulateContract", async (...a: unknown[]) => {
  const { address, functionName, args = [] } = a[0] as { address: string; functionName: string; args?: readonly unknown[] };
  chain.simulated.push({ address, functionName, args });
  if (chain.failSim.has(functionName)) throw new Error(`simulated revert of ${functionName}`);
  return { request: { address, functionName, args } };
});
mock.method(stubbed, "getBlockNumber", async () => 1_000n);
mock.method(stubbed, "getTransactionReceipt", async (...a: unknown[]) => {
  const { hash } = a[0] as { hash: string };
  if (!chain.mined.has(hash)) throw new Error("not found");
  return { status: "success" };
});
mock.method(stubbed, "waitForTransactionReceipt", async (...a: unknown[]) => {
  const { hash } = a[0] as { hash: string };
  if (!chain.mined.has(hash)) throw new Error("not mined");
  return { status: "success" };
});
/** The scheduler key's broadcasts: recorded; postSparePrice applies V2's band rule (20% around the reference). */
v2.setPaymentsV2TestSeams({
  send: async (_account, request) => {
    const r = request as { functionName: string; args: readonly unknown[] };
    const hash = randomHex(32);
    chain.sent.push({ functionName: r.functionName, args: r.args, hash });
    chain.mined.add(hash);
    if (r.functionName === "postSparePrice") {
      const [epochId, price] = r.args as [bigint, bigint];
      const ref = chain.ref;
      const diff = price > ref ? price - ref : ref - price;
      const accepted = ref !== 0n && diff * 10_000n <= ref * 2_000n;
      chain.prices.set(Number(epochId), { price, referencePrice: ref, posted: true, accepted });
      if (accepted) chain.ref = price;
    }
    return hash;
  },
});

after(() => {
  mock.restoreAll();
  v2.setPaymentsV2TestSeams({ send: null });
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---- nodes, jobs, epochs -----------------------------------------------------------------------------------------
type Node = { key: LocalAccount; owner: LocalAccount };
let nodeA: Node;
let nodeB: Node;
let ipSeq = 0;
const nextIp = () => `10.4.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

before(async () => {
  const mkNode = async (name: string): Promise<Node> => {
    const key = privateKeyToAccount(generatePrivateKey());
    const owner = privateKeyToAccount(generatePrivateKey());
    const ownerSig = await owner.signMessage({ message: linkMessage(key.address, owner.address) });
    await registerNode(key.address, {
      gpu: `TEST ${name}`,
      gpuUuid: `TEST-V2-GPU-${name}`,
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
const PRICE_ONE = priceOf(textRequest("x"));

/** Signs and submits a paid job for `contract` (undefined = no contract field, signed for V1) and `asset`. */
async function submitSigned(payer: LocalAccount, request: unknown, opts: { contract?: Address; asset?: "eth" | "spare"; signFor?: Address } = {}) {
  const priceWei = priceOf(request);
  const issued = nowSec();
  const message = jobPaymentMessage({
    chainId: targetChain.id,
    contract: opts.signFor ?? opts.contract ?? V1,
    requestHash: jobRequestHash(request),
    priceWei,
    issued,
    asset: opts.asset,
  });
  const signature = await payer.signMessage({ message });
  return submitJob(
    { request, payment: { payer: payer.address, signature, issued, priceWei: priceWei.toString(), ...(opts.contract ? { contract: opts.contract } : {}), ...(opts.asset ? { asset: opts.asset } : {}) } },
    nextIp(),
  );
}

const only = (id: string) => getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id != ? AND status IN ('open','leased')").run(id);
async function work(node: Node, text: string) {
  const a = await pollForTask(node.key.address, AbortSignal.abort());
  assert.ok(a && "taskId" in a, "the node got a job task");
  const outputHash = sha256Hex(Buffer.from(text, "utf8"));
  const signature = await signReceipt(node.key, targetChain.id, { jobId: a.jobId as Hex, node: node.key.address, outputHash, gpuMs: 10n, epoch: BigInt(a.epoch) });
  return submitResult(node.key.address, a.taskId, { outputHash, signature, gpuMs: 10, epoch: a.epoch, text, dev: true });
}
async function agree(id: string) {
  only(id);
  await work(nodeA, "same words");
  assert.equal((await work(nodeB, "same words")).status, "agreed");
}
const jobRow = (id: string) =>
  getDb().prepare("SELECT charge_status, charged_epoch, pay_contract, pay_asset, spare_price, spare_wei, pay_wait, pay_waits, receipt_epoch FROM jobs WHERE id = ?").get(id) as {
    charge_status: string;
    charged_epoch: number | null;
    pay_contract: string | null;
    pay_asset: string | null;
    spare_price: string | null;
    spare_wei: string | null;
    pay_wait: string | null;
    pay_waits: number;
    receipt_epoch: number | null;
  };
const openEpoch = () => (getDb().prepare("SELECT id FROM epochs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
function closeLocal(epoch: number) {
  const at = nowSec();
  getDb().prepare("UPDATE epochs SET status = 'closed-unposted', closed_at = ?, ended_at = ? WHERE id = ?").run(at, at, epoch);
  getDb().prepare("INSERT INTO epochs (id, clock, status, started_at, length, provisional) VALUES (?, 'scheduler-local', 'open', ?, 21600, 0)").run(epoch + 1, at);
}
/** Clears every job a test left pending (other suites' jobs never leak into a charge). */
function settleAll() {
  getDb().prepare("UPDATE jobs SET charge_status = 'released' WHERE charge_status = 'pending'").run();
  getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE status IN ('open','leased')").run();
}
const lastSent = (fn: string) => [...chain.sent].reverse().find((s) => s.functionName === fn);
const acct = (who: Address) => v2.accountJsonAll(who) as Promise<{ v2: NonNullable<Awaited<ReturnType<typeof v2.accountJsonV2>>> } & Record<string, unknown>>;

// ---- pure rules --------------------------------------------------------------------------------------------------
describe("pure rules", () => {
  test("credits first: holds use credits before deposits; a pending withdrawal locks only deposits", () => {
    const f = v2.v2EthAvailable;
    assert.equal(f({ credits: 0n, balance: 10n, withdrawAmount: 0n, held: 3n }), 7n);
    assert.equal(f({ credits: 5n, balance: 0n, withdrawAmount: 0n, held: 3n }), 2n);
    // credits 2, deposits 3 with 2 asked out: one hold of 1 comes from credits, 1 credit + 1 deposit left
    assert.equal(f({ credits: 2n, balance: 3n, withdrawAmount: 2n, held: 1n }), 2n);
    assert.equal(f({ credits: 2n, balance: 3n, withdrawAmount: 2n, held: 2n }), 1n);
    assert.equal(f({ credits: 2n, balance: 3n, withdrawAmount: 2n, held: 3n }), 0n);
    // a withdrawal can never make credits unspendable
    assert.equal(f({ credits: 4n, balance: 1n, withdrawAmount: 1n, held: 0n }), 4n);
    // deposits below the withdrawal (charges since the request): never negative
    assert.equal(f({ credits: 0n, balance: 1n, withdrawAmount: 5n, held: 0n }), 0n);
  });

  test("SPARE availability, the pool price and SPARE per job (0% discount, rounded up)", () => {
    assert.equal(v2.v2SpareAvailable({ balance: 10n, withdrawAmount: 3n, held: 4n }), 3n);
    assert.equal(v2.v2SpareAvailable({ balance: 10n, withdrawAmount: 8n, held: 4n }), 0n);
    assert.equal(v2.priceFromSqrtPriceX96(SQRT_AT_PRICE), PRICE);
    // the live pool on 27 Nov 2026 (docs/uniswap-v4-adapter.md): spot 38,829,344,367 wei per SPARE
    assert.equal(v2.priceFromSqrtPriceX96(402_068_041_980_415_802_526_053_282_136_449n), 38_829_344_367n);
    assert.equal(spareForWei(1n * E18, PRICE), 10_000n * E18);
    assert.equal(spareForWei(1n, 3n), 333_333_333_333_333_334n, "rounded up");
  });

  test("minEthOut: value minus the 2.90% hook and the buffer, never below the floor or the pot's uncovered need", () => {
    const base = { soldSpare: 10_000n * E18, price: PRICE, hookCutBps: 290, bufferBps: 100, potRequired: 0n, cover: 0n };
    assert.equal(v2.minEthOutFor({ ...base, floor: 0n }), (E18 * 9_610n) / 10_000n);
    assert.equal(v2.minEthOutFor({ ...base, floor: (E18 * 9_700n) / 10_000n }), (E18 * 9_700n) / 10_000n);
    assert.equal(v2.minEthOutFor({ ...base, floor: 0n, potRequired: E18, cover: 0n }), E18);
  });

  test("the plan: ETH and SPARE legs, unpaid, waits, the shared spend limit, the cap and the wait limit", () => {
    const a = getAddress(privateKeyToAccount(generatePrivateKey()).address);
    const b = getAddress(privateKeyToAccount(generatePrivateKey()).address);
    const due = [
      { id: "e1", payer: a, priceWei: 10n, asset: "eth" as const, waits: 0 },
      { id: "e2", payer: a, priceWei: 10n, asset: "eth" as const, waits: 0 },
      { id: "s1", payer: b, priceWei: 10n, asset: "spare" as const, waits: 0 },
      { id: "s2", payer: b, priceWei: 10n, asset: "spare" as const, waits: 8 },
    ];
    const budgets = new Map([
      [a.toLowerCase(), { eth: 15n, room: null, spare: 0n, spareRoom: null }],
      [b.toLowerCase(), { eth: 0n, room: null, spare: spareForWei(10n, PRICE), spareRoom: null }],
    ]);
    const p = v2.planV2Charge({ due, budgets, price: PRICE, blocked: null, capRoom: E18 });
    assert.deepEqual(p.eth.map((j) => j.id), ["e1"]);
    assert.deepEqual(p.unpaid, [{ id: "e2", reason: "balance" }, { id: "s2", reason: "spare-balance" }], "withdrawn ETH; a SPARE job past 8 waits");
    assert.deepEqual(p.spare.map((j) => [j.id, j.spareWei]), [["s1", spareForWei(10n, PRICE)]]);
    const blocked = v2.planV2Charge({ due, budgets, price: null, blocked: "no-reference", capRoom: 0n });
    assert.deepEqual(blocked.waits, [{ id: "s1", reason: "no-reference", counts: true }]);
    const capped = v2.planV2Charge({ due: due.slice(2, 3), budgets, price: PRICE, blocked: null, capRoom: 9n });
    assert.deepEqual(capped.waits.map((w) => w.reason), ["cap"]);
    const limited = v2.planV2Charge({
      due: [due[0], { ...due[2], payer: a }],
      budgets: new Map([[a.toLowerCase(), { eth: 100n, room: 15n, spare: E18, spareRoom: null }]]),
      price: PRICE,
      blocked: null,
      capRoom: E18,
    });
    assert.deepEqual(limited.eth.map((j) => j.id), ["e1"]);
    assert.deepEqual(limited.waits, [{ id: "s1", reason: "spend-limit", counts: false }], "the ETH-value limit is shared by both legs");
    assert.equal(v2.waitOfStatus("min-out"), "sale");
    assert.equal(v2.waitOfStatus("paused"), "paused");
    assert.equal(v2.waitOfStatus("ok"), null);
  });
});

// ---- routing and holds -------------------------------------------------------------------------------------------
describe("which contract holds the money", () => {
  test("a payment signed for V2 is charged on V2, one signed for V1 (old clients: no contract field) on V1", async () => {
    settleAll();
    const payer = privateKeyToAccount(generatePrivateKey());
    add(chain.v1, payer.address, 10n * PRICE_ONE);
    add(chain.bal, payer.address, 10n * PRICE_ONE);
    const onV2 = await submitSigned(payer, textRequest("v2 signed"), { contract: V2 });
    const prices = [priceOf(textRequest("v2 signed")), priceOf(textRequest("v1 signed, old client")), priceOf(textRequest("v2 signed, no field"))];
    assert.equal(onV2.contract, "v2");
    assert.equal(onV2.asset, "eth");
    assert.equal(jobRow(onV2.id).pay_contract, "v2");
    const onV1 = await submitSigned(payer, textRequest("v1 signed, old client"));
    assert.equal(onV1.contract, "v1");
    assert.equal(jobRow(onV1.id).pay_contract, null, "V1 jobs keep NULL, as before V2");
    // signed for V2 but without the field: still found and charged on V2
    const implicit = await submitSigned(payer, textRequest("v2 signed, no field"), { signFor: V2 });
    assert.equal(implicit.contract, "v2");
    // naming a contract that is not this scheduler's
    await assert.rejects(submitSigned(payer, textRequest("elsewhere"), { contract: getAddress(SPARE_TOKEN) }), (e: { code?: string }) => e.code === "unknown-contract");
    // the held amounts land on the contract the job is charged on
    const a = await acct(payer.address);
    assert.equal(a.held, prices[1].toString(), "V1 holds its one job");
    assert.equal(a.v2.held, (prices[0] + prices[2]).toString(), "V2 holds its two");
  });

  test("an API key's job: V2 first when its ETH covers the price, else V1", async () => {
    const owner = getAddress(privateKeyToAccount(generatePrivateKey()).address);
    add(chain.v1, owner, 5n * PRICE_ONE);
    assert.equal((await v2.keyPaidJob(owner, PRICE_ONE)).contract, "v1", "nothing on V2 yet");
    add(chain.cred, owner, PRICE_ONE);
    assert.equal((await v2.keyPaidJob(owner, PRICE_ONE)).contract, "v2", "V2 credits cover it");
    assert.equal((await v2.keyPaidJob(owner, 2n * PRICE_ONE)).contract, "v1", "V2 does not cover a bigger job");
  });

  test("credits first: holds spend credits before deposits, and a pending withdrawal never touches credits", async () => {
    settleAll();
    const payer = privateKeyToAccount(generatePrivateKey());
    const P = priceOf(textRequest("credit job 1"));
    add(chain.cred, payer.address, 2n * P);
    add(chain.bal, payer.address, 3n * P);
    chain.withdraw.set(payer.address.toLowerCase(), 2n * P);
    assert.equal((await acct(payer.address)).v2.available, (3n * P).toString(), "2 credits + 1 deposit not asked out");
    const r1 = await submitSigned(payer, textRequest("credit job 1"), { contract: V2 });
    assert.equal(r1.available, (2n * P).toString());
    const r2 = await submitSigned(payer, textRequest("credit job 2"), { contract: V2 });
    assert.equal(r2.available, P.toString(), "credits used up first");
    const r3 = await submitSigned(payer, textRequest("credit job 3"), { contract: V2 });
    assert.equal(r3.available, "0");
    await assert.rejects(submitSigned(payer, textRequest("credit job 4"), { contract: V2 }), (e: { status?: number; code?: string }) => e.status === 402 && e.code === "insufficient-balance");
    const a = await acct(payer.address);
    assert.equal(a.v2.credits, (2n * P).toString());
    assert.equal(a.v2.withdrawal?.amount, (2n * P).toString());
    chain.withdraw.delete(payer.address.toLowerCase());
  });

  test("SPARE jobs: refused until the Safe sets a reference price, then held in SPARE at it", async () => {
    settleAll();
    const payer = privateKeyToAccount(generatePrivateKey());
    const P = priceOf(textRequest("spare job"));
    add(chain.spare, payer.address, spareForWei(3n * P, PRICE));
    chain.ref = 0n;
    await assert.rejects(submitSigned(payer, textRequest("spare too early"), { contract: V2, asset: "spare" }), (e: { status?: number; code?: string }) => e.status === 409 && e.code === "spare-payments-closed");
    assert.equal((await acct(payer.address)).v2.spare.open, false);
    chain.ref = PRICE;
    // SPARE only on V2
    await assert.rejects(submitSigned(payer, textRequest("spare on v1"), { contract: V1, asset: "spare" }), (e: { status?: number }) => e.status === 400);
    const j = await submitSigned(payer, textRequest("spare job"), { contract: V2, asset: "spare" });
    assert.equal(j.contract, "v2");
    assert.equal(j.asset, "spare");
    assert.equal(jobRow(j.id).pay_asset, "spare");
    const a = await acct(payer.address);
    assert.equal(a.v2.spare.held, spareForWei(P, PRICE).toString(), "held in SPARE at the reference price");
    assert.equal(a.v2.spare.available, (spareForWei(3n * P, PRICE) - spareForWei(P, PRICE)).toString());
    assert.equal(a.v2.spare.discountBps, 0);
    // a SPARE signature does not pay an ETH job (the message differs)
    await assert.rejects(submitSigned(payer, textRequest("asset swapped"), { contract: V2, asset: "spare", signFor: V1 }), (e: { status?: number }) => e.status === 401);
  });
});

// ---- charging ----------------------------------------------------------------------------------------------------
describe("charging at the epoch close", () => {
  const ethPayer = privateKeyToAccount(generatePrivateKey());
  const sparePayer = privateKeyToAccount(generatePrivateKey());
  const v1Payer = privateKeyToAccount(generatePrivateKey());
  const ids: Record<string, string> = {};
  const price: Record<string, bigint> = {};
  /** Submits a paid job and runs it to agreement at once (other jobs' tasks are cancelled while it runs). */
  const agreed = async (name: string, payer: LocalAccount, prompt: string, opts: Parameters<typeof submitSigned>[2] = {}) => {
    const r = await submitSigned(payer, textRequest(prompt), opts);
    await agree(r.id);
    ids[name] = r.id;
    price[name] = priceOf(textRequest(prompt));
    return r.id;
  };

  before(async () => {
    settleAll();
    add(chain.bal, ethPayer.address, 100n * PRICE_ONE);
    add(chain.spare, sparePayer.address, spareForWei(100n * PRICE_ONE, PRICE));
    add(chain.v1, v1Payer.address, 100n * PRICE_ONE);
    chain.ref = PRICE; // open for the submission
    await agreed("eth", ethPayer, "v2 eth job", { contract: V2 });
    await agreed("spare", sparePayer, "v2 spare job", { contract: V2, asset: "spare" });
    await agreed("v1", v1Payer, "v1 job");
    chain.ref = 0n; // the Safe has not set the reference in this scenario yet
  });

  test("no reference: no price posted, ETH charged with charge(), the SPARE job waits with the reason; V1 charges only V1", async () => {
    const epoch = openEpoch();
    const sentBefore = chain.sent.length;
    const out = await v2.chargeOpenEpochV2(epoch);
    assert.match(out, /^V2: charged 1 ETH job\(s\) .* and 0 SPARE job\(s\)/, out);
    assert.ok(!chain.sent.slice(sentBefore).some((s) => s.functionName === "postSparePrice"), "nothing posted without a reference");
    const charge = lastSent("charge")!;
    assert.deepEqual(charge.args[1], [getAddress(ethPayer.address)]);
    assert.deepEqual(charge.args[2], [price.eth]);
    assert.equal(jobRow(ids.eth).charge_status, "charged");
    assert.equal(jobRow(ids.eth).receipt_epoch, epoch);
    assert.equal(jobRow(ids.spare).charge_status, "pending");
    assert.equal(jobRow(ids.spare).pay_wait, "no-reference");
    assert.equal(jobRow(ids.spare).pay_waits, 1);
    const inv = jobInvoice(ids.spare, { address: sparePayer.address, secret: null }) as Record<string, unknown> & { waiting: { reason: string; text: string } | null };
    assert.equal(inv.version, 2);
    assert.equal(inv.asset, "spare");
    assert.equal(inv.contract, "v2");
    assert.equal(inv.waiting?.reason, "no-reference");
    assert.match(inv.waiting!.text, /reference price/);
    // V1's charge of the same epoch takes the V1 job only (the send itself goes nowhere in this test)
    const simBefore = chain.simulated.length;
    await chargeOpenEpoch(epoch);
    const v1Sim = chain.simulated.slice(simBefore).find((s) => s.functionName === "charge" && same(s.address, V1))!;
    assert.deepEqual(v1Sim.args[1], [getAddress(v1Payer.address)]);
    // one V2 charge per epoch: a second call does nothing
    assert.match(await v2.chargeOpenEpochV2(epoch), /already charged/);
    const pub = v2.v2ChargesOf(epoch) as { v2: { status: string; customers: { customer: string }[]; spare: unknown; leaves: string[]; listHash: string } };
    assert.equal(pub.v2.status, "done");
    assert.equal(pub.v2.spare, null);
    assert.deepEqual(pub.v2.customers.map((c) => c.customer), [getAddress(ethPayer.address)]);
    assert.equal(pub.v2.listHash, charge.args[3]);
    closeLocal(epoch);
  });

  test("with a reference: the pool price is posted once, the SPARE job is charged with chargeWithSpare at it", async () => {
    chain.ref = PRICE;
    const epoch = openEpoch();
    const out = await v2.chargeOpenEpochV2(epoch);
    assert.match(out, /1 SPARE job\(s\)/, out);
    const post = lastSent("postSparePrice")!;
    assert.deepEqual(post.args, [BigInt(epoch), PRICE], "the pool's spot price, minus nothing");
    const c = lastSent("chargeWithSpare")!;
    const [e, cs, as_, ss, sa, minOut] = c.args as [bigint, Address[], bigint[], Address[], bigint[], bigint];
    assert.equal(e, BigInt(epoch));
    assert.deepEqual([cs, as_], [[], []], "no ETH jobs this epoch");
    assert.deepEqual(ss, [getAddress(sparePayer.address)]);
    assert.deepEqual(sa, [price.spare]);
    const sold = spareForWei(price.spare, PRICE);
    assert.equal(minOut, (((sold * PRICE) / E18) * 9_610n) / 10_000n, "value x (1 - 2.90% hook - 1% buffer), above the 4% floor");
    const row = jobRow(ids.spare);
    assert.equal(row.charge_status, "charged");
    assert.equal(row.spare_price, PRICE.toString());
    assert.equal(row.spare_wei, sold.toString());
    assert.equal(row.pay_wait, null);
    assert.equal(await v2.chargeOpenEpochV2(epoch).then((s) => /already charged/.test(s)), true);
    assert.equal(chain.sent.filter((s) => s.functionName === "postSparePrice" && s.args[0] === BigInt(epoch)).length, 1, "posted once");

    // receipt version 2, sealed, verified against V2's Charged and CustomerChargedSpare
    const receipt = jobReceipt(ids.spare, { address: sparePayer.address, secret: null }) as JobReceipt;
    assert.equal(receipt.version, 2);
    assert.equal(receipt.state, "sealed");
    assert.equal(receipt.paymentsContract, getAddress(V2));
    assert.deepEqual(receipt.payment, { contract: "v2", asset: "spare", spare: { priceWeiPer1e18Spare: PRICE.toString(), spareWei: sold.toString() } });
    const pub = v2.v2ChargesOf(epoch) as { v2: { listHash: Hex; tx: Hex; spare: { customers: { customer: Address; amountWei: string; spareWei: string }[] } } };
    const client = (spareAmount: bigint): ReceiptChainClient => ({
      getChainId: async () => targetChain.id,
      getTransactionReceipt: async () => ({
        status: "success",
        blockNumber: 9n,
        logs: [
          {
            address: V2,
            topics: encodeEventTopics({ abi: jobPaymentsV2Abi, eventName: "CustomerChargedSpare", args: { epochId: BigInt(epoch), customer: sparePayer.address } }) as Hex[],
            data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [price.spare, spareAmount]),
          },
          {
            address: V2,
            topics: encodeEventTopics({ abi: jobPaymentsV2Abi, eventName: "Charged", args: { epochId: BigInt(epoch), listHash: pub.v2.listHash } }) as Hex[],
            data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [0n, 0n, 0n]),
          },
        ],
      }),
    });
    assert.equal(pub.v2.spare.customers[0].spareWei, sold.toString(), "the public answer matches CustomerChargedSpare");
    const opts = { chainId: targetChain.id, paymentsContract: V1, paymentsContractV2: V2 };
    const ok = await verifyReceipt(JSON.parse(JSON.stringify(receipt)), { ...opts, client: client(sold) });
    assert.equal(ok.outcome, "verified", JSON.stringify(ok.checks));
    const wrongAmount = await verifyReceipt(JSON.parse(JSON.stringify(receipt)), { ...opts, client: client(sold - 1n) });
    assert.equal(wrongAmount.outcome, "failed", "a SPARE amount that is not the price at the stated rate fails");
    const tampered = JSON.parse(JSON.stringify(receipt)) as JobReceipt;
    tampered.payment!.spare!.priceWeiPer1e18Spare = (PRICE * 2n).toString();
    assert.equal((await verifyReceipt(tampered, { ...opts, client: client(sold) })).outcome, "failed", "a changed price fails");
    const noV2 = await verifyReceipt(JSON.parse(JSON.stringify(receipt)), { chainId: targetChain.id, paymentsContract: V1, client: client(sold) });
    assert.equal(noV2.outcome, "failed", "a site without V2 does not accept a V2 receipt");
    // the ETH job's receipt names V2 and ETH
    const ethReceipt = jobReceipt(ids.eth, { address: ethPayer.address, secret: null }) as JobReceipt;
    assert.deepEqual(ethReceipt.payment, { contract: "v2", asset: "eth", spare: null });
    closeLocal(epoch);
  });

  test("a price outside the band pauses SPARE for the epoch: the SPARE job waits, ETH is charged", async () => {
    chain.ref = PRICE;
    const sj = { id: await agreed("paused", sparePayer, "paused spare", { contract: V2, asset: "spare" }) };
    const ej = { id: await agreed("ethPaused", ethPayer, "eth next to paused", { contract: V2 }) };
    chain.sqrtP = SQRT_AT_PRICE / 2n; // the pool moved: 4x the price, far outside 20%
    const epoch = openEpoch();
    const out = await v2.chargeOpenEpochV2(epoch);
    assert.match(out, /1 ETH job\(s\).*0 SPARE job\(s\).*paused/, out);
    assert.equal(chain.prices.get(epoch)?.accepted, false);
    assert.equal(lastSent("charge")!.args[0], BigInt(epoch));
    assert.equal(jobRow(sj.id).pay_wait, "paused");
    assert.equal(jobRow(sj.id).charge_status, "pending", "never charged at a wrong price");
    assert.equal(jobRow(ej.id).charge_status, "charged");
    chain.sqrtP = SQRT_AT_PRICE;
    closeLocal(epoch);
  });

  test("a sale that would not fill: chargeWithSpare does not simulate, ETH goes alone, the SPARE job waits ('sale')", async () => {
    const ej = { id: await agreed("ethSale", ethPayer, "eth next to a failed sale", { contract: V2 }) };
    chain.failSim.add("chargeWithSpare");
    const epoch = openEpoch();
    const out = await v2.chargeOpenEpochV2(epoch);
    chain.failSim.delete("chargeWithSpare");
    assert.match(out, /1 ETH job\(s\).*0 SPARE job\(s\).*sale/, out);
    assert.equal(jobRow(ids.paused).pay_wait, "sale");
    assert.equal(jobRow(ids.paused).pay_waits, 2);
    assert.equal(jobRow(ej.id).charge_status, "charged");
    closeLocal(epoch);
  });

  test("after 8 waits a SPARE job is not charged at all (unpaid), with the reason on its invoice", async () => {
    getDb().prepare("UPDATE jobs SET pay_waits = 8 WHERE id = ?").run(ids.paused);
    chain.failSim.add("chargeWithSpare");
    const epoch = openEpoch();
    await v2.chargeOpenEpochV2(epoch);
    chain.failSim.delete("chargeWithSpare");
    assert.equal(jobRow(ids.paused).charge_status, "unpaid");
    const inv = jobInvoice(ids.paused, { address: sparePayer.address, secret: null }) as { chargeStatus: string; waiting: { text: string } | null };
    assert.equal(inv.chargeStatus, "unpaid");
    assert.match(inv.waiting!.text, /^Not charged: it waited 8 epoch closes/);
    closeLocal(epoch);
  });
});

// ---- flag off ----------------------------------------------------------------------------------------------------
describe("TOKEN_PAYMENTS_V2 off", () => {
  test("the account, charges, receipt and invoice answers are exactly V1's", async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    add(chain.v1, payer.address, 10n * PRICE_ONE);
    process.env.TOKEN_PAYMENTS_V2 = "off";
    try {
      assert.equal(v2.v2Address(), null);
      assert.deepEqual(await v2.accountJsonAll(payer.address), await accountJson(payer.address));
      assert.deepEqual(v2.v2ChargesOf(0), {});
      const j = await submitSigned(payer, textRequest("flag off"));
      assert.equal("contract" in j, false, "no new fields in the submit answer");
      await agree(j.id);
      const r = jobReceipt(j.id, { address: payer.address, secret: null }) as JobReceipt;
      assert.equal(r.version, 1);
      assert.equal("payment" in r, false);
      const inv = jobInvoice(j.id, { address: payer.address, secret: null }) as Record<string, unknown>;
      assert.equal(inv.version, 1);
      assert.equal("asset" in inv, false);
      assert.equal(chargesJson(0).epochId, 0);
      assert.equal(await v2.chargeOpenEpochV2(openEpoch()), "V2 payments off");
      // a signature for V2 is refused: only V1 exists
      await assert.rejects(submitSigned(payer, textRequest("v2 while off"), { contract: V2 }), (e: { status?: number }) => e.status === 401);
    } finally {
      process.env.TOKEN_PAYMENTS_V2 = "on";
    }
  });
});

// ---- ABI ---------------------------------------------------------------------------------------------------------
describe("ABI", () => {
  test("src/contracts/jobPaymentsV2.ts matches the compiled contract (when contracts/out exists)", (t) => {
    const file = join(process.cwd(), "contracts", "out", "SparecycleJobPaymentsV2.sol", "SparecycleJobPaymentsV2.json");
    if (!existsSync(file)) return t.skip("run forge build first");
    type Item = { type: string; name?: string; inputs?: readonly { type: string; components?: unknown; indexed?: boolean }[] };
    const sig = (e: Item) => `${e.name}(${(e.inputs ?? []).map((i) => i.type).join(",")})`;
    const sel = (e: Item) => (e.type === "event" ? toEventSelector(sig(e)) : toFunctionSelector(sig(e)));
    const compiled = new Set((JSON.parse(readFileSync(file, "utf8")).abi as Item[]).filter((e) => ["function", "event", "error"].includes(e.type)).map(sel));
    for (const e of jobPaymentsV2Abi as unknown as readonly Item[]) {
      if (!["function", "event", "error"].includes(e.type)) continue;
      // tuples: the selector uses the tuple's component types; sparePriceOf only returns one, its input is a uint64
      assert.ok(compiled.has(sel(e)), `${e.type} ${sig(e)} is not in the compiled SparecycleJobPaymentsV2`);
    }
  });
});
