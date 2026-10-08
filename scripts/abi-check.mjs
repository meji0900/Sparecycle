#!/usr/bin/env node
// ABI sync check: compiled SparecycleRewards ABI (forge) vs the human-readable interface ABI in
// src/contracts/sparecycleRewards.ts. Every entry of the TS ABI must exist in the compiled ABI with the same
// name, parameter types, parameter names, indexed flags, outputs and state mutability. Every compiled entry
// must be in the TS ABI or in the short allow-list of inherited OpenZeppelin entries below. Exit 1 on any
// mismatch. Usage: npm run contracts:abi-check
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(root, "contracts");
// Optional argument: another TS ABI file (used to test this checker itself).
const tsFile = process.argv[2] ?? join(root, "src", "contracts", "sparecycleRewards.ts");

// Inherited from Ownable2Step / ReentrancyGuard / SafeERC20, plus receive(). Not part of the dApp interface,
// allowed in the compiled ABI only. The constructor is checked separately against docs/SPEC.md.
const ALLOWED_EXTRA = new Set([
  "function acceptOwnership()",
  "function pendingOwner()",
  "function renounceOwnership()",
  "function transferOwnership(address)",
  "event OwnershipTransferStarted(address,address)",
  "event OwnershipTransferred(address,address)",
  "error OwnableInvalidOwner(address)",
  "error OwnableUnauthorizedAccount(address)",
  "error ReentrancyGuardReentrantCall()",
  "error SafeERC20FailedOperation(address)",
  "receive",
]);
const SPEC_CONSTRUCTOR = ["address", "address", "address", "address", "uint64"];
// Functions the brief forbids. A compiled function whose name matches fails the check outright.
const FORBIDDEN = /withdraw|mint|setpot|drain|sweep|emergency/i;

function compiledAbi() {
  const env = { ...process.env, PATH: `${join(homedir(), ".foundry", "bin")}${delimiter}${process.env.PATH ?? ""}` };
  const out = execFileSync("forge", ["inspect", "SparecycleRewards", "abi", "--json"], {
    cwd: contractsDir,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.slice(out.indexOf("[")));
}

function tsAbi() {
  const text = readFileSync(tsFile, "utf8");
  const start = text.indexOf("parseAbi([");
  const end = text.indexOf("]);", start);
  if (start < 0 || end < 0) throw new Error(`no parseAbi([...]) block in ${tsFile}`);
  const block = text
    .slice(start + "parseAbi([".length, end)
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
  const strings = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  if (strings.length === 0) throw new Error("no ABI strings found");
  return parseAbi(strings);
}

const canonType = (p) =>
  p.type.startsWith("tuple") ? `(${p.components.map(canonType).join(",")})${p.type.slice(5)}` : p.type;
const sigKey = (x) =>
  x.type === "receive" || x.type === "fallback"
    ? x.type
    : `${x.type} ${x.name ?? ""}(${(x.inputs ?? []).map(canonType).join(",")})`;
const normParam = (p, isEvent) => ({
  type: p.type,
  name: p.name ?? "",
  ...(isEvent ? { indexed: Boolean(p.indexed) } : {}),
  ...(p.components ? { components: p.components.map((c) => normParam(c, false)) } : {}),
});
function norm(x) {
  switch (x.type) {
    case "function":
      return {
        name: x.name,
        inputs: x.inputs.map((p) => normParam(p, false)),
        outputs: (x.outputs ?? []).map((p) => normParam(p, false)),
        stateMutability: x.stateMutability,
      };
    case "event":
      return { name: x.name, inputs: x.inputs.map((p) => normParam(p, true)), anonymous: Boolean(x.anonymous) };
    case "error":
      return { name: x.name, inputs: x.inputs.map((p) => normParam(p, false)) };
    default:
      return { stateMutability: x.stateMutability };
  }
}

const problems = [];
let compiled;
try {
  compiled = compiledAbi();
} catch (e) {
  console.error("forge inspect failed (is Foundry installed? run `npm run contracts:build`):", e.message);
  process.exit(1);
}
const expected = tsAbi();

const compiledByKey = new Map(compiled.filter((x) => x.type !== "constructor").map((x) => [sigKey(x), x]));
const expectedByKey = new Map(expected.map((x) => [sigKey(x), x]));

for (const [key, want] of expectedByKey) {
  const got = compiledByKey.get(key);
  if (!got) {
    problems.push(`missing in Solidity: ${key}`);
    continue;
  }
  const a = JSON.stringify(norm(want));
  const b = JSON.stringify(norm(got));
  if (a !== b) problems.push(`differs: ${key}\n    ts:  ${a}\n    sol: ${b}`);
}
const extras = [];
for (const [key, got] of compiledByKey) {
  if (got.type === "function" && FORBIDDEN.test(got.name)) problems.push(`forbidden function in Solidity: ${key}`);
  if (expectedByKey.has(key)) continue;
  if (ALLOWED_EXTRA.has(key)) extras.push(key);
  else problems.push(`not in the TS ABI (add it there or remove it from Solidity): ${key}`);
}
const ctor = compiled.find((x) => x.type === "constructor");
const ctorTypes = (ctor?.inputs ?? []).map((p) => p.type);
if (JSON.stringify(ctorTypes) !== JSON.stringify(SPEC_CONSTRUCTOR)) {
  problems.push(`constructor (${ctorTypes.join(",")}) != SPEC (${SPEC_CONSTRUCTOR.join(",")})`);
}

if (problems.length) {
  console.error(`ABI check FAILED (${problems.length} problem${problems.length > 1 ? "s" : ""}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`ABI check passed: ${expectedByKey.size} TS entries match the compiled SparecycleRewards ABI exactly.`);
console.log(`Constructor matches SPEC: (${SPEC_CONSTRUCTOR.join(", ")}).`);
console.log(`Inherited entries present only in the compiled ABI (allowed): ${extras.join("; ")}`);
