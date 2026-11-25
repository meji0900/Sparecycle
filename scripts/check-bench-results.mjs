#!/usr/bin/env node
// CI-friendly check of the published GPU bench evidence (no GPU, no network): guards against a change in
// src/server/verify.ts (fingerprints / thresholds) or in the bench tooling silently changing published verdicts.
//
//   node scripts/check-bench-results.mjs        (npm run check:bench)
//
//  1. every bench/results/<folder>/runs.json: re-runs scripts/compare-bench.mjs with the recorded folders and --only,
//     and compares the output with the committed summary JSON
//  2. every bench/reference/*.json: re-runs the recorded scripts/build-challenge-reference.mjs command and compares
//  3. every "allowed" rule in src/server/gpu-allowlist.json names an evidence folder that exists under bench/results/
// Run from anywhere; paths resolve against the repo root. Exit 1 on any mismatch.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sparecycle-bench-check-"));
let failures = 0;
const report = (ok, what, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const node = (args) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8" });

try {
  const results = join(ROOT, "bench", "results");
  const folders = existsSync(results) ? readdirSync(results, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  for (const f of folders) {
    const manifest = join(results, f, "runs.json");
    if (!existsSync(manifest)) {
      report(false, `bench/results/${f}`, "no runs.json");
      continue;
    }
    for (const run of readJson(manifest).compare) {
      const out = join(tmp, `${f}-${run.summary}`);
      const args = ["scripts/compare-bench.mjs", ...run.folders.map((d) => `bench/results/${f}/${d}`), ...(run.only ? ["--only", run.only] : []), "--json", out];
      const r = node(args);
      const same = r.status === 0 && existsSync(out) && isDeepStrictEqual(readJson(out), readJson(join(results, f, run.summary)));
      report(same, `bench/results/${f}/${run.summary} reproduces`, r.status === 0 ? "" : (r.stderr || r.stdout).trim().split("\n").slice(-1)[0]);
    }
  }

  const refDir = join(ROOT, "bench", "reference");
  for (const file of existsSync(refDir) ? readdirSync(refDir).filter((n) => n.endsWith(".json")) : []) {
    const ref = readJson(join(refDir, file));
    const argv = ref.command.split(/\s+/).slice(1); // drop "node"
    const at = argv.indexOf("--out");
    const out = join(tmp, file);
    argv[at + 1] = out;
    const r = node(argv);
    const fresh = r.status === 0 && existsSync(out) ? readJson(out) : null;
    const same = fresh !== null && isDeepStrictEqual({ ...fresh, command: null }, { ...ref, command: null });
    report(same, `bench/reference/${file} reproduces`, r.status === 0 ? "" : (r.stderr || r.stdout).trim().split("\n").slice(-1)[0]);
  }

  const allowlist = readJson(join(ROOT, "src", "server", "gpu-allowlist.json"));
  for (const rule of allowlist.rules.filter((x) => x.status === "allowed")) {
    const ok = typeof rule.evidence === "string" && existsSync(join(ROOT, rule.evidence, "runs.json"));
    report(ok, `allowlist rule ${rule.id} (allowed) has published evidence`, rule.evidence ?? "no evidence field");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall bench evidence checks passed");
process.exitCode = failures ? 1 : 0;
