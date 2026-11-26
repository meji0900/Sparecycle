// The holder page model (brief §7; src/server/holder-page.ts, rendered by src/app/(dapp)/token/holders/page.tsx): the
// test fails if any figure or row has no source; with the contracts not deployed (today) every part shows NOT LIVE YET
// and never a zero or a sample number; with simulated deployed contracts every number is linked; the page renders the
// model only (it formats no number itself) and is a 404 while TOKEN_HOLDER_PAGE is off; the new copy avoids the words
// of brief §9.3. Also: with every TOKEN_* flag off an epoch close runs no token step. Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, mock, test } from "node:test";
import { getAddress, pad, type Address, type Hex } from "viem";
import { setupTokenHarness } from "./test-support/token-harness";

const h = await setupTokenHarness();
const { m } = h;
const P = await import("./holder-page");
const W = await import("./token-work");
const { tokenChain } = m.chainIo;
const { ADDR, NOT_LIVE_YET, TOKEN_CONTRACTS } = await import("@/lib/addresses");
const { FORBIDDEN_TOKEN_WORDS } = await import("@/lib/token-rules");
after(h.cleanup);

const ROOT = join(import.meta.dirname, "..", "..");
type Model = Awaited<ReturnType<typeof P.buildHolderPage>>;

/** THE check: every figure has a source with a link, or is NOT LIVE YET with a reason; every table row has a source. */
function unsourced(model: Model): string[] {
  const bad: string[] = [];
  for (const s of model.sections) {
    for (const f of s.figures) {
      if (f.kind === "value") {
        if (!f.source || !f.source.label?.trim() || !/^(https?:\/\/|\/api\/v1\/)/.test(f.source.href ?? "")) bad.push(`${s.id}: "${f.label}" has no source`);
      } else if (f.kind === "not-live") {
        if (!f.why?.trim()) bad.push(`${s.id}: "${f.label}" is not live without a reason`);
      } else bad.push(`${s.id}: unknown figure`);
    }
    for (const t of s.tables) for (const r of t.rows) if (!r.source || !/^(https?:\/\/|\/api\/v1\/)/.test(r.source.href ?? "")) bad.push(`${s.id}/${t.label}: a row has no source`);
  }
  for (const e of model.exclusions) if (e.address && !/^https?:\/\//.test(e.href)) bad.push(`exclusion ${e.label} has no link`);
  return bad;
}

const today = (): Parameters<typeof P.buildHolderPage>[0] => ({
  readAt: 1_795_700_000_000,
  block: 123_604_662n,
  readError: null,
  contracts: { ...TOKEN_CONTRACTS },
  spareToken: ADDR.spareToken,
  payments: ADDR.payments,
  treasuryBps: 500,
  burns: { status: "not-live", why: "Burns are not live. The first SPARE block to read burn transfers from is not recorded yet." },
  carry: [],
  staked: { status: "not-live", why: "SparecycleNodeStake is not deployed." },
  distributed: { status: "not-live", why: "SparecycleHolderPool is not deployed." },
});

const tx = (n: number) => pad(`0x${n.toString(16)}`, { size: 32 }) as Hex;
const addr = (n: number) => getAddress(pad(`0x${n.toString(16)}`, { size: 20 })) as Address;

describe("every figure has a source", () => {
  test("today: the contracts are not deployed, so every part is NOT LIVE YET, never a zero; the one live rule is linked", () => {
    const model = P.buildHolderPage(today());
    assert.deepEqual(unsourced(model), []);
    assert.deepEqual(model.sections.map((s) => s.id), ["burned", "distributed", "staked", "rules"]);
    const figures = model.sections.flatMap((s) => s.figures);
    const values = figures.filter((f) => f.kind === "value");
    assert.deepEqual(values.map((f) => [f.label, f.kind === "value" && f.value]), [["Treasury cut of every charge", "5%"]], "the only number: TREASURY_BPS read live");
    assert.ok(figures.filter((f) => f.kind === "not-live").length >= 10);
    for (const f of values) assert.ok(f.kind === "value" && !/^0(\.0+)?$/.test(f.value), "no zero as a placeholder");
    for (const s of model.sections.slice(0, 3)) assert.equal(s.live, false, s.id);
    // Undeployed contracts in the exclusion list show the placeholder, never an invented address.
    const nulls = model.exclusions.filter((e) => e.address === null);
    assert.ok(nulls.length >= 4);
    assert.ok(nulls.every((e) => "notLive" in e && e.notLive === NOT_LIVE_YET));
    assert.ok(model.exclusions.some((e) => e.address === ADDR.treasurySafe));
    assert.equal(model.block?.href, `https://robinhoodchain.blockscout.com/block/123604662`);
    assert.match(model.readAtText, /UTC$/);
  });

  test("the checker catches a figure or a row without a source", () => {
    const model = P.buildHolderPage(today());
    const broken = structuredClone(model) as Model;
    const f = broken.sections[3].figures[0];
    if (f.kind === "value") (f as { source?: unknown }).source = undefined;
    assert.equal(unsourced(broken).length, 1);
    const broken2 = structuredClone(model) as Model;
    broken2.sections[0].tables.push({ label: "x", columns: ["a"], rows: [{ source: { label: "", href: "" }, cells: ["1"] }], empty: "" });
    assert.equal(unsourced(broken2).length, 1);
  });

  test("simulated deployed contracts: every number links to its transaction, event log or contract read", () => {
    const stake = addr(0x57a4e0);
    const pool = addr(0xf00d1);
    const burner = addr(0xb0a2);
    const r = today();
    r.contracts = { nodeStake: stake, holderPool: pool, burner, jobPaymentsV2: null };
    r.burns = {
      status: "live",
      fromBlock: 120_000_000n,
      rows: [
        { path: "2a", txHash: tx(1), block: 1n, time: 1_795_700_000, spareBurned: 10n ** 21n, ethIn: 10n ** 16n, epochId: 7 },
        { path: "2b", txHash: tx(2), block: 2n, time: 1_795_700_100, spareBurned: 5n * 10n ** 20n, ethIn: 5n * 10n ** 15n, epochId: 8 },
      ],
      slashes: [{ txHash: tx(3), block: 3n, spareBurned: 10n ** 20n }],
      burner: "live",
      stakeLive: true,
    };
    r.carry = [{ epochId: 9, chargeTx: tx(4), carriedWei: 3n * 10n ** 15n, reason: "carried over (cap)" }];
    r.staked = {
      status: "live",
      total: 2n * 10n ** 24n,
      owners: [
        { owner: addr(1), staked: 10n ** 24n, projectRun: true },
        { owner: addr(2), staked: 10n ** 24n, projectRun: false },
      ],
      proposals: [{ proposalId: 1n, owner: addr(2), amount: 10n ** 20n, evidenceHash: tx(5), txHash: tx(6), executedTx: tx(3), evidenceUrl: "/api/v1/slashing/1" }],
    };
    r.distributed = { status: "live", roots: [{ epochId: 7n, totalEth: 3n * 10n ** 15n, txHash: tx(7) }], claims: [{ epochId: 7n, mode: 0, amount: 10n ** 15n, txHash: tx(8) }] };
    const model = P.buildHolderPage(r);
    assert.deepEqual(unsourced(model), []);
    const burned = model.sections[0];
    assert.equal(burned.live, true);
    const rows = burned.tables.find((t) => t.label === "Burn transactions")!.rows;
    assert.deepEqual(rows.map((x) => x.source.href), [tx(1), tx(2)].map((h) => `https://robinhoodchain.blockscout.com/tx/${h}`));
    assert.deepEqual(rows[0].cells.slice(0, 3), ["7", "0.01 ETH", "1,000 SPARE"]);
    const carry = burned.tables.find((t) => t.label === "Carried over")!.rows[0];
    assert.deepEqual(carry.cells, ["9", "0.003 ETH", "carried over (cap)"]);
    assert.match(carry.source.href, /\/tx\/0x0+4$/);
    const staked = model.sections[2];
    assert.deepEqual(
      staked.figures.map((f) => (f.kind === "value" ? f.value : "")),
      ["2,000,000", "1", "1"],
      "total staked, project-run and community owners",
    );
    assert.equal(staked.tables[0].rows[0].source.href, "/api/v1/slashing/1", "a proposal links its public evidence");
  });

  test("the rows of the burn table always carry a transaction link (no row without a hash)", () => {
    const r = today();
    r.burns = { status: "live", fromBlock: 1n, rows: [], slashes: [], burner: "not-live", stakeLive: false };
    const model = P.buildHolderPage(r);
    const burned = model.sections[0];
    const first = burned.figures[0];
    assert.equal(first.kind === "value" && first.value, "No burn transaction yet", "none yet is said in words, not as 0");
    assert.equal(burned.tables[0].rows.length, 0);
    assert.deepEqual(unsourced(model), []);
  });
});

describe("the page", () => {
  const page = readFileSync(join(ROOT, "src", "app", "(dapp)", "token", "holders", "page.tsx"), "utf8");

  test("404 unless TOKEN_HOLDER_PAGE is on, and nothing links to it while it is off", () => {
    assert.match(page, /if \(!serverEnv\.tokenHolderPage\(\)\) notFound\(\);/);
    const token = readFileSync(join(ROOT, "src", "app", "(dapp)", "token", "page.tsx"), "utf8");
    const link = token.indexOf('href="/token/holders"');
    assert.ok(link > 0);
    assert.ok(token.lastIndexOf("serverEnv.tokenHolderPage() ?", link) > 0, "the only link sits behind the flag");
    const shell = readFileSync(join(ROOT, "src", "components", "dapp", "app-shell.tsx"), "utf8");
    assert.ok(!shell.includes("/token/holders"), "not in the navigation");
  });

  test("renders the model only: no number formatting of its own", () => {
    for (const f of ["formatAmount", "formatInt", "formatEther", "formatUnits", "toLocaleString", "readContract", "publicClient"]) {
      assert.ok(!page.includes(f), `page.tsx uses ${f}`);
    }
    assert.match(page, /<FigureCell key=/);
    assert.match(page, /<SourceLink source=\{figure\.source\} \/>/);
  });

  test("the new copy never uses the words of brief §9.3", () => {
    const model = P.buildHolderPage(today());
    const copy = [JSON.stringify(model), page.replace(/\breturn\b/g, "")].join("\n").toLowerCase();
    for (const w of FORBIDDEN_TOKEN_WORDS) {
      const re = new RegExp(`\\b${w}${w === "earn" ? "(s|ed|ing)?" : ""}\\b`);
      assert.ok(!re.test(copy), `"${w}" in the holder page copy`);
    }
  });
});

describe("epoch close with every TOKEN_* flag off (the default)", () => {
  test("no token step runs: nothing read, nothing stored", async () => {
    const calls: string[] = [];
    for (const k of Object.keys(tokenChain) as (keyof typeof tokenChain)[]) {
      mock.method(tokenChain, k, async () => {
        calls.push(k);
        throw new Error("no chain read expected");
      });
    }
    await W.runTokenWorkAfterClose(1);
    assert.deepEqual(calls, []);
    for (const t of ["token_burn_plans", "token_holder_roots", "token_slash_faults", "token_slash_proposals", "token_stake_reads"]) {
      assert.equal((m.db.getDb().prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t);
    }
    mock.restoreAll();
  });

  test("the operator view (with a flag on) lists prepared payloads and states that nothing is signed or sent", () => {
    const v = W.tokenPayloadsJson();
    assert.match(v.note, /Nothing here is signed or sent/);
    assert.deepEqual(v.flags, { burns: false, holders: false, slashing: false, stakeGate: false, holderPage: false });
  });
});
