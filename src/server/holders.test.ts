// Holder weights (brief §6.1–6.2, credit mode; src/server/holders.ts) against an independent second-by-second reference
// on RECORDED SPARE Transfer logs (src/server/test-fixtures/spare-transfers-recorded.json: 141 real mainnet logs, 62
// addresses) plus labelled synthetic scenarios: SPARE bought just before an epoch ends and sold right after gets no more
// than its true time share; staked SPARE counts for its owner and an executed slash takes it; excluded addresses (the
// list, the zero / dead address, contracts unless allow-listed) are never in a root; the minimum (N11); setMode counts
// from the next epoch and a default of credits (N18); the leaf layout; and the runner (ledger, root, the prepared and
// unsigned postRoot call and Safe funding transaction) on a scratch DB with every chain read stubbed. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, mock, test } from "node:test";
import { concat, decodeFunctionData, getAddress, keccak256, numberToHex, pad, type Address, type Hex } from "viem";

for (const k of Object.keys(process.env)) {
  if (/^(NEXT_PUBLIC_|SCHEDULER_|TOKEN_|PROJECT_NODE_|PAID_TEST_)/.test(k)) delete process.env[k];
}
const dir = mkdtempSync(join(tmpdir(), "sparecycle-holders-"));
Object.assign(process.env, {
  NEXT_PUBLIC_NETWORK: "local",
  NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9", // nothing listens: an unstubbed chain read fails fast
  NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS: "0x00000000000000000000000000000000000000a1",
  DB_PATH: join(dir, "test.db"),
});

const H = await import("./holders");
const { tokenChain } = await import("./chain-io");
const { getDb, getMeta } = await import("./db");
const { ADDR, BURN_SINKS, HOLDER_EXCLUSIONS } = await import("@/lib/addresses");
const { PONS } = await import("@/lib/pons");
const { buildTree, getProof, verifyProof } = await import("@/lib/merkle");
const { HOLDER_MIN_SPARE_WEI, HOLDER_MODE, holderShareOf } = await import("@/lib/token-rules");
const { holderPoolAbi } = await import("@/lib/token-contracts");

after(() => {
  mock.restoreAll();
  try {
    getDb().close();
  } catch {
    /* closed */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

type T = { block: bigint; logIndex: number; txHash: Hex; time: number; from: Address; to: Address; value: bigint; slashedOwner?: Address | null };
const SPARE = 10n ** 18n;
const lower = (a: string) => a.toLowerCase();

// ---- the independent reference: replay every second, sum what each address holds -----------------------------------
/**
 * Held = wallet + staked: staking or unstaking moves nothing (N15), stake -> sink takes the slashed owner's, any other
 * transfer moves `value` from `from` to `to`. Second s sees every transfer with time <= s. Written apart from holders.ts.
 */
function reference(start: number, end: number, opening: Map<string, bigint>, transfers: T[], stake: string | null): Map<string, bigint> {
  const held = new Map(opening);
  const sum = new Map<string, bigint>();
  const sinks = new Set([lower(BURN_SINKS.zero), lower(BURN_SINKS.dead)]);
  let i = 0;
  for (let s = start; s < end; s++) {
    for (; i < transfers.length && transfers[i].time <= s; i++) {
      const t = transfers[i];
      const from = lower(t.from);
      const to = lower(t.to);
      if (stake && (from === stake || to === stake)) {
        if (from === stake && sinks.has(to) && t.slashedOwner) {
          held.set(lower(t.slashedOwner), (held.get(lower(t.slashedOwner)) ?? 0n) - t.value);
          held.set(to, (held.get(to) ?? 0n) + t.value); // the sink holds what was burned (always excluded)
        }
        continue;
      }
      if (from !== lower(BURN_SINKS.zero)) held.set(from, (held.get(from) ?? 0n) - t.value);
      held.set(to, (held.get(to) ?? 0n) + t.value);
    }
    for (const [a, v] of held) if (v !== 0n) sum.set(a, (sum.get(a) ?? 0n) + v);
  }
  const out = new Map<string, bigint>();
  for (const [a, v] of sum) if (v > 0n) out.set(a, v / BigInt(end - start));
  return out;
}

const ledgerOf = (m: Map<string, bigint>) => new Map([...m].map(([a, v]) => [a, { wallet: v, staked: 0n }]));

// ---- the recorded logs -------------------------------------------------------------------------------------------
const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "test-fixtures", "spare-transfers-recorded.json"), "utf8")) as {
  fromTime: number;
  toTime: number;
  logs: { block: number; logIndex: number; txHash: Hex; time: number; from: string; to: string; value: string }[];
};
const recordedTransfers: T[] = recorded.logs.map((l) => ({
  block: BigInt(l.block),
  logIndex: l.logIndex,
  txHash: l.txHash,
  time: l.time,
  from: getAddress(l.from),
  to: getAddress(l.to),
  value: BigInt(l.value),
}));
/** Opening balances that make the recorded window a consistent history (nobody sends more than they hold). */
function consistentOpening(ts: T[]): Map<string, bigint> {
  const bal = new Map<string, bigint>();
  const need = new Map<string, bigint>();
  for (const t of ts) {
    const f = lower(t.from);
    if (f !== lower(BURN_SINKS.zero)) {
      const b = (bal.get(f) ?? 0n) - t.value;
      bal.set(f, b);
      if (b < -(need.get(f) ?? 0n)) need.set(f, -b);
    }
    bal.set(lower(t.to), (bal.get(lower(t.to)) ?? 0n) + t.value);
  }
  return need;
}
const EPOCH = 21_600;

