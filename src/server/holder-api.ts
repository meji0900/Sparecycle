// Public reads of the holder pool (docs/token-features.md), served only with TOKEN_HOLDERS on (the JSON 404 catch-all,
// src/app/api/v1/[...path]/route.ts, answers them; off = the unknown path they were before):
//   GET /api/v1/holders/epochs      every computed epoch: status, root, funding, total, holders, the postRoot transaction
//   GET /api/v1/holders/:address    one address's leaves with their Merkle proofs, claim window and claimed state, and its
//                                   spend-only credit balance in SparecycleJobPaymentsV2
// Only data the chain makes public anyway (addresses, amounts, roots). No prompt, no job, no error text (an RPC error can
// carry a URL), no unsigned payload: those stay in the operator view (GET /api/v1/admin/token-payloads).
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { explorerAddressUrl, explorerTxUrl, HOLDER_CONTRACT_ALLOWLIST, HOLDER_EXCLUSIONS, TOKEN_CONTRACTS } from "@/lib/addresses";
import { DEFAULT_HOLDER_MODE, HOLDER_MIN_SPARE_WEI, HOLDER_MODE, UNCLAIMED_ROLLOVER_EPOCHS } from "@/lib/token-rules";
import { tokenChain } from "./chain-io";
import { getDb } from "./db";
import { openEpochRow } from "./epochs";
import { ApiError } from "./http";
import { HOLDER_WEIGHT_METHOD, holderPostingLive } from "./holders";

/** Public status of a root row (the DB's `prepared` / `nothing-due` / `incomplete` are the earlier prepared-only mode). */
export type HolderEpochStatus = "ready" | "sent" | "posted" | "skipped" | "unpostable" | "conflict" | "failed" | "prepared" | "nothing-due" | "incomplete";

type RootRow = {
  epoch_id: number;
  status: HolderEpochStatus;
  root: string | null;
  total_eth_wei: string;
  funded_wei: string | null;
  leaves: number;
  total_weight: string | null;
  note: string | null;
  posted_tx: string | null;
  pending_tx: string | null;
  posted_at: number | null;
  claimable_until: number | null;
  created_at: number;
};

const modeLabel = (m: number) => (m === HOLDER_MODE.credits ? "compute credits" : `mode ${m}`);

/** The eligibility rules every holder answer carries (src/lib/token-rules.ts, src/lib/addresses.ts). */
export function holderRules() {
  return {
    method: HOLDER_WEIGHT_METHOD,
    minimumSpareWei: HOLDER_MIN_SPARE_WEI.toString(),
    rolloverEpochs: UNCLAIMED_ROLLOVER_EPOCHS,
    defaultMode: modeLabel(DEFAULT_HOLDER_MODE),
    modes: ["compute credits"],
    credits: "Compute credits pay for Sparecycle jobs. They cannot be withdrawn or transferred.",
    exclusions: HOLDER_EXCLUSIONS.map((e) => ({ label: e.label, address: e.address, why: e.why })),
    contractsExcluded:
      HOLDER_CONTRACT_ALLOWLIST.length === 0
        ? "Any other address with contract code is excluded; no contract is allow-listed. A wallet with an EIP-7702 delegation counts as a wallet."
        : `Any other address with contract code is excluded, except ${HOLDER_CONTRACT_ALLOWLIST.length} allow-listed contract(s).`,
  };
}

const lastComputedAt = () => (getDb().prepare("SELECT MAX(created_at) AS t FROM token_holder_roots").get() as { t: number | null }).t;

/** GET /api/v1/holders/epochs */
export function holderEpochsJson() {
  const rows = getDb().prepare("SELECT * FROM token_holder_roots ORDER BY epoch_id DESC LIMIT 100").all() as RootRow[];
  const pool = TOKEN_CONTRACTS.holderPool;
  const v2 = TOKEN_CONTRACTS.jobPaymentsV2;
  return {
    live: holderPostingLive(),
    contracts: {
      holderPool: pool ? { address: pool, url: explorerAddressUrl(pool) } : null,
      jobPaymentsV2: v2 ? { address: v2, url: explorerAddressUrl(v2) } : null,
    },
    openEpoch: openEpochRow()?.id ?? null,
    lastComputedAt: lastComputedAt(),
    rules: holderRules(),
    epochs: rows.map((r) => ({
      epochId: r.epoch_id,
      status: r.status,
      root: r.root,
      fundedWei: r.funded_wei,
      totalWei: r.total_eth_wei,
      holders: r.leaves,
      totalWeight: r.total_weight,
      note: r.note,
      computedAt: r.created_at,
      postedTx: r.posted_tx ? { hash: r.posted_tx, url: explorerTxUrl(r.posted_tx) } : null,
      pendingTx: r.status === "sent" && r.pending_tx ? { hash: r.pending_tx, url: explorerTxUrl(r.pending_tx) } : null,
      postedAt: r.posted_at,
      claimableUntilEpoch: r.claimable_until,
    })),
  };
}

