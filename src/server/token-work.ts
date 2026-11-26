// The token-feature steps of an epoch close (docs/token-features.md). Each runs only when its TOKEN_* flag is on; with
// every flag off (the default) runTokenWorkAfterClose returns at once and the close is exactly as before. Each step is
// isolated: it logs, never throws into the close, and NEVER signs or sends a transaction (payloads are prepared,
// unsigned, and served to the operator by GET /api/v1/admin/token-payloads).
import { getDb } from "./db";
import { serverEnv } from "./env";
import { burnPlansJson, prepareBurns } from "./burns";
import { prepareHolderRoots } from "./holders";
import { attributeFaults, proposeDueSlashes } from "./slashing";

const msg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

/** Runs after `epochId` closed (and its charge and root post were attempted). */
export async function runTokenWorkAfterClose(epochId: number): Promise<void> {
  const burns = serverEnv.tokenBurns();
  const holders = serverEnv.tokenHolders();
  const slashing = serverEnv.tokenSlashing();
  if (!burns && !holders && !slashing) return;
  if (slashing) {
    try {
      const n = attributeFaults(epochId);
      const ids = await proposeDueSlashes(epochId);
      console.log(`[sparecycle] token: epoch ${epochId} slashing: ${n} new fault(s), ${ids.length} proposal(s) prepared (none sent)`);
    } catch (e) {
      console.error(`[sparecycle] token: epoch ${epochId} slashing failed: ${msg(e)}`);
    }
  }
  if (burns) {
    try {
      console.log(`[sparecycle] token: ${await prepareBurns()}`);
    } catch (e) {
      console.error(`[sparecycle] token: burn plan failed: ${msg(e)}`);
    }
  }
  if (holders) {
    try {
      console.log(`[sparecycle] token: ${await prepareHolderRoots()}`);
    } catch (e) {
      console.error(`[sparecycle] token: holder roots failed: ${msg(e)}`);
    }
  }
}

/**
 * GET /api/v1/admin/token-payloads (operator, Bearer SCHEDULER_ADMIN_TOKEN): the prepared, UNSIGNED payloads for the
 * treasury Safe's signers and the scheduler key. Not public: a prepared buy on a thin pool is a trade signal.
 */
export function tokenPayloadsJson() {
  const db = getDb();
  const parse = (s: string | null) => (s ? (JSON.parse(s) as unknown) : null);
  const roots = db.prepare("SELECT * FROM token_holder_roots ORDER BY epoch_id DESC LIMIT 50").all() as Record<string, string | number | null>[];
  const proposals = db
    .prepare("SELECT id, owner, node_key, evidence_hash, status, call_json FROM token_slash_proposals ORDER BY id DESC LIMIT 50")
    .all() as { id: number; owner: string; node_key: string; evidence_hash: string; status: string; call_json: string | null }[];
  return {
    note: "Prepared by the scheduler. Nothing here is signed or sent. The treasury Safe's signers decide.",
    flags: {
      burns: serverEnv.tokenBurns(),
      holders: serverEnv.tokenHolders(),
      slashing: serverEnv.tokenSlashing(),
      stakeGate: serverEnv.tokenStakeGate(),
      holderPage: serverEnv.tokenHolderPage(),
    },
    burnPlans: burnPlansJson(),
    holderRoots: roots.map((r) => ({
      ...r,
      missing: parse(r.missing as string | null),
      post_call: parse(r.post_call as string | null),
      fund_safe_tx: parse(r.fund_safe_tx as string | null),
    })),
    slashProposals: proposals.map((p) => ({ ...p, call_json: undefined, call: parse(p.call_json) })),
  };
}