describe("time-weighted weights on recorded Transfer logs", () => {
  const start = recorded.fromTime;
  const end = start + EPOCH;
  const opening = consistentOpening(recordedTransfers);

  test("the fixture is what it says: 141 mainnet logs inside one epoch", () => {
    assert.equal(recordedTransfers.length, 141);
    assert.ok(recordedTransfers.every((t) => t.time >= start && t.time < end));
    assert.ok(new Set(recordedTransfers.flatMap((t) => [t.from, t.to])).size >= 60);
  });

  test("every address's average equals the second-by-second reference exactly", () => {
    const { averages } = H.timeWeightedAverages({ start, end, opening: ledgerOf(opening), transfers: recordedTransfers, stake: null });
    const ref = reference(start, end, opening, recordedTransfers, null);
    assert.ok(ref.size > 20);
    assert.deepEqual(new Map([...averages].sort()), new Map([...ref].sort()));
  });

  test("the closing ledger equals opening plus every transfer", () => {
    const { closing } = H.timeWeightedAverages({ start, end, opening: ledgerOf(opening), transfers: recordedTransfers, stake: null });
    const net = new Map(opening);
    for (const t of recordedTransfers) {
      net.set(lower(t.from), (net.get(lower(t.from)) ?? 0n) - t.value);
      net.set(lower(t.to), (net.get(lower(t.to)) ?? 0n) + t.value);
    }
    for (const [a, v] of net) assert.equal(closing.get(a)?.wallet ?? 0n, v, a);
  });

  test("the Pons hook (on the list) and a contract never reach a root; holders split the share pro rata", () => {
    const { averages } = H.timeWeightedAverages({ start, end, opening: ledgerOf(opening), transfers: recordedTransfers, stake: null });
    const hook = lower(PONS.memeHook);
    const busiest = "0x8366a39cc670b4001a1121b8f6a443a643e40951"; // most transfers in the window: treated as a contract here
    assert.ok(averages.has(hook) || recordedTransfers.some((t) => lower(t.to) === hook));
    const excluded = new Set(HOLDER_EXCLUSIONS.flatMap((e) => (e.address ? [lower(e.address)] : [])));
    const el = H.eligibleWeights(averages, { excluded, allowlist: new Set(), contracts: new Set([busiest]), min: 1n });
    const total = 3n * 10n ** 15n;
    const shares = H.allocateHolderShares(total, el.eligible);
    const { tree, leaves } = H.buildHolderTree(9, shares.map((s) => ({ ...s, mode: HOLDER_MODE.credits })));
    const inRoot = new Set(leaves.map((l) => lower(l.holder)));
    for (const a of [...excluded, busiest, hook]) assert.ok(!inRoot.has(a), `${a} must not be in the root`);
    assert.ok(leaves.length > 10);
    const paid = leaves.reduce((s, l) => s + l.amount, 0n);
    assert.ok(paid <= total && total - paid < BigInt(leaves.length), "floored pro rata: never more than the share");
    for (const l of leaves) assert.ok(verifyProof(getProof(tree, l.leaf), tree.root, l.leaf));
    // Pro rata to the weight: the biggest weight gets the biggest amount.
    const top = [...el.eligible].sort((a, b) => (a[1] < b[1] ? 1 : -1))[0][0];
    assert.equal(lower(leaves.reduce((m, l) => (l.amount > m.amount ? l : m)).holder), lower(top));
  });
});

