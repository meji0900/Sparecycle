// One source for addresses: src/lib/addresses.ts. proof.ts must not repeat a literal, every address is checksummed,
// and the docs table labels Pons contracts as Pons's and keys as keys. Also: the node downloads' checksums in
// src/lib/downloads.json equal public/downloads/SHA256SUMS.txt. Run: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { getAddress } from "viem";
import { ADDR, ADDRESS_ROWS, TESTNET_ADDR, VERIFICATION } from "./addresses";
import { EARLIER_TOKEN, MAINNET, PAYMENTS, TESTNET, TOKEN, TREASURY } from "./proof";
import { PONS } from "./pons";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const downloads = JSON.parse(read("src/lib/downloads.json")) as { files: Record<string, { file: string; sha256: string }> };
const ADDRESS_LITERAL = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

describe("addresses", () => {
  test("proof.ts holds no address literal of its own", () => {
    const found = read("src/lib/proof.ts").match(ADDRESS_LITERAL) ?? [];
    assert.deepEqual(found, [], "move these to src/lib/addresses.ts");
  });

  test("proof.ts reads the same values", () => {
    assert.equal(MAINNET.rewardContract, ADDR.rewards);
    assert.equal(MAINNET.owner, ADDR.treasurySafe);
    assert.equal(MAINNET.ponsFeeEscrow, PONS.feeEscrow);
    assert.equal(PAYMENTS.address, ADDR.payments);
    assert.equal(TREASURY.safe, ADDR.treasurySafe);
    assert.deepEqual([...TREASURY.owners], [...ADDR.safeSigners]);
    assert.equal(TOKEN.address, ADDR.spareToken);
    assert.equal(EARLIER_TOKEN.address, ADDR.cycleToken);
    assert.equal(TESTNET.rewardContract, TESTNET_ADDR.rewards);
    assert.equal(PAYMENTS.sourcify.checkedOn, VERIFICATION.payments.sourcify.checkedOn);
  });

  test("every address is EIP-55 checksummed and appears once in the table", () => {
    const all = [...Object.values(ADDR).flat(), ...Object.values(TESTNET_ADDR)];
    for (const a of all) assert.equal(getAddress(a), a, `${a} is not checksummed`);
    const seen = new Set<string>();
    for (const r of ADDRESS_ROWS) {
      assert.equal(getAddress(r.address), r.address, `${r.id}: not checksummed`);
      const key = `${r.network}:${r.address.toLowerCase()}`;
      assert.ok(!seen.has(key), `${r.id}: address listed twice`);
      seen.add(key);
    }
  });

  test("the table: ours with a verification status, Pons labelled as Pons, keys as keys, a testnet section", () => {
    const row = (id: string) => ADDRESS_ROWS.find((r) => r.id === id)!;
    for (const id of ["rewards", "payments"]) {
      assert.equal(row(id).by, "sparecycle");
      assert.equal(row(id).kind, "contract");
      assert.ok(row(id).source?.sourcify?.checkedOn, `${id}: no Sourcify check date`);
      assert.ok(row(id).source?.blockscout?.checkedOn, `${id}: no Blockscout check date`);
    }
    assert.equal(row("payments").source?.blockscout?.status, "verified", "Blockscout shows an exact match (checked 26 Nov 2026)");
    for (const id of ["scheduler", "sweep-bot", "launch-wallet", "team-wallet"]) assert.equal(row(id).kind, "key", id);
    for (const r of ADDRESS_ROWS.filter((r) => [PONS.factory, PONS.feeEscrow, ADDR.spareToken, ADDR.spareCurve, ADDR.cycleToken, ADDR.cycleCurve].includes(r.address as never))) {
      assert.equal(r.by, "pons", `${r.id} is a Pons contract`);
      assert.equal(r.source, undefined, `${r.id}: we do not claim a verification status for Pons contracts`);
    }
    assert.ok(ADDRESS_ROWS.some((r) => r.network === "testnet"));
    assert.ok(row("treasury-safe").role.includes("project owner"), "the Safe row says who holds the keys");
  });

  test("node download checksums match SHA256SUMS.txt", () => {
    const sums = Object.fromEntries(
      read("public/downloads/SHA256SUMS.txt")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          const [hash, file] = l.trim().split(/\s+/);
          return [file, hash];
        }),
    );
    for (const f of Object.values(downloads.files)) assert.equal(sums[f.file], f.sha256, f.file);
  });
});
