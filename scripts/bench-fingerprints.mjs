#!/usr/bin/env node
// Adds the scheduler's image fingerprint (64-bit dHash, src/server/verify.ts: the exact code live matching uses) to
// every image item of a bench folder's bench.json, so the folder can be published under bench/results/ without its
// PNG files and still be compared (scripts/compare-bench.mjs) and turned into challenge references.
//
//   node scripts/bench-fingerprints.mjs <bench-folder> [--out path/to/bench.json]
//
// Reads <bench-folder>/bench.json and the PNG of each image item. Writes the same JSON (same layout as the node
// client writes it) with `fingerprint` on each image item, to --out or back into <bench-folder>/bench.json. Fails if a
// PNG is missing or unreadable: fingerprints are computed, never typed in.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const { decodePng, imageFingerprint } = await srcImport("server/verify.ts");

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : null;
const dir = args.find((a, i) => !a.startsWith("--") && !(outAt >= 0 && i === outAt + 1));
if (!dir) {
  console.error("usage: node scripts/bench-fingerprints.mjs <bench-folder> [--out path/to/bench.json]");
  process.exit(1);
}

const bench = JSON.parse(readFileSync(join(dir, "bench.json"), "utf8"));
let n = 0;
for (const it of bench.items) {
  if (it.kind !== "image") continue;
  const img = decodePng(readFileSync(join(dir, it.file)));
  if (!img) throw new Error(`${join(dir, it.file)} is not a readable PNG`);
  it.fingerprint = imageFingerprint(img);
  n++;
}
const dest = out ?? join(dir, "bench.json");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(bench, null, 2) + "\n");
console.log(`${n} image fingerprint(s) -> ${dest}`);
