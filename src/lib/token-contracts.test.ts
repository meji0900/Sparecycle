// The scheduler's token ABIs (src/lib/token-contracts.ts) must match the contracts in contracts/src: every event, function
// and error we use, with the same parameter types, indexed fields, return types and mutability. Checked against the
// Foundry build output (contracts/out) when it exists; CI builds the contracts first, a plain `npm test` without a build
// skips.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { burnerAbi, holderPoolAbi, jobPaymentsV2Abi, nodeStakeAbi } from "./token-contracts";

type Param = { type: string; indexed?: boolean; components?: readonly Param[] };
type Item = { type: string; name?: string; inputs?: readonly Param[]; outputs?: readonly Param[]; stateMutability?: string };
/** A tuple is written as its component types, so a struct return is compared field by field. */
const t = (p: Param): string => (p.type.startsWith("tuple") ? `(${(p.components ?? []).map(t).join(",")})${p.type.slice(5)}` : p.type);
const sig = (i: Item) =>
  `${i.type} ${i.name}(${(i.inputs ?? []).map((p) => t(p) + (p.indexed ? " indexed" : "")).join(",")})` +
  (i.type === "function" ? ` ${i.stateMutability} -> (${(i.outputs ?? []).map(t).join(",")})` : "");
const out = (name: string) => join(process.cwd(), "contracts", "out", `${name}.sol`, `${name}.json`);

for (const [name, abi] of [
  ["SparecycleNodeStake", nodeStakeAbi],
  ["SparecycleHolderPool", holderPoolAbi],
  ["SparecycleBurner", burnerAbi],
  ["SparecycleJobPaymentsV2", jobPaymentsV2Abi],
] as const) {
  describe(`${name} ABI used by the site`, () => {
    const file = out(name);
    test("every event, function and error matches the compiled contract", { skip: !existsSync(file) && "contracts/out not built" }, () => {
      const compiled = new Set(
        (JSON.parse(readFileSync(file, "utf8")).abi as Item[]).filter((i) => i.type === "event" || i.type === "function" || i.type === "error").map(sig),
      );
      for (const item of abi as readonly Item[]) assert.ok(compiled.has(sig(item)), `${name}: ${sig(item)} is not in the compiled ABI`);
    });
  });
}

describe("nodeStakeAbi keeps the scheduler's entries in place", () => {
  test("chain-io reads Slashed at [3] and SlashProposed at [4]", () => {
    const items = nodeStakeAbi as readonly Item[];
    assert.equal(`${items[3].type} ${items[3].name}`, "event Slashed");
    assert.equal(`${items[4].type} ${items[4].name}`, "event SlashProposed");
  });
});
