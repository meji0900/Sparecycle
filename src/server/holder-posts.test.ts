// Holder-pool roots, live mode (SparecycleHolderPool and SparecycleJobPaymentsV2 set; src/server/holders.ts,
// holder-posts.ts, holder-api.ts): the epoch's funding read from V2's Distributed events, floored shares with the remainder
// left in the pool, skipped epochs, and the idempotent postRoot sending against a mock chain that enforces the contract's
// rules (closed epochs, strictly increasing ids, total <= available): posted once, in order; an on-chain root found after a
// crash is adopted without a send; a pending transaction is waited for; a dropped one is sent again only when the chain has
// no root; unpostable, conflict and failed states; RPC failures retried without counting. Then the public reads
// GET /api/v1/holders/epochs and /holders/:address through the catch-all route, with the flag off (404, as main) and on.
// Nothing is sent: holderPoolSender is replaced. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, mock, test } from "node:test";
import { ContractFunctionRevertedError, decodeFunctionData, encodeErrorResult, getAddress, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";

for (const k of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_|SCHEDULER_|TOKEN_|PROJECT_NODE_|PAID_TEST_)/.test(k)) delete process.env[k];
}
const dir = mkdtempSync(join(tmpdir(), "sparecycle-holder-posts-"));
const POOL = getAddress("0x00000000000000000000000000000000000f00d1");
const V2 = getAddress("0x00000000000000000000000000000000000b2b22");
Object.assign(process.env, {
  NEXT_PUBLIC_NETWORK: "local",
  NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9", // nothing listens: an unstubbed chain read fails fast
  NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS: "0x0000000000000000000000000000000000007e3a",
  SCHEDULER_SIGNER_KEY: generatePrivateKey(),
  TOKEN_HOLDER_POOL_ADDRESS: POOL,
  TOKEN_JOB_PAYMENTS_V2_ADDRESS: V2,
  TOKEN_SPARE_START_BLOCK: "5000",
  DB_PATH: join(dir, "test.db"),
});

const H = await import("./holders");
const P = await import("./holder-posts");
const { tokenChain, holderPoolSender } = await import("./chain-io");
const { getDb, getMeta } = await import("./db");
const { verifyProof } = await import("@/lib/merkle");
const { holderPoolAbi } = await import("@/lib/token-contracts");
const { FORBIDDEN_TOKEN_WORDS, HOLDER_MODE } = await import("@/lib/token-rules");
const { openApiDocument, OPENAPI_MODULES, listOperations } = await import("@/lib/openapi");
const { holdersApi } = await import("@/lib/openapi-holders");
const catchAll = await import("@/app/api/v1/[...path]/route");
const openapiRoute = await import("@/app/api/v1/openapi.json/route");

