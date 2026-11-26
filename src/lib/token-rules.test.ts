// The token-feature rules and addresses (brief §10, docs/token-features.md): every section-10 value is a named constant
// labelled "Default, not yet confirmed by Fabio" with the brief's default; the split of the 500 bps adds up; nothing is
// deployed (every token contract null, never an invented address); the exclusion list is checksummed; /docs/contracts
// is unchanged (no token row); and the token features use SPARE, never CYCLE (N16). Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { getAddress } from "viem";
import { ADDR, ADDRESS_ROWS, BURN_SINKS, HOLDER_CONTRACT_ALLOWLIST, HOLDER_EXCLUSIONS, SAFE_MULTISEND_CALL_ONLY, SPARE_START_BLOCK, TOKEN_CONTRACTS, UNISWAP_V4 } from "./addresses";
import * as R from "./token-rules";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("section 10 defaults", () => {
  test("the brief's defaults, each in a named constant", () => {
    assert.deepEqual([R.SPLIT_BURN_BPS, R.SPLIT_HOLDER_BPS, R.SPLIT_TREASURY_BPS], [150, 150, 200], "N1");
    assert.equal(R.SPLIT_BURN_BPS + R.SPLIT_HOLDER_BPS + R.SPLIT_TREASURY_BPS, R.TREASURY_CUT_BPS);
    assert.equal(R.TREASURY_CUT_BPS, 500);
    assert.equal(R.SLASH_BPS, 1_000, "N4: 10%");
    assert.deepEqual([R.FAULTS_PER_PROPOSAL, R.FAULT_WINDOW_EPOCHS, R.APPEAL_WINDOW_EPOCHS, R.UNSTAKE_COOLDOWN_EPOCHS], [3, 8, 4, 16], "N5-N8");
    assert.ok(R.UNSTAKE_COOLDOWN_EPOCHS > R.FAULT_WINDOW_EPOCHS + R.APPEAL_WINDOW_EPOCHS, "C > W + A");
    assert.equal(R.SLASHED_SPARE_GOES_TO, "burned", "N9");
    assert.equal(R.HOLDER_MIN_SPARE_WEI, 100_000n * 10n ** 18n, "N11 working proposal");
    assert.deepEqual([R.BURN_CAP_BPS_OF_QUOTE_LIQUIDITY, R.BURN_MAX_SLIPPAGE_BPS], [100, 200], "N12");
    assert.equal(R.CONTRACTS_EXCLUDED_UNLESS_ALLOWLISTED, true, "N14");
    assert.equal(R.STAKED_COUNTS_AS_HELD, true, "N15");
    assert.equal(R.TOKEN_FEATURES_TOKEN, "SPARE", "N16");
    assert.equal(R.DEFAULT_HOLDER_MODE, R.HOLDER_MODE.credits, "N18");
    assert.deepEqual(R.SUPPORTED_HOLDER_MODES, [R.HOLDER_MODE.credits], "credit mode only; NVDA gated");
    assert.equal(R.UNCLAIMED_ROLLOVER_EPOCHS, 8, "N19");
    assert.equal(R.BURN_PATH, "2a-safe", "N23");
    assert.equal(R.burnShareOf(500n), 150n);
    assert.equal(R.holderShareOf(500n), 150n);
  });

  test("every exported value constant is labelled 'Default, not yet confirmed by Fabio'", () => {
    const src = read("src/lib/token-rules.ts");
    const unlabelled: string[] = [];
    const lines = src.split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = /^export const ([A-Z][A-Z0-9_]+)\b/.exec(l);
      if (!m || ["TREASURY_CUT_BPS", "HOLDER_MODE", "SUPPORTED_HOLDER_MODES", "FORBIDDEN_TOKEN_WORDS"].includes(m[1])) return;
      const doc = lines.slice(Math.max(0, i - 6), i).join(" ");
      if (!doc.includes("Default, not yet confirmed by Fabio")) unlabelled.push(m[1]);
    });
    assert.deepEqual(unlabelled, []);
  });
});

describe("addresses of the token features", () => {
  test("only NodeStake is deployed (26 Nov 2026); the other token contracts, the v4 infrastructure and the start block are null", () => {
    assert.deepEqual(TOKEN_CONTRACTS, { nodeStake: ADDR.nodeStake, holderPool: null, burner: null, jobPaymentsV2: null });
    assert.deepEqual([UNISWAP_V4.poolManager, UNISWAP_V4.stateView, UNISWAP_V4.universalRouter, UNISWAP_V4.spareEthPoolKey], [null, null, null, null]);
    assert.equal(SAFE_MULTISEND_CALL_ONLY, null);
    assert.equal(SPARE_START_BLOCK, null);
    assert.match(UNISWAP_V4.spareEthPoolId, /^0x[0-9a-f]{64}$/);
  });

  test("the exclusion list: checksummed, the brief's entries, and nothing allow-listed", () => {
    for (const e of HOLDER_EXCLUSIONS) if (e.address) assert.equal(getAddress(e.address), e.address, e.label);
    const listed = new Set(HOLDER_EXCLUSIONS.flatMap((e) => (e.address ? [e.address] : [])));
    for (const a of [ADDR.teamWallet, ADDR.launchWallet, ADDR.treasurySafe, ADDR.spareCurve, BURN_SINKS.zero, BURN_SINKS.dead]) assert.ok(listed.has(a), a);
    assert.deepEqual(HOLDER_CONTRACT_ALLOWLIST, []);
    assert.equal(getAddress(BURN_SINKS.dead), BURN_SINKS.dead);
  });

  test("/docs/contracts: SparecycleNodeStake is the only token-feature row (the others are not deployed)", () => {
    const rows = ADDRESS_ROWS.filter((r) => /NodeStake|HolderPool|Burner|JobPaymentsV2|PoolManager|StateView|Universal Router/i.test(`${r.name} ${r.id}`));
    assert.deepEqual(rows.map((r) => [r.id, r.address]), [["node-stake", ADDR.nodeStake]]);
  });

  test("SPARE only, never CYCLE (N16)", () => {
    for (const f of ["src/server/burns.ts", "src/server/holders.ts", "src/server/holder-page.ts", "src/server/chain-io.ts", "src/server/slashing.ts", "src/server/stake-gate.ts"]) {
      assert.ok(!/cycleToken|cycleCurve/.test(read(f)), `${f} names CYCLE`);
    }
    assert.match(read("src/server/chain-io.ts"), /address: ADDR\.spareToken/);
  });
});
