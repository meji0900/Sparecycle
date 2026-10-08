"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { hoursFlag, pad2, PRESETS } from "@/lib/dapp/hours";
import { cn } from "@/lib/utils";

/**
 * 24 toggleable hours in two rows (00–11, 12–23). One tab stop for the grid; arrow keys move, Space or Enter
 * toggles (roving tabindex). Selected hours are marked by a filled block and aria-pressed, not by colour alone.
 */
export function IdlePlanner({ hours, onChange }: { hours: boolean[]; onChange: (h: boolean[]) => void }) {
  const [focus, setFocus] = useState(1);
  const cells = useRef<(HTMLButtonElement | null)[]>([]);
  const count = hours.filter(Boolean).length;
  const flag = hoursFlag(hours);
  const preset = PRESETS.find((p) => p.hours.every((v, i) => v === hours[i]));

  const move = (to: number) => {
    const i = Math.max(0, Math.min(23, to));
    setFocus(i);
    cells.current[i]?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const map: Record<string, number> = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + 12, ArrowUp: i - 12, Home: i < 12 ? 0 : 12, End: i < 12 ? 11 : 23 };
    if (e.key in map) {
      e.preventDefault();
      move(map[e.key]);
    }
  };
  const toggle = (i: number) => onChange(hours.map((v, h) => (h === i ? !v : v)));

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange([...p.hours])}
            aria-pressed={preset?.id === p.id}
            title={p.hint}
            className={cn(
              "h-8 rounded-m border px-3 text-sm transition-colors duration-150",
              preset?.id === p.id ? "border-line-strong bg-white/[0.06] text-text" : "border-line text-muted hover:border-line-strong hover:text-text",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-2" role="group" aria-label="Idle hours, local time of the node computer. Use arrow keys to move and Space to toggle.">
        {[0, 12].map((start) => (
          <div key={start} className="flex items-center gap-2">
            <span className="w-7 shrink-0 text-xs text-faint" aria-hidden>
              {start === 0 ? "AM" : "PM"}
            </span>
            <div className="grid min-w-0 flex-1 grid-cols-12 gap-1">
              {Array.from({ length: 12 }, (_, k) => {
                const h = start + k;
                const on = hours[h];
                return (
                  <button
                    key={h}
                    ref={(el) => {
                      cells.current[h] = el;
                    }}
                    type="button"
                    tabIndex={focus === h ? 0 : -1}
                    aria-pressed={on}
                    aria-label={`${pad2(h)}:00 to ${pad2((h + 1) % 24)}:00`}
                    onClick={() => {
                      setFocus(h);
                      toggle(h);
                    }}
                    onKeyDown={(e) => onKey(e, h)}
                    className={cn(
                      "flex h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-s border text-[11px] transition-colors duration-150 sm:h-12 sm:text-xs",
                      on ? "border-signal/40 bg-signal-soft text-text" : "border-line text-faint hover:border-line-strong hover:text-muted",
                    )}
                  >
                    <span className="num">{pad2(h)}</span>
                    <span aria-hidden className={cn("h-1 w-3 rounded-[1px]", on ? "bg-signal" : "border border-current")} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 text-sm text-muted" aria-live="polite">
        {count === 0 ? (
          "No hours selected. A node with no hours never takes a job."
        ) : (
          <>
            <span className="num text-text">{count}</span> idle hour{count === 1 ? "" : "s"} a day,{" "}
            <span className="num text-text">{count * 7}</span> a week.{" "}
            {count === 24 ? "The node may work at any hour, so no --hours flag is needed." : <>Flag: <span className="num text-text">--hours {flag}</span></>}
          </>
        )}
      </p>
      <p className="mt-1 text-xs text-faint">
        Hours are the node computer&apos;s local time. In the flag, 1-8 means from 01:00 until 08:00.
      </p>
    </div>
  );
}
