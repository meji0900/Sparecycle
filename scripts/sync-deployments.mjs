#!/usr/bin/env node
// Reads Foundry broadcast output and writes src/contracts/deployments.json:
//   { "<chainId>": { "<ContractName>": "0x…" } }
// Run after every `forge script … --broadcast` (deploy-local.mjs calls it for you).
// The latest run for a chain replaces that chain's entry (so a redeploy without the mock escrow does not
// leave a stale mock address); other chains are kept.
// Usage: node scripts/sync-deployments.mjs [ScriptName.s.sol] [--chain <id>]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const chainIdx = args.indexOf("--chain");
const onlyChain = chainIdx >= 0 ? args[chainIdx + 1] : null;
const script = args.find((a, i) => !a.startsWith("--") && (chainIdx < 0 || i !== chainIdx + 1)) || "Deploy.s.sol";

const dir = join(root, "contracts", "broadcast", script);
const outFile = join(root, "src", "contracts", "deployments.json");
if (!existsSync(dir)) {
  console.error(`No broadcast found at ${dir}. Run forge script … --broadcast first.`);
  process.exit(1);
}

const deployments = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
let wrote = 0;
for (const chainId of readdirSync(dir)) {
  if (onlyChain && chainId !== onlyChain) continue;
  const file = join(dir, chainId, "run-latest.json");
  if (!existsSync(file)) continue;
  const run = JSON.parse(readFileSync(file, "utf8"));
  const contracts = {};
  for (const tx of run.transactions ?? []) {
    if ((tx.transactionType === "CREATE" || tx.transactionType === "CREATE2") && tx.contractName && tx.contractAddress) {
      contracts[tx.contractName] = getAddress(tx.contractAddress);
    }
  }
  if (Object.keys(contracts).length) {
    deployments[chainId] = contracts;
    wrote++;
    console.log(`chain ${chainId}: ${Object.entries(contracts).map(([n, a]) => `${n}=${a}`).join(", ")}`);
  }
}
if (!wrote) {
  console.error(`No CREATE transactions found under ${dir}${onlyChain ? ` for chain ${onlyChain}` : ""}.`);
  process.exit(1);
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(deployments, null, 2) + "\n");
console.log(`Wrote ${outFile}`);
