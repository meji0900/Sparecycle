// Shared harness of the token-feature unit tests (slashing / stake-gate / burns / holder-page .test.ts): a scratch SQLite
// DB, a local-chain config with no reachable RPC (an unstubbed chain read fails fast), the payments contract's reads
// stubbed, dev-runner "nodes" driven in-process (register -> poll -> signed result) and paid jobs signed like the dapp
// signs them. Nothing is ever sent: simulateContract throws. Test code only. Call setupTokenHarness() before anything
// else in a test file.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import type { Hex, LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const newAccount = () => privateKeyToAccount(generatePrivateKey());

export async function setupTokenHarness(env: Record<string, string> = {}) {
  for (const k of Object.keys(process.env)) {
    if (/^(NEXT_PUBLIC_|SCHEDULER_|SWEEP_|VAST_|GPU_POOL_|OUTPUT_|AUTH_|API_|TEAM_|CHALLENGE_|GPU_ALLOWLIST|PROJECT_NODE_|PAID_TEST_|TOKEN_)/.test(k)) {
      delete process.env[k];
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "sparecycle-token-"));
  Object.assign(process.env, {
    NEXT_PUBLIC_NETWORK: "local",
    NEXT_PUBLIC_RPC_URL: "http://127.0.0.1:9",
    NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS: newAccount().address,
    DB_PATH: join(dir, "test.db"),
    SCHEDULER_ALLOW_DEV_RUNNER: "1",
    JOB_RATE_LIMIT: "100000",
    ...env,
  });
  const m = {
    db: await import("../db"),
    env: await import("../env"),
    jobs: await import("../jobs"),
    nodes: await import("../nodes"),
    results: await import("../results"),
    epochs: await import("../epochs"),
    chainIo: await import("../chain-io"),
    proto: await import("@/lib/protocol"),
    chain: await import("@/lib/chain"),
    config: await import("@/lib/config"),
    jobPayment: await import("@/lib/job-payment"),
  };

  const balances = new Map<string, bigint>();
  const pc = m.chain.publicClient as unknown as Record<string, (...a: unknown[]) => unknown>;
  mock.method(pc, "readContract", async (...a: unknown[]) => {
    const { functionName, args = [] } = a[0] as { functionName: string; args?: readonly unknown[] };
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
  mock.method(pc, "simulateContract", async () => {
    throw new Error("no chain in this test: nothing is sent");
  });

  type Node = { key: LocalAccount; owner: LocalAccount; gpuUuid: string };
  let seq = 0;
  async function mkNode(o: { owner?: LocalAccount } = {}): Promise<Node> {
    const key = newAccount();
    const owner = o.owner ?? newAccount();
    const gpuUuid = `TEST-TOKEN-GPU-${seq++}`;
    await m.nodes.registerNode(key.address, {
      gpu: "TEST dev",
      gpuUuid,
      vramMb: 24_000,
      caps: ["text:qwen2.5-1.5b", "image:sd15"],
      owner: owner.address,
      ownerSig: await owner.signMessage({ message: m.proto.linkMessage(key.address, owner.address) }),
      dev: true,
      backend: "cuda",
    });
    return { key, owner, gpuUuid };
  }
  const allOnline = () => m.db.getDb().prepare("UPDATE nodes SET last_seen = ?").run(m.db.nowSec());

  type Lease = { taskId: string; jobId: Hex; epoch: number; spec: { kind: "image" | "text" } };
  async function poll(n: Node): Promise<Lease | null> {
    const a = await m.nodes.pollForTask(n.key.address, AbortSignal.abort());
    if (a && "challengeId" in a) throw new Error("unexpected challenge");
    return a as Lease | null;
  }
  async function lease(n: Node): Promise<Lease> {
    const a = await poll(n);
    assert.ok(a, "the node got a task");
    return a;
  }
  async function send(n: Node, a: Lease, text: string) {
    const bytes = Buffer.from(text, "utf8");
    const outputHash = m.proto.sha256Hex(bytes);
    const signature = await m.proto.signReceipt(n.key, m.chain.targetChain.id, { jobId: a.jobId, node: n.key.address, outputHash, gpuMs: 10n, epoch: BigInt(a.epoch) });
    return m.results.submitResult(n.key.address, a.taskId, { gpuMs: 10, epoch: a.epoch, dev: true, text, outputHash, signature });
  }
  /** Two nodes lease the job's current round and answer `outA` / `outB`; returns the second answer. */
  async function pair(a: Node, b: Node, outA: string, outB: string) {
    allOnline();
    const la = await lease(a);
    const lb = await lease(b);
    assert.equal(la.jobId, lb.jobId, "both nodes work on the same job");
    await send(a, la, outA);
    return send(b, lb, outB);
  }

  let ip = 0;
  const textRequest = (prompt: string) => ({ kind: "text", params: { model: "qwen2.5-1.5b", prompt, maxTokens: 16 } });
  /** A paid text job signed by a fresh payer (balance stubbed to cover it). */
  async function submitPaid(prompt: string) {
    const payer = newAccount();
    const request = textRequest(prompt);
    const priceWei = m.jobPayment.jobPriceWei(m.proto.parseJobRequest(request), m.config.config.jobPriceWeiPerUnit);
    balances.set(payer.address.toLowerCase(), 100n * priceWei);
    const issued = m.db.nowSec();
    const message = m.jobPayment.jobPaymentMessage({
      chainId: m.chain.targetChain.id,
      contract: m.config.config.jobPayments!,
      requestHash: m.jobPayment.jobRequestHash(request),
      priceWei,
      issued,
    });
    const signature = await payer.signMessage({ message });
    return m.jobs.submitJob({ request, payment: { payer: payer.address, signature, issued, priceWei: priceWei.toString() } }, `10.9.${Math.floor(++ip / 250)}.${ip % 250}`);
  }

  const cleanup = () => {
    mock.restoreAll();
    try {
      m.db.getDb().close();
    } catch {
      /* closed */
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };

  return { m, balances, mkNode, allOnline, poll, lease, send, pair, submitPaid, textRequest, cleanup };
}
