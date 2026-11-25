// Periodic GPU challenge: the scheduler hands a node one fixed case of the published bench suite and compares the
// node's answer with the reference fingerprints of its backend (bench/reference/suite-<BENCH_SUITE>-<backend>.json),
// using the live matching code and thresholds (src/server/verify.ts: 12 dHash bits / 0.9 text similarity).
//
//   CHALLENGE_MODE=off      (default) no challenges
//   CHALLENGE_MODE=observe  challenges are issued and their pass / fail recorded; job eligibility never changes
//   CHALLENGE_MODE=enforce  pending-challenge (no jobs, challenges only) -> eligible on a pass;
//                           a fail -> cooldown (CHALLENGE_COOLDOWN_HOURS, default 6), then re-challenged;
//                           a second consecutive fail -> suspended (re-qualify only through the admin endpoint);
//                           an eligible node is re-challenged every CHALLENGE_INTERVAL_HOURS (default 24)
//
// Who gets challenges: only nodes that advertised the "challenge-1" feature at registration (node client 0.3.0+), on a
// backend that has a reference (today: cuda; dev-runner nodes use a synthetic reference in local tests). Other nodes
// are gated as before the challenge existed, except that a cooldown / suspension, once earned, sticks to the node key
// even if it re-registers without the feature. Project pool nodes are not exempt.
//
// Challenges are unpaid and never charged; they live in their own table, so they never count as jobs, never appear
// in job lists and never enter a payout tree. The admin endpoint can re-issue a challenge or temporarily allow a node;
// it never touches jobs, tasks or results.
import { getAddress, type Address, type Hex } from "viem";
import { targetChain } from "@/lib/chain";
import {
  CHALLENGE_FEATURE,
  isBackend,
  MODELS,
  modelRunsOn,
  recoverChallengeSigner,
  sha256Hex,
  validateSpec,
  type Backend,
  type ChallengeAssignment,
  type JobSpec,
} from "@/lib/protocol";
import cudaReference from "../../bench/reference/suite-1-cuda.json" with { type: "json" };
import devReference from "../../bench/reference/suite-1-dev-runner.json" with { type: "json" };
import { getDb, nowSec, randomHex, tx } from "./db";
import { POLICY, serverEnv } from "./env";
import { ApiError } from "./http";
import { decodePng, fingerprintsMatch, hammingHex, imageFingerprint, textFingerprint, textSimilarity } from "./verify";

export { CHALLENGE_FEATURE };

export type ChallengeState = "pending-challenge" | "eligible" | "cooldown" | "suspended";

type RawReference = { suite: number; backend: string; synthetic?: boolean; cases: { id: string; kind: string; spec: unknown; fingerprints: { fingerprint: string }[] }[] };
type RefCase = { id: string; kind: "image" | "text"; spec: JobSpec; fingerprints: string[] };
export type Reference = { suite: number; backend: Backend; synthetic: boolean; cases: RefCase[] };

/** Validates a reference file (every spec must be a valid job spec, every case needs fingerprints). Throws. */
export function loadReference(raw: RawReference): Reference {
  if (!isBackend(raw.backend)) throw new Error(`challenge reference: unknown backend ${raw.backend}`);
  const cases = raw.cases.map((c) => {
    const spec = validateSpec(c.spec);
    if (spec.kind !== c.kind || !c.fingerprints.length) throw new Error(`challenge reference: case ${c.id} is malformed`);
    return { id: c.id, kind: spec.kind, spec, fingerprints: c.fingerprints.map((f) => f.fingerprint) };
  });
  if (!cases.length) throw new Error("challenge reference has no cases");
  return { suite: raw.suite, backend: raw.backend, synthetic: raw.synthetic === true, cases };
}

/** Published references per backend. No Vulkan or CPU reference exists yet: those nodes are never challenged. */
const REFERENCES: Partial<Record<Backend, Reference>> = { cuda: loadReference(cudaReference as RawReference) };
const DEV_REFERENCE = loadReference(devReference as RawReference);

/** The reference a node is checked against, or null (no challenge possible). */
export function referenceFor(backend: Backend, dev: boolean): Reference | null {
  if (dev) return serverEnv.allowDevRunner() ? DEV_REFERENCE : null;
  return REFERENCES[backend] ?? null;
}

type ChallengeNode = {
  node_key: Address;
  owner: Address;
  backend: string;
  caps: string;
  vram_mb: number;
  dev: number;
  challenge_cap: number;
  challenge_state: ChallengeState | null;
  challenge_fails: number;
  challenge_due_at: number | null;
  cooldown_until: number | null;
  allow_until: number | null;
};

