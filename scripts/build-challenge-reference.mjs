#!/usr/bin/env node
// Builds the reference fingerprints the scheduler's periodic GPU challenge compares against
// (bench/reference/suite-<BENCH_SUITE>-<backend>.json, read by src/server/challenge.ts), from bench folders of
// reference devices that passed (bench/results/, docs/gpu-support.md).
//
//   node scripts/build-challenge-reference.mjs --backend cuda --out bench/reference/suite-1-cuda.json \
//        <folder>[:image|:text] <folder>[:image|:text] ...
//   node scripts/build-challenge-reference.mjs --dev-runner --out bench/reference/suite-1-dev-runner.json
//
// A folder suffix keeps one job kind from that folder (e.g. images from one run, text from a run with the live
// llama.cpp settings). Each case of the bench suite (node-client/src/bench.ts) becomes a challenge case: its exact
// job spec plus the run-1 fingerprint of every reference device, computed with the scheduler's own code
// (src/server/verify.ts). The script refuses references whose devices disagree with each other under the live
// thresholds. Output is deterministic (no timestamps), so re-running it reproduces the committed file.
//
// --dev-runner: SYNTHETIC reference from the dev runner's deterministic outputs, for local end-to-end tests only
// (the scheduler uses it only for dev-runner nodes, which it accepts only with SCHEDULER_ALLOW_DEV_RUNNER=1).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const { decodePng, imageFingerprint, textFingerprint, fingerprintsMatch, IMAGE_MAX_BITS, TEXT_MIN_SIMILARITY } = await srcImport("server/verify.ts");
const { validateSpec, isBackend } = await srcImport("lib/protocol.ts");
const { BENCH_SUITE, IMAGE_SUITE, TEXT_SUITE } = await import("../node-client/src/bench.ts");

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const valued = new Set(["--backend", "--out"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const devRunner = args.includes("--dev-runner");
const backend = devRunner ? "cuda" : opt("backend");
const out = opt("out");
if (!out || (!devRunner && (!isBackend(backend) || positional.length === 0))) {
  console.error(
    "usage: node scripts/build-challenge-reference.mjs --backend cuda|vulkan|cpu --out <file.json> <folder>[:image|:text] ...\n" +
      "       node scripts/build-challenge-reference.mjs --dev-runner --out <file.json>",
  );
  process.exit(1);
}

/** The exact job spec each bench case runs (same defaults as node-client/src/bench.ts). */
const caseSpecs = [
  ...IMAGE_SUITE.map((c) => {
    const { id, ...p } = c;
    delete p.control; // a bench-only marker (which case this one is the other-seed control of), not a job parameter
    return { id, kind: "image", spec: validateSpec({ kind: "image", params: { model: "sd15", negative: "", ...p } }) };
  }),
  ...TEXT_SUITE.map(({ id, ...p }) => ({ id, kind: "text", spec: validateSpec({ kind: "text", params: { model: "qwen2.5-1.5b", system: "", ...p } }) })),
];

const devices = [];
const prints = new Map(caseSpecs.map((c) => [c.id, []]));

if (devRunner) {
  const { devImage, devText } = await import("../node-client/src/dev-runner.ts");
  for (const c of caseSpecs) {
    const fp =
      c.kind === "image"
        ? imageFingerprint(decodePng(devImage(c.spec.params).png))
        : textFingerprint(devText(c.spec.params).text);
    prints.get(c.id).push({ device: "dev-runner (synthetic)", fingerprint: fp });
  }
  devices.push({ label: "dev-runner (synthetic)", folder: null, kinds: ["image", "text"] });
} else {
  for (const arg of positional) {
    const m = /^(.*?)(?::(image|text))?$/.exec(arg);
    const folder = m[1];
    const kinds = m[2] ? [m[2]] : ["image", "text"];
    const bench = JSON.parse(readFileSync(join(folder, "bench.json"), "utf8"));
    if (bench.suite !== BENCH_SUITE) throw new Error(`${folder}: bench suite ${bench.suite}, expected ${BENCH_SUITE}`);
    if (bench.backend !== backend) throw new Error(`${folder}: backend ${bench.backend}, expected ${backend}`);
    const label = `${bench.device?.name ?? "?"} [${bench.backend}${bench.device?.computeCap ? ` cc${bench.device.computeCap}` : ""}]`;
    devices.push({ label, folder: folder.replace(/\\/g, "/"), kinds });
    for (const it of bench.items) {
      if (it.run !== 1 || !kinds.includes(it.kind) || !prints.has(it.id)) continue;
      let fp;
      if (it.kind === "image") {
        const png = join(folder, it.file);
        if (existsSync(png)) fp = imageFingerprint(decodePng(readFileSync(png)));
        else if (typeof it.fingerprint === "string") fp = it.fingerprint;
        else throw new Error(`${png} not found and the item has no stored fingerprint`);
      } else fp = textFingerprint(it.text);
      prints.get(it.id).push({ device: label, fingerprint: fp });
    }
  }
}

const cases = [];
for (const c of caseSpecs) {
  const fps = prints.get(c.id);
  if (!fps.length) continue; // kind not covered by this reference (e.g. no images on vulkan)
  for (let i = 0; i < fps.length; i++) {
    for (let j = i + 1; j < fps.length; j++) {
      if (!fingerprintsMatch(c.kind, fps[i].fingerprint, fps[j].fingerprint)) {
        throw new Error(`case ${c.id}: reference devices ${fps[i].device} and ${fps[j].device} disagree; not a usable reference`);
      }
    }
  }
  cases.push({ id: c.id, kind: c.kind, spec: c.spec, fingerprints: fps });
}
const perKind = (k) => cases.filter((c) => c.kind === k).length;
for (const k of ["image", "text"]) {
  const n = perKind(k);
  const expected = k === "image" ? IMAGE_SUITE.length : TEXT_SUITE.length;
  if (n !== 0 && n !== expected) throw new Error(`${k}: ${n} of ${expected} suite cases have reference fingerprints`);
}
if (!cases.length) throw new Error("no cases: the folders hold no run-1 items of the requested kinds");

const reference = {
  $comment: devRunner
    ? "SYNTHETIC dev-runner reference for local end-to-end tests only. Used by the scheduler only for dev-runner nodes (SCHEDULER_ALLOW_DEV_RUNNER=1). Generated by scripts/build-challenge-reference.mjs; do not edit by hand."
    : "Challenge reference fingerprints (src/server/challenge.ts). Generated by scripts/build-challenge-reference.mjs from the bench folders below; do not edit by hand. A node passes a challenge case when its output matches every fingerprint under the live thresholds.",
  suite: BENCH_SUITE,
  backend,
  synthetic: devRunner,
  command: `node scripts/build-challenge-reference.mjs ${args.join(" ").replace(/\\/g, "/")}`,
  thresholds: { imageMaxBits: IMAGE_MAX_BITS, textMinSimilarity: TEXT_MIN_SIMILARITY },
  devices,
  cases,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(reference, null, 2) + "\n");
console.log(`${cases.length} case(s) (${perKind("image")} image, ${perKind("text")} text) from ${devices.length} device run(s) -> ${out}`);
