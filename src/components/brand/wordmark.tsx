import Link from "next/link";
import { cn } from "@/lib/utils";

/** Two nodes joined by a check: the network's unit of trust. The right node is "agreed". */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 14" aria-hidden className={cn("h-3.5 w-6", className)} fill="none">
      <rect x="0.5" y="2.5" width="9" height="9" rx="1.5" stroke="currentColor" />
      <rect x="14.5" y="2.5" width="9" height="9" rx="1.5" fill="var(--signal)" stroke="var(--signal)" />
      <path d="M9.5 7h5" stroke="currentColor" />
    </svg>
  );
}

export function Wordmark({ href = "/", className }: { href?: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cn("inline-flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.02em] text-text", className)}
      aria-label="Sparecycle home"
    >
      <Mark />
      Sparecycle
    </Link>
  );
}