// hasClaimed reads: `true` never changes, so it is kept; `false` is kept for a short while.
const claimedCache = new Map<string, { claimed: boolean; at: number }>();
const FALSE_TTL_MS = 15_000;
async function hasClaimed(epochId: number, holder: Address): Promise<boolean | null> {
  const key = `${epochId}:${holder.toLowerCase()}`;
  const hit = claimedCache.get(key);
  if (hit && (hit.claimed || Date.now() - hit.at < FALSE_TTL_MS)) return hit.claimed;
  try {
    const claimed = await tokenChain.holderHasClaimed(BigInt(epochId), holder);
    if (claimedCache.size > 20_000) claimedCache.clear();
    claimedCache.set(key, { claimed, at: Date.now() });
    return claimed;
  } catch {
    return null;
  }
}

export type HolderEntryState = "claimable" | "claimed" | "expired" | "pending" | "not-posted" | "unknown";

/** GET /api/v1/holders/:address */
export async function holderAccountJson(raw: string) {
  if (!isAddress(raw, { strict: false })) throw new ApiError(400, "bad-address", "Give a 0x address (40 hex characters).");
  const address = getAddress(raw);
  const rows = getDb()
    .prepare(
      `SELECT l.epoch_id, l.mode, l.avg_balance_wei, l.amount_wei, l.leaf, l.proof, r.status, r.root, r.posted_tx, r.claimable_until
       FROM token_holder_leaves l JOIN token_holder_roots r ON r.epoch_id = l.epoch_id
       WHERE l.holder = ? ORDER BY l.epoch_id DESC LIMIT 50`,
    )
    .all(address) as {
    epoch_id: number;
    mode: number;
    avg_balance_wei: string;
    amount_wei: string;
    leaf: string;
    proof: string | null;
    status: HolderEpochStatus;
    root: string;
    posted_tx: string | null;
    claimable_until: number | null;
  }[];
  const open = openEpochRow()?.id ?? null;
  const pool = TOKEN_CONTRACTS.holderPool;
  const entries = await Promise.all(
    rows.map(async (r) => {
      const posted = r.status === "posted";
      const claimed = posted ? await hasClaimed(r.epoch_id, address) : false;
      const expired = posted && r.claimable_until !== null && open !== null && open > r.claimable_until;
      const state: HolderEntryState = !posted
        ? r.status === "ready" || r.status === "sent"
          ? "pending"
          : "not-posted"
        : claimed === null
          ? "unknown"
          : claimed
            ? "claimed"
            : expired
              ? "expired"
              : "claimable";
      const proof = r.proof ? (JSON.parse(r.proof) as Hex[]) : [];
      return {
        epochId: r.epoch_id,
        state,
        mode: r.mode,
        modeLabel: modeLabel(r.mode),
        amountWei: r.amount_wei,
        avgBalanceWei: r.avg_balance_wei,
        leaf: r.leaf,
        proof,
        root: r.root,
        rootStatus: r.status,
        postedTx: r.posted_tx ? { hash: r.posted_tx, url: explorerTxUrl(r.posted_tx) } : null,
        claimableUntilEpoch: r.claimable_until,
        claimed,
        claim:
          state === "claimable" && pool
            ? { contract: pool, function: "claim(uint64 epochId, uint8 mode, uint256 amount, bytes32[] proof)", args: [r.epoch_id, r.mode, r.amount_wei, proof] }
            : null,
      };
    }),
  );
  let creditWei: string | null = null;
  if (TOKEN_CONTRACTS.jobPaymentsV2) {
    try {
      creditWei = (await tokenChain.creditOf(address)).toString();
    } catch {
      creditWei = null;
    }
  }
  return {
    address,
    live: holderPostingLive(),
    openEpoch: open,
    lastComputedAt: lastComputedAt(),
    creditWei,
    claimableWei: entries.filter((e) => e.state === "claimable").reduce((s, e) => s + BigInt(e.amountWei), 0n).toString(),
    entries,
    rules: holderRules(),
  };
}
