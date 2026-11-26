import { handle, json } from "@/server/http";
import { CACHE_MS, stakingJson } from "@/server/staking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/staking — the public figures of SparecycleNodeStake: total staked, total slashed (burned), the minimum
 * stake per node, how many owner wallets stake, and the contract's fixed rules. Read from the chain, cached for half a
 * minute; a failed read is a 503, never a zero (src/server/staking.ts).
 */
export const GET = handle(async () => json(await stakingJson(), 200, { "cache-control": `public, max-age=${Math.round(CACHE_MS / 1000)}` }));
