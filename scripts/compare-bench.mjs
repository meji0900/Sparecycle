#!/usr/bin/env node
// Compares bench folders from different devices (made with `node src/agent.ts bench` in the node client): would
// two honest nodes on these devices pass the scheduler's two-node check, and how much margin do the thresholds have?
//
//   node scripts/compare-bench.mjs <bench-folder> <bench-folder> [...] [--only image|text] [--json summary.json]
//
// --only keeps one job kind (e.g. for a folder whose text jobs ran with older settings). Image items are fingerprinted
// from their PNG; when the PNG is not there (published folders under bench/results/ keep only bench.json) the item's
// `fingerprint` field is used, computed from the PNG with the same code by scripts/bench-fingerprints.mjs.
//
// Uses the scheduler's own fingerprints and thresholds (src/server/verify.ts):
//   image: dHash bits that differ, agree when <= IMAGE_MAX_BITS
//   text:  edit-distance similarity, agree when >= TEXT_MIN_SIMILARITY
// "control" images use the same prompt with the next seed: the closest a wrong answer can look. A safe image
// threshold sits above every same-job distance and below every control distance.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const { decodePng, imageFingerprint, hammingHex, textFingerprint, textSimilarity, IMAGE_MAX_BITS, TEXT_MIN_SIMILARITY } =
  await srcImport("server/verify.ts");

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null;
const onlyAt = args.indexOf("--only");
const only = onlyAt >= 0 ? args[onlyAt + 1] : null;
const dirs = args.filter((a, i) => !a.startsWith("--") && !(jsonAt >= 0 && i === jsonAt + 1) && !(onlyAt >= 0 && i === onlyAt + 1));
if (dirs.length < 1 || (onlyAt >= 0 && !["image", "text"].includes(only))) {
  console.error("usage: node scripts/compare-bench.mjs <bench-folder> <bench-folder> [...] [--only image|text] [--json summary.json]");
  process.exit(1);
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const min = (xs) => (xs.length ? Math.min(...xs) : null);
const max = (xs) => (xs.length ? Math.max(...xs) : null);
const f3 = (x) => (x === null ? "-" : x.toFixed(3));

function load(dir) {
  const file = join(dir, "bench.json");
  if (!existsSync(file)) throw new Error(`${file} not found`);
  const b = JSON.parse(readFileSync(file, "utf8"));
  const items = b.items
    .filter((it) => !only || it.kind === only)
    .map((it) => {
      if (it.kind === "image") {
        const png = join(dir, it.file);
        if (existsSync(png)) {
          const img = decodePng(readFileSync(png));
          const fp = img ? imageFingerprint(img) : null;
          if (it.fingerprint && fp !== it.fingerprint) console.warn(`warning: ${png}: stored fingerprint ${it.fingerprint}, computed ${fp}`);
          return { ...it, fp };
        }
        if (typeof it.fingerprint === "string") return { ...it, fp: it.fingerprint };
        throw new Error(`${png} not found and the item has no stored fingerprint`);
      }
      return { ...it, fp: textFingerprint(it.text) };
    });
  const label = `${b.device?.name ?? "?"} [${b.backend}${b.device?.computeCap ? ` cc${b.device.computeCap}` : ""}]`;
  return { dir, label, suite: b.suite, backend: b.backend, device: b.device, software: b.software, items };
}

const benches = dirs.map(load);
const suites = new Set(benches.map((b) => b.suite));
if (suites.size > 1) console.warn(`warning: different bench suites (${[...suites].join(", ")}); only shared job ids are compared`);

const first = (b, kind) => b.items.filter((i) => i.kind === kind && i.run === 1);
const dist = (kind, a, b) => (kind === "image" ? (a && b ? hammingHex(a, b) : 64) : textSimilarity(a, b));
const agrees = (kind, d) => (kind === "image" ? d <= IMAGE_MAX_BITS : d >= TEXT_MIN_SIMILARITY);

const summary = { thresholds: { imageMaxBits: IMAGE_MAX_BITS, textMinSimilarity: TEXT_MIN_SIMILARITY }, ...(only ? { only } : {}), devices: [], pairs: [] };

console.log(`Thresholds: image <= ${IMAGE_MAX_BITS} differing bits of 64, text similarity >= ${TEXT_MIN_SIMILARITY}${only ? ` (${only} jobs only)` : ""}\n`);
console.log("Devices (same device, run 2+ against run 1):");
for (const b of benches) {
  const img = b.items.filter((i) => i.kind === "image");
  const txt = b.items.filter((i) => i.kind === "text");
  const self = { image: [], text: [] };
  for (const it of b.items.filter((i) => i.run > 1)) {
    const ref = b.items.find((j) => j.id === it.id && j.run === 1 && j.kind === it.kind);
    if (ref) self[it.kind].push(dist(it.kind, ref.fp, it.fp));
  }
  const controls = first(b, "image")
    .filter((i) => i.control)
    .map((i) => dist("image", i.fp, first(b, "image").find((j) => j.id === i.control)?.fp));
  const d = {
    dir: b.dir,
    label: b.label,
    software: b.software,
    imageMedianMs: median(img.map((i) => i.gpuMs)),
    textMedianTokPerS: median(txt.map((i) => i.tokensPerSecond)),
    selfImageMaxBits: max(self.image),
    selfTextMinSimilarity: min(self.text),
    controlImageMinBits: min(controls),
    nsfwFlags: img.filter((i) => i.nsfw).length,
  };
  summary.devices.push(d);
  console.log(`  ${b.label}  (${b.dir})`);
  if (img.length)
    console.log(
      `    image: median ${(d.imageMedianMs / 1000).toFixed(2)} s, repeat max ${d.selfImageMaxBits ?? "-"} bits, control (other seed) min ${d.controlImageMinBits ?? "-"} bits${d.nsfwFlags ? `, ${d.nsfwFlags} flagged nsfw` : ""}`,
    );
  if (txt.length) console.log(`    text:  median ${d.textMedianTokPerS?.toFixed(1) ?? "-"} tok/s, repeat min similarity ${f3(d.selfTextMinSimilarity)}`);
}

console.log("\nPairs (run 1 of each job):");
for (let x = 0; x < benches.length; x++) {
  for (let y = x + 1; y < benches.length; y++) {
    const A = benches[x];
    const B = benches[y];
    const pair = { a: A.label, b: B.label, sameBackend: A.backend === B.backend, image: [], text: [] };
    for (const kind of ["image", "text"]) {
      for (const a of first(A, kind)) {
        const b = first(B, kind).find((j) => j.id === a.id);
        if (!b) continue;
        const d = dist(kind, a.fp, b.fp);
        pair[kind].push({ id: a.id, value: d, agree: agrees(kind, d) });
      }
    }
    summary.pairs.push(pair);
    console.log(`  ${A.label}  vs  ${B.label}${pair.sameBackend ? "" : "  (different backends: the scheduler never pairs these)"}`);
    for (const kind of ["image", "text"]) {
      const rows = pair[kind];
      if (!rows.length) continue;
      const ok = rows.filter((r) => r.agree).length;
      const vals = rows.map((r) => r.value);
      const worst = [...rows].sort((p, q) => (kind === "image" ? q.value - p.value : p.value - q.value)).slice(0, 3);
      const spread = kind === "image" ? `bits min ${min(vals)} / median ${median(vals)} / max ${max(vals)}` : `similarity min ${f3(min(vals))} / median ${f3(median(vals))}`;
      console.log(`    ${kind}: ${ok}/${rows.length} agree, ${spread}; worst: ${worst.map((r) => `${r.id}=${kind === "image" ? r.value : r.value.toFixed(3)}`).join(", ")}`);
    }
  }
}

// Threshold check for images: every same-job distance (repeats and cross-device, same backend) vs every control.
const same = [
  ...summary.devices.map((d) => d.selfImageMaxBits).filter((v) => v !== null),
  ...summary.pairs.filter((p) => p.sameBackend).flatMap((p) => p.image.map((r) => r.value)),
];
const controls = summary.devices.map((d) => d.controlImageMinBits).filter((v) => v !== null);
if (same.length && controls.length) {
  const hi = Math.max(...same);
  const lo = Math.min(...controls);
  summary.imageThreshold = { sameJobMaxBits: hi, controlMinBits: lo, current: IMAGE_MAX_BITS };
  console.log(`\nImage threshold: same job up to ${hi} bits, other seed from ${lo} bits, current threshold ${IMAGE_MAX_BITS}.`);
  if (hi > IMAGE_MAX_BITS) console.log("  TOO STRICT: honest pairs above would be rejected.");
  else if (lo <= IMAGE_MAX_BITS) console.log("  TOO LOOSE: an image with another seed would pass.");
  else console.log(`  OK: margin ${IMAGE_MAX_BITS - hi} bit(s) below, ${lo - IMAGE_MAX_BITS - 1} above.`);
}
const textSame = summary.pairs.filter((p) => p.sameBackend).flatMap((p) => p.text.map((r) => r.value));
if (textSame.length) {
  const lo = Math.min(...textSame);
  summary.textThreshold = { sameJobMinSimilarity: lo, current: TEXT_MIN_SIMILARITY };
  console.log(`Text threshold: lowest same-backend similarity ${lo.toFixed(3)}, current threshold ${TEXT_MIN_SIMILARITY}${lo < TEXT_MIN_SIMILARITY ? "  TOO STRICT for these devices" : "  OK"}.`);
}

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(summary, null, 2) + "\n");
  console.log(`\nSummary written to ${jsonOut}`);
}