describe("synthetic scenarios (labelled: not recorded)", () => {
  const start = 1_800_000_000;
  const end = start + EPOCH;
  const pool = getAddress("0x00000000000000000000000000000000000b0001");
  const alice = getAddress("0x00000000000000000000000000000000000a11ce");
  const bob = getAddress("0x0000000000000000000000000000000000000b0b");
  const carol = getAddress("0x00000000000000000000000000000000000ca201");
  const dave = getAddress("0x0000000000000000000000000000000000000da5");
  const stake = getAddress("0x000000000000000000000000000000000057a4e0");
  let n = 0;
  const tr = (time: number, from: Address, to: Address, value: bigint, slashedOwner: Address | null = null): T => ({
    block: BigInt(1000 + time - start),
    logIndex: n++,
    txHash: pad(numberToHex(n), { size: 32 }),
    time,
    from,
    to,
    value,
    slashedOwner,
  });

  test("bought one block before the end and sold right after: no more than the true time share", () => {
    const opening = new Map([[lower(pool), 100_000_000n * SPARE], [lower(alice), 200_000n * SPARE]]);
    const buy = tr(end - 2, pool, bob, 50_000_000n * SPARE); // held for the last 2 seconds of the epoch
    const { averages, closing } = H.timeWeightedAverages({ start, end, opening: ledgerOf(opening), transfers: [buy], stake: null });
    const trueShare = (50_000_000n * SPARE * 2n) / BigInt(EPOCH);
    assert.equal(averages.get(lower(bob)), trueShare);
    assert.ok(averages.get(lower(bob))! < HOLDER_MIN_SPARE_WEI, "far below the minimum: no share at all");
    assert.equal(averages.get(lower(alice)), 200_000n * SPARE, "a steady holder weighs its whole balance");
    // The sale right after the end belongs to the next epoch: there bob weighs 0 seconds of it.
    const next = H.timeWeightedAverages({ start: end, end: end + EPOCH, opening: closing, transfers: [tr(end, bob, pool, 50_000_000n * SPARE)], stake: null });
    assert.equal(next.averages.get(lower(bob)) ?? 0n, 0n);
    const el = H.eligibleWeights(averages, { excluded: new Set([lower(pool)]), allowlist: new Set(), contracts: new Set(), min: HOLDER_MIN_SPARE_WEI });
    assert.deepEqual([...el.eligible.keys()], [alice]);
    assert.deepEqual(el.belowMin, [lower(bob)]);
  });

  test("staked SPARE counts for its owner (N15); an executed slash takes it from the owner", () => {
    const opening = new Map([[lower(dave), 400_000n * SPARE]]);
    const ts = [
      tr(start + 3_600, dave, stake, 300_000n * SPARE), // stake
      tr(start + 10_800, stake, BURN_SINKS.dead, 30_000n * SPARE, dave), // slash executed: 10% burned
      tr(start + 18_000, stake, dave, 270_000n * SPARE), // unstake the rest
    ];
    const { averages, closing } = H.timeWeightedAverages({ start, end, opening: ledgerOf(opening), transfers: ts, stake });
    assert.deepEqual(averages, reference(start, end, opening, ts, lower(stake)));
    const expected = (400_000n * SPARE * 10_800n + 370_000n * SPARE * 10_800n) / BigInt(EPOCH);
    assert.equal(averages.get(lower(dave)), expected);
    assert.equal(averages.has(lower(stake)), false, "the stake contract itself holds no weight");
    assert.deepEqual(closing.get(lower(dave)), { wallet: 370_000n * SPARE, staked: 0n });
    // Without N15 the staked part would not count.
    const walletOnly = H.timeWeightedAverages({ start, end, opening: ledgerOf(opening), transfers: ts, stake, countStaked: false });
    assert.ok(walletOnly.averages.get(lower(dave))! < expected);
  });

  test("buys and sells inside the epoch: matches the reference to the wei", () => {
    const opening = new Map([[lower(pool), 10n ** 9n * SPARE]]);
    const ts = [
      tr(start, pool, carol, 200_000n * SPARE), // at the first second: counts in full
      tr(start + 7_777, carol, alice, 50_000n * SPARE),
      tr(start + 7_777, alice, pool, 1n), // same block, later log
      tr(start + 21_000, pool, dave, 123_456_789n),
      tr(end - 1, carol, pool, 150_000n * SPARE),
    ];
    const { averages } = H.timeWeightedAverages({ start, end, opening: ledgerOf(opening), transfers: ts, stake: null });
    assert.deepEqual(averages, reference(start, end, opening, ts, null));
    assert.throws(() => H.timeWeightedAverages({ start, end, opening: ledgerOf(opening), transfers: [tr(end, pool, carol, 1n)], stake: null }), /outside the epoch/);
  });

  test("contracts are excluded unless allow-listed; the zero and dead address and the list always", () => {
    const avg = new Map([
      [lower(alice), 200_000n * SPARE],
      [lower(carol), 300_000n * SPARE],
      [lower(BURN_SINKS.dead), 10n ** 9n * SPARE],
      [lower(ADDR.teamWallet), 10n ** 8n * SPARE],
    ]);
    const excluded = new Set([lower(BURN_SINKS.dead), lower(ADDR.teamWallet)]);
    const el = H.eligibleWeights(avg, { excluded, allowlist: new Set(), contracts: new Set([lower(carol)]), min: HOLDER_MIN_SPARE_WEI });
    assert.deepEqual([...el.eligible.keys()], [alice]);
    assert.deepEqual(el.contracts, [lower(carol)]);
    const allowed = H.eligibleWeights(avg, { excluded, allowlist: new Set([lower(carol)]), contracts: new Set([lower(carol)]), min: HOLDER_MIN_SPARE_WEI });
    assert.deepEqual([...allowed.eligible.keys()].sort(), [alice, carol].sort());
  });
});

