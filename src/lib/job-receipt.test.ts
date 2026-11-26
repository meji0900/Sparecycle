// Jobs tree and job receipts (src/lib/job-receipt.ts, feature brief #8 option B): the leaf encoding against a
// hand-built abi.encode, the uint8 codes, proofs for every leaf, tampering, the strict receipt parser, and
// verifyReceipt against a stub chain (a Charged / CustomerCharged transaction built here). No network. Run: npm test
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  encodePacked,
  keccak256,
  numberToHex,
  pad,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { jobPaymentsAbi } from "@/contracts/jobPayments";
import {
  buildJobsTree,
  jobLeafOf,
  JOBS_HASH_RULE,
  LEAF_CHARGE_STATUS,
  LEAF_VERDICT,
  parseReceipt,
  ReceiptFormatError,
  verifyReceipt,
  ZERO_HASH,
  type JobLeafEntry,
  type JobReceipt,
  type ReceiptChainClient,
} from "./job-receipt";
import { getProof, verifyProof } from "./merkle";
import { sha256Hex, signReceipt } from "./protocol";

const CHAIN = 4663;
const CONTRACT: Address = "0x420716931E5Ff2a984840C6E95837d826a8BE7eB";
const rnd32 = (): Hex => keccak256(generatePrivateKey());
const addr = (): Address => privateKeyToAccount(generatePrivateKey()).address;

/** abi.encode of the seven leaf fields, by hand: every value left-padded to one 32-byte word. */
function manualLeaf(epochId: number, e: JobLeafEntry): Hex {
  const word = (v: bigint | number) => pad(numberToHex(v), { size: 32 });
  return keccak256(
    concat([
      word(epochId),
      e.jobId,
      pad(e.payer.toLowerCase() as Hex, { size: 32 }),
      word(e.priceWei),
      word(LEAF_VERDICT[e.verdict]),
      word(LEAF_CHARGE_STATUS[e.chargeStatus]),
      e.outputHash ?? ZERO_HASH,
    ]),
  );
}

const entry = (over: Partial<JobLeafEntry> = {}): JobLeafEntry => ({
  jobId: rnd32(),
  payer: addr(),
  priceWei: 26_214_400_000_000n,
  verdict: "agreed",
  chargeStatus: "charged",
  outputHash: rnd32(),
  ...over,
});

describe("jobs tree: leaf encoding and codes", () => {
  test("the uint8 codes are fixed (changing them would change every committed leaf)", () => {
    assert.deepEqual(LEAF_VERDICT, { agreed: 1, disagreed: 2, expired: 3, rejected: 4 });
    assert.deepEqual(LEAF_CHARGE_STATUS, { charged: 1, released: 2, unpaid: 3 });
    assert.equal(JOBS_HASH_RULE, "v2-jobs-merkle");
  });

  test("leaf = keccak256(abi.encode(uint64, bytes32, address, uint256, uint8, uint8, bytes32)), 224 bytes in", () => {
    for (const e of [
      entry(),
      entry({ verdict: "disagreed", chargeStatus: "released", outputHash: null }),
      entry({ verdict: "expired", chargeStatus: "released", outputHash: null, priceWei: 1n }),
      entry({ verdict: "rejected", chargeStatus: "released", outputHash: null }),
      entry({ chargeStatus: "unpaid" }),
    ]) {
      assert.equal(jobLeafOf(7, e), manualLeaf(7, e));
      const packedStyle = keccak256(encodePacked(["uint64", "bytes32", "address", "uint256"], [7n, e.jobId, e.payer, e.priceWei]));
      assert.notEqual(jobLeafOf(7, e), packedStyle, "abi.encode, not encodePacked");
    }
    const words = encodeAbiParameters(
      [{ type: "uint64" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "uint8" }, { type: "bytes32" }],
      [1n, ZERO_HASH, CONTRACT, 0n, 1, 1, ZERO_HASH],
    );
    assert.equal((words.length - 2) / 2, 224);
  });

  test("a not-agreed job's output hash is 0x00…00 (null and zero give the same leaf)", () => {
    const e = entry({ verdict: "disagreed", chargeStatus: "released", outputHash: null });
    assert.equal(jobLeafOf(3, e), jobLeafOf(3, { ...e, outputHash: ZERO_HASH }));
  });

  test("every field and the epoch change the leaf", () => {
    const e = entry();
    const base = jobLeafOf(5, e);
    const variants: JobLeafEntry[] = [
      { ...e, jobId: rnd32() },
      { ...e, payer: addr() },
      { ...e, priceWei: e.priceWei + 1n },
      { ...e, verdict: "disagreed" },
      { ...e, chargeStatus: "unpaid" },
      { ...e, outputHash: rnd32() },
    ];
    for (const v of variants) assert.notEqual(jobLeafOf(5, v), base);
    assert.notEqual(jobLeafOf(6, e), base);
  });
});

