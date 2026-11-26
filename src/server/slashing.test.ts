// Fault attribution and slash proposals (brief §3; src/server/slashing.ts) on a scratch DB with dev-runner nodes driven
// through real re-check rounds: a fault only when a node's signed result disagrees with an agreed result of two other
// nodes of two other owner wallets; one mismatch never proposes; F = 3 faults in W = 8 epochs create exactly one
// proposal whose public evidence bundle carries the job ids, the signed results (output hashes, signatures that recover
// to the node keys), the agreeing results and the thresholds of ./verify, and no prompt or output; evidenceHash covers
// the stored JSON; the proposeSlash call is prepared and unsigned (NodeStake stubbed) or `incomplete` (not deployed);
// GET /api/v1/slashing and /api/v1/slashing/:id answer only with TOKEN_SLASHING=on. Run: npm test
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, mock, test } from "node:test";
import { decodeFunctionData, getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { setupTokenHarness } from "./test-support/token-harness";

const h = await setupTokenHarness();
const { m, mkNode, pair, submitPaid } = h;
const S = await import("./slashing");
const { tokenChain } = m.chainIo;
const { nodeStakeAbi } = await import("@/lib/token-contracts");
const { FAULTS_PER_PROPOSAL, FAULT_WINDOW_EPOCHS } = await import("@/lib/token-rules");
const { IMAGE_MAX_BITS, TEXT_MIN_SIMILARITY } = await import("./verify");
const route = await import("@/app/api/v1/[...path]/route");
const db = () => m.db.getDb();

after(h.cleanup);
before(async () => {
  await m.epochs.ensureEpoch();
});
beforeEach(() => {
  db().exec("UPDATE tasks SET status = 'cancelled' WHERE status IN ('open','leased')");
  db().exec("UPDATE jobs SET status = 'expired' WHERE status IN ('queued','running','checking')");
  delete process.env.TOKEN_SLASHING;
});

const GOOD = "the agreed answer of the honest nodes";
const BAD = "a completely unrelated and wrong reply";
type Node = Awaited<ReturnType<typeof mkNode>>;

/** A paid job: round 0 on bad + other (they mismatch), round 1 on c + d (they agree with `other`). Returns the job id. */
let promptSeq = 0;
async function faultyJob(bad: Node, other: Node, c: Node, d: Node, epoch: number, prompt = `PRIVATE-PROMPT-MARK ${++promptSeq}`) {
  const j = await submitPaid(prompt);
  assert.equal((await pair(bad, other, BAD, GOOD)).status, "queued", "round 0 mismatched: re-check");
  assert.equal((await pair(c, d, GOOD, GOOD)).status, "agreed");
  db().prepare("UPDATE jobs SET epoch_id = ? WHERE id = ?").run(epoch, j.id);
  return j.id as Hex;
}

const faultsOf = (n: Node) =>
  db().prepare("SELECT job_id, round, epoch_id, proposal_id FROM token_slash_faults WHERE node_key = ? ORDER BY epoch_id").all(n.key.address) as {
    job_id: string;
    round: number;
    epoch_id: number;
    proposal_id: number | null;
  }[];

describe("attribution", () => {
  test("the node whose result disagrees with the agreed pair of two other owners gets the fault; its round partner does not", async () => {
    const [bad, other, c, d] = await Promise.all([mkNode(), mkNode(), mkNode(), mkNode()]);
    const id = await faultyJob(bad, other, c, d, 100);
    assert.equal(S.attributeFaults(100), 1);
    assert.deepEqual(faultsOf(bad).map((f) => [f.job_id, f.round, f.epoch_id]), [[id, 0, 100]]);
    assert.deepEqual(faultsOf(other), [], "its result matches the agreed one");
    assert.deepEqual([...faultsOf(c), ...faultsOf(d)], []);
    assert.equal(S.attributeFaults(100), 0, "idempotent");
  });

  test("a mismatch with no later agreement attributes nothing (final disagreed; free job)", async () => {
    const [a, b] = await Promise.all([mkNode(), mkNode()]);
    // A free trial job gets one round (D17): its mismatch is final, and no later pair ever agrees.
    const free = await m.jobs.submitJob(h.textRequest("free job"), "10.99.0.1");
    const res = await pair(a, b, BAD, GOOD);
    assert.equal(res.status, "disagreed");
    db().prepare("UPDATE jobs SET epoch_id = 101 WHERE id = ?").run(free.id);
    assert.equal(S.attributeFaults(101), 0);
    assert.deepEqual([...faultsOf(a), ...faultsOf(b)], []);
  });

  test("pure rule: agreeing pair with N's owner, or a result that matches one of them, is not a fault", () => {
    const row = (task: string, node: string, owner: string, round: number, fp: string) => ({
      task_id: task,
      node_key: node,
      owner,
      round,
      output_hash: `0x${"11".repeat(32)}`,
      fingerprint: fp,
      gpu_ms: 1,
      epoch: 1,
      signature: `0x${"22".repeat(65)}`,
    });
    const job = { id: "0x01", kind: "text" as const, model: "qwen2.5-1.5b", round: 1, epoch_id: 1 };
    const N = row("t0", "0xn", "0xowner-n", 0, BAD);
    assert.equal(S.faultsOfJob(job, [N, row("t1", "0xb", "0xowner-b", 0, GOOD), row("t2", "0xc", "0xowner-c", 1, GOOD), row("t3", "0xd", "0xowner-d", 1, GOOD)]).length, 1);
    assert.equal(S.faultsOfJob(job, [N, row("t2", "0xc", "0xOWNER-N", 1, GOOD), row("t3", "0xd", "0xowner-d", 1, GOOD)]).length, 0, "one agreeing node is N's owner (any case)");
    assert.equal(S.faultsOfJob(job, [N, row("t2", "0xc", "0xowner-c", 1, BAD), row("t3", "0xd", "0xowner-d", 1, BAD)]).length, 0, "N matches the agreed result");
    assert.equal(S.faultsOfJob({ ...job, round: 0 }, [N]).length, 0, "no re-check, no fault");
    assert.equal(S.faultsOfJob(job, [N, row("t2", "0xc", "0xowner-c", 1, GOOD), row("t3", "0xd", "0xowner-c", 1, GOOD)]).length, 0, "the agreeing pair must be two owners");
  });
});

describe("proposals", () => {
  let bad: Node, other: Node, c: Node, d: Node;
  const jobs: Hex[] = [];
  before(async () => {
    [bad, other, c, d] = await Promise.all([mkNode(), mkNode(), mkNode(), mkNode()]);
  });

  test("one fault never proposes; F = 3 faults in W = 8 epochs make exactly one proposal", async () => {
    assert.equal(FAULTS_PER_PROPOSAL, 3);
    assert.equal(FAULT_WINDOW_EPOCHS, 8);
    jobs.push(await faultyJob(bad, other, c, d, 200));
    S.attributeFaults(200);
    assert.deepEqual(await S.proposeDueSlashes(200), [], "one mismatch: no proposal");
    jobs.push(await faultyJob(bad, other, c, d, 203));
    S.attributeFaults(203);
    assert.deepEqual(await S.proposeDueSlashes(203), [], "two faults: still none");
    jobs.push(await faultyJob(bad, other, c, d, 207));
    S.attributeFaults(207);
    const ids = await S.proposeDueSlashes(207);
    assert.equal(ids.length, 1, "three faults in epochs 200..207 (window 200..207): one proposal");
    assert.deepEqual(await S.proposeDueSlashes(207), [], "the same faults never make a second one");
    assert.ok(faultsOf(bad).every((f) => f.proposal_id === ids[0]));
    // A fourth fault alone does not make another proposal.
    jobs.push(await faultyJob(bad, other, c, d, 208));
    S.attributeFaults(208);
    assert.deepEqual(await S.proposeDueSlashes(208), []);
    const rows = db().prepare("SELECT * FROM token_slash_proposals").all() as { status: string; amount_wei: string | null; call_json: string | null }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "incomplete", "SparecycleNodeStake is not deployed: no amount, no call");
    assert.equal(rows[0].amount_wei, null);
    assert.equal(rows[0].call_json, null);
  });

  test("faults spread over more than W epochs do not propose", async () => {
    const [x, y, z, w] = await Promise.all([mkNode(), mkNode(), mkNode(), mkNode()]);
    for (const e of [300, 305, 309]) {
      await faultyJob(x, y, z, w, e);
      S.attributeFaults(e);
    }
    assert.deepEqual(await S.proposeDueSlashes(309), [], "window 302..309 holds only two of them");
    assert.equal(faultsOf(x).length, 3);
  });

  test("the evidence bundle: job ids, signed results, agreeing results, thresholds; no prompt, no output; hash = keccak256(json)", async () => {
    const row = db().prepare("SELECT * FROM token_slash_proposals ORDER BY id LIMIT 1").get() as { evidence_json: string; evidence_hash: Hex; owner: string; node_key: string };
    assert.equal(row.evidence_hash, keccak256(toBytes(row.evidence_json)));
    const ev = JSON.parse(row.evidence_json) as {
      owner: Address;
      node: Address;
      thresholds: { imageMaxBits: number; textMinSimilarity: number };
      rule: { faultsPerProposal: number; windowEpochs: number };
      faults: {
        jobId: Hex;
        result: { node: Address; outputHash: Hex; gpuMs: number; epoch: number; signature: Hex };
        agreeing: { node: Address; owner: Address; outputHash: Hex; gpuMs: number; epoch: number; signature: Hex }[];
        comparison: { metric: string; value: number; threshold: number; matches: boolean }[];
      }[];
    };
    assert.equal(ev.node, bad.key.address);
    assert.equal(ev.owner, bad.owner.address);
    assert.deepEqual(ev.thresholds, { imageMaxBits: IMAGE_MAX_BITS, textMinSimilarity: TEXT_MIN_SIMILARITY });
    assert.deepEqual(ev.faults.map((f) => f.jobId).sort(), jobs.slice(0, 3).sort());
    for (const f of ev.faults) {
      assert.equal(f.agreeing.length, 2);
      const owners = new Set(f.agreeing.map((a) => a.owner.toLowerCase()));
      assert.equal(owners.size, 2, "two other owner wallets");
      assert.ok(!owners.has(bad.owner.address.toLowerCase()));
      for (const r of [f.result, ...f.agreeing]) {
        const signer = await m.proto.recoverReceiptSigner(m.chain.targetChain.id, { jobId: f.jobId, node: r.node, outputHash: r.outputHash, gpuMs: BigInt(r.gpuMs), epoch: BigInt(r.epoch) }, r.signature);
        assert.equal(signer && getAddress(signer), r.node, "every signed result recovers to its node key");
      }
      assert.equal(f.result.outputHash, m.proto.sha256Hex(Buffer.from(BAD, "utf8")));
      assert.ok(f.agreeing.every((a) => a.outputHash === m.proto.sha256Hex(Buffer.from(GOOD, "utf8"))));
      assert.ok(f.comparison.every((x) => x.metric === "text-similarity" && x.value < TEXT_MIN_SIMILARITY && x.threshold === TEXT_MIN_SIMILARITY && !x.matches));
    }
    const lowered = row.evidence_json.toLowerCase();
    assert.ok(!lowered.includes("private-prompt-mark"), "no prompt");
    assert.ok(!lowered.includes(BAD.toLowerCase()) && !lowered.includes(GOOD.toLowerCase()), "no output text, no text fingerprint");
  });

  test("with SparecycleNodeStake readable, the unsigned proposeSlash call takes 10% of the stake (N4)", async () => {
    const [p, q, r, s] = await Promise.all([mkNode(), mkNode(), mkNode(), mkNode()]);
    for (const e of [400, 401, 402]) {
      await faultyJob(p, q, r, s, e);
      S.attributeFaults(e);
    }
    const stake = 12_345n * 10n ** 18n;
    mock.method(tokenChain, "stakedOf", async () => stake);
    const [id] = await S.proposeDueSlashes(402);
    const row = db().prepare("SELECT * FROM token_slash_proposals WHERE id = ?").get(id) as { status: string; amount_wei: string; call_json: string; evidence_hash: Hex };
    assert.equal(row.status, "prepared");
    assert.equal(row.amount_wei, ((stake * 1_000n) / 10_000n).toString());
    const call = JSON.parse(row.call_json) as { unsigned: boolean; data: Hex };
    assert.equal(call.unsigned, true);
    const dec = decodeFunctionData({ abi: nodeStakeAbi, data: call.data });
    assert.equal(dec.functionName, "proposeSlash");
    assert.deepEqual(dec.args, [p.owner.address, (stake * 1_000n) / 10_000n, row.evidence_hash]);
    mock.restoreAll();
  });
});

