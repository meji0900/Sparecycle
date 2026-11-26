// Resolves the state the flag-dependent copy (src/lib/token-copy.ts) is written for: the TOKEN_* flags, and with the stake
// gate on, minStakePerNode() read from SparecycleNodeStake through ./chain-io (cached for ten minutes). With every flag off
// it returns TOKEN_COPY_OFF at once: no read, no await, so a static page stays static and renders exactly as before.
import { TOKEN_COPY_OFF, type TokenCopyState } from "@/lib/token-copy";
import { tokenChain } from "./chain-io";
import { serverEnv } from "./env";

type Flags = { burns: boolean; holders: boolean; stakeGate: boolean; holderPage: boolean };

const MIN_TTL_MS = 10 * 60 * 1000;
const g = globalThis as typeof globalThis & { __sparecycleMinStake?: { at: number; value: bigint } };

async function cachedMinStake(): Promise<bigint> {
  const hit = g.__sparecycleMinStake;
  if (hit && Date.now() - hit.at < MIN_TTL_MS) return hit.value;
  const value = await tokenChain.minStakePerNode();
  g.__sparecycleMinStake = { at: Date.now(), value };
  return value;
}

/** The copy state for these flags. The stake lines switch only when the gate is on and the minimum is above 0. */
export async function resolveTokenCopyState(flags: Flags, readMin: () => Promise<bigint> = cachedMinStake): Promise<TokenCopyState> {
  if (!flags.burns && !flags.holders && !flags.stakeGate && !flags.holderPage) return TOKEN_COPY_OFF;
  let minStakeWei: bigint | null = null;
  let stakeRequired = false;
  if (flags.stakeGate) {
    try {
      minStakeWei = await readMin();
      stakeRequired = minStakeWei > 0n;
    } catch {
      // Unknown minimum (contract not reachable or not deployed): never claim "no token needed to run a node" unverified.
      stakeRequired = true;
    }
  }
  return { ...flags, minStakeWei, stakeRequired };
}

export const tokenFlags = (): Flags => ({
  burns: serverEnv.tokenBurns(),
  holders: serverEnv.tokenHolders(),
  stakeGate: serverEnv.tokenStakeGate(),
  holderPage: serverEnv.tokenHolderPage(),
});

/**
 * The copy state for a server component. `perRequest`: on a page that is otherwise prerendered at build (e.g. /nodes),
 * any flag on makes it render per request (next/server connection()), so the copy follows the flags and the chain; with
 * every flag off nothing changes and the page stays static.
 */
export async function tokenCopyState(opts: { perRequest?: boolean } = {}): Promise<TokenCopyState> {
  const flags = tokenFlags();
  if (!flags.burns && !flags.holders && !flags.stakeGate && !flags.holderPage) return TOKEN_COPY_OFF;
  if (opts.perRequest) {
    const { connection } = await import("next/server");
    await connection();
  }
  return resolveTokenCopyState(flags);
}
