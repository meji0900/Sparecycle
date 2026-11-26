// The stake gate (brief §3 "Scheduler changes"; src/server/stake-gate.ts, wired into ./nodes and ./rounds) on a scratch
// DB with dev-runner nodes: with TOKEN_STAKE_GATE off (the default) leasing is exactly as before and no stake is read;
// with it on, an owner below minStakePerNode x active nodes gets no lease and is not counted as the peer, a top-up
// restores leases from the next poll, a sufficient read is cached for the epoch, a failed read falls back to the last
// one, a contract that is not deployed fails closed, and a re-check round needs a staked pair. Run: npm test
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, mock, test } from "node:test";
import type { Address } from "viem";
import { setupTokenHarness } from "./test-support/token-harness";

const h = await setupTokenHarness();
const { m, mkNode, poll, lease, send, pair, submitPaid, allOnline } = h;
const G = await import("./stake-gate");
const { tokenChain, NotLiveError } = m.chainIo;
const db = () => m.db.getDb();

after(h.cleanup);
before(async () => {
  await m.epochs.ensureEpoch();
});

const original = { stakedOf: tokenChain.stakedOf, minStakePerNode: tokenChain.minStakePerNode };
const stake = new Map<string, bigint>();
let minPerNode = 100n;
let reads = { staked: 0, min: 0 };
function stubStake() {
  mock.method(tokenChain, "stakedOf", async (owner: Address) => {
    reads.staked++;
    return stake.get(owner.toLowerCase()) ?? 0n;
  });
  mock.method(tokenChain, "minStakePerNode", async () => {
    reads.min++;
    return minPerNode;
  });
}

beforeEach(() => {
  const d = db();
  d.exec("UPDATE tasks SET status = 'cancelled' WHERE status IN ('open','leased')");
  d.exec("UPDATE jobs SET status = 'expired' WHERE status IN ('queued','running','checking')");
  d.exec("DELETE FROM nodes");
  d.exec("DELETE FROM token_stake_reads");
  d.exec("DELETE FROM meta WHERE key = 'token_stake_min'");
  delete process.env.TOKEN_STAKE_GATE;
  Object.assign(tokenChain, original); // only the stake reads: the harness's payments stubs stay
  stake.clear();
  minPerNode = 100n;
  reads = { staked: 0, min: 0 };
});

