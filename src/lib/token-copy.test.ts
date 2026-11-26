// Flag-dependent copy (brief §0.7; src/lib/token-copy.ts): with every flag off each line is byte-for-byte today's copy
// (pinned below from the files before this change); each line switches only with its own flag; the staking lines stay
// as they are while minStakePerNode is 0 and switch when it is above 0 or unknown; the terms and disclosures keep "not a
// yield product", "the token can go to zero" and "not financial advice"; every 0.7 file takes its lines from the table;
// the new copy never uses the words of brief §9.3. Also: token-feature addresses can be set by env. Run: npm test
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { FORBIDDEN_TOKEN_WORDS } from "./token-rules";
import { TOKEN_COPY_OFF, tokenCopy, type TokenCopyState } from "./token-copy";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const state = (o: Partial<TokenCopyState>): TokenCopyState => ({ ...TOKEN_COPY_OFF, ...o });
const SPARE = 10n ** 18n;

/** Today's copy, as it stood in each file before the token features (commit dd06533). */
const TODAY = {
  heroNoToken: "No token needed to run a node or pay for a job",
  bentoNoToken: { title: "No token needed", description: "You don't have to buy or lock the token to run a node or pay for a job." },
  whoForNoToken: { title: "You don't hold the token", body: "You don't need it. Not to run a node, and not to pay for a job." },
  runANodeToken: "You do not need to hold the token.",
  tokenFactNeed: "You don't need the token for anything here: not to run a node, and not to pay for a job.",
  tokenFactFeesToPot:
    "Creator trading fees fund the job pot. Buybacks are off. This is not a reason the token should go up, and it is not a yield on holding.",
  nodesIntroTail: "No hourly rate, and no token needed.",
  nodesHold: "Nothing. No token, no stake, no deposit.",
  facts: [],
  disclosures: [],
  termsExtra: [],
};
const STAKE_KEYS = ["heroNoToken", "bentoNoToken", "whoForNoToken", "runANodeToken", "tokenFactNeed", "nodesIntroTail", "nodesHold"] as const;

describe("flag-dependent copy", () => {
  test("every flag off: exactly today's copy", () => {
    assert.deepEqual(tokenCopy(TOKEN_COPY_OFF), TODAY);
  });

  test("the stake gate with minStakePerNode = 0 keeps 'no token needed to run a node' (it stays true)", () => {
    assert.deepEqual(tokenCopy(state({ stakeGate: true, minStakeWei: 0n, stakeRequired: false })), TODAY);
  });

  test("a minimum above 0 switches exactly the staking lines, with the amount read from the chain", () => {
    const c = tokenCopy(state({ stakeGate: true, minStakeWei: 2_500n * SPARE, stakeRequired: true }));
    for (const k of STAKE_KEYS) assert.notDeepEqual(c[k], TODAY[k], k);
    assert.equal(c.heroNoToken, "No token needed to pay for a job");
    assert.match(c.nodesHold, /^At least 2,500 SPARE per active node/);
    assert.match(c.runANodeToken, /at least 2,500 SPARE per active node/);
    assert.equal(c.tokenFactFeesToPot, TODAY.tokenFactFeesToPot, "a burn line, not a stake line");
    assert.equal(c.disclosures.length, 1);
    assert.equal(c.disclosures[0].title, "Node staking and slashing");
    assert.match(c.disclosures[0].body, /not trustless/);
    // Minimum unknown (read failed): the lines switch too, without an amount.
    const unknown = tokenCopy(state({ stakeGate: true, minStakeWei: null, stakeRequired: true }));
    assert.match(unknown.nodesHold, /^The minimum SPARE stake per active node/);
  });

  test("burns and holders add their own facts, disclosures and terms clauses, and leave the staking lines alone", () => {
    const b = tokenCopy(state({ burns: true }));
    for (const k of STAKE_KEYS) assert.deepEqual(b[k], TODAY[k], k);
    assert.deepEqual(b.disclosures.map((d) => d.title), ["Usage burn"]);
    assert.match(b.facts[0], /buy SPARE and burn it; every transaction is listed/);
    assert.match(b.tokenFactFeesToPot, /Pons buybacks are off; separately/);
    assert.equal(b.termsExtra.length, 1);
    const h = tokenCopy(state({ holders: true }));
    assert.deepEqual(h.disclosures.map((d) => d.title), ["Holder share as compute credits"]);
    assert.match(h.facts[0], /compute credits\. Credits pay for jobs and cannot be withdrawn as ETH/);
    assert.equal(tokenCopy(state({ holderPage: true })).facts.length, 0, "the page flag only adds links");
  });

  test("the new copy never uses the words of brief §9.3", () => {
    const all = tokenCopy(state({ burns: true, holders: true, stakeGate: true, minStakeWei: 10n * SPARE, stakeRequired: true }));
    const text = JSON.stringify(all).toLowerCase().replace(TODAY.tokenFactFeesToPot.toLowerCase(), "");
    for (const w of FORBIDDEN_TOKEN_WORDS) {
      assert.ok(!new RegExp(`\\b${w}${w === "earn" ? "(s|ed|ing)?" : ""}\\b`).test(text), `"${w}" in the token copy`);
    }
  });
});

