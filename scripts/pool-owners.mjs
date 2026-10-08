#!/usr/bin/env node
// Owner wallets of the project's own bootstrap GPU nodes. A job's two copies always go to two different owners,
// so the pool has two: "a" and "b". They never receive payouts (PROJECT_NODE_OWNERS), hold no funds, and exist
// only to link the pool nodes. Keys live in .keys/pool-owners.json (gitignored) and are never printed.
//
//   node scripts/pool-owners.mjs init                 create the two keys once; prints the addresses
//   node scripts/pool-owners.mjs sign <a|b> <nodeKey> prints the owner address and its link signature for that node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), ".keys", "pool-owners.json");
const [cmd, which, nodeKey] = process.argv.slice(2);

function load() {
  if (!existsSync(FILE)) throw new Error(`${FILE} not found: run "node scripts/pool-owners.mjs init" first`);
  return JSON.parse(readFileSync(FILE, "utf8"));
}

if (cmd === "init") {
  if (!existsSync(FILE)) {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify({ a: generatePrivateKey(), b: generatePrivateKey() }, null, 2) + "\n", { mode: 0o600 });
  }
  const k = load();
  const a = privateKeyToAccount(k.a).address;
  const b = privateKeyToAccount(k.b).address;
  console.log(`pool owner a: ${a}\npool owner b: ${b}\nPROJECT_NODE_OWNERS=${a},${b}`);
} else if (cmd === "sign" && (which === "a" || which === "b") && nodeKey && isAddress(nodeKey)) {
  const { linkMessage } = await srcImport("lib/protocol.ts");
  const account = privateKeyToAccount(load()[which]);
  const signature = await account.signMessage({ message: linkMessage(getAddress(nodeKey), account.address) });
  console.log(`SPARECYCLE_OWNER=${account.address}\nSPARECYCLE_OWNER_SIG=${signature}`);
} else {
  console.error("usage: node scripts/pool-owners.mjs init | sign <a|b> <nodeKey>");
  process.exit(1);
}