after(() => {
  mock.restoreAll();
  try {
    getDb().close();
  } catch {
    /* closed */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const SPARE = 10n ** 18n;
const who = (n: number) => getAddress(pad(toHex(n), { size: 20 })) as Address;
const hashOf = (n: number) => pad(toHex(n), { size: 32 }) as Hex;
const lower = (a: string) => a.toLowerCase();

test("live mode needs both contracts; the default infra here is live", () => {
  assert.equal(H.holderPostingLive(), true);
  assert.equal(H.holderPostingLive({ holderPool: POOL, jobPaymentsV2: null }), false);
  assert.equal(H.holderPostingLive({ holderPool: null, jobPaymentsV2: V2 }), false);
});

// ---- Preparing a live root --------------------------------------------------------------------------------------
describe("live root: funding from V2, floored shares, skipped epochs", () => {
  const B0 = 5_000n;
  const T0 = 1_820_000_000;
  const EPOCH = 21_600;
  const blockAt = (t: number) => B0 + BigInt(t - T0);
  const timeOf = (b: bigint) => T0 + Number(b - B0);
  const alice = who(0xa11ce);
  const bob = who(0xb0b);
  const carol = who(0xca401);
  const minter = who(0x1111);
  let k = 0;
  const raw = (time: number, from: Address, to: Address, value: bigint) => ({ block: blockAt(time), logIndex: k++, txHash: hashOf(9000 + k), from, to, value });
  const s5 = T0 + 1_000;
  const transfers = [
    raw(T0 + 10, "0x0000000000000000000000000000000000000000", minter, 10n ** 9n * SPARE),
    raw(T0 + 20, minter, alice, 100_000n * SPARE),
    raw(T0 + 30, minter, bob, 300_000n * SPARE),
    raw(T0 + 40, minter, carol, 600_000n * SPARE),
  ];
  let open = 6n;
  const funding = 10n ** 18n + 7n;
  let available = 10n ** 20n;

  const stubChain = () => {
    mock.method(tokenChain, "currentEpoch", async () => open);
    mock.method(tokenChain, "rewardsEpoch", async (id: bigint) => {
      const s = s5 + (Number(id) - 5) * EPOCH;
      return { startedAt: BigInt(s), endedAt: id < open ? BigInt(s + EPOCH) : 0n, settled: id < open };
    });
    mock.method(tokenChain, "headBlock", async () => blockAt(T0 + 10 * EPOCH));
    mock.method(tokenChain, "blockTime", async (b: bigint) => timeOf(b));
    mock.method(tokenChain, "lastBlockBefore", async (ts: number) => blockAt(ts - 1));
    mock.method(tokenChain, "spareTransfers", async (from: bigint, to: bigint) => transfers.filter((t) => t.block >= from && t.block <= to));
    mock.method(tokenChain, "slashedEvents", async () => []);
    mock.method(tokenChain, "modeSets", async () => []);
    mock.method(tokenChain, "isContract", async (a: Address) => lower(a) === lower(minter)); // the minter stands in for a contract
    mock.method(tokenChain, "holderFunding", async (epochId: bigint) => ({ total: epochId === 5n ? funding : 0n, txs: [] }));
    mock.method(tokenChain, "holderPoolAvailable", async () => available);
    mock.method(tokenChain, "safeNonce", async () => {
      throw new Error("live mode prepares no Safe transaction");
    });
    mock.method(tokenChain, "chargedEvent", async () => {
      throw new Error("live mode does not read the V1 charge");
    });
  };
  const epochRow = (id: number) => ({ id, started_at: s5 + (id - 5) * EPOCH, ended_at: s5 + (id - 4) * EPOCH, length: EPOCH });
  const insertEpoch = (id: number) =>
    getDb()
      .prepare("INSERT OR REPLACE INTO epochs (id, clock, status, started_at, length, provisional, ended_at, closed_at) VALUES (?, 'contract', 'posted', ?, ?, 0, ?, ?)")
      .run(id, epochRow(id).started_at, EPOCH, epochRow(id).ended_at, epochRow(id).ended_at);

  test("an epoch not yet closed on-chain is not computed: nothing stored, the ledger does not move, retried later", async () => {
    stubChain();
    insertEpoch(5);
    open = 5n;
    const line = await H.prepareHolderRoots();
    assert.match(line, /epoch 5: failed \(epoch 5 is not closed on-chain yet\)/);
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM token_holder_roots").get() as { n: number }).n, 0);
    assert.equal(getMeta("token_holder_block"), null);
    open = 6n;
  });

  test("shares are each holder's floored time-weighted share of the epoch's V2 funding; totalEth = their sum", async () => {
    stubChain();
    const line = await H.prepareHolderRoots();
    assert.match(line, /epoch 5: ready, 3 holders, total 1000000000000000006 of 1000000000000000007 wei funded/);
    const row = getDb().prepare("SELECT * FROM token_holder_roots WHERE epoch_id = 5").get() as Record<string, string | number | null>;
    assert.equal(row.status, "ready");
    assert.equal(row.funded_wei, funding.toString());
    assert.equal(row.total_eth_wei, (10n ** 18n + 6n).toString(), "0.1 + 0.3 + 0.6 ETH + 6 wei: 1 wei stays in the pool");
    assert.equal(row.fund_safe_tx, null, "V2 funds the pool itself: no Safe transaction");
    assert.equal(row.to_treasury_wei, null);
    const leaves = getDb().prepare("SELECT holder, mode, amount_wei, avg_balance_wei, leaf, proof FROM token_holder_leaves WHERE epoch_id = 5").all() as {
      holder: Address;
      mode: number;
      amount_wei: string;
      avg_balance_wei: string;
      leaf: Hex;
      proof: string;
    }[];
    const by = new Map(leaves.map((l) => [l.holder, l]));
    assert.deepEqual([...by.keys()].sort(), [alice, bob, carol].sort(), "the minter (a contract) is excluded");
    assert.equal(by.get(alice)!.amount_wei, (10n ** 17n).toString());
    assert.equal(by.get(bob)!.amount_wei, (3n * 10n ** 17n + 2n).toString());
    assert.equal(by.get(carol)!.amount_wei, (6n * 10n ** 17n + 4n).toString());
    assert.equal(by.get(bob)!.avg_balance_wei, (300_000n * SPARE).toString(), "held the whole epoch: the average is the balance");
    for (const l of leaves) {
      assert.equal(l.mode, HOLDER_MODE.credits);
      assert.equal(l.leaf, H.holderLeafOf(5n, l.holder, l.mode, BigInt(l.amount_wei)));
      assert.ok(verifyProof(JSON.parse(l.proof) as Hex[], row.root as Hex, l.leaf), "stored proof verifies");
    }
    const call = JSON.parse(row.post_call as string) as { data: Hex; from: string };
    assert.deepEqual(decodeFunctionData({ abi: holderPoolAbi, data: call.data }).args, [5n, row.root, 10n ** 18n + 6n]);
    assert.match(call.from, /holder-posts/);
  });

  test("available() below the funding caps the root; an epoch with no funding or no eligible holder is skipped", async () => {
    stubChain();
    insertEpoch(6);
    insertEpoch(7);
    open = 8n;
    available = 10n; // caps epoch 6? no: epoch 6 has no funding at all
    const line = await H.prepareHolderRoots();
    assert.match(line, /epoch 6: skipped \(no holder-pool funding in this epoch/);
    assert.match(line, /epoch 7: skipped/);
    const r6 = getDb().prepare("SELECT status, total_eth_wei, leaves, post_call FROM token_holder_roots WHERE epoch_id = 6").get() as Record<string, unknown>;
    assert.deepEqual([r6.status, r6.total_eth_wei, r6.leaves, r6.post_call], ["skipped", "0", 0, null]);

    // A direct call for a funded epoch with a small available(): the shares come from available, not the funding.
    getDb().prepare("DELETE FROM token_holder_roots WHERE epoch_id >= 5").run();
    getDb().prepare("DELETE FROM token_holder_leaves").run();
    getDb().prepare("DELETE FROM meta WHERE key = 'token_holder_block'").run();
    available = 10n ** 17n;
    const capped = await H.prepareHolderRoot(epochRow(5));
    assert.match(capped, /ready, 3 holders, total 100000000000000000 of 1000000000000000007 wei funded/);

    // No eligible holder: everyone below the minimum.
    getDb().prepare("DELETE FROM token_holder_roots").run();
    getDb().prepare("DELETE FROM meta WHERE key = 'token_holder_block'").run();
    const none = await H.prepareHolderRoot(epochRow(5), { ...H.defaultHolderInfra(), min: 10n ** 30n });
    assert.match(none, /skipped \(no eligible holder in this epoch: the funding stays in the pool\)/);
    getDb().prepare("DELETE FROM token_holder_roots").run();
    getDb().prepare("DELETE FROM token_holder_leaves").run();
    getDb().prepare("DELETE FROM meta WHERE key = 'token_holder_block'").run();
    getDb().prepare("DELETE FROM epochs").run();
    available = 10n ** 20n;
    mock.restoreAll();
  });
});

// ---- Posting against a mock pool ---------------------------------------------------------------------------------
type RootInfo = { root: Hex; total: bigint; claimed: bigint; postedInEpoch: bigint; claimableUntilEpoch: bigint; posted: boolean; rolledOver: boolean };
const EMPTY: RootInfo = { root: `0x${"00".repeat(32)}`, total: 0n, claimed: 0n, postedInEpoch: 0n, claimableUntilEpoch: 0n, posted: false, rolledOver: false };
const revert = (errorName: "EpochNotClosed" | "EpochNotPostable" | "TotalExceedsAvailable" | "NotScheduler", args: readonly unknown[] = []) =>
  new ContractFunctionRevertedError({
    abi: holderPoolAbi,
    functionName: "postRoot",
    data: encodeErrorResult({ abi: holderPoolAbi, errorName, args } as Parameters<typeof encodeErrorResult>[0]),
  });

/** The pool's postRoot rules (SparecycleHolderPool.sol), the reward contract's clock, and receipts. */
class MockPool {
  open = 20n;
  nextPostable = 0n;
  available = 10n ** 21n;
  roots = new Map<bigint, RootInfo>();
  postedTx = new Map<bigint, Hex>();
  receipts = new Map<string, "success" | "reverted" | null>();
  sends: { epochId: bigint; root: Hex; total: bigint; hash: Hex }[] = [];
  simulations = 0;
  /** Next send: "ok" | "reverted" (mined, reverted) | "lost" (sent, then the receipt wait fails) | an Error thrown by the simulation. */
  next: ("ok" | "reverted" | "lost" | Error)[] = [];
  private seq = 0;

  check(epochId: bigint, total: bigint) {
    if (epochId >= this.open) throw revert("EpochNotClosed", [epochId, this.open]);
    if (epochId < this.nextPostable) throw revert("EpochNotPostable", [epochId, this.nextPostable]);
    if (total > this.available) throw revert("TotalExceedsAvailable", [total, this.available]);
  }
  post(epochId: bigint, root: Hex, total: bigint, hash: Hex) {
    this.roots.set(epochId, { ...EMPTY, root, total, posted: true, postedInEpoch: this.open, claimableUntilEpoch: this.open + 8n });
    this.postedTx.set(epochId, hash);
    this.nextPostable = epochId + 1n;
    this.available -= total;
  }
  install() {
    mock.method(tokenChain, "currentEpoch", async () => this.open);
    mock.method(tokenChain, "holderRoot", async (id: bigint) => this.roots.get(id) ?? EMPTY);
    mock.method(tokenChain, "holderNextPostable", async () => this.nextPostable);
    mock.method(tokenChain, "holderRootPostedTx", async (id: bigint) => this.postedTx.get(id) ?? null);
    mock.method(holderPoolSender, "receiptStatus", async (hash: Hex) => this.receipts.get(lower(hash)) ?? null);
    mock.method(holderPoolSender, "postRoot", async (pool: Address, epochId: bigint, root: Hex, total: bigint, onSent: (h: Hex) => void) => {
      assert.equal(pool, POOL);
      this.simulations++;
      const step = this.next.shift() ?? "ok";
      if (step instanceof Error) throw step;
      this.check(epochId, total); // the simulation
      const hash = hashOf(0xbeef00 + ++this.seq);
      this.sends.push({ epochId, root, total, hash });
      onSent(hash);
      if (step === "lost") {
        this.receipts.set(lower(hash), null);
        throw new Error("Timed out while waiting for transaction");
      }
      if (step === "reverted") {
        this.receipts.set(lower(hash), "reverted");
        return { hash, success: false };
      }
      this.post(epochId, root, total, hash);
      this.receipts.set(lower(hash), "success");
      return { hash, success: true };
    });
  }
}

const rootHex = (n: number) => keccak256(toHex(`root-${n}`));
function readyRow(epochId: number, total = 1000n, fields: Record<string, string | number | null> = {}) {
  getDb()
    .prepare(
      `INSERT INTO token_holder_roots (epoch_id, status, total_eth_wei, root, leaves, from_block, created_at, funded_wei) VALUES (?, 'ready', ?, ?, 2, 100, 1, ?)`,
    )
    .run(epochId, total.toString(), rootHex(epochId), (total + 1n).toString());
  const keys = Object.keys(fields);
  if (keys.length) getDb().prepare(`UPDATE token_holder_roots SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE epoch_id = ?`).run(...keys.map((k) => fields[k]), epochId);
}
const row = (epochId: number) => getDb().prepare("SELECT * FROM token_holder_roots WHERE epoch_id = ?").get(epochId) as Record<string, string | number | null>;

describe("posting roots (mock chain with the pool's rules)", () => {
  let chain: MockPool;
  beforeEach(() => {
    mock.restoreAll();
    getDb().prepare("DELETE FROM token_holder_roots").run();
    chain = new MockPool();
    chain.install();
  });

  test("ready roots are posted in epoch order, once; a second run sends nothing", async () => {
    readyRow(6, 600n);
    readyRow(5, 500n);
    const line = await P.postHolderRoots();
    assert.match(line, /epoch 5: root .* posted, totalEth 500 wei .*\| epoch 6: root .* posted, totalEth 600 wei/);
    assert.deepEqual(chain.sends.map((s) => [s.epochId, s.total]), [[5n, 500n], [6n, 600n]]);
    for (const [id, s] of [[5, chain.sends[0]], [6, chain.sends[1]]] as const) {
      const r = row(id);
      assert.equal(r.status, "posted");
      assert.equal(r.posted_tx, s.hash);
      assert.equal(r.root, s.root);
      assert.equal(r.claimable_until, 28, "postedInEpoch + 8");
      assert.equal(r.pending_tx, null);
    }
    assert.equal(await P.postHolderRoots(), "holder roots: nothing to post");
    assert.equal(chain.sends.length, 2);
  });

  test("two runs at once (close + timer) still send each root once", async () => {
    readyRow(5);
    readyRow(6);
    await Promise.all([P.runHolderWork(), P.runHolderWork(), P.runHolderWork()]);
    assert.deepEqual(chain.sends.map((s) => s.epochId), [5n, 6n]);
  });

  test("a root already on-chain (crash after the send) is adopted with its RootPosted transaction, nothing sent", async () => {
    readyRow(7);
    chain.post(7n, rootHex(7), 1000n, hashOf(0x7777));
    const line = await P.postHolderRoots();
    assert.match(line, /epoch 7: root on-chain \(tx 0x0+7777\), marked posted/);
    assert.equal(chain.sends.length, 0);
    assert.equal(chain.simulations, 0);
    assert.deepEqual([row(7).status, row(7).posted_tx], ["posted", hashOf(0x7777)]);
  });

  test("another root on-chain for the epoch is a conflict: nothing sent, later epochs go on", async () => {
    readyRow(8);
    readyRow(9);
    chain.post(8n, rootHex(999), 1000n, hashOf(0x8888));
    const line = await P.postHolderRoots();
    assert.match(line, /epoch 8: CONFLICT/);
    assert.equal(row(8).status, "conflict");
    assert.match(String(row(8).note), /another root/);
    assert.deepEqual(chain.sends.map((s) => s.epochId), [9n]);
  });

  test("a sent transaction is waited for, never sent again while pending; once mined it is posted without a send", async () => {
    const pending = hashOf(0xaaaa);
    readyRow(10, 1000n, { status: "sent", pending_tx: pending, sent_at: Math.floor(Date.now() / 1000) - 60 });
    readyRow(11);
    chain.receipts.set(lower(pending), null);
    let line = await P.postHolderRoots();
    assert.match(line, /epoch 10: postRoot 0x0+aaaa not mined yet/);
    assert.equal(chain.sends.length, 0, "epoch 11 waits behind it (ids must increase)");
    // It gets mined.
    chain.post(10n, rootHex(10), 1000n, pending);
    chain.receipts.set(lower(pending), "success");
    line = await P.postHolderRoots();
    assert.match(line, /epoch 10: root on-chain \(tx 0x0+aaaa\), marked posted/);
    assert.deepEqual(chain.sends.map((s) => s.epochId), [11n]);
  });

  test("a transaction dropped for longer than the timeout is sent again only because the chain has no root", async () => {
    const dropped = hashOf(0xdddd);
    readyRow(12, 1000n, { status: "sent", pending_tx: dropped, sent_at: Math.floor(Date.now() / 1000) - P.SENT_TIMEOUT_S - 5 });
    await P.postHolderRoots();
    assert.deepEqual(chain.sends.map((s) => s.epochId), [12n]);
    assert.equal(row(12).status, "posted");
    assert.notEqual(row(12).posted_tx, dropped);
  });

  test("a send whose receipt wait fails stays `sent` and is not sent twice in the run", async () => {
    readyRow(13);
    readyRow(14);
    chain.next = ["lost"];
    const line = await P.postHolderRoots();
    assert.match(line, /epoch 13: postRoot 0x[0-9a-f]+ sent, receipt not confirmed/);
    assert.equal(row(13).status, "sent");
    assert.equal(row(13).pending_tx, chain.sends[0].hash);
    assert.equal(chain.sends.length, 1, "epoch 14 not attempted while 13 is pending");
  });

  test("an epoch the pool no longer accepts is unpostable; the next one is posted", async () => {
    chain.nextPostable = 16n;
    readyRow(15);
    readyRow(16);
    const line = await P.postHolderRoots();
    assert.match(line, /epoch 15: unpostable \(the pool accepts epochs from 16 on\)/);
    assert.equal(row(15).status, "unpostable");
    assert.equal(chain.simulations, 1, "only epoch 16 was simulated");
    assert.deepEqual(chain.sends.map((s) => s.epochId), [16n]);
  });

  test("an epoch not closed on-chain waits (nothing simulated)", async () => {
    chain.open = 17n;
    readyRow(17);
    assert.match(await P.postHolderRoots(), /epoch 17: not closed on-chain yet/);
    assert.equal(chain.simulations, 0);
    assert.equal(row(17).status, "ready");
  });

  test("an RPC failure is retried later without counting an attempt", async () => {
    readyRow(18);
    chain.next = [new Error("HTTP request failed. fetch failed")];
    const line = await P.postHolderRoots();
    assert.match(line, /epoch 18: not sent \(.*fetch failed.*\); retried later/);
    assert.deepEqual([row(18).status, row(18).post_attempts], ["ready", 0]);
    assert.match(String(row(18).post_error), /fetch failed/);
    await P.postHolderRoots();
    assert.deepEqual([row(18).status, row(18).post_error], ["posted", null]);
  });

  test("a contract revert counts; after MAX_POST_ATTEMPTS the root is failed and later epochs go on", async () => {
    readyRow(19, 10n ** 30n); // more than available(): TotalExceedsAvailable
    readyRow(21);
    chain.open = 30n;
    for (let i = 1; i <= P.MAX_POST_ATTEMPTS; i++) {
      const line = await P.postHolderRoots();
      assert.match(line, new RegExp(`epoch 19: postRoot refused \\(reverted: TotalExceedsAvailable\\), attempt ${i} of ${P.MAX_POST_ATTEMPTS}`));
    }
    assert.equal(row(19).status, "failed");
    assert.deepEqual(chain.sends.map((s) => s.epochId), [21n], "epoch 21 went on after 19 failed");
  });

  test("a mined revert counts as an attempt and the root is sent again on the next run", async () => {
    readyRow(22);
    chain.open = 30n;
    chain.next = ["reverted"];
    assert.match(await P.postHolderRoots(), /epoch 22: postRoot refused \(transaction 0x[0-9a-f]+ reverted\), attempt 1/);
    assert.deepEqual([row(22).status, row(22).post_attempts, row(22).pending_tx], ["ready", 1, null]);
    await P.postHolderRoots();
    assert.equal(row(22).status, "posted");
    assert.equal(chain.sends.length, 2);
  });

  test("without the scheduler key nothing is sent", async () => {
    readyRow(23);
    const key = process.env.SCHEDULER_SIGNER_KEY;
    delete process.env.SCHEDULER_SIGNER_KEY;
    try {
      assert.match(await P.postHolderRoots(), /SCHEDULER_SIGNER_KEY or the reward contract not set, nothing sent/);
      assert.equal(chain.simulations, 0);
    } finally {
      process.env.SCHEDULER_SIGNER_KEY = key;
    }
  });
});

test("the sender: postRoot goes through sendAsScheduler only, and holder-posts.ts holds no key or wallet code", () => {
  const io = readFileSync(join(import.meta.dirname, "chain-io.ts"), "utf8");
  const sender = io.slice(io.indexOf("export const holderPoolSender"), io.indexOf("export const tokenChain"));
  assert.match(sender, /functionName: "postRoot"/);
  assert.match(sender, /sendAsScheduler\(\(\) => wallet\.writeContract\(request\)\)/);
  assert.equal((sender.match(/writeContract/g) ?? []).length, 1, "one write, postRoot");
  assert.ok(sender.indexOf("simulateContract") < sender.indexOf("writeContract"), "simulated before it is sent");
  const posts = readFileSync(join(import.meta.dirname, "holder-posts.ts"), "utf8");
  for (const bad of ["createWalletClient", "writeContract", "sendTransaction", "privateKeyToAccount", "signerKey", "schedulerAccount"]) {
    assert.ok(!posts.includes(bad), `holder-posts.ts uses ${bad}`);
  }
});

// ---- Public reads ------------------------------------------------------------------------------------------------
describe("GET /api/v1/holders/epochs and /api/v1/holders/:address", () => {
  const holder = who(0xa11ce);
  const other = who(0xb0b);
  const get = (path: string) => catchAll.GET(new Request(`http://local/api/v1/${path}`), { params: Promise.resolve({ path: path.split("/") }) });

  const seed = () => {
    mock.restoreAll();
    const db = getDb();
    db.prepare("DELETE FROM token_holder_roots").run();
    db.prepare("DELETE FROM token_holder_leaves").run();
    db.prepare("DELETE FROM epochs").run();
    db.prepare("INSERT INTO epochs (id, clock, status, started_at, length, provisional) VALUES (40, 'contract', 'open', 1, 21600, 0)").run();
    const ins = db.prepare(
      "INSERT INTO token_holder_roots (epoch_id, status, total_eth_wei, funded_wei, root, leaves, created_at, posted_tx, claimable_until, post_error, post_call) VALUES (?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?)",
    );
    // 30: posted long ago, window over; 35 and 36: posted, claimable; 37: ready (not posted yet); 38: skipped.
    const trees = new Map<number, ReturnType<typeof H.buildHolderTree>>();
    for (const id of [30, 35, 36, 37]) {
      const t = H.buildHolderTree(id, [
        { holder: holder, mode: HOLDER_MODE.credits, amount: 1000n + BigInt(id), weight: 1n },
        { holder: other, mode: HOLDER_MODE.credits, amount: 7n, weight: 1n },
      ]);
      trees.set(id, t);
      const posted = id !== 37;
      // Posted in epoch id + 1: claimable until id + 1 + 8 (epoch 30's window ended at 39; the open epoch is 40).
      const until = posted ? id + 9 : null;
      ins.run(id, posted ? "posted" : "ready", String(1007n + BigInt(id)), String(1010n + BigInt(id)), t.tree.root, 100 + id, posted ? hashOf(id) : null, until, "HTTP request failed. URL: https://secret-rpc.example/key", '{"unsigned":true}');
      const insL = db.prepare("INSERT INTO token_holder_leaves (epoch_id, holder, mode, avg_balance_wei, amount_wei, leaf, proof) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const l of t.leaves) insL.run(id, l.holder, l.mode, (250_000n * SPARE).toString(), l.amount.toString(), l.leaf, JSON.stringify(l.proof));
    }
    db.prepare("INSERT INTO token_holder_roots (epoch_id, status, total_eth_wei, funded_wei, root, leaves, created_at, note) VALUES (38, 'skipped', '0', '0', ?, 0, 200, 'no holder-pool funding in this epoch')").run(`0x${"00".repeat(32)}`);
    mock.method(tokenChain, "holderHasClaimed", async (epochId: bigint) => epochId === 35n);
    mock.method(tokenChain, "creditOf", async () => 1035n);
    return trees;
  };

  test("flag off: both paths are the catch-all's JSON 404, exactly as an unknown path; OpenAPI unchanged", async () => {
    seed();
    delete process.env.TOKEN_HOLDERS;
    const unknown = await get("no-such-thing");
    for (const p of ["holders/epochs", `holders/${holder}`]) {
      const r = await get(p);
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), await (await get("no-such-thing")).json());
    }
    assert.equal(unknown.status, 404);
    const doc = await (await openapiRoute.GET()).json();
    assert.deepEqual(doc, JSON.parse(JSON.stringify(openApiDocument())), "the description main serves");
    assert.ok(!Object.keys(doc.paths).some((p) => p.startsWith("/holders")));
  });

  test("flag on: epochs list with status, totals and transaction links; no error text or payload", async () => {
    seed();
    process.env.TOKEN_HOLDERS = "on";
    try {
      const r = await get("holders/epochs");
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.live, true);
      assert.equal(body.contracts.holderPool.address, POOL);
      assert.equal(body.lastComputedAt, 200);
      assert.equal(body.rules.minimumSpareWei, (100_000n * SPARE).toString());
      assert.equal(body.rules.rolloverEpochs, 8);
      assert.match(body.rules.method, /Time-weighted average SPARE balance over the epoch \(six hours\)/);
      assert.ok(body.rules.exclusions.some((e: { label: string }) => e.label === "Treasury Safe"));
      assert.deepEqual(body.epochs.map((e: { epochId: number; status: string }) => [e.epochId, e.status]), [[38, "skipped"], [37, "ready"], [36, "posted"], [35, "posted"], [30, "posted"]]);
      const e36 = body.epochs[2];
      assert.equal(e36.postedTx.url, `https://robinhoodchain.blockscout.com/tx/${hashOf(36)}`);
      assert.equal(e36.totalWei, "1043");
      const text = JSON.stringify(body);
      assert.ok(!text.includes("secret-rpc"), "no post_error");
      assert.ok(!text.includes("unsigned"), "no prepared payload");
      const lowerText = text.toLowerCase();
      for (const w of FORBIDDEN_TOKEN_WORDS) assert.ok(!new RegExp(`\\b${w}${w === "earn" ? "(s|ed|ing)?" : ""}\\b`).test(lowerText), `"${w}" in the API copy`);
    } finally {
      delete process.env.TOKEN_HOLDERS;
    }
  });

  test("flag on: an address's leaves with proofs, claim window, claimed state and credit balance", async () => {
    const trees = seed();
    process.env.TOKEN_HOLDERS = "on";
    try {
      assert.equal((await get("holders/0x1234")).status, 400);
      const body = await (await get(`holders/${holder.toLowerCase()}`)).json();
      assert.equal(body.address, holder);
      assert.equal(body.creditWei, "1035");
      assert.equal(body.openEpoch, 40);
      const states = Object.fromEntries(body.entries.map((e: { epochId: number; state: string }) => [e.epochId, e.state]));
      assert.deepEqual(states, { 37: "pending", 36: "claimable", 35: "claimed", 30: "expired" });
      assert.equal(body.claimableWei, "1036");
      const e36 = body.entries.find((e: { epochId: number }) => e.epochId === 36);
      assert.equal(e36.claimableUntilEpoch, 45);
      assert.equal(e36.modeLabel, "compute credits");
      assert.ok(verifyProof(e36.proof, trees.get(36)!.tree.root, e36.leaf));
      assert.deepEqual(e36.claim.args, [36, 1, "1036", e36.proof]);
      assert.equal(e36.claim.contract, POOL);
      assert.equal(body.entries.find((e: { epochId: number }) => e.epochId === 35).claim, null, "claimed: no call offered");
      const nobody = await (await get(`holders/${who(0xffff)}`)).json();
      assert.deepEqual(nobody.entries, []);
      assert.equal(nobody.claimableWei, "0");
    } finally {
      delete process.env.TOKEN_HOLDERS;
    }
  });

  test("flag on: the OpenAPI description adds exactly the two holder paths, and every $ref resolves", async () => {
    process.env.TOKEN_HOLDERS = "on";
    try {
      const doc = await (await openapiRoute.GET()).json();
      const base = openApiDocument();
      assert.deepEqual(Object.keys(doc.paths).filter((p) => !(p in base.paths)), ["/holders/epochs", "/holders/{address}"]);
      const merged = openApiDocument([...OPENAPI_MODULES, holdersApi]);
      assert.deepEqual(listOperations(merged).filter((o) => o.path.startsWith("/holders")).map((o) => o.op.operationId), ["listHolderEpochs", "getHolderAccount"]);
      for (const r of JSON.stringify(doc).match(/"\$ref":"([^"]+)"/g) ?? []) {
        const [, , kind, name] = r.slice(8, -1).split("/");
        assert.ok(doc.components[kind]?.[name], `unresolved ${r}`);
      }
    } finally {
      delete process.env.TOKEN_HOLDERS;
    }
  });
});