describe("jobs tree: proofs", () => {
  test("every leaf of trees of 1 to 9 jobs proves against the root; a changed leaf or proof does not", () => {
    for (let n = 1; n <= 9; n++) {
      const entries = Array.from({ length: n }, (_, i) =>
        i % 3 === 0 ? entry({ verdict: "disagreed", chargeStatus: "released", outputHash: null }) : entry(),
      );
      const { tree, leaves } = buildJobsTree(11, entries);
      for (const l of leaves) {
        const proof = getProof(tree, l.leaf);
        assert.ok(verifyProof(proof, tree.root, l.leaf), `n=${n}`);
        assert.ok(!verifyProof(proof, tree.root, jobLeafOf(11, { ...l, priceWei: l.priceWei + 1n })), `n=${n}: changed price`);
        if (proof.length) assert.ok(!verifyProof([rnd32(), ...proof.slice(1)], tree.root, l.leaf), `n=${n}: changed proof`);
      }
      if (n === 1) assert.equal(tree.root, leaves[0].leaf, "one job: the root is its leaf");
    }
  });
});

// ---- receipts against a stub chain -------------------------------------------------------------------------------

type Built = { receipt: JobReceipt; chargeTx: Hex; client: ReceiptChainClient; calls: string[] };

/** Two node keys sign the job; the job sits in a 4-job tree of epoch 9; the stub chain holds the charge tx. */
async function sealedReceipt(opts: { verdict?: "agreed" | "disagreed"; chargeStatus?: "charged" | "released" | "unpaid" } = {}): Promise<Built> {
  const verdict = opts.verdict ?? "agreed";
  const chargeStatus = opts.chargeStatus ?? (verdict === "agreed" ? "charged" : "released");
  const epochId = 9;
  const jobId = rnd32();
  const payer = addr();
  const priceWei = 26_214_400_000_000n;
  const nodeA = privateKeyToAccount(generatePrivateKey());
  const nodeB = privateKeyToAccount(generatePrivateKey());
  const hashA = sha256Hex("output A");
  const hashB = verdict === "agreed" ? hashA : sha256Hex("output B");
  const sign = async (k: typeof nodeA, outputHash: Hex) => ({
    node: k.address,
    outputHash,
    gpuMs: 1234,
    epoch: epochId,
    signature: await signReceipt(k, CHAIN, { jobId, node: k.address, outputHash, gpuMs: 1234n, epoch: BigInt(epochId) }),
  });
  const outputHash = verdict === "agreed" ? hashA : null;
  const mine: JobLeafEntry = { jobId, payer, priceWei, verdict, chargeStatus, outputHash };
  const { tree } = buildJobsTree(epochId, [mine, entry(), entry({ verdict: "expired", chargeStatus: "released", outputHash: null }), entry()]);
  const leaf = jobLeafOf(epochId, mine);
  const chargeTx = rnd32();
  const receipt: JobReceipt = {
    format: "sparecycle-job-receipt",
    version: 1,
    state: "sealed",
    chainId: CHAIN,
    paymentsContract: CONTRACT,
    jobId,
    payer,
    priceWei: priceWei.toString(),
    verdict,
    chargeStatus,
    outputHash,
    nodes: [await sign(nodeA, hashA), await sign(nodeB, hashB)],
    epochId,
    chargeTx,
    anchor: {
      hashRule: "v2-jobs-merkle",
      leafInputs: {
        epochId,
        jobId,
        payer,
        priceWei: priceWei.toString(),
        verdict: LEAF_VERDICT[verdict],
        chargeStatus: LEAF_CHARGE_STATUS[chargeStatus],
        outputHash: outputHash ?? ZERO_HASH,
      },
      leaf,
      proof: getProof(tree, leaf),
      listHash: tree.root,
    },
    pending: null,
  };
  const word = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v]);
  const logs = [
    {
      address: CONTRACT,
      topics: encodeEventTopics({ abi: jobPaymentsAbi, eventName: "CustomerCharged", args: { epochId: BigInt(epochId), customer: payer } }) as Hex[],
      data: word(priceWei * 3n),
    },
    {
      address: CONTRACT,
      topics: encodeEventTopics({ abi: jobPaymentsAbi, eventName: "Charged", args: { epochId: BigInt(epochId), listHash: tree.root } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [priceWei * 3n, priceWei * 3n - 1n, 1n]),
    },
  ];
  const calls: string[] = [];
  const client: ReceiptChainClient = {
    getChainId: async () => {
      calls.push("chainId");
      return CHAIN;
    },
    getTransactionReceipt: async ({ hash }) => {
      calls.push(`receipt ${hash}`);
      if (hash.toLowerCase() !== chargeTx.toLowerCase()) {
        const e = new Error("not found");
        e.name = "TransactionReceiptNotFoundError";
        throw e;
      }
      return { status: "success", blockNumber: 123n, logs };
    },
  };
  return { receipt, chargeTx, client, calls };
}

