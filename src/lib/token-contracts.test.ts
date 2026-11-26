// The scheduler's token ABIs (src/lib/token-contracts.ts) must match the contracts in contracts/src: every event and
// function we use, with the same parameter types and indexed fields. Checked against the Foundry build output
// (contracts/out) when it exists; CI builds the contracts first, a plain `npm test` without a build skips.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { burnerAbi, holderPoolAbi, nodeStakeAbi } from "./token-contracts";

type Item = { type: string; name?: string; inputs?: readonly { type: string; indexed?: boolean }[] };
const sig = (i: Item) => `${i.type} ${i.name}(${(i.inputs ?? []).map((p) => p.type + (p.indexed ? " indexed" : "")).join(",")})`;
const out = (name: string) => join(process.cwd(), "contracts", "out", `${name}.sol`, `${name}.json`);

for (const [name, abi] of [["SparecycleNodeStake", nodeStakeAbi], ["SparecycleHolderPool", holderPoolAbi], ["SparecycleBurner", burnerAbi]] as const) {
  describe(`${name} ABI used by the scheduler`, () => {
    const file = out(name);
    test("every event and function matches the compiled contract", { skip: !existsSync(file) && "contracts/out not built" }, () => {
      const compiled = new Set((JSON.parse(readFileSync(file, "utf8")).abi as Item[]).filter((i) => i.type === "event" || i.type === "function").map(sig));
      for (const item of abi as readonly Item[]) assert.ok(compiled.has(sig(item)), `${name}: ${sig(item)} is not in the compiled ABI`);
    });
  });
}
