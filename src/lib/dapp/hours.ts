// Idle planner helpers. The node client reads `--hours 1-8,22-24`: ranges in the node computer's local time,
// start inclusive, end exclusive, 0..24 (node-client/src/gpu.ts parseHours).

/** Contiguous runs of selected hours as [start, endExclusive] pairs. */
export function hoursToRanges(selected: readonly boolean[]): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  for (let h = 0; h <= 24; h++) {
    const on = h < 24 && selected[h];
    if (on && start === null) start = h;
    if (!on && start !== null) {
      out.push([start, h]);
      start = null;
    }
  }
  return out;
}

/** The value of the --hours flag, or null when no hour is selected. */
export function hoursFlag(selected: readonly boolean[]): string | null {
  const ranges = hoursToRanges(selected);
  if (!ranges.length) return null;
  return ranges.map(([a, b]) => `${a}-${b}`).join(",");
}

export const hoursFrom = (...ranges: [number, number][]) =>
  Array.from({ length: 24 }, (_, h) => ranges.some(([a, b]) => h >= a && h < b));

export const PRESETS = [
  { id: "sleep", label: "While I sleep", hint: "01:00 to 08:00", hours: hoursFrom([1, 8]) },
  { id: "overnight-workday", label: "Overnight + workday", hint: "22:00 to 08:00 and 09:00 to 17:00", hours: hoursFrom([0, 8], [9, 17], [22, 24]) },
  { id: "always", label: "Always on", hint: "All 24 hours", hours: hoursFrom([0, 24]) },
  { id: "clear", label: "Clear", hint: "No hours", hours: hoursFrom() },
] as const;

export const pad2 = (n: number) => String(n).padStart(2, "0");
