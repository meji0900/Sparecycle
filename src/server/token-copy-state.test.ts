// The state behind the flag-dependent copy (src/server/token-copy-state.ts): every flag off = TOKEN_COPY_OFF with no chain
// read (static pages stay static); the staking lines switch only with the stake gate on and minStakePerNode > 0 read
// from the chain, or when it cannot be read; the holder page is linked from /token and /proof only behind its flag.
// Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

for (const k of Object.keys(process.env)) if (k.startsWith("TOKEN_")) delete process.env[k];
const { resolveTokenCopyState, tokenCopyState, tokenFlags } = await import("./token-copy-state");
const { TOKEN_COPY_OFF } = await import("@/lib/token-copy");

const OFF = { burns: false, holders: false, stakeGate: false, holderPage: false };
const ROOT = join(import.meta.dirname, "..", "..");

describe("token copy state", () => {
  test("every flag off: TOKEN_COPY_OFF itself, and the minimum is never read", async () => {
    let reads = 0;
    const s = await resolveTokenCopyState(OFF, async () => {
      reads++;
      return 1n;
    });
    assert.equal(s, TOKEN_COPY_OFF);
    assert.equal(reads, 0);
    assert.deepEqual(tokenFlags(), OFF);
    assert.equal(await tokenCopyState({ perRequest: true }), TOKEN_COPY_OFF, "no connection() call, no read");
  });

  test("stake gate on: required only when the minimum read from the chain is above 0, or unknown", async () => {
    assert.equal((await resolveTokenCopyState({ ...OFF, stakeGate: true }, async () => 0n)).stakeRequired, false);
    const above = await resolveTokenCopyState({ ...OFF, stakeGate: true }, async () => 5n);
    assert.deepEqual([above.stakeRequired, above.minStakeWei], [true, 5n]);
    const unknown = await resolveTokenCopyState({ ...OFF, stakeGate: true }, async () => {
      throw new Error("not deployed");
    });
    assert.deepEqual([unknown.stakeRequired, unknown.minStakeWei], [true, null]);
  });

  test("other flags do not read the minimum", async () => {
    let reads = 0;
    const s = await resolveTokenCopyState({ ...OFF, burns: true, holders: true, holderPage: true }, async () => {
      reads++;
      return 1n;
    });
    assert.equal(reads, 0);
    assert.deepEqual([s.burns, s.holders, s.holderPage, s.stakeRequired], [true, true, true, false]);
  });

  test("the holder page is linked from /token and /proof only behind TOKEN_HOLDER_PAGE", () => {
    for (const f of [["src", "app", "(dapp)", "token", "page.tsx"], ["src", "app", "(dapp)", "proof", "page.tsx"]]) {
      const src = readFileSync(join(ROOT, ...f), "utf8");
      const link = src.indexOf('href="/token/holders"');
      assert.ok(link > 0, f.join("/"));
      assert.ok(src.lastIndexOf("serverEnv.tokenHolderPage() ?", link) > 0, `${f.join("/")}: behind the flag`);
    }
  });
});
