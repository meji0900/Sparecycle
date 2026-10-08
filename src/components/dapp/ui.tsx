import type { ReactNode } from "react";
import { EM_DASH } from "@/lib/format";
import { cn } from "@/lib/utils";

/** A section heading inside a dApp page (the page h1 comes from PageHeader). */
export function SectionTitle({
  id,
  title,
  description,
  aside,
  className,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end", className)}>
      <div className="max-w-[680px]">
        <h2 id={id} className="text-xl font-semibold tracking-[-0.015em] text-text">
          {title}
        </h2>
        {description ? <div className="mt-2 text-sm leading-relaxed text-muted">{description}</div> : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
  );
}

/** Bordered surface with an optional header row. */
export function Panel({
  title,
  aside,
  children,
  footer,
  className,
  bodyClassName,
  as: Tag = "section",
  labelledBy,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  as?: "section" | "div";
  labelledBy?: string;
}) {
  return (
    <Tag aria-labelledby={labelledBy} className={cn("min-w-0 rounded-l border border-line bg-coal", className)}>
      {title || aside ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
          {title ? <div className="min-w-0 font-medium text-text">{title}</div> : <span />}
          {aside ? <div className="flex shrink-0 flex-wrap items-center gap-2">{aside}</div> : null}
        </div>
      ) : null}
      <div className={bodyClassName}>{children}</div>
      {footer ? <div className="border-t border-line px-5 py-3.5 text-xs leading-relaxed text-faint">{footer}</div> : null}
    </Tag>
  );
}

/** Label/value rows. `cols` only splits on wide screens. */
export function Facts({ children, cols = 1, className }: { children: ReactNode; cols?: 1 | 2 | 3; className?: string }) {
  return (
    // Hairlines come from each cell's 1px shadow (opaque --line on --coal), clipped at the outer edge, so a short last
    // row leaves plain background instead of a grey block.
    <dl
      className={cn(
        "grid gap-px overflow-hidden [&>*]:shadow-[0_0_0_1px_#1f1f1f]",
        cols === 2 && "sm:grid-cols-2",
        cols === 3 && "sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function Fact({ label, children, note, className }: { label: ReactNode; children: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 bg-coal px-5 py-3.5", className)}>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-h-6 min-w-0 text-[15px] break-words text-text">{children}</dd>
      {note ? <dd className="text-xs leading-relaxed text-faint">{note}</dd> : null}
    </div>
  );
}

/** Inline row: label left, value right (used in narrow panels). */
export function Row({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3", className)}>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-sm text-text">{children}</dd>
    </div>
  );
}

/** Em dash plus the reason a value is missing. Never a zero. */
export function Dash({ why }: { why?: ReactNode }) {
  return (
    <span className="text-faint">
      <span aria-hidden>{EM_DASH}</span>
      {why ? <span className="ml-1.5 text-sm">{why}</span> : <span className="sr-only">Not available</span>}
    </span>
  );
}

/** A table that scrolls inside its own box on narrow screens, never the page. */
export function TableBox({ children, label, minWidth = 720 }: { children: ReactNode; label: string; minWidth?: number }) {
  return (
    <div className="overflow-x-auto" role="region" aria-label={label} tabIndex={0}>
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export const th = "border-b border-line px-5 py-2.5 text-left text-xs font-normal whitespace-nowrap text-faint";
export const td = "border-b border-line px-5 py-3 align-middle";

/** A message row in place of table rows (loading, empty, unreachable). */
export function TableMessage({ children, colSpan }: { children: ReactNode; colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0 text-sm text-muted">
        {/* Pinned to the left edge so the message stays readable while the table scrolls on phones. */}
        <div className="sticky left-0 max-w-[calc(100vw-2.5rem)] px-5 py-8">{children}</div>
      </td>
    </tr>
  );
}

/** Loading placeholder bar: shape only, no fake numbers. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("inline-block h-4 w-24 animate-pulse rounded-s bg-white/[0.05]", className)} />;
}

/** One option of a radio group, drawn as a card (the input is visually hidden; focus shows on the card). */
export function RadioCard({
  name,
  value,
  checked,
  onSelect,
  title,
  sub,
  icon,
  className,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  title: ReactNode;
  sub?: ReactNode;
  /** Optional picture shown instead of the radio dot (e.g. a shape outline). */
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex min-w-0 cursor-pointer items-start gap-3 rounded-m border p-4 transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal",
        checked ? "border-line-strong bg-white/[0.04]" : "border-line hover:border-line-strong",
        className,
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} className="sr-only" />
      {icon ?? (
        <span aria-hidden className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border", checked ? "border-signal" : "border-line-strong")}>
          {checked ? <span className="size-2 rounded-full bg-signal" /> : null}
        </span>
      )}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-text">{title}</span>
        {sub ? <span className="mt-0.5 block text-xs leading-relaxed text-muted">{sub}</span> : null}
      </span>
    </label>
  );
}