describe("GET /api/v1/slashing (catch-all route)", () => {
  const get = (path: string[]) => route.GET(new Request(`http://x/api/v1/${path.join("/")}`), { params: Promise.resolve({ path }) });

  test("flag off (the default): exactly the unknown-path 404, for the list, a proposal and the operator view", async () => {
    for (const p of [["slashing"], ["slashing", "1"], ["admin", "token-payloads"]]) {
      const res = await get(p);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "not-found", message: "no such scheduler endpoint" });
    }
  });

  test("flag on: the list and the evidence; other methods still 404", async () => {
    process.env.TOKEN_SLASHING = "on";
    const list = (await (await get(["slashing"])).json()) as { proposals: { id: number; evidenceHash: Hex; sent: boolean; evidenceUrl: string }[] };
    assert.ok(list.proposals.length >= 2);
    assert.ok(list.proposals.every((p) => p.sent === false));
    const one = list.proposals[list.proposals.length - 1];
    const res = await get(["slashing", String(one.id)]);
    assert.equal(res.status, 200);
    const detail = (await res.json()) as { evidenceJson: string; evidenceHash: Hex; hashRule: string };
    assert.equal(keccak256(toBytes(detail.evidenceJson)), one.evidenceHash);
    assert.equal((await get(["slashing", "999999"])).status, 404);
    assert.equal((await get(["slashing", "x"])).status, 400);
    assert.equal((await route.POST()).status, 404);
    const admin = await get(["admin", "token-payloads"]);
    assert.equal(admin.status, 503, "operator view needs SCHEDULER_ADMIN_TOKEN");
  });
});