const backendOf = (n: { backend: string }): Backend => (isBackend(n.backend) ? n.backend : "cuda");

/** Reference cases this node can run (its capability tags, VRAM and backend). */
export function runnableCases(n: Pick<ChallengeNode, "backend" | "caps" | "vram_mb" | "dev">): RefCase[] {
  const ref = referenceFor(backendOf(n), n.dev === 1);
  if (!ref) return [];
  const caps = JSON.parse(n.caps) as string[];
  const backend = backendOf(n);
  return ref.cases.filter((c) => {
    const m = MODELS[c.spec.params.model];
    return caps.includes(m.tag) && n.vram_mb >= m.vramMb && modelRunsOn(c.spec.params.model, backend);
  });
}

/** Does this node take part in challenges at all? (feature advertised + a reference case it can run) */
export const challengeable = (n: Pick<ChallengeNode, "challenge_cap" | "backend" | "caps" | "vram_mb" | "dev">) =>
  n.challenge_cap === 1 && runnableCases(n).length > 0;

/**
 * SQL predicate (over the nodes table under alias `n`): may this node be leased JOB tasks? Used for the node itself
 * and for the "compatible peer online" check, so both apply the same gate. Needs the params of eligibilityParams().
 *   allowlist (GPU_ALLOWLIST_MODE=enforce): only gpu_status 'eligible'
 *   challenge (CHALLENGE_MODE=enforce): an operator allow, or no cooldown / suspension and either not challengeable
 *     (old client, or no reference for the backend) or challenge_state 'eligible'
 */
export const eligibleSql = (n: string) => `(
  ($amode != 'enforce' OR ${n}.gpu_status = 'eligible')
  AND ($cmode != 'enforce'
       OR COALESCE(${n}.allow_until, 0) > $now
       OR (COALESCE(${n}.challenge_state, '') NOT IN ('cooldown', 'suspended')
           AND (${n}.challenge_cap = 0
                OR (CASE WHEN ${n}.dev = 1 THEN $refDev WHEN ${n}.backend = 'cuda' THEN $refCuda
                         WHEN ${n}.backend = 'vulkan' THEN $refVulkan ELSE $refCpu END) = 0
                OR ${n}.challenge_state = 'eligible')))
)`;

export function eligibilityParams(): Record<string, string | number> {
  const has = (b: Backend, dev = false) => (referenceFor(b, dev) ? 1 : 0);
  return {
    amode: serverEnv.gpuAllowlistMode(),
    cmode: serverEnv.challengeMode(),
    refCuda: has("cuda"),
    refVulkan: has("vulkan"),
    refCpu: has("cpu"),
    refDev: has("cuda", true),
  };
}