describe("modes and leaves", () => {
  test("setMode in epoch N counts from N+1 only; never chose = credits (N18); NVDA (not offered) = credits", () => {
    const set = [{ mode: HOLDER_MODE.nvda, effectiveEpoch: 8, block: 100, logIndex: 0 }];
    assert.equal(H.modeForEpoch(set, 7, [HOLDER_MODE.credits, HOLDER_MODE.nvda]), HOLDER_MODE.credits, "chosen during epoch 7: not yet");
    assert.equal(H.modeForEpoch(set, 8, [HOLDER_MODE.credits, HOLDER_MODE.nvda]), HOLDER_MODE.nvda);
    assert.equal(H.modeForEpoch([], 8, [HOLDER_MODE.credits, HOLDER_MODE.nvda]), HOLDER_MODE.credits);
    assert.equal(H.modeForEpoch(set, 8), HOLDER_MODE.credits, "only credits is supported in this phase");
    const twice = [...set, { mode: HOLDER_MODE.credits, effectiveEpoch: 9, block: 200, logIndex: 0 }];
    assert.equal(H.modeForEpoch(twice, 8, [HOLDER_MODE.credits, HOLDER_MODE.nvda]), HOLDER_MODE.nvda);
    assert.equal(H.modeForEpoch(twice, 9, [HOLDER_MODE.credits, HOLDER_MODE.nvda]), HOLDER_MODE.credits);
  });

  test("leaf = keccak256(uint64 epochId ‖ address holder ‖ uint8 mode ‖ uint256 amount), 61 bytes", () => {
    const holder = getAddress("0x00000000000000000000000000000000000a11ce");
    const packed = concat([pad(numberToHex(42), { size: 8 }), holder, pad(numberToHex(0), { size: 1 }), pad(numberToHex(5n * SPARE), { size: 32 })]);
    assert.equal((packed.length - 2) / 2, 61);
    assert.equal(H.holderLeafOf(42n, holder, 0, 5n * SPARE), keccak256(packed));
    assert.equal(H.buildHolderTree(1, []).tree.root, `0x${"00".repeat(32)}`);
    assert.equal(buildTree([keccak256(packed)]).root, keccak256(packed));
  });
});