const opts = (client: ReceiptChainClient) => ({ client, chainId: CHAIN, paymentsContract: CONTRACT });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("verifyReceipt", () => {
  test("a sealed charged receipt verifies against the Charged and CustomerCharged events of its transaction", async () => {
    const b = await sealedReceipt();
    const v = await verifyReceipt(clone(b.receipt), opts(b.client));
    assert.equal(v.outcome, "verified", JSON.stringify(v.checks));
    assert.ok(v.checks.every((c) => c.status === "pass"), JSON.stringify(v.checks));
    assert.equal(v.computedRoot, b.receipt.anchor!.listHash);
    assert.equal(v.onchain?.listHash, b.receipt.anchor!.listHash);
    assert.deepEqual(b.calls, ["chainId", `receipt ${b.chargeTx}`]);
  });

  test("a not-charged (released) receipt verifies too; the wallet-charge check is skipped", async () => {
    const b = await sealedReceipt({ verdict: "disagreed" });
    const v = await verifyReceipt(clone(b.receipt), opts(b.client));
    assert.equal(v.outcome, "verified", JSON.stringify(v.checks));
    assert.equal(v.checks.find((c) => c.id === "customer")?.status, "skip");
  });

  test("tampering with any field fails", async () => {
    const b = await sealedReceipt();
    const other = rnd32();
    const tampers: [string, (r: JobReceipt) => void][] = [
      ["state", (r) => (r.state = "provisional")],
      ["chainId", (r) => (r.chainId = 46630)],
      ["paymentsContract", (r) => (r.paymentsContract = addr())],
      ["jobId", (r) => (r.jobId = other)],
      ["payer", (r) => (r.payer = addr())],
      ["priceWei", (r) => (r.priceWei = "1")],
      ["verdict", (r) => (r.verdict = "disagreed")],
      ["chargeStatus", (r) => (r.chargeStatus = "unpaid")],
      ["outputHash", (r) => (r.outputHash = other)],
      ["nodes[0].gpuMs", (r) => (r.nodes[0].gpuMs += 1)],
      ["nodes[1].epoch", (r) => (r.nodes[1].epoch += 1)],
      ["nodes[0].outputHash", (r) => (r.nodes[0].outputHash = other)],
      ["nodes[1].node", (r) => (r.nodes[1].node = addr())],
      ["nodes[0].signature", (r) => (r.nodes[0].signature = r.nodes[1].signature)],
      ["nodes dropped", (r) => r.nodes.pop()],
      ["epochId", (r) => (r.epochId = 10)],
      ["chargeTx", (r) => (r.chargeTx = other)],
      ["anchor.leafInputs.epochId", (r) => (r.anchor!.leafInputs.epochId = 10)],
      ["anchor.leafInputs.priceWei", (r) => (r.anchor!.leafInputs.priceWei = "1")],
      ["anchor.leafInputs.verdict", (r) => (r.anchor!.leafInputs.verdict = 2)],
      ["anchor.leafInputs.chargeStatus", (r) => (r.anchor!.leafInputs.chargeStatus = 3)],
      ["anchor.leafInputs.outputHash", (r) => (r.anchor!.leafInputs.outputHash = ZERO_HASH)],
      ["anchor.leaf", (r) => (r.anchor!.leaf = other)],
      ["anchor.proof", (r) => (r.anchor!.proof[0] = other)],
      ["anchor.proof shortened", (r) => r.anchor!.proof.pop()],
      ["anchor.listHash", (r) => (r.anchor!.listHash = other)],
      ["anchor.hashRule", (r) => ((r.anchor as { hashRule: string }).hashRule = "v1")],
      ["pending", (r) => (r.pending = { reason: "no-anchor", epochId: 9 })],
      ["format", (r) => ((r as { format: string }).format = "x")],
      ["version", (r) => ((r as { version: number }).version = 2)],
      ["an extra field", (r) => ((r as Record<string, unknown>).note = "paid in full")],
    ];
    for (const [name, change] of tampers) {
      const r = clone(b.receipt);
      change(r);
      const v = await verifyReceipt(r, opts(b.client));
      assert.equal(v.outcome, "failed", `${name}: ${JSON.stringify(v.checks)}`);
      assert.ok(v.checks.some((c) => c.status === "fail"), name);
    }
  });

  test("a consistent fake root fails on-chain: the Charged event carries another root", async () => {
    const b = await sealedReceipt();
    const r = clone(b.receipt);
    // Rebuild a self-consistent receipt with a higher price: leaf, proof and root all agree, the chain does not.
    r.priceWei = r.anchor!.leafInputs.priceWei = "1";
    const leaf = jobLeafOf(9, { jobId: r.jobId, payer: r.payer, priceWei: 1n, verdict: "agreed", chargeStatus: "charged", outputHash: r.outputHash });
    r.anchor!.leaf = r.anchor!.listHash = leaf;
    r.anchor!.proof = [];
    const v = await verifyReceipt(r, opts(b.client));
    assert.equal(v.outcome, "failed");
    assert.equal(v.checks.find((c) => c.id === "onchain")?.status, "fail");
  });

  test("an RPC that cannot be reached: unreachable, not failed and not verified", async () => {
    const b = await sealedReceipt();
    const down: ReceiptChainClient = {
      getChainId: async () => {
        throw new TypeError("fetch failed");
      },
      getTransactionReceipt: b.client.getTransactionReceipt,
    };
    const v = await verifyReceipt(clone(b.receipt), opts(down));
    assert.equal(v.outcome, "unreachable");
    assert.match(v.error ?? "", /fetch failed/);
  });

  test("an RPC on another chain, or without the transaction, fails", async () => {
    const b = await sealedReceipt();
    const otherChain: ReceiptChainClient = { ...b.client, getChainId: async () => 1 };
    assert.equal((await verifyReceipt(clone(b.receipt), opts(otherChain))).outcome, "failed");
    const noTx: ReceiptChainClient = {
      ...b.client,
      getTransactionReceipt: async () => {
        const e = new Error("Transaction receipt could not be found");
        e.name = "TransactionReceiptNotFoundError";
        throw e;
      },
    };
    assert.equal((await verifyReceipt(clone(b.receipt), opts(noTx))).outcome, "failed");
  });

  test("events from another contract do not count", async () => {
    const b = await sealedReceipt();
    const spoof: ReceiptChainClient = {
      ...b.client,
      getTransactionReceipt: async (a) => {
        const tx = await b.client.getTransactionReceipt(a);
        return { ...tx, logs: tx.logs.map((l) => ({ ...l, address: addr() })) };
      },
    };
    assert.equal((await verifyReceipt(clone(b.receipt), opts(spoof))).outcome, "failed");
  });

  test("a receipt for another site's contract or chain fails before any RPC call", async () => {
    const b = await sealedReceipt();
    const v = await verifyReceipt(clone(b.receipt), { client: b.client, chainId: CHAIN, paymentsContract: addr() });
    assert.equal(v.outcome, "failed");
    assert.deepEqual(b.calls, []);
  });

  test("provisional receipts: node signatures checked, nothing on-chain; D15 says no-anchor, not failed", async () => {
    const b = await sealedReceipt({ verdict: "disagreed" });
    const base = clone(b.receipt);
    const provisional = (reason: "waiting-for-charge" | "no-anchor"): JobReceipt => ({
      ...base,
      state: "provisional",
      epochId: null,
      chargeTx: null,
      anchor: null,
      pending: { reason, epochId: 9 },
    });
    const waiting = await verifyReceipt(provisional("waiting-for-charge"), opts(b.client));
    assert.equal(waiting.outcome, "provisional", JSON.stringify(waiting.checks));
    const none = await verifyReceipt(provisional("no-anchor"), opts(b.client));
    assert.equal(none.outcome, "no-anchor", JSON.stringify(none.checks));
    assert.deepEqual(b.calls, [], "no RPC call for a provisional receipt");
    const badSig = provisional("no-anchor");
    badSig.nodes[0].gpuMs += 1;
    assert.equal((await verifyReceipt(badSig, opts(b.client))).outcome, "failed");
  });
});

describe("parseReceipt", () => {
  test("refuses what is not a version 1 receipt, and names the problem", async () => {
    const b = await sealedReceipt();
    assert.throws(() => parseReceipt(null), ReceiptFormatError);
    assert.throws(() => parseReceipt([]), ReceiptFormatError);
    assert.throws(() => parseReceipt({ ...clone(b.receipt), extra: 1 }), /extra/);
    const lower = clone(b.receipt);
    lower.payer = lower.payer.toLowerCase() as Address;
    assert.equal(parseReceipt(lower).payer, b.receipt.payer, "an all-lowercase address is read and checksummed");
    const badChecksum = clone(b.receipt);
    badChecksum.payer = (badChecksum.payer.slice(0, 2) + [...badChecksum.payer.slice(2)].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join("")) as Address;
    if (/[a-fA-F]/.test(badChecksum.payer.slice(2))) assert.throws(() => parseReceipt(badChecksum), /payer/);
  });
});
