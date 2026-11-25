// Public read models: /status, /epochs, /epochs/:id/tree, /epochs/:id/proof.
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { buildTree, getProof, verifyProof } from "@/lib/merkle";
import { getDb } from "./db";
import { ApiError } from "./http";
import { rootPostingConfigured } from "./chain-io";
import { clockMode, ensureEpoch, epochJson, getEpochRow, lastClosedEpochRow, listEpochRows, LOCAL_CLOCK_NOTE } from "./epochs";
import { expireStaleJobs, jobCounts } from "./jobs";
import { nodeCounts } from "./nodes";
import { poolStatus } from "./gpu-pool";
import { serverEnv } from "./env";
import { GPU_SUPPORT_URL } from "./gpu-allowlist";

export async function statusJson() {
  expireStaleJobs();
  const open = await ensureEpoch();
  const last = lastClosedEpochRow();
  const local = clockMode() === "scheduler-local";
  return {
    ok: true,
    schedulerOnline: true,
    epoch: {
      id: open.id,
      startedAt: open.started_at,
      endsAt: open.started_at + open.length,
      length: open.length,
      clock: clockMode(),
      /** true while the previous epoch's root post is pending, so the start time is not on-chain yet. */
      provisional: open.provisional === 1,
      note: local ? LOCAL_CLOCK_NOTE : null,
    },
    nodes: nodeCounts(),
    gpuPool: poolStatus(),
    /** GPU gate modes (docs/gpu-support.md): allowlist observe | enforce, challenge off | observe | enforce. */
    gpuGate: { allowlist: serverEnv.gpuAllowlistMode(), challenge: serverEnv.challengeMode(), supported: GPU_SUPPORT_URL },
    jobs: jobCounts(open.id),
    lastSettled: last
      ? {
          id: last.id,
          root: last.root,
          reserved: last.reserved ?? "0",
          leaves: last.leaves,
          postedTx: last.posted_tx,
          status: last.status,
        }
      : null,
    rootPosting: rootPostingConfigured() ? "configured" : "not-configured",
    trust: "centralized-scheduler",
    /** OUTPUT_AUTH: "enforce" = outputs readable only with the job's read secret or the paying wallet's sign-in. */
    outputAuth: serverEnv.outputAuth(),
  };
}

export async function epochsJson() {
  await ensureEpoch().catch(() => undefined); // list what we have even if the RPC is down
  return { epochs: listEpochRows().map(epochJson) };
}

type PayoutRow = { account: Address; amount: string; leaf: Hex };

function closedEpoch(id: number) {
  const row = getEpochRow(id);
  if (!row) throw new ApiError(404, "unknown-epoch", `no epoch ${id}`);
  if (row.status === "open") throw new ApiError(409, "epoch-open", `epoch ${id} is still open; its tree is published at close`);
  const leaves = getDb().prepare("SELECT account, amount, leaf FROM payouts WHERE epoch_id = ? ORDER BY account").all(id) as PayoutRow[];
  const tree = buildTree(leaves.map((l) => l.leaf));
  if (tree.root.toLowerCase() !== (row.root ?? "").toLowerCase()) {
    throw new ApiError(500, "tree-mismatch", `stored leaves of epoch ${id} do not rebuild the stored root`);
  }
  return { row, leaves, tree };
}

export function treeJson(id: number) {
  const { row, leaves } = closedEpoch(id);
  return {
    id: row.id,
    root: row.root,
    reserved: row.reserved ?? "0",
    status: row.status,
    potAtClose: row.pot_at_close,
    postedTx: row.posted_tx,
    leaves: leaves.map((l) => ({ account: l.account, amount: l.amount, leaf: l.leaf })),
  };
}

export function proofJson(id: number, accountRaw: string | null) {
  if (!accountRaw || !isAddress(accountRaw)) throw new ApiError(400, "invalid-account", "account must be a wallet address");
  const account = getAddress(accountRaw);
  const { row, leaves, tree } = closedEpoch(id);
  const mine = leaves.find((l) => l.account.toLowerCase() === account.toLowerCase());
  if (!mine) throw new ApiError(404, "not-in-root", `${account} has no payout in epoch ${id}`);
  const proof = getProof(tree, mine.leaf);
  if (!verifyProof(proof, tree.root, mine.leaf)) throw new ApiError(500, "tree-mismatch", "proof does not verify");
  return { epochId: row.id, account, amount: mine.amount, leaf: mine.leaf, proof, root: tree.root, status: row.status };
}