describe("the runner on a scratch DB (chain reads stubbed, nothing sent)", () => {
  const B0 = 5_000n;
  const T0 = 1_810_000_000;
  const timeOf = (b: bigint) => T0 + Number(b - B0); // one block a second
  const blockAt = (t: number) => B0 + BigInt(t - T0);
  const pool = getAddress("0x00000000000000000000000000000000000b0001");
  const alice = getAddress("0x00000000000000000000000000000000000a11ce");
  const erin = getAddress("0x00000000000000000000000000000000000e7702");
  const bob = getAddress("0x0000000000000000000000000000000000000b0b");
  const holderPool = getAddress("0x00000000000000000000000000000000000f00d1");
  const nodeStake = getAddress("0x000000000000000000000000000000000057a4e0");
  const start = T0 + 1_000;
  const end = start + EPOCH;
  const chargeTx = pad("0xc4a2", { size: 32 });
  let k = 0;
  const raw = (time: number, from: Address, to: Address, value: bigint) => ({
    block: blockAt(time),
    logIndex: k++,
    txHash: pad(numberToHex(1000 + k), { size: 32 }),
    from,
    to,
    value,
  });
  const chain = [
    raw(T0 + 10, BURN_SINKS.zero, pool, 10n ** 9n * SPARE), // mint to the pool before the epoch
    raw(T0 + 20, pool, alice, 500_000n * SPARE),
    raw(T0 + 30, pool, getAddress(PONS.memeHook), 5_000_000n * SPARE),
    raw(T0 + 40, pool, erin, 200_000n * SPARE),
    raw(start + 600, pool, ADDR.teamWallet, 9_000_000n * SPARE),
    raw(end - 2, pool, bob, 80_000_000n * SPARE), // just before the end
    raw(end + 5, bob, pool, 80_000_000n * SPARE), // right after: next epoch
  ];

  test("prepares the root, the unsigned postRoot call and the Safe funding transaction; the ledger moves on", async () => {
    const db = getDb();
    db.prepare("INSERT INTO epochs (id, clock, status, started_at, length, provisional, ended_at, closed_at) VALUES (5, 'contract', 'posted', ?, ?, 0, ?, ?)").run(start, EPOCH, end, end);
    db.prepare("INSERT INTO charges (epoch_id, list_json, list_hash, total_wei, status, tx, created_at, hash_rule) VALUES (5, '[]', ?, '0', 'done', ?, 0, 'v2-jobs-merkle')").run(pad("0x1", { size: 32 }), chargeTx);
    const toTreasury = 2n * 10n ** 16n;
    mock.method(tokenChain, "chargedEvent", async (h: Hex) => (h === chargeTx ? { epochId: 5n, total: 0n, toPot: 0n, toTreasury, block: 1n, txHash: h } : null));
    mock.method(tokenChain, "headBlock", async () => blockAt(end + 100));
    mock.method(tokenChain, "blockTime", async (b: bigint) => timeOf(b));
    mock.method(tokenChain, "lastBlockBefore", async (ts: number) => blockAt(ts - 1));
    mock.method(tokenChain, "spareTransfers", async (from: bigint, to: bigint) => chain.filter((t) => t.block >= from && t.block <= to));
    mock.method(tokenChain, "slashedEvents", async () => []);
    mock.method(tokenChain, "modeSets", async () => [{ holder: alice, mode: HOLDER_MODE.nvda, effectiveEpoch: 6n, block: blockAt(start + 50), logIndex: 0 }]);
    const contractsSeen: string[] = [];
    mock.method(tokenChain, "isContract", async (a: Address) => {
      contractsSeen.push(lower(a));
      return lower(a) === lower(pool); // the pool is a contract; erin is an EIP-7702 wallet, an EOA (chain-io decides)
    });
    mock.method(tokenChain, "safeNonce", async () => 7n);

    const infra = { ...H.defaultHolderInfra(), startBlock: B0, holderPool, nodeStake };
    const line = await H.prepareHolderRoot({ id: 5, started_at: start, ended_at: end, length: EPOCH }, infra);
    assert.match(line, /epoch 5: prepared, 2 holders/);
    assert.match(line, /1 contracts/);
    assert.match(line, /NOT posted/);
    const row = db.prepare("SELECT * FROM token_holder_roots WHERE epoch_id = 5").get() as Record<string, string | number | null>;
    assert.equal(row.status, "prepared");
    const total = holderShareOf(toTreasury);
    assert.equal(row.total_eth_wei, total.toString());
    const leaves = db.prepare("SELECT holder, mode, amount_wei, leaf FROM token_holder_leaves WHERE epoch_id = 5 ORDER BY holder").all() as { holder: string; mode: number; amount_wei: string; leaf: Hex }[];
    assert.deepEqual(leaves.map((l) => l.holder).sort(), [alice, erin].sort(), "team wallet and hook (list), pool (contract) and bob (minimum) are out");
    assert.ok(leaves.every((l) => l.mode === HOLDER_MODE.credits), "alice's ModeSet takes effect in epoch 6, and NVDA is not offered");
    assert.ok(leaves.reduce((s, l) => s + BigInt(l.amount_wei), 0n) <= total);
    assert.ok(!contractsSeen.includes(lower(ADDR.teamWallet)), "excluded addresses are not even looked up");
    const tree = buildTree(leaves.map((l) => l.leaf));
    assert.equal(row.root, tree.root);
    const call = JSON.parse(row.post_call as string) as { unsigned: boolean; to: string; data: Hex };
    assert.equal(call.unsigned, true);
    assert.equal(call.to, holderPool);
    const decoded = decodeFunctionData({ abi: holderPoolAbi, data: call.data });
    assert.equal(decoded.functionName, "postRoot");
    assert.deepEqual(decoded.args, [5n, tree.root, total]);
    const fund = JSON.parse(row.fund_safe_tx as string) as { unsigned: boolean; safeTx: { to: string; value: string; nonce: string }; safeTxHash: Hex };
    assert.equal(fund.unsigned, true);
    assert.deepEqual([fund.safeTx.to, fund.safeTx.value, fund.safeTx.nonce], [holderPool, total.toString(), "7"]);
    assert.equal(getMeta("token_holder_block"), blockAt(end - 1).toString(), "the ledger is at the epoch end");
    const bobRow = db.prepare("SELECT wallet_wei FROM token_holder_ledger WHERE address = ?").get(lower(bob)) as { wallet_wei: string };
    assert.equal(bobRow.wallet_wei, (80_000_000n * SPARE).toString(), "bob's sale is after the end: the next epoch's");
  });

  test("the next epoch starts from the stored ledger: bob's sale right after the end weighs nothing", async () => {
    const db = getDb();
    const s2 = end;
    const e2 = end + EPOCH;
    db.prepare("INSERT INTO epochs (id, clock, status, started_at, length, provisional, ended_at, closed_at) VALUES (6, 'contract', 'posted', ?, ?, 0, ?, ?)").run(s2, EPOCH, e2, e2);
    mock.method(tokenChain, "headBlock", async () => blockAt(e2 + 100));
    const infra = { ...H.defaultHolderInfra(), startBlock: B0, holderPool, nodeStake };
    const line = await H.prepareHolderRoots(infra);
    assert.match(line, /epoch 6: nothing-due/, "no charge in epoch 6: nothing to distribute, but the ledger moved");
    const leaves = db.prepare("SELECT holder FROM token_holder_leaves WHERE epoch_id = 6").all();
    assert.equal(leaves.length, 0);
    assert.equal(getMeta("token_holder_block"), blockAt(e2 - 1).toString());
  });

  test("without SPARE_START_BLOCK (today) the root is stored incomplete and nothing is read", async () => {
    const db = getDb();
    db.prepare("INSERT INTO epochs (id, clock, status, started_at, length, provisional, ended_at, closed_at) VALUES (7, 'contract', 'posted', ?, ?, 0, ?, ?)").run(end + EPOCH, EPOCH, end + 2 * EPOCH, end + 2 * EPOCH);
    const reads = mock.method(tokenChain, "spareTransfers", async () => {
      throw new Error("must not be read");
    });
    const line = await H.prepareHolderRoot({ id: 7, started_at: end + EPOCH, ended_at: end + 2 * EPOCH, length: EPOCH });
    assert.match(line, /incomplete \(SPARE start block not recorded\)/);
    const row = db.prepare("SELECT status, missing FROM token_holder_roots WHERE epoch_id = 7").get() as { status: string; missing: string };
    assert.equal(row.status, "incomplete");
    assert.match(row.missing, /SPARE_START_BLOCK/);
    assert.equal(reads.mock.callCount(), 0);
  });
});
