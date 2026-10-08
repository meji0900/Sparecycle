#!/usr/bin/env node
// Off-server copy of every published payout tree, so claims stay possible even if the server's volume is lost.
//
//   node scripts/backup-trees.mjs [site]      default https://sparecycle.tech
//
// Saves backups/trees/<host>/epoch-<id>.json (the exact /api/v1/epochs/{id}/tree response) for every closed epoch,
// skips files already saved with the same root, and checks that each tree carries the root the epoch list shows.
// With these files anyone can rebuild a Merkle proof (sorted-pair keccak tree, src/lib/merkle.ts).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
console.log(`${saved} saved, ${kept} already up to date, in ${dir}`);
