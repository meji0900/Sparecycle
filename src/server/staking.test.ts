// GET /api/v1/staking (src/server/staking.ts, src/app/api/v1/staking/route.ts) with the chain reads of ./chain-io stubbed:
// the figures and owner counts, the half-minute cache, the incremental Staked-event scan, a failed owner scan (figures
// still shown, owners null), a failed contract read (503, never a zero, and not retried for ten seconds), and a network
// without the contract. Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, mock, test } from "node:test";
import type { Address } from "viem";

for (const k of Object.keys(process.env)) if (/^(NEXT_PUBLIC_|TOKEN_|SCHEDULER_)/.test(k)) delete process.env[k];
const STAKE = "0x00000000000000000000000000000000000057a1" as Address;
const SPARE = "0x00000000000000000000000000000000000005a2" as Address;
Object.assign(process.env, {
  NEXT_PUBLIC_NETWORK: "local",
  NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9", // nothing answers: an unstubbed read fails fast
  TOKEN_NODE_STAKE_ADDRESS: STAKE,
  TOKEN_NODE_STAKE_START_BLOCK: "100",
});

const { tokenChain } = await import("./chain-io");
const S = await import("./staking");
const route = await import("@/app/api/v1/staking/route");
const { ADDR } = await import("@/lib/addresses");
const { NODE_STAKE_DEPLOY_BLOCK } = await import("@/lib/staking");

const owner = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const E18 = 10n ** 18n;

let head = 200n;
let totalsFail = false;
let logsFail = false;
const scans: [bigint, bigint][] = [];
const events = new Map<bigint, Address[]>(); // block -> owners with a Staked event there
const accounts = new Map<string, { staked: bigint; unstaking: bigint }>();
let reads = 0;

function stub() {
  mock.method(tokenChain, "headBlock", async () => head);
  mock.method(tokenChain, "nodeStakeTotals", async (address: Address, block: bigint) => {
    reads++;
    assert.equal(address, STAKE);
    assert.equal(block, head, "every figure is read at the head block");
    if (totalsFail) throw new Error("HTTP request failed");
    return {
      totalStaked: 1234n * E18,
      totalSlashed: 0n,
      minStakePerNode: 0n,
      proposalCount: 0n,
      token: SPARE,
      rules: { epochLength: 21_600n, cooldownEpochs: 16n, appealWindowEpochs: 4n, decisionWindowEpochs: 12n, slashBps: 1000, proposalGraceEpochs: 2n, stallFactor: 2n },
    };
  });
  mock.method(tokenChain, "nodeStakeStakers", async (address: Address, from: bigint, to: bigint) => {
    assert.equal(address, STAKE);
    if (logsFail) throw new Error("query returned more than 10000 results");
    scans.push([from, to]);
    const out: Address[] = [];
    for (const [b, os] of events) if (b >= from && b <= to) out.push(...os);
    return [...new Set(out)];
  });
  mock.method(tokenChain, "nodeStakeAccounts", async (_a: Address, owners: Address[], block: bigint) => {
    assert.equal(block, head);
    return owners.map((o) => ({ owner: o, ...(accounts.get(o.toLowerCase()) ?? { staked: 0n, unstaking: 0n }) }));
  });
}

beforeEach(() => {
  mock.restoreAll();
  S.resetStakingCache();
  head = 200n;
  totalsFail = false;
  logsFail = false;
  scans.length = 0;
  events.clear();
  accounts.clear();
  reads = 0;
  process.env.TOKEN_NODE_STAKE_ADDRESS = STAKE;
  process.env.TOKEN_NODE_STAKE_START_BLOCK = "100";
  stub();
});
after(() => mock.restoreAll());