/** Is this node eligible for job leases right now? (same predicate as the SQL above) */
export function jobEligible(nodeKey: Address, now = nowSec()): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS ok FROM nodes n WHERE n.node_key = $node AND ${eligibleSql("n")}`)
    .get({ node: nodeKey, now, ...eligibilityParams() }) as { ok: number } | undefined;
  return Boolean(row);
}

type ChallengeRow = {
  id: Hex;
  node_key: Address;
  owner: Address;
  backend: string;
  dev: number;
  suite: number;
  case_id: string;
  kind: "image" | "text";
  spec: string;
  expected: string;
  mode: "observe" | "enforce";
  status: "issued" | "passed" | "failed" | "expired";
  issued_at: number;
  lease_expires: number;
};

const assignmentOf = (c: ChallengeRow): ChallengeAssignment => ({
  type: "challenge",
  challengeId: c.id,
  suite: c.suite,
  caseId: c.case_id,
  spec: JSON.parse(c.spec) as JobSpec,
  chainId: targetChain.id,
  leaseExpiresAt: c.lease_expires,
});

const randomIndex = (n: number) => {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return b[0] % n;
};

/**
 * The challenge this node should run now, or null. Re-hands an open one; otherwise issues a new one when due
 * (registration, interval passed, cooldown over). Never for suspended nodes in enforce mode, never with
 * CHALLENGE_MODE=off, never to a node without the challenge feature.
 */
export function nextChallenge(nodeKey: Address): ChallengeAssignment | null {
  const mode = serverEnv.challengeMode();
  if (mode === "off") return null;
  // Cheap read first: this runs in every long-poll iteration, and most nodes never take challenges.
  const cap = getDb().prepare("SELECT challenge_cap FROM nodes WHERE node_key = ?").get(nodeKey) as { challenge_cap: number } | undefined;
  if (cap?.challenge_cap !== 1) return null;
  return tx((db) => {
    const now = nowSec();
    const n = db.prepare("SELECT * FROM nodes WHERE node_key = ?").get(nodeKey) as ChallengeNode | undefined;
    if (!n || n.challenge_cap !== 1) return null;
    const cases = runnableCases(n);
    if (!cases.length) return null;
    db.prepare("UPDATE challenges SET status = 'expired' WHERE node_key = ? AND status = 'issued' AND lease_expires < ?").run(nodeKey, now);
    const open = db.prepare("SELECT * FROM challenges WHERE node_key = ? AND status = 'issued' LIMIT 1").get(nodeKey) as ChallengeRow | undefined;
    if (open) return assignmentOf(open);
    if (mode === "enforce" && n.challenge_state === "suspended") return null;
    if (mode === "enforce" && n.challenge_state === "cooldown" && (n.cooldown_until ?? 0) > now) return null;
    if (n.challenge_due_at !== null && n.challenge_due_at > now) return null;
    const ref = referenceFor(backendOf(n), n.dev === 1)!;
    const c = cases[randomIndex(cases.length)];
    const row: ChallengeRow = {
      id: randomHex(32),
      node_key: n.node_key,
      owner: n.owner,
      backend: backendOf(n),
      dev: n.dev,
      suite: ref.suite,
      case_id: c.id,
      kind: c.kind,
      spec: JSON.stringify(c.spec),
      expected: JSON.stringify(c.fingerprints),
      mode,
      status: "issued",
      issued_at: now,
      lease_expires: now + POLICY.taskLeaseSeconds,
    };
    db.prepare(
      `INSERT INTO challenges (id, node_key, owner, backend, dev, suite, case_id, kind, spec, expected, mode, status, issued_at, lease_expires)
       VALUES ($id, $node_key, $owner, $backend, $dev, $suite, $case_id, $kind, $spec, $expected, $mode, $status, $issued_at, $lease_expires)`,
    ).run(row);
    return assignmentOf(row);
  });
}

function bad(message: string, field?: string): never {
  throw new ApiError(400, "invalid-challenge-result", message, field ? { field } : undefined);
}

/** POST /api/v1/challenges/:id/result — the node's signed answer. */
export async function submitChallengeResult(nodeKey: Address, challengeId: string, body: unknown) {
  if (!/^0x[0-9a-f]{64}$/.test(challengeId)) throw new ApiError(400, "invalid-challenge-id", "challenge id must be 0x + 64 lowercase hex characters");
  if (typeof body !== "object" || body === null) bad("expected a JSON object");
  const b = body as Record<string, unknown>;
  const db = getDb();
  const c = db.prepare("SELECT * FROM challenges WHERE id = ?").get(challengeId) as ChallengeRow | undefined;
  if (!c) throw new ApiError(404, "unknown-challenge", "no challenge with this id");
  if (c.node_key !== nodeKey) throw new ApiError(409, "not-your-challenge", "this challenge was issued to another node");
  if (c.status !== "issued") throw new ApiError(409, "challenge-closed", `challenge is ${c.status}`);
  if (c.lease_expires < nowSec()) {
    db.prepare("UPDATE challenges SET status = 'expired' WHERE id = ? AND status = 'issued'").run(c.id);
    throw new ApiError(409, "challenge-expired", "the challenge lease expired; poll for a new one");
  }
  const spec = JSON.parse(c.spec) as JobSpec;
  if (typeof b.outputHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.outputHash)) bad("outputHash must be a 32-byte hex hash", "outputHash");
  if (typeof b.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(b.signature)) bad("signature must be a 65-byte hex signature", "signature");
  const gpuMs = b.gpuMs;
  if (typeof gpuMs !== "number" || !Number.isFinite(gpuMs) || gpuMs < 0 || gpuMs > 86_400_000) bad("gpuMs must be a number of ms", "gpuMs");

  let output: Uint8Array;
  let fingerprint: string;
  if (spec.kind === "image") {
    if (typeof b.png !== "string" || b.png.length === 0) bad("image challenges need png (base64)", "png");
    output = Buffer.from(b.png, "base64");
    const img = decodePng(output, spec.params.width, spec.params.height);
    if (!img) bad(`png must be a valid ${spec.params.width}x${spec.params.height} PNG`, "png");
    fingerprint = imageFingerprint(img);
  } else {
    if (typeof b.text !== "string") bad("text challenges need text", "text");
    if (b.text.length > POLICY.maxTextOutputChars) bad(`text is longer than ${POLICY.maxTextOutputChars} characters`, "text");
    output = Buffer.from(b.text, "utf8");
    fingerprint = textFingerprint(b.text);
  }
  const outputHash = sha256Hex(output);
  if (outputHash.toLowerCase() !== (b.outputHash as string).toLowerCase()) {
    throw new ApiError(400, "output-hash-mismatch", "outputHash is not the sha256 of the submitted output");
  }
  const signer = await recoverChallengeSigner(
    targetChain.id,
    { challengeId: c.id, node: nodeKey, outputHash, gpuMs: BigInt(Math.round(gpuMs)) },
    b.signature as Hex,
  );
  if (!signer || getAddress(signer) !== nodeKey) {
    throw new ApiError(401, "bad-challenge-signature", "challenge answer is not signed by this node key (EIP-712 ChallengeResult)");
  }

  const expected = JSON.parse(c.expected) as string[];
  const distances = expected.map((fp) => (spec.kind === "image" ? hammingHex(fingerprint, fp) : Math.round(textSimilarity(fingerprint, fp) * 1000) / 1000));
  const passed = expected.every((fp) => fingerprintsMatch(spec.kind, fingerprint, fp));
  return tx((db) => {
    const now = nowSec();
    const cur = db.prepare("SELECT status FROM challenges WHERE id = ?").get(c.id) as { status: string };
    if (cur.status !== "issued") throw new ApiError(409, "challenge-closed", `challenge is ${cur.status}`);
    const n = db.prepare("SELECT * FROM nodes WHERE node_key = ?").get(nodeKey) as ChallengeNode;
    const mode = serverEnv.challengeMode();
    const before = { state: n.challenge_state, fails: n.challenge_fails };
    let state = n.challenge_state;
    let fails = n.challenge_fails;
    let cooldownUntil = n.cooldown_until;
    let dueAt: number | null;
    if (mode === "enforce") {
      if (passed) {
        state = "eligible";
        fails = 0;
        cooldownUntil = null;
        dueAt = now + serverEnv.challengeIntervalSeconds();
      } else {
        fails += 1;
        if (fails >= 2) {
          state = "suspended";
          cooldownUntil = null;
          dueAt = null;
        } else {
          state = "cooldown";
          cooldownUntil = now + serverEnv.challengeCooldownSeconds();
          dueAt = cooldownUntil;
        }
      }
    } else {
      // observe (or switched off since issue): record only; schedule the next one, never touch the state.
      dueAt = now + (passed ? serverEnv.challengeIntervalSeconds() : serverEnv.challengeCooldownSeconds());
    }
    db.prepare(
      "UPDATE nodes SET challenge_state = ?, challenge_fails = ?, cooldown_until = ?, challenge_due_at = ? WHERE node_key = ?",
    ).run(state, fails, cooldownUntil, dueAt, nodeKey);
    const detail = { distances, mode, before, after: { state, fails }, gpuMs: Math.round(gpuMs) };
    db.prepare("UPDATE challenges SET status = ?, answered_at = ?, output_hash = ?, fingerprint = ?, detail = ? WHERE id = ?").run(
      passed ? "passed" : "failed",
      now,
      outputHash,
      fingerprint,
      JSON.stringify(detail),
      c.id,
    );
    console.log(
      `[sparecycle] challenge ${mode}: node ${nodeKey} case ${c.case_id} ${passed ? "passed" : "failed"} (${spec.kind === "image" ? "bits" : "similarity"} ${distances.join(", ")})${mode === "enforce" ? ` -> ${state}` : ""}`,
    );
    return { ok: true, challengeId: c.id, passed, state, mode };
  });
}

// ---- operator escape hatch ------------------------------------------------------------------------------

export const ADMIN_ACTIONS = ["reissue", "allow", "revoke-allow"] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/**
 * POST /api/v1/admin/challenges (Authorization: Bearer $SCHEDULER_ADMIN_TOKEN):
 *   reissue      -> pending-challenge, challenged at the next poll (a node coming back from suspension keeps one
 *                   strike: one more fail suspends it again)
 *   allow        -> the challenge gate is waived until now + hours (default 24, max 168); the allowlist still applies
 *   revoke-allow -> ends an allow
 * Each call writes a gpu_admin_log row. It never assigns, changes or deletes jobs, tasks or results.
 */
export function adminChallenge(body: unknown) {
  if (typeof body !== "object" || body === null) throw new ApiError(400, "invalid-request", "expected a JSON object");
  const b = body as Record<string, unknown>;
  const action = b.action;
  if (typeof action !== "string" || !(ADMIN_ACTIONS as readonly string[]).includes(action)) {
    throw new ApiError(400, "invalid-request", `action must be one of ${ADMIN_ACTIONS.join(", ")}`, { field: "action" });
  }
  if (typeof b.nodeKey !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b.nodeKey)) {
    throw new ApiError(400, "invalid-request", "nodeKey must be an address", { field: "nodeKey" });
  }
  const nodeKey = getAddress(b.nodeKey);
  const note = typeof b.note === "string" ? b.note.slice(0, 200) : null;
  const hours = b.hours === undefined ? 24 : b.hours;
  if (action === "allow" && (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0 || hours > 168)) {
    throw new ApiError(400, "invalid-request", "hours must be a number in (0, 168]", { field: "hours" });
  }
  return tx((db) => {
    const now = nowSec();
    const n = db.prepare("SELECT * FROM nodes WHERE node_key = ?").get(nodeKey) as ChallengeNode | undefined;
    if (!n) throw new ApiError(404, "unknown-node", "no node with this key");
    const snap = (x: ChallengeNode) => ({
      state: x.challenge_state,
      fails: x.challenge_fails,
      cooldownUntil: x.cooldown_until,
      dueAt: x.challenge_due_at,
      allowUntil: x.allow_until,
    });
    const before = snap(n);
    if (action === "reissue") {
      db.prepare("UPDATE challenges SET status = 'expired' WHERE node_key = ? AND status = 'issued'").run(nodeKey);
      db.prepare(
        `UPDATE nodes SET challenge_state = 'pending-challenge', challenge_fails = MIN(challenge_fails, 1), cooldown_until = NULL,
           challenge_due_at = ? WHERE node_key = ?`,
      ).run(now, nodeKey);
    } else if (action === "allow") {
      db.prepare("UPDATE nodes SET allow_until = ? WHERE node_key = ?").run(now + Math.round((hours as number) * 3600), nodeKey);
    } else {
      db.prepare("UPDATE nodes SET allow_until = NULL WHERE node_key = ?").run(nodeKey);
    }
    const after = snap(db.prepare("SELECT * FROM nodes WHERE node_key = ?").get(nodeKey) as ChallengeNode);
    db.prepare("INSERT INTO gpu_admin_log (at, action, node_key, detail, note) VALUES (?, ?, ?, ?, ?)").run(
      now,
      action,
      nodeKey,
      JSON.stringify({ before, after, ...(action === "allow" ? { hours } : {}) }),
      note,
    );
    console.log(`[sparecycle] challenge admin: ${action} node ${nodeKey} (${before.state ?? "none"} -> ${after.state ?? "none"})`);
    return { ok: true, nodeKey, action, before, after };
  });
}

/** GET /api/v1/admin/challenges?nodeKey=0x… — a node's challenge state, recent challenges and admin log. */
export function adminChallengeReport(nodeKeyRaw: string | null) {
  if (!nodeKeyRaw || !/^0x[0-9a-fA-F]{40}$/.test(nodeKeyRaw)) throw new ApiError(400, "invalid-request", "nodeKey must be an address");
  const nodeKey = getAddress(nodeKeyRaw);
  const db = getDb();
  const n = db.prepare("SELECT * FROM nodes WHERE node_key = ?").get(nodeKey) as (ChallengeNode & { family: string | null; gpu_status: string | null }) | undefined;
  if (!n) throw new ApiError(404, "unknown-node", "no node with this key");
  const challenges = db
    .prepare(
      "SELECT id, case_id, kind, mode, status, issued_at, answered_at, detail FROM challenges WHERE node_key = ? ORDER BY issued_at DESC, rowid DESC LIMIT 20",
    )
    .all(nodeKey) as { detail: string | null }[];
  const log = db.prepare("SELECT at, action, detail, note FROM gpu_admin_log WHERE node_key = ? ORDER BY id DESC LIMIT 50").all(nodeKey) as {
    detail: string;
  }[];
  return {
    nodeKey,
    family: n.family,
    gpuStatus: n.gpu_status,
    challengeFeature: n.challenge_cap === 1,
    challengeable: challengeable(n),
    state: n.challenge_state,
    fails: n.challenge_fails,
    dueAt: n.challenge_due_at,
    cooldownUntil: n.cooldown_until,
    allowUntil: n.allow_until,
    jobEligible: jobEligible(nodeKey),
    challenges: challenges.map((c) => ({ ...c, detail: c.detail ? JSON.parse(c.detail) : null })),
    log: log.map((l) => ({ ...l, detail: JSON.parse(l.detail) })),
  };
}
