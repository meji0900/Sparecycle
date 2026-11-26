// The same-day docs check (scripts/check-docs-touch.mjs) and the docs navigation data. Run: npm test
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { pathToFileURL } from "node:url";
import { DOCS_NAV, DOCS_PAGES } from "./docs-nav";

const ROOT = join(import.meta.dirname, "..", "..");
const { checkDocsTouch } = (await import(pathToFileURL(join(ROOT, "scripts", "check-docs-touch.mjs")).href)) as {
  checkDocsTouch: (files: string[], labels?: string[]) => { ok: boolean; code: string[]; docs: string[] };
};

describe("docs check", () => {
  test("API, scheduler or node-client source without docs fails", () => {
    for (const f of ["src/app/api/v1/jobs/route.ts", "src/server/jobs.ts", "node-client/src/agent.ts"]) {
      assert.equal(checkDocsTouch([f, "README.md"]).ok, false, f);
    }
  });

  test("passes with a docs page, a docs/ file or the changelog", () => {
    for (const d of ["src/app/(site)/docs/api/page.tsx", "docs/private-outputs.md", "src/lib/changelog.ts"]) {
      assert.equal(checkDocsTouch(["src/server/jobs.ts", d]).ok, true, d);
    }
  });

  test("passes with the no-docs label, for other files and for tests only", () => {
    assert.equal(checkDocsTouch(["src/server/jobs.ts"], ["bug", "no-docs"]).ok, true);
    assert.equal(checkDocsTouch(["src/components/site/site-footer.tsx", "README.md"]).ok, true);
    assert.equal(checkDocsTouch(["src/server/jobs.test.ts"]).ok, true);
    assert.equal(checkDocsTouch(["src\\server\\jobs.ts"]).ok, false, "Windows separators are normalised");
  });
});

describe("docs navigation", () => {
  test("every entry has a page file under src/app/(site)/docs and a unique href", () => {
    const hrefs = new Set<string>();
    assert.ok(DOCS_NAV.length > 0);
    for (const p of DOCS_PAGES) {
      assert.match(p.href, /^\/docs(\/[a-z0-9-]+)*$/);
      assert.ok(!hrefs.has(p.href), `duplicate ${p.href}`);
      hrefs.add(p.href);
      assert.ok(p.title.trim() && p.description.trim(), p.href);
      const file = join(ROOT, "src", "app", "(site)", ...p.href.split("/").filter(Boolean), "page.tsx");
      assert.ok(existsSync(file), `${p.href}: no page at ${file}`);
    }
  });
});