describe("GET /api/v1/staking", () => {
  test("figures read at one block, owners counted from Staked events and getAccount", async () => {
    events.set(120n, [owner(1), owner(2)]);
    events.set(150n, [owner(3), owner(1)]);
    accounts.set(owner(1), { staked: 1000n * E18, unstaking: 0n });
    accounts.set(owner(2), { staked: 200n * E18, unstaking: 34n * E18 }); // active and cooling
    accounts.set(owner(3), { staked: 0n, unstaking: 0n }); // staked once, left
    const res = await route.GET();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=30");
    const body = (await res.json()) as Record<string, unknown> & { owners: Record<string, unknown>; rules: Record<string, unknown> };
    assert.equal(body.contract, STAKE);
    assert.equal(body.token, SPARE);
    assert.equal(body.decimals, 18);
    assert.equal(body.block, "200");
    assert.equal(body.totalStakedWei, (1234n * E18).toString());
    assert.equal(body.totalSlashedWei, "0");
    assert.equal(body.minStakePerNodeWei, "0");
    assert.equal(body.proposals, 0);
    assert.deepEqual(body.owners, { staking: 2, active: 2, cooling: 1, fromBlock: "100" });
    assert.equal(body.ownersError, null);
    assert.deepEqual(body.rules, { epochLengthSeconds: 21_600, cooldownEpochs: 16, appealWindowEpochs: 4, decisionWindowEpochs: 12, slashBps: 1000, proposalGraceEpochs: 2, stallFactor: 2 });
    assert.deepEqual(scans, [[100n, 200n]], "scanned once, from the start block to the head");
    assert.ok(Array.isArray(body.notes) && (body.notes as string[]).some((n) => /pays nothing/.test(n)));
  });

  test("cached for 30 s; after that only the new blocks are scanned", async () => {
    events.set(120n, [owner(1)]);
    accounts.set(owner(1), { staked: 5n, unstaking: 0n });
    const t0 = 1_000_000;
    const a = await S.stakingJson(t0);
    const b = await S.stakingJson(t0 + S.CACHE_MS - 1);
    assert.equal(b, a, "same answer inside the cache window");
    assert.equal(reads, 1);
    head = 260n;
    events.set(250n, [owner(4)]);
    accounts.set(owner(4), { staked: 0n, unstaking: 7n });
    const c = await S.stakingJson(t0 + S.CACHE_MS);
    assert.equal(reads, 2);
    assert.deepEqual(scans, [[100n, 200n], [201n, 260n]]);
    assert.deepEqual(c.owners, { staking: 2, active: 1, cooling: 1, fromBlock: "100" });
    assert.equal(c.block, "260");
  });

  test("concurrent requests share one read", async () => {
    const [a, b] = await Promise.all([S.stakingJson(5), S.stakingJson(5)]);
    assert.equal(a, b);
    assert.equal(reads, 1);
  });

  test("a failed event scan leaves the figures and says the owner count could not be read; the next read rescans", async () => {
    events.set(120n, [owner(1)]);
    accounts.set(owner(1), { staked: 5n, unstaking: 0n });
    logsFail = true;
    const a = await S.stakingJson(0);
    assert.equal(a.owners, null, "never a zero owner count");
    assert.match(a.ownersError ?? "", /Could not read/);
    assert.equal(a.totalStakedWei, (1234n * E18).toString());
    logsFail = false;
    const b = await S.stakingJson(S.CACHE_MS);
    assert.deepEqual(scans, [[100n, 200n]], "the failed scan did not move the start");
    assert.deepEqual(b.owners, { staking: 1, active: 1, cooling: 0, fromBlock: "100" });
  });

  test("a failed contract read is a 503 in the error shape, never a zero, and is not retried for 10 s", async () => {
    totalsFail = true;
    const res = await route.GET();
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = (await res.json()) as { error: string; message: string; totalStakedWei?: string };
    assert.equal(body.error, "chain-read-failed");
    assert.equal(body.totalStakedWei, undefined);
    assert.doesNotMatch(body.message, /127\.0\.0\.1|http/i, "no RPC detail in the answer");
    const t = Date.now();
    await assert.rejects(S.stakingJson(t + S.FAILURE_CACHE_MS - 1000), /Could not read/);
    assert.equal(reads, 1, "the failure is cached");
    totalsFail = false;
    const ok = await S.stakingJson(t + S.FAILURE_CACHE_MS + 1000);
    assert.equal(ok.totalStakedWei, (1234n * E18).toString());
    assert.equal(reads, 2);
  });

  test("no contract on this network: 503 staking-not-deployed, nothing read", async () => {
    delete process.env.TOKEN_NODE_STAKE_ADDRESS;
    const res = await route.GET();
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, "staking-not-deployed");
    assert.equal(reads, 0);
  });
});

describe("which contract and from which block", () => {
  test("TOKEN_NODE_STAKE_ADDRESS wins; on mainnet the live contract; its deploy block by default", () => {
    assert.equal(S.stakeContract(), STAKE);
    assert.equal(S.stakeStartBlock(STAKE), 100n);
    delete process.env.TOKEN_NODE_STAKE_START_BLOCK;
    assert.equal(S.stakeStartBlock(STAKE), 0n, "an unknown contract is scanned from block 0");
    assert.equal(S.stakeStartBlock(ADDR.nodeStake as Address), NODE_STAKE_DEPLOY_BLOCK);
    delete process.env.TOKEN_NODE_STAKE_ADDRESS;
    assert.equal(S.stakeContract(), null, "not on a local chain without the override");
  });

  test("the staking module never signs or sends", () => {
    const src = readFileSync(join(import.meta.dirname, "staking.ts"), "utf8");
    for (const bad of ["createWalletClient", "writeContract", "sendTransaction", "simulateContract", "privateKeyToAccount", "schedulerAccount", "signerKey"]) {
      assert.ok(!src.includes(bad), `staking.ts uses ${bad}`);
    }
  });
});
