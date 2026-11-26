#!/usr/bin/env node
// Off-server copy of every published payout tree, so claims stay possible even if the server's volume is lost.
//
//   node scripts/backup-trees.mjs [site]      default https://sparecycle.tech
//
// Saves backups/trees/<host>/epoch-<id>.json (the exact /api/v1/epochs/{id}/tree response) for every closed epoch,
// skips files already saved with the same root, and checks that each tree carries the root the epoch list shows.
// With these files anyone can rebuild a Merkle proof (sorted-pair keccak tree, src/lib/merkle.ts).
// Also saves charges-<id>.json (the /api/v1/epochs/{id}/charges response) for every confirmed jobs-root charge
// (hashRule "v2-jobs-merkle"), after checking that its leaves rebuild its listHash: the jobs tree that payers' job
// receipts prove against (src/lib/job-receipt.ts).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const { buildTree } = await srcImport("lib/merkle.ts");

const site = (process.argv[2] ?? "https://sparecycle.tech").replace(/\/+$/, "");
const host = new URL(site).host;
const dir = join("backups", "trees", host);
mkdirSync(dir, { recursive: true });

const get = async (path) => {
  const r = await fetch(`${site}${path}`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
};

const { epochs } = await get("/api/v1/epochs");
let saved = 0;
let kept = 0;
for (const e of epochs) {
  if (e.status === "open" || !e.root) continue;
  const file = join(dir, `epoch-${e.id}.json`);
  if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).root === e.root) {
    kept++;
    continue;
  }
  const tree = await get(`/api/v1/epochs/${e.id}/tree`);
  if (tree.root !== e.root) throw new Error(`epoch ${e.id}: tree root ${tree.root} != listed root ${e.root}`);
  writeFileSync(file, JSON.stringify(tree, null, 2) + "\n");
  saved++;
  console.log(`epoch ${e.id}: ${tree.leaves.length} leaves, root ${tree.root} -> ${file}`);
}
// Jobs trees of the charges (v2). Epochs whose charge is v1, missing or not confirmed are skipped.
let jobTrees = 0;
for (const e of epochs) {
  if (e.status === "open") continue;
  const file = join(dir, `charges-${e.id}.json`);
  const c = await get(`/api/v1/epochs/${e.id}/charges`);
  if (c.hashRule !== "v2-jobs-merkle" || c.status !== "done") continue;
  if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).listHash === c.listHash) {
    kept++;
    continue;
  }
  if (buildTree(c.leaves).root !== c.listHash.toLowerCase()) throw new Error(`epoch ${e.id}: the jobs-tree leaves do not rebuild listHash ${c.listHash}`);
  writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
  jobTrees++;
  console.log(`epoch ${e.id}: jobs tree of ${c.leaves.length} leaves, listHash ${c.listHash} -> ${file}`);
}
console.log(`${saved} payout trees and ${jobTrees} jobs trees saved, ${kept} already up to date, in ${dir}`);
