// The changelog lists only what is live, each entry dated and backed by evidence. Run: npm test
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { CHANGELOG, KIND_LABEL, formatChangelogDate, isValidChangelogDate, rfc822Wita, witaDay } from "./changelog";

describe("changelog", () => {
  test("every entry has a unique id, a valid date, a known kind, a summary and at least one piece of evidence", () => {
    const ids = new Set<string>();
    for (const e of CHANGELOG) {
      assert.match(e.id, /^[a-z0-9-]+$/);
      assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
      ids.add(e.id);
      assert.ok(isValidChangelogDate(e.date), `${e.id}: bad date ${e.date}`);
      assert.ok(e.kind in KIND_LABEL, `${e.id}: unknown kind`);
      assert.ok(e.title.trim() && e.summary.trim(), e.id);
      assert.ok(e.evidence.length > 0, `${e.id} has no evidence`);
      for (const ev of e.evidence) {
        assert.ok(ev.label.trim(), `${e.id}: evidence without a label`);
        assert.ok(!!ev.tx !== !!ev.url, `${e.id}: evidence must be a tx or a url`);
        if (ev.tx) assert.match(ev.tx, /^0x[0-9a-f]{64}$/, `${e.id}: bad tx hash`);
        if (ev.url) assert.match(ev.url, /^(https:\/\/|\/[a-z0-9])/, `${e.id}: evidence url must be https or a site path`);
        if (ev.url) assert.ok(!/\/commit\//.test(ev.url), `${e.id}: commits are not evidence (history was rewritten)`);
      }
    }
  });

  test("newest first (by WITA day), and nothing dated in the future", () => {
    const days = CHANGELOG.map((e) => witaDay(e.date));
    for (let i = 1; i < days.length; i++) assert.ok(days[i - 1] >= days[i], `${CHANGELOG[i].id} is newer than the entry above it`);
    const now = Date.now();
    for (const e of CHANGELOG) {
      const t = Date.parse(e.date.length === 10 ? `${e.date}T00:00:00+08:00` : e.date);
      assert.ok(t <= now, `${e.id} is dated in the future`);
    }
  });

  test("dates show WITA with UTC alongside", () => {
    assert.deepEqual(formatChangelogDate("2026-11-24T13:55:32Z"), { wita: "24 Nov 2026, 21:55 WITA", utc: "13:55 UTC" });
    assert.deepEqual(formatChangelogDate("2026-11-24T20:30:00Z"), { wita: "25 Nov 2026, 04:30 WITA", utc: "24 Nov 2026, 20:30 UTC" });
    assert.deepEqual(formatChangelogDate("2026-11-25"), { wita: "25 Nov 2026 (WITA)", utc: null });
    assert.equal(witaDay("2026-11-24T20:30:00Z"), "2026-11-25");
    assert.equal(rfc822Wita("2026-11-24T13:55:32Z"), "Tue, 24 Nov 2026 21:55:32 +0800");
    assert.equal(rfc822Wita("2026-11-25"), "Wed, 25 Nov 2026 00:00:00 +0800");
    assert.equal(isValidChangelogDate("25 Nov 2026"), false);
  });
});
