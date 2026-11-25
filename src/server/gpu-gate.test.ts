// Unit tests of the GPU gate on a scratch SQLite DB: registerNode + allowlist, tryLease eligibility, and the periodic
// challenge state machine (src/server/challenge.ts). No chain, no GPU. Run: npm test
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { Address, Hex, LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// Scratch DB and a clean scheduler env, set before any server module is loaded (they read env lazily, but be sure).
const dir = mkdtempSync(join(tmpdir(), "sparecycle-gpu-gate-"));
process.env.DB_PATH = join(dir, "test.db");
for (const k of ["NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS", "GPU_ALLOWLIST_MODE", "CHALLENGE_MODE", "CHALLENGE_INTERVAL_HOURS", "CHALLENGE_COOLDOWN_HOURS", "PROJECT_NODE_OWNERS", "VAST_API_KEY"]) {
  delete process.env[k];
}
process.env.SCHEDULER_ALLOW_DEV_RUNNER = "1";

const { registerNode, tryLease } = await import("./nodes");
type NodeRow = import("./nodes").NodeRow;
const { getDb, nowSec } = await import("./db");
const { ApiError } = await import("./http");
const { ensureEpoch } = await import("./epochs");
const { submitJob, listJobs, jobCounts } = await import("./jobs");
const { GPU_SUPPORT_URL } = await import("./gpu-allowlist");
const { adminChallenge, jobEligible, nextChallenge, submitChallengeResult } = await import("./challenge");
const { CHALLENGE_FEATURE, linkMessage, sha256Hex, signChallengeResult } = await import("@/lib/protocol");
const { targetChain } = await import("@/lib/chain");

after(() => {
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

const TEXT = "text:qwen2.5-1.5b";
const IMAGE = "image:sd15";
let uuidSeq = 0;

type Reg = { node: LocalAccount; owner: LocalAccount; res: Awaited<ReturnType<typeof registerNode>> };

/** Registers a node like a client would. `old: true` sends exactly the 0.2.0 body (no device, no features). */
async function register(o: {
  gpu: string;
  backend?: "cuda" | "vulkan" | "cpu";
  caps?: string[];
  dev?: boolean;
  old?: boolean;
  device?: Record<string, unknown>;
  node?: LocalAccount;
  owner?: LocalAccount;
}): Promise<Reg> {
  const node = o.node ?? privateKeyToAccount(generatePrivateKey());
  const owner = o.owner ?? privateKeyToAccount(generatePrivateKey());
  const ownerSig = await owner.signMessage({ message: linkMessage(node.address, owner.address) });
  const body: Record<string, unknown> = {
    gpu: o.gpu,
    gpuUuid: `GPU-${node.address.slice(2, 10)}-${uuidSeq++}`,
    vramMb: 8192,
    caps: o.caps ?? [TEXT],
    owner: owner.address,
    ownerSig,
    dev: o.dev ?? false,
    backend: o.backend ?? "cuda",
    version: o.old ? "sparecycle-node/0.2.0" : "sparecycle-node/0.3.0",
  };
  if (!o.old) {
    body.features = [CHALLENGE_FEATURE];
    if (o.device) body.device = o.device;
  }
  const res = await registerNode(node.address, body);
  return { node, owner, res };
}

const row = (a: Address) => getDb().prepare("SELECT * FROM nodes WHERE node_key = ?").get(a) as NodeRow;
const lease = async (a: Address) => tryLease(row(a), (await ensureEpoch()).id);
let ipSeq = 0;
const textJob = () => submitJob({ kind: "text", params: { model: "qwen2.5-1.5b", prompt: `hello ${ipSeq}`, maxTokens: 16 } }, `10.0.${ipSeq >> 8}.${ipSeq++ & 255}`);

/** Each test starts with no open work and every earlier node offline. */
beforeEach(() => {
  const db = getDb();
  db.exec("UPDATE tasks SET status = 'cancelled' WHERE status IN ('open','leased')");
  db.exec("UPDATE jobs SET status = 'expired' WHERE status IN ('queued','running','checking')");
  db.exec("UPDATE nodes SET last_seen = 0");
  delete process.env.GPU_ALLOWLIST_MODE;
  delete process.env.CHALLENGE_MODE;
  delete process.env.PROJECT_NODE_OWNERS;
});

const isApiError = (status: number, code: string) => (e: unknown) =>
  e instanceof ApiError && e.status === status && e.code === code;

// ---- registration -----------------------------------------------------------------------------------
describe("registerNode with the GPU allowlist", () => {
  test("observe (default): a blocked device still registers, classified and stored as blocked", async () => {
    const r = await register({ gpu: "llvmpipe (LLVM 15.0.7, 256 bits) (Vulkan)", backend: "vulkan" });
    assert.equal(r.res.gpu.status, "blocked");
    assert.equal(r.res.gpu.allowlistMode, "observe");
    assert.equal(row(r.node.address).family, "software-rasterizer");
    assert.equal(row(r.node.address).gpu_status, "blocked");
  });

  test("enforce: a blocked device is refused with 403 gpu-not-supported and a link to the support list", async () => {
    process.env.GPU_ALLOWLIST_MODE = "enforce";
    const node = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(
      register({ gpu: "Some card (Vulkan)", backend: "vulkan", node, device: { vulkan: { deviceType: "PHYSICAL_DEVICE_TYPE_CPU" } } }),
      (e: unknown) => isApiError(403, "gpu-not-supported")(e) && (e as InstanceType<typeof ApiError>).extra?.supported === GPU_SUPPORT_URL,
    );
    assert.equal(row(node.address), undefined, "no row stored");
  });

  test("enforce: an untested family registers with gpu_status untested", async () => {
    process.env.GPU_ALLOWLIST_MODE = "enforce";
    const r = await register({ gpu: "NVIDIA GeForce RTX 2080 Ti", device: { computeCap: "7.5" } });
    assert.equal(r.res.ok, true);
    assert.equal(row(r.node.address).gpu_status, "untested");
    assert.equal(row(r.node.address).family, "nvidia-rtx20-turing");
  });

  test("an allowed family is eligible", async () => {
    process.env.GPU_ALLOWLIST_MODE = "enforce";
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060", device: { vendor: "nvidia", computeCap: "8.6", driver: "590.48.01" } });
    assert.equal(row(r.node.address).gpu_status, "eligible");
    assert.deepEqual(JSON.parse(row(r.node.address).device_info!), { vendor: "nvidia", computeCap: "8.6", driver: "590.48.01" });
  });

  test("an old 0.2.0 body (no device, no features) registers exactly as before", async () => {
    const r = await register({ gpu: "NVIDIA GeForce RTX 4060", old: true, caps: [IMAGE, TEXT] });
    assert.equal(r.res.ok, true);
    assert.deepEqual(r.res.caps, [IMAGE, TEXT]);
    const n = row(r.node.address);
    assert.equal(n.challenge_cap, 0);
    assert.equal(n.challenge_state, null);
    assert.equal(n.device_info, null);
    assert.equal(n.gpu_status, "eligible");
  });

  test("the challenge feature marks a CUDA node pending-challenge; Vulkan / CPU nodes have no reference, so no state", async () => {
    const cuda = await register({ gpu: "NVIDIA GeForce RTX 3060" });
    assert.equal(row(cuda.node.address).challenge_cap, 1);
    assert.equal(row(cuda.node.address).challenge_state, "pending-challenge");
    assert.equal(cuda.res.challenge.challengeable, true);
    const vk = await register({ gpu: "AMD Radeon RX 7600 (Vulkan)", backend: "vulkan" });
    assert.equal(row(vk.node.address).challenge_cap, 1);
    assert.equal(row(vk.node.address).challenge_state, null);
    assert.equal(vk.res.challenge.challengeable, false);
  });

  test("an unknown capability tag in caps is still rejected; the feature travels in `features`", async () => {
    await assert.rejects(register({ gpu: "NVIDIA GeForce RTX 3060", caps: [TEXT, CHALLENGE_FEATURE] }), isApiError(400, "invalid-registration"));
  });
});

// ---- leasing ----------------------------------------------------------------------------------------
describe("tryLease never leases job tasks to non-eligible nodes", () => {
  test("allowlist enforce: an untested node gets no job, and is not counted as the compatible peer", async () => {
    process.env.GPU_ALLOWLIST_MODE = "enforce";
    const untested = await register({ gpu: "NVIDIA GeForce RTX 5090", old: true });
    const a = await register({ gpu: "NVIDIA GeForce RTX 3060", old: true });
    await textJob();
    assert.equal(await lease(untested.node.address), null, "untested node: no job");
    assert.equal(await lease(a.node.address), null, "the only peer is untested, so the first task is not handed out");
    const b = await register({ gpu: "NVIDIA GeForce RTX 4060", old: true });
    const first = await lease(a.node.address);
    assert.ok(first, "eligible pair: first task leased");
    assert.equal(await lease(untested.node.address), null, "the second task never goes to the untested node");
    const second = await lease(b.node.address);
    assert.equal(second?.jobId, first.jobId);
  });

  test("allowlist observe: classification blocks nothing", async () => {
    const untested = await register({ gpu: "NVIDIA GeForce RTX 2070", old: true });
    await register({ gpu: "NVIDIA GeForce RTX 3060", old: true });
    await textJob();
    assert.ok(await lease(untested.node.address));
  });

  test("a blocked node registered in observe mode gets nothing once enforce is on", async () => {
    const blocked = await register({ gpu: "llvmpipe (LLVM 15) (Vulkan)", backend: "vulkan", old: true });
    await register({ gpu: "AMD Radeon RX 7600 (Vulkan)", backend: "vulkan", old: true });
    process.env.GPU_ALLOWLIST_MODE = "enforce";
    await textJob();
    assert.equal(await lease(blocked.node.address), null);
  });

  test("challenge enforce: a pending-challenge node gets no job and does not count as the peer", async () => {
    process.env.CHALLENGE_MODE = "enforce";
    const pending = await register({ gpu: "NVIDIA GeForce RTX 3060" });
    const ready = await register({ gpu: "NVIDIA GeForce RTX 4060", old: true });
    await textJob();
    assert.equal(jobEligible(pending.node.address), false);
    assert.equal(await lease(pending.node.address), null);
    assert.equal(await lease(ready.node.address), null, "only peer is pending-challenge");
  });

  test("challenge enforce: an old node without the feature is gated as before (gets jobs, no challenge)", async () => {
    process.env.CHALLENGE_MODE = "enforce";
    const old1 = await register({ gpu: "NVIDIA GeForce RTX 3060", old: true });
    const old2 = await register({ gpu: "NVIDIA GeForce RTX 4060", old: true });
    await textJob();
    assert.equal(nextChallenge(old1.node.address), null);
    assert.ok(await lease(old1.node.address));
    assert.ok(await lease(old2.node.address));
  });
});

// ---- challenge state machine -------------------------------------------------------------------------
const reference = JSON.parse(readFileSync(join(process.cwd(), "bench", "reference", "suite-1-cuda.json"), "utf8")) as {
  cases: { id: string; kind: string; fingerprints: { fingerprint: string }[] }[];
};
/** The reference answer of a text case (a text fingerprint is the normalized text itself). */
const rightAnswer = (caseId: string) => reference.cases.find((c) => c.id === caseId)!.fingerprints[0].fingerprint;

async function answer(node: LocalAccount, challengeId: Hex, text: string, signer: LocalAccount = node) {
  const outputHash = sha256Hex(text);
  const signature = await signChallengeResult(signer, targetChain.id, { challengeId, node: node.address, outputHash, gpuMs: 1234n });
  return submitChallengeResult(node.address, challengeId, { text, outputHash, gpuMs: 1234, signature });
}

/** Pretend the cooldown / interval has passed. */
const timeTravel = (a: Address) =>
  getDb().prepare("UPDATE nodes SET cooldown_until = ?, challenge_due_at = ? WHERE node_key = ?").run(nowSec() - 1, nowSec() - 1, a);

describe("challenge state machine (CHALLENGE_MODE=enforce)", () => {
  test("pass: pending-challenge -> eligible, then not due again until the interval", async () => {
    process.env.CHALLENGE_MODE = "enforce";
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060" });
    const c = nextChallenge(r.node.address);
    assert.ok(c);
    assert.equal(c.type, "challenge");
    assert.equal(c.spec.kind, "text", "a text-only node gets a text case");
    assert.equal(nextChallenge(r.node.address)?.challengeId, c.challengeId, "an open challenge is handed back, not duplicated");
    const res = await answer(r.node, c.challengeId, rightAnswer(c.caseId));
    assert.equal(res.passed, true);
    assert.equal(res.state, "eligible");
    assert.equal(row(r.node.address).challenge_state, "eligible");
    assert.ok(row(r.node.address).challenge_due_at! >= nowSec() + 24 * 3600 - 5, "next one after CHALLENGE_INTERVAL_HOURS (24)");
    assert.equal(jobEligible(r.node.address), true);
    assert.equal(nextChallenge(r.node.address), null);
    await assert.rejects(answer(r.node, c.challengeId, rightAnswer(c.caseId)), isApiError(409, "challenge-closed"));
  });

  test("fail -> cooldown (6 h), then a second consecutive fail -> suspended", async () => {
    process.env.CHALLENGE_MODE = "enforce";
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060" });
    const c1 = nextChallenge(r.node.address)!;
    const r1 = await answer(r.node, c1.challengeId, "a completely different answer from a broken GPU");
    assert.equal(r1.passed, false);
    assert.equal(r1.state, "cooldown");
    const n1 = row(r.node.address);
    assert.ok(n1.cooldown_until! >= nowSec() + 6 * 3600 - 5 && n1.cooldown_until! <= nowSec() + 6 * 3600 + 5);
    assert.equal(jobEligible(r.node.address), false);
    assert.equal(nextChallenge(r.node.address), null, "no challenge during the cooldown");

    timeTravel(r.node.address);
    const c2 = nextChallenge(r.node.address)!;
    assert.ok(c2 && c2.challengeId !== c1.challengeId, "re-challenged after the cooldown");
    const r2 = await answer(r.node, c2.challengeId, "still wrong");
    assert.equal(r2.state, "suspended");
    timeTravel(r.node.address);
    assert.equal(nextChallenge(r.node.address), null, "suspended: no more challenges");
    assert.equal(jobEligible(r.node.address), false);
  });

  test("a pass after one fail clears the strike", async () => {
    process.env.CHALLENGE_MODE = "enforce";
    const r = await register({ gpu: "NVIDIA GeForce RTX 4060" });
    await answer(r.node, nextChallenge(r.node.address)!.challengeId, "wrong");
    timeTravel(r.node.address);
    const c = nextChallenge(r.node.address)!;
    const res = await answer(r.node, c.challengeId, rightAnswer(c.caseId));
    assert.equal(res.state, "eligible");
    assert.equal(row(r.node.address).challenge_fails, 0);
  });

  test("cooldown and suspension stick to the node key, even if it re-registers without the feature", async () => {
    process.env.CHALLENGE_MODE = "enforce";
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060" });
    await answer(r.node, nextChallenge(r.node.address)!.challengeId, "wrong");
    await register({ gpu: "NVIDIA GeForce RTX 3060", old: true, node: r.node, owner: r.owner });
    assert.equal(row(r.node.address).challenge_state, "cooldown");
    assert.equal(jobEligible(r.node.address), false);
  });

  test("bad answers are refused without changing state: wrong signer, another node, wrong hash", async () => {
    process.env.CHALLENGE_MODE = "enforce";
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060" });
    const other = await register({ gpu: "NVIDIA GeForce RTX 4060" });
    const c = nextChallenge(r.node.address)!;
    await assert.rejects(answer(r.node, c.challengeId, rightAnswer(c.caseId), other.node), isApiError(401, "bad-challenge-signature"));
    await assert.rejects(answer(other.node, c.challengeId, rightAnswer(c.caseId)), isApiError(409, "not-your-challenge"));
    const outputHash = sha256Hex("something else");
    const signature = await signChallengeResult(r.node, targetChain.id, { challengeId: c.challengeId, node: r.node.address, outputHash, gpuMs: 1n });
    await assert.rejects(
      submitChallengeResult(r.node.address, c.challengeId, { text: rightAnswer(c.caseId), outputHash, gpuMs: 1, signature }),
      isApiError(400, "output-hash-mismatch"),
    );
    assert.equal(row(r.node.address).challenge_state, "pending-challenge");
  });

  test("project pool nodes are not exempt", async () => {
    process.env.CHALLENGE_MODE = "enforce";
    const owner = privateKeyToAccount(generatePrivateKey());
    process.env.PROJECT_NODE_OWNERS = owner.address;
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060", owner });
    assert.equal(jobEligible(r.node.address), false);
    assert.ok(nextChallenge(r.node.address));
  });

  test("challenges are never jobs: no job rows, not in job lists or counts", async () => {
    process.env.CHALLENGE_MODE = "enforce";
    const jobsBefore = (getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
    const epoch = (await ensureEpoch()).id;
    const countsBefore = JSON.stringify(jobCounts(epoch));
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060" });
    const c = nextChallenge(r.node.address)!;
    await answer(r.node, c.challengeId, rightAnswer(c.caseId));
    assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n, jobsBefore);
    assert.equal(JSON.stringify(jobCounts(epoch)), countsBefore);
    assert.ok(!JSON.stringify(listJobs(100)).includes(c.challengeId.slice(2)));
    assert.equal(row(r.node.address).agreed_jobs, 0);
  });
});

describe("challenge observe mode and off mode", () => {
  test("observe: challenges are issued and recorded, but state and eligibility never change", async () => {
    process.env.CHALLENGE_MODE = "observe";
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060" });
    assert.equal(jobEligible(r.node.address), true);
    const c = nextChallenge(r.node.address)!;
    const res = await answer(r.node, c.challengeId, "wrong");
    assert.equal(res.passed, false);
    const n = row(r.node.address);
    assert.equal(n.challenge_state, "pending-challenge");
    assert.equal(n.challenge_fails, 0);
    assert.equal(n.cooldown_until, null);
    assert.equal(jobEligible(r.node.address), true);
    const rec = getDb().prepare("SELECT status, mode FROM challenges WHERE id = ?").get(c.challengeId) as { status: string; mode: string };
    assert.deepEqual({ ...rec }, { status: "failed", mode: "observe" });
    assert.equal(nextChallenge(r.node.address), null, "next one only after the cooldown period");
  });

  test("off: no challenges at all", async () => {
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060" });
    assert.equal(nextChallenge(r.node.address), null);
    assert.equal(jobEligible(r.node.address), true);
  });

  test("old nodes without the feature never get challenges in any mode", async () => {
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060", old: true });
    for (const mode of ["off", "observe", "enforce"]) {
      process.env.CHALLENGE_MODE = mode;
      assert.equal(nextChallenge(r.node.address), null, mode);
    }
  });
});

describe("challenge admin endpoint logic", () => {
  test("reissue from suspended keeps one strike; allow / revoke-allow; audit log; jobs untouched", async () => {
    process.env.CHALLENGE_MODE = "enforce";
    const r = await register({ gpu: "NVIDIA GeForce RTX 3060" });
    await answer(r.node, nextChallenge(r.node.address)!.challengeId, "wrong");
    timeTravel(r.node.address);
    await answer(r.node, nextChallenge(r.node.address)!.challengeId, "wrong");
    assert.equal(row(r.node.address).challenge_state, "suspended");

    const counts = () => getDb().prepare("SELECT (SELECT COUNT(*) FROM jobs) j, (SELECT COUNT(*) FROM tasks) t, (SELECT COUNT(*) FROM results) r").get();
    const before = JSON.stringify(counts());

    const allow = adminChallenge({ nodeKey: r.node.address, action: "allow", hours: 2, note: "investigating" });
    assert.equal(allow.after.state, "suspended");
    assert.equal(jobEligible(r.node.address), true, "temporary allow waives the challenge gate");
    adminChallenge({ nodeKey: r.node.address, action: "revoke-allow" });
    assert.equal(jobEligible(r.node.address), false);

    const re = adminChallenge({ nodeKey: r.node.address, action: "reissue" });
    assert.equal(re.after.state, "pending-challenge");
    assert.equal(re.after.fails, 1);
    const c = nextChallenge(r.node.address)!;
    assert.ok(c, "re-issued challenge handed out at the next poll");
    assert.equal((await answer(r.node, c.challengeId, "wrong again")).state, "suspended", "one more fail suspends again");

    adminChallenge({ nodeKey: r.node.address, action: "reissue" });
    const c2 = nextChallenge(r.node.address)!;
    assert.equal((await answer(r.node, c2.challengeId, rightAnswer(c2.caseId))).state, "eligible");

    const log = getDb().prepare("SELECT action FROM gpu_admin_log WHERE node_key = ? ORDER BY id").all(r.node.address) as { action: string }[];
    assert.deepEqual(log.map((l) => l.action), ["allow", "revoke-allow", "reissue", "reissue"]);
    assert.equal(JSON.stringify(counts()), before, "admin actions never touch jobs, tasks or results");
    assert.throws(() => adminChallenge({ nodeKey: r.node.address, action: "assign-result" }), isApiError(400, "invalid-request"));
  });
});