const textJob = (p: string) => m.jobs.submitJob(h.textRequest(p), `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);

describe("flag off (the default)", () => {
  test("leasing is exactly as before: no stake read, no SQL change, nothing stored", async () => {
    mock.method(tokenChain, "stakedOf", async () => {
      throw new Error("must not be read with the gate off");
    });
    mock.method(tokenChain, "minStakePerNode", async () => {
      throw new Error("must not be read with the gate off");
    });
    assert.equal(m.env.serverEnv.tokenStakeGate(), false);
    assert.equal(G.stakePeerSql("p"), "", "the peer query is byte-for-byte the one used before the gate");
    const [a, b] = await Promise.all([mkNode(), mkNode()]);
    const j = await textJob("no stake needed");
    const res = await pair(a, b, "same", "same");
    assert.equal(res.status, "agreed");
    assert.equal(res.jobId, j.id);
    assert.equal((tokenChain.stakedOf as unknown as { mock: { callCount(): number } }).mock.callCount(), 0);
    assert.equal((db().prepare("SELECT COUNT(*) AS n FROM token_stake_reads").get() as { n: number }).n, 0);
  });

  test("other values of the flag are off too", () => {
    for (const v of ["1", "true", "yes", "enabled", ""]) {
      process.env.TOKEN_STAKE_GATE = v;
      assert.equal(m.env.serverEnv.tokenStakeGate(), false, v);
    }
    process.env.TOKEN_STAKE_GATE = "ON";
    assert.equal(m.env.serverEnv.tokenStakeGate(), true);
  });
});

describe("flag on", () => {
  test("the stake read fails (RPC down, or a contract that is not live): no node gets a lease (fail closed)", async () => {
    process.env.TOKEN_STAKE_GATE = "on";
    // SparecycleNodeStake is deployed (26 Nov 2026), so a failing read is simulated instead of hitting the chain.
    mock.method(tokenChain, "stakedOf", async () => {
      throw new NotLiveError("SparecycleNodeStake");
    });
    mock.method(tokenChain, "minStakePerNode", async () => {
      throw new Error("rpc unreachable");
    });
    await assert.rejects(tokenChain.stakedOf("0x0000000000000000000000000000000000000001"), NotLiveError);
    const [a, b] = await Promise.all([mkNode(), mkNode()]);
    await textJob("gated");
    allOnline();
    assert.equal(await poll(a), null);
    assert.equal(await poll(b), null);
  });

  test("below the minimum: no lease and not the peer; a top-up restores leases from the next poll", async () => {
    process.env.TOKEN_STAKE_GATE = "on";
    stubStake();
    const [a, b] = await Promise.all([mkNode(), mkNode()]);
    stake.set(a.owner.address.toLowerCase(), 100n);
    stake.set(b.owner.address.toLowerCase(), 99n);
    const j = await textJob("needs two staked owners");
    allOnline();
    assert.equal(await poll(b), null, "b is below the minimum");
    assert.equal(await poll(a), null, "a meets it, but its only peer does not: the first task is not handed out");
    stake.set(b.owner.address.toLowerCase(), 100n); // top-up
    const lb = await lease(b);
    const la = await lease(a);
    assert.equal(lb.jobId, j.id);
    assert.equal(la.jobId, j.id);
    await send(b, lb, "x");
    assert.equal((await send(a, la, "x")).status, "agreed");
  });

  test("a sufficient read is cached for the epoch; an insufficient one is read again at every poll", async () => {
    process.env.TOKEN_STAKE_GATE = "on";
    stubStake();
    const a = await mkNode();
    stake.set(a.owner.address.toLowerCase(), 500n);
    const epoch = (await m.epochs.ensureEpoch()).id + 50;
    assert.equal(await G.ownerMeetsStake(a.owner.address, epoch), true);
    assert.equal(await G.ownerMeetsStake(a.owner.address, epoch), true);
    assert.deepEqual(reads, { staked: 1, min: 1 }, "one read for the epoch");
    assert.equal(await G.ownerMeetsStake(a.owner.address, epoch + 1), true);
    assert.deepEqual(reads, { staked: 2, min: 2 }, "a new epoch reads again");
    stake.set(a.owner.address.toLowerCase(), 0n);
    const b = await mkNode();
    assert.equal(await G.ownerMeetsStake(b.owner.address, epoch + 1), false);
    assert.equal(await G.ownerMeetsStake(b.owner.address, epoch + 1), false);
    assert.equal(reads.staked, 4, "below the minimum: stakedOf is read again each time");
    assert.equal(reads.min, 2, "minStakePerNode once per epoch");
  });

  test("the minimum is per ACTIVE node: two online nodes of one owner need twice the stake", async () => {
    process.env.TOKEN_STAKE_GATE = "on";
    stubStake();
    const a1 = await mkNode();
    const a2 = await mkNode({ owner: a1.owner });
    stake.set(a1.owner.address.toLowerCase(), 150n);
    allOnline();
    const epoch = (await m.epochs.ensureEpoch()).id;
    assert.equal(G.activeNodeCount(a1.owner.address), 2);
    assert.equal(await G.ownerMeetsStake(a1.owner.address, epoch), false, "150 < 2 x 100");
    db().prepare("UPDATE nodes SET last_seen = 0 WHERE node_key = ?").run(a2.key.address); // a2 goes offline
    assert.equal(G.activeNodeCount(a1.owner.address), 1);
    assert.equal(await G.ownerMeetsStake(a1.owner.address, epoch), true, "150 >= 1 x 100");
  });

  test("a failed read falls back to the owner's last read; with none it fails closed", async () => {
    process.env.TOKEN_STAKE_GATE = "on";
    stubStake();
    const a = await mkNode();
    const b = await mkNode();
    stake.set(a.owner.address.toLowerCase(), 100n);
    const epoch = (await m.epochs.ensureEpoch()).id;
    assert.equal(await G.ownerMeetsStake(a.owner.address, epoch), true);
    mock.method(tokenChain, "stakedOf", async () => {
      throw new Error("rpc down");
    });
    mock.method(tokenChain, "minStakePerNode", async () => {
      throw new Error("rpc down");
    });
    assert.equal(await G.ownerMeetsStake(a.owner.address, epoch + 5), true, "last read (100 >= 100) still stands");
    assert.equal(await G.ownerMeetsStake(b.owner.address, epoch + 5), false, "never read: closed");
  });

  test("a re-check round needs a pair of staked owners among the registered nodes", async () => {
    process.env.TOKEN_STAKE_GATE = "on";
    stubStake();
    const [a, b, c, d] = await Promise.all([mkNode(), mkNode(), mkNode(), mkNode()]);
    for (const n of [a, b]) stake.set(n.owner.address.toLowerCase(), 100n);
    // Every node polls once with nothing queued, so each owner's stake read is stored. c and d are registered and online
    // but never staked: they cannot take round 1, so the mismatch is final at once.
    allOnline();
    for (const n of [a, b, c, d]) assert.equal(await poll(n), null);
    const j = await submitPaid("re-check needs a staked pair");
    const res = await pair(a, b, "one answer", "a completely different reply");
    assert.equal(res.status, "disagreed", "no staked pair left for round 1");
    assert.equal(res.jobId, j.id);
    // Once c and d stake (and poll), a mismatch moves to them.
    for (const n of [c, d]) stake.set(n.owner.address.toLowerCase(), 100n);
    for (const n of [c, d]) assert.equal(await poll(n), null);
    await submitPaid("now there is a staked pair");
    assert.equal((await pair(a, b, "one answer", "a completely different reply")).status, "queued");
    assert.equal((await pair(c, d, "same", "same")).status, "agreed");
  });
});
