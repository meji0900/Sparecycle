// Same-day docs check for pull requests: fails when the API, the scheduler or the node client changed and nothing
// under the docs did, unless the pull request carries the label `no-docs`.
//
//   code:  src/app/api/**, src/server/**, node-client/src/**   (tests, *.test.ts, do not count)
//   docs:  src/app/(site)/docs/**, docs/**, src/lib/changelog.ts
//
// Usage (CI): node scripts/check-docs-touch.mjs --base origin/main
//   Labels come from PR_LABELS (comma-separated) or, when absent, from the pull_request event in GITHUB_EVENT_PATH.
// Usage (local): node scripts/check-docs-touch.mjs --base main
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const SKIP_LABEL = "no-docs";
const CODE = [/^src\/app\/api\//, /^src\/server\//, /^node-client\/src\//];
const DOCS = [/^src\/app\/\(site\)\/docs\//, /^docs\//, /^src\/lib\/changelog\.ts$/];
const isTest = (f) => /\.test\.[cm]?[jt]sx?$/.test(f);

/** Pure decision, for tests: { ok, reason, code, docs }. */
export function checkDocsTouch(files, labels = []) {
  const norm = files.map((f) => f.trim().replace(/\\/g, "/")).filter(Boolean);
  const code = norm.filter((f) => CODE.some((r) => r.test(f)) && !isTest(f));
  const docs = norm.filter((f) => DOCS.some((r) => r.test(f)));
  if (labels.map((l) => l.trim().toLowerCase()).includes(SKIP_LABEL)) {
    return { ok: true, reason: `label "${SKIP_LABEL}" set`, code, docs };
  }
  if (!code.length) return { ok: true, reason: "no API, scheduler or node-client source changed", code, docs };
  if (docs.length) return { ok: true, reason: "docs changed with the code", code, docs };
  return { ok: false, reason: "API, scheduler or node-client source changed without a docs or changelog change", code, docs };
}

function labelsFromEnv() {
  if (process.env.PR_LABELS !== undefined) return process.env.PR_LABELS.split(",").filter(Boolean);
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return [];
  try {
    const event = JSON.parse(readFileSync(path, "utf8"));
    return (event.pull_request?.labels ?? []).map((l) => l.name);
  } catch {
    return [];
  }
}

function main() {
  const i = process.argv.indexOf("--base");
  const base = i > 0 ? process.argv[i + 1] : process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main";
  const out = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  const result = checkDocsTouch(out.split("\n"), labelsFromEnv());
  if (result.ok) {
    console.log(`✓ Docs check: ${result.reason}.`);
    return;
  }
  console.error(`✗ Docs check: ${result.reason}.`);
  console.error(`  Changed source:\n    ${result.code.join("\n    ")}`);
  console.error(
    `  Update the docs the same day: src/app/(site)/docs/, docs/ or src/lib/changelog.ts.\n  If this change needs no docs, add the label "${SKIP_LABEL}" to the pull request.`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