describe("the brief 0.7 files take their lines from the table", () => {
  test("no 0.7 line is left as a literal; the terms and disclosures keep the three statements", () => {
    const files: [string, string[]][] = [
      ["src/components/landing/hero.tsx", ["tokenCopy(TOKEN_COPY_OFF).heroNoToken", "noTokenFact,"]],
      ["src/components/landing/feature-bento.tsx", ["tokenCopy(TOKEN_COPY_OFF).bentoNoToken"]],
      ["src/components/landing/who-for.tsx", ["tokenCopy(TOKEN_COPY_OFF).whoForNoToken"]],
      ["src/components/landing/sections.tsx", ["tokenLine,", "need,", "...extra,"]],
      ["src/app/(dapp)/nodes/page.tsx", ["copy.nodesIntroTail", "copy.nodesHold", "tokenCopyState({ perRequest: true })"]],
      ["src/app/(site)/page.tsx", ["tokenCopy(await tokenCopyState())"]],
      ["src/app/(site)/legal/terms/page.tsx", ["copy.termsExtra"]],
      ["src/app/(site)/legal/disclosures/page.tsx", ["copy.disclosures.map"]],
    ];
    for (const [f, needles] of files) for (const n of needles) assert.ok(read(f).includes(n), `${f}: ${n}`);
    for (const line of [TODAY.heroNoToken, TODAY.runANodeToken, TODAY.tokenFactNeed, TODAY.nodesIntroTail, TODAY.nodesHold, TODAY.whoForNoToken.body]) {
      for (const [f] of files) assert.ok(!read(f).includes(line), `${f} still has "${line}" as a literal`);
    }
    const terms = read("src/app/(site)/legal/terms/page.tsx");
    for (const s of ["not financial, legal or tax advice", "not a yield product", "the token can go to zero"]) assert.ok(terms.includes(s), `terms: ${s}`);
    const disc = read("src/app/(site)/legal/disclosures/page.tsx");
    for (const s of ["Not financial, legal, or tax advice", "It is not a yield product and not a fixed return", "can go to zero"]) assert.ok(disc.includes(s), `disclosures: ${s}`);
    const footer = read("src/components/site/site-footer.tsx");
    assert.ok(footer.includes("Not financial or legal advice. Not a yield product."));
  });
});

describe("token-feature addresses can be set by env (server start or build)", () => {
  const load = (env: Record<string, string>) => {
    const hooks = pathToFileURL(join(ROOT, "src", "server", "node-ts-hooks.mjs")).href;
    const mod = pathToFileURL(join(ROOT, "src", "lib", "addresses.ts")).href;
    const code = `const a = await import(${JSON.stringify(mod)}); console.log(JSON.stringify({ c: a.TOKEN_CONTRACTS, u: { ...a.UNISWAP_V4 }, m: a.SAFE_MULTISEND_CALL_ONLY, s: a.SPARE_START_BLOCK === null ? null : String(a.SPARE_START_BLOCK), x: a.HOLDER_EXCLUSIONS.map((e) => e.address) }));`;
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TOKEN_"))) as NodeJS.ProcessEnv;
    const r = spawnSync(process.execPath, ["--import", hooks, "--input-type=module", "-e", code], { env: { ...clean, ...env }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
      c: Record<string, string | null>;
      u: { poolManager: string | null; stateView: string | null; universalRouter: string | null; spareEthPoolKey: Record<string, unknown> | null };
      m: string | null;
      s: string | null;
      x: (string | null)[];
    };
  };

  test("unset: every value is null (not live)", () => {
    const r = load({});
    assert.deepEqual(r.c, { nodeStake: null, holderPool: null, burner: null, jobPaymentsV2: null });
    assert.equal(r.s, null);
  });

  test("set: checksummed, the pool key built for native ETH / SPARE, the stake contract excluded from holder weights; malformed values ignored", () => {
    const r = load({
      TOKEN_NODE_STAKE_ADDRESS: "0x00000000000000000000000000000000000057a4",
      TOKEN_HOLDER_POOL_ADDRESS: "not an address",
      TOKEN_V4_STATE_VIEW_ADDRESS: "0x00000000000000000000000000000000000000aa",
      TOKEN_V4_POOL_KEY: "8388608, 200, 0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
      TOKEN_SPARE_START_BLOCK: "122000000",
      TOKEN_SAFE_MULTISEND_CALL_ONLY_ADDRESS: "0x123",
    });
    assert.equal(r.c.nodeStake, "0x00000000000000000000000000000000000057A4");
    assert.equal(r.c.holderPool, null, "malformed: ignored");
    assert.equal(r.u.stateView, "0x00000000000000000000000000000000000000AA");
    assert.deepEqual(r.u.spareEthPoolKey, {
      currency0: "0x0000000000000000000000000000000000000000",
      currency1: "0x012D695B94377E0c7b9EdEE3d824259BaA37cf3A",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
    });
    assert.equal(r.s, "122000000");
    assert.equal(r.m, null);
    assert.ok(r.x.includes("0x00000000000000000000000000000000000057A4"), "the stake contract is on the exclusion list");
  });
});
