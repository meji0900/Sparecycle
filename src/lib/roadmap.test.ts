// The roadmap promises no dates: no calendar dates, years, quarters, digits followed by a time unit, or timing words.
// Run: npm test
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ROADMAP, ROADMAP_STATUSES } from "./roadmap";

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const UNIT = "(?:s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?|mo|mos|months?|q|quarters?|y|yrs?|years?)";

/** Each rule: a name and a pattern that must not match any roadmap text. */
export const FORBIDDEN: [string, RegExp][] = [
  ["ISO or numeric date", /\b\d{4}-\d{1,2}(-\d{1,2})?\b|\b\d{1,2}[/.]\d{1,2}([/.]\d{2,4})?\b/],
  ["year", /\b(19|20)\d{2}\b/],
  ["quarter or half", /\b[QH][1-4]\b|\b(first|second|third|fourth|last) (quarter|half)\b/i],
  ["month with a number", new RegExp(`\\b${MONTH}\\.?\\s+\\d|\\d+(st|nd|rd|th)?\\s+(of\\s+)?${MONTH}\\b`, "i")],
  ["month name", /\b(january|february|april|june|july|august|september|october|november|december)\b/i],
  ["number with a time unit", new RegExp(`\\d+(\\.\\d+)?\\s*-?\\s*${UNIT}\\b`, "i")],
  ["timing word", /\b(soon|shortly|imminent(ly)?|eta|asap|tomorrow|upcoming|next (week|month|quarter|year|release|sprint))\b/i],
  ["time window", /\b(this|by the end of|end of|within|in a few|in the coming) (the )?(week|month|quarter|year|days|weeks|months)\b/i],
  ["percentage or target number", /\d+(\.\d+)?\s*%|\b\d+x\b/i],
];

const textsOf = (i: (typeof ROADMAP)[number]) => [i.title, i.summary];

describe("roadmap", () => {
  test("every item has an id, a title, a summary and one of the three statuses", () => {
    const ids = new Set<string>();
    const statuses = new Set(ROADMAP_STATUSES.map((s) => s.id));
    assert.deepEqual([...statuses], ["in-progress", "planned", "exploring"]);
    for (const item of ROADMAP) {
      assert.match(item.id, /^[a-z0-9-]+$/);
      assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
      ids.add(item.id);
      assert.ok(item.title.trim().length > 0 && item.summary.trim().length > 0, item.id);
      assert.ok(statuses.has(item.status), `${item.id}: unknown status ${item.status}`);
    }
  });

  test("no dates, quarters, numeric targets, digits with a time unit or timing words", () => {
    for (const item of ROADMAP) {
      for (const text of [...textsOf(item)]) {
        for (const [rule, re] of FORBIDDEN) {
          assert.ok(!re.test(text), `roadmap item "${item.id}" has a ${rule}: ${text.match(re)?.[0]}`);
        }
      }
    }
    for (const s of ROADMAP_STATUSES) {
      for (const [rule, re] of FORBIDDEN) assert.ok(!re.test(`${s.label} ${s.note}`), `status ${s.id} has a ${rule}`);
    }
  });

  test("the rules catch what they are meant to catch", () => {
    const caught = (t: string) => FORBIDDEN.some(([, re]) => re.test(t));
    for (const t of ["Ships in Q3", "by 2027", "on 12 Jan", "March 3", "in 2 weeks", "6h", "within 30 days", "coming soon", "next month", "2026-12-01", "10/12", "90%", "in a few weeks"]) {
      assert.ok(caught(t), `not caught: ${t}`);
    }
    for (const t of ["Pay per job over HTTP (x402)", "An MCP server", "a daily spending cap", "may not happen", "OpenAI-compatible"]) {
      assert.ok(!caught(t), `false positive: ${t}`);
    }
  });
});
