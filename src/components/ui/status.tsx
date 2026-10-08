import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "live" | "neutral" | "warn" | "error" | "off";

const toneClass: Record<Tone, string> = {
  live: "text-signal border-signal/30 bg-signal-soft",
  neutral: "text-muted border-line-strong bg-white/[0.02]",
  warn: "text-amber border-amber/30 bg-amber-soft",
  error: "text-rust border-rust/30 bg-rust-soft",
  off: "text-faint border-line bg-transparent",
};

const glyph: Record<Tone, ReactNode> = {
  // Shape + word, never colour alone (brief: do not use colour alone for state).
  live: <span aria-hidden className="size-1.5 rounded-full bg-current" />,
  neutral: <span aria-hidden className="size-1.5 rounded-full border border-current" />,
  warn: <span aria-hidden className="size-0 border-x-[4px] border-b-[7px] border-x-transparent border-b-current" />,
  error: <span aria-hidden className="text-[10px] leading-none">✕</span>,
  off: <span aria-hidden className="h-px w-2 bg-current" />,
};

/** Small status tag: shape + text. */
export function StatusTag({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-s border px-2 text-xs font-medium whitespace-nowrap",
        toneClass[tone],
        className,
      )}
    >
      {glyph[tone]}
      {children}
    </span>
  );
}

/** Full-width notice. Used for the two persistent dApp banners and empty/blocked states. */
export function Notice({
  tone = "neutral",
  title,
  children,
  className,
  action,
}: {
  tone?: Exclude<Tone, "off">;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const rule: Record<string, string> = {
    live: "before:bg-signal",
    neutral: "before:bg-line-strong",
    warn: "before:bg-amber",
    error: "before:bg-rust",
  };
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "relative flex flex-col gap-3 rounded-m border border-line bg-graphite py-3 pr-4 pl-5 text-sm sm:flex-row sm:items-center sm:justify-between",
        "before:absolute before:inset-y-2 before:left-0 before:w-[2px] before:rounded-full",
        rule[tone],
        className,
      )}
    >
      <div className="min-w-0">
        {title ? <p className="font-medium text-text">{title}</p> : null}
        {children ? <div className="text-muted">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
