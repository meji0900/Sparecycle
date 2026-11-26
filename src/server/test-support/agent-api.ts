// Shared harness of the agent-API unit tests (apikeys / openai / mcp .test.ts): a scratch SQLite DB, a local-chain
// config with no reachable RPC, stubbed chain reads (balances, spend limits, ERC-1271 wallets), two in-process dev
// "nodes" that agree or disagree on demand, wallet sign-in through the real routes, and key creation + activation.
// Test code only: imported by *.test.ts files, never by the app. Call setupAgentApi() before anything else.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { verifyMessage, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

export const SITE = "http://127.0.0.1:3304";
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const newAccount = () => privateKeyToAccount(generatePrivateKey());

/** Everything one test file needs; built once by setupAgentApi(). */
export async function setupAgentApi() {
  const dir = mkdtempSync(join(tmpdir(), "sparecycle-agent-api-"));
  for (const k of Object.keys(process.env)) {
    if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|VAST_|GPU_POOL_|OUTPUT_|AUTH_|API_|TEAM_|CHALLENGE_|GPU_ALLOWLIST)/.test(k)) delete process.env[k];
  }
  const payments = newAccount().address; // stands in for the payments contract: every read of it is stubbed below
  Object.assign(process.env, {
    NEXT_PUBLIC_NETWORK: "local",
    NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9", // nothing listens: an unstubbed chain call fails fast
    NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS: payments,
    NEXT_PUBLIC_JOB_PRICE_WEI_PER_UNIT: "1000",
    DB_PATH: join(dir, "test.db"),
    SCHEDULER_ALLOW_DEV_RUNNER: "1",
    JOB_RATE_LIMIT: "1000",
    OUTPUT_AUTH: "enforce",
  });

  const m = {
    db: await import("../db"),
    jobs: await import("../jobs"),
    nodes: await import("../nodes"),
    results: await import("../results"),
    payments: await import("../payments"),
    apikeys: await import("../apikeys"),
    openai: await import("../openai"),
    mcp: await import("../mcp"),
    proto: await import("@/lib/protocol"),
    rounds: await import("@/lib/rounds"),
    chain: await import("@/lib/chain"),
    libKeys: await import("@/lib/api-keys"),
    routes: {
      keys: await import("@/app/api/v1/keys/route"),
      key: await import("@/app/api/v1/keys/[id]/route"),
      activate: await import("@/app/api/v1/keys/[id]/activate/route"),
      disableAll: await import("@/app/api/v1/keys/disable-all/route"),
      jobs: await import("@/app/api/v1/jobs/route"),
      result: await import("@/app/api/v1/jobs/[id]/result/route"),
      receipt: await import("@/app/api/v1/jobs/[id]/receipt/route"),
      job: await import("@/app/api/v1/jobs/[id]/route"),
      catalog: await import("@/app/api/v1/catalog/route"),
      nonce: await import("@/app/api/v1/auth/nonce/route"),
      verify: await import("@/app/api/v1/auth/verify/route"),
      chat: await import("@/app/api/v1/chat/completions/route"),
      chatPoll: await import("@/app/api/v1/chat/completions/[id]/route"),
      images: await import("@/app/api/v1/images/generations/route"),
      imagesPoll: await import("@/app/api/v1/images/generations/[id]/route"),
      models: await import("@/app/api/v1/models/route"),
      mcp: await import("@/app/api/v1/mcp/route"),
    },
  };

  // ---- Stubbed chain reads ----------------------------------------------------------------------------
  const chain = {
    balance: new Map<string, bigint>(),
    spendLimit: new Map<string, bigint>(),
    /** smart wallet address (lowercase) -> the EOA whose signature it accepts (a stand-in for ERC-1271). */
    smartWallets: new Map<string, LocalAccount>(),
    reads: 0,
  };
  const pc = m.chain.publicClient as unknown as Record<string, unknown>;
  pc.readContract = async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
    chain.reads++;
    const who = String(args?.[0] ?? "").toLowerCase();
    if (functionName === "balanceOf") return chain.balance.get(who) ?? 0n;
    if (functionName === "spendLimitPerEpoch") return chain.spendLimit.get(who) ?? 0n;
    if (functionName === "withdrawRequestOf") return [0n, 0n, 0n];
    if (functionName === "canWithdraw") return false;
    if (functionName === "chargedInEpoch") return 0n;
    throw new Error(`unstubbed read ${functionName}`);
  };
  pc.verifyMessage = async ({ address, message, signature }: { address: Address; message: string; signature: Hex }) => {
    const owner = chain.smartWallets.get(address.toLowerCase());
    return owner ? verifyMessage({ address: owner.address, message, signature }) : false;
  };
  pc.simulateContract = async () => ({ request: {} }); // the charge transaction then fails at the (absent) RPC

  // ---- Captured logs: no key, secret or prompt may ever be printed -------------------------------------------
  const logs: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
      orig(...a);
    };
  }

  // ---- Nodes ---------------------------------------------------------------------------------------------------
  const mkNode = async (name: string) => {
    const key = newAccount();
    const owner = newAccount();
    const ownerSig = await owner.signMessage({ message: m.proto.linkMessage(key.address, owner.address) });
    await m.nodes.registerNode(key.address, {
      gpu: `TEST ${name}`,
      gpuUuid: `TEST-GPU-${name}`,
      vramMb: 24_000,
      caps: ["text:qwen2.5-1.5b", "image:sd15"],
      owner: owner.address,
      ownerSig,
      dev: true,
    });
    return key;
  };
  const nodeA = await mkNode("A");
  const nodeB = await mkNode("B");

  /** A solid-colour PNG of the given size (two equal ones agree; black vs white disagree). */
  const png = (w: number, h: number, v: number) => {
    const p = new PNG({ width: w, height: h });
    p.data.fill(v);
    for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255;
    return PNG.sync.write(p);
  };

  /** One node leases the only open task and sends a signed dev result. */
  async function work(node: LocalAccount, out: { text?: string; shade?: number; nsfw?: boolean }) {
    const a = (await m.nodes.pollForTask(node.address, AbortSignal.abort())) as { jobId: Hex; taskId: string; epoch: number; spec: { kind: string; params: { width: number; height: number } } } | null;
    assert.ok(a, "the node got a task");
    const body: Record<string, unknown> = { gpuMs: 10, epoch: a.epoch, dev: true };
    let output: Uint8Array;
    if (a.spec.kind === "image") {
      output = png(a.spec.params.width, a.spec.params.height, out.shade ?? 0);
      body.png = Buffer.from(output).toString("base64");
      body.nsfw = !!out.nsfw;
    } else {
      output = Buffer.from(out.text ?? "same answer", "utf8");
      body.text = out.text ?? "same answer";
    }
    const outputHash = m.proto.sha256Hex(output);
    const signature = await m.proto.signReceipt(node, m.chain.targetChain.id, {
      jobId: a.jobId,
      node: node.address,
      outputHash,
      gpuMs: 10n,
      epoch: BigInt(a.epoch),
    });
    return m.results.submitResult(node.address, a.taskId, { ...body, outputHash, signature });
  }

  /** Cancels the open tasks of every job except `id`, so the next polls pick that job. */
  const only = (id: string) => m.db.getDb().prepare("UPDATE tasks SET status = 'cancelled' WHERE job_id != ? AND status IN ('open','leased')").run(id);

  /**
   * Puts job `id` (still unleased) in its last re-check round (../rounds), so a mismatch on these two nodes is final:
   * the harness has only two nodes, and a paid job's earlier round would send it to another pair instead.
   */
  const lastRound = (id: string) => {
    const last = m.rounds.MAX_ROUNDS - 1;
    m.db.getDb().prepare("UPDATE jobs SET round = ? WHERE id = ?").run(last, id);
    m.db.getDb().prepare("UPDATE tasks SET round = ? WHERE job_id = ?").run(last, id);
  };

  /** Runs job `id` on both nodes: equal outputs agree, different ones disagree. */
  async function run(id: string, a: { text?: string; shade?: number; nsfw?: boolean } = {}, b = a) {
    only(id);
    await work(nodeA, a);
    return (await work(nodeB, b)).status;
  }

  /**
   * Forced-mismatch hook: runs the current round of job `id` on two given nodes. Different outputs disagree, so a paid job
   * moves on to another pair (re-check rounds); the result of the second node is returned (its status and round).
   */
  async function runOn(id: string, x: LocalAccount, y: LocalAccount, a: { text?: string; shade?: number; nsfw?: boolean } = {}, b = a) {
    only(id);
    await work(x, a);
    return work(y, b);
  }

  /** The owner wallet a node key was registered with. */
  const ownerOf = (node: LocalAccount) => (m.db.getDb().prepare("SELECT owner FROM nodes WHERE node_key = ?").get(node.address) as { owner: Address }).owner;

  /** Marks nodes online (polled just now) or offline (last seen long ago). */
  const setOnline = (online: LocalAccount[], offline: LocalAccount[] = []) => {
    const up = m.db.getDb().prepare("UPDATE nodes SET last_seen = ? WHERE node_key = ?");
    for (const n of online) up.run(m.db.nowSec(), n.address);
    for (const n of offline) up.run(0, n.address);
  };

  // ---- HTTP helpers ---------------------------------------------------------------------------------------------
  let ipSeq = 0;
  const nextIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  type Init = { method?: string; headers?: Record<string, string>; body?: unknown; path?: string };
  const req = (path: string, { method = "GET", headers = {}, body }: Init = {}) =>
    new Request(`${SITE}${path}`, {
      method,
      headers: { "x-forwarded-for": nextIp(), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const json = async (res: Response) => (res.headers.get("content-type")?.includes("json") ? ((await res.json()) as Record<string, any>) : null); // eslint-disable-line @typescript-eslint/no-explicit-any

  function assertPrivate(res: Response, label: string) {
    assert.equal(res.headers.get("cache-control"), "private, no-store", `${label}: cache-control`);
  }

  /** Signs `account` in through the real nonce + verify routes (`signer` signs for a smart wallet). Returns the cookie header. */
  async function signIn(account: { address: Address }, signer: LocalAccount = account as LocalAccount) {
    const n = await (await m.routes.nonce.GET(req("/api/v1/auth/nonce"))).json();
    const message = createSiweMessage({
      address: account.address,
      chainId: n.chainId,
      domain: new URL(SITE).host,
      nonce: n.nonce,
      uri: `${SITE}/jobs`,
      version: "1",
      issuedAt: new Date(),
      statement: n.statement,
    });
    const signature = await signer.signMessage({ message });
    const res = await m.routes.verify.POST(req("/api/v1/auth/verify", { method: "POST", body: { message, signature } }));
    assert.equal(res.status, 200, "sign-in");
    const value = /^sc_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    assert.ok(value);
    return { cookie: `sc_session=${value}` };
  }

  /** Creates and activates a key for a signed-in wallet; returns the full key and its id. */
  async function makeKey(session: { cookie: string }, signer: LocalAccount, dailyCapWei = "1000000000000", label = "test") {
    const c = await m.routes.keys.POST(req("/api/v1/keys", { method: "POST", headers: session, body: { label, dailyCapWei } }));
    assert.equal(c.status, 201, "create key");
    const pending = await c.json();
    const signature = await signer.signMessage({ message: pending.linkMessage });
    const a = await m.routes.activate.POST(req(`/api/v1/keys/${pending.keyId}/activate`, { method: "POST", headers: session, body: { signature } }), ctx(pending.keyId));
    assert.equal(a.status, 200, "activate key");
    const active = await a.json();
    return { key: active.key as string, keyId: pending.keyId as string, pending, active };
  }

  /** A funded wallet with a session and one active key. */
  async function customer(balance = 10n ** 15n, dailyCapWei = "1000000000000") {
    const wallet = newAccount();
    chain.balance.set(wallet.address.toLowerCase(), balance);
    const session = await signIn(wallet);
    const k = await makeKey(session, wallet, dailyCapWei);
    return { wallet, session, ...k };
  }

  const cleanup = () => {
    try {
      m.db.getDb().close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  return { m, chain, logs, nodeA, nodeB, mkNode, work, run, runOn, ownerOf, setOnline, only, lastRound, req, ctx, bearer, json, assertPrivate, signIn, makeKey, customer, cleanup, payments, png };
}
