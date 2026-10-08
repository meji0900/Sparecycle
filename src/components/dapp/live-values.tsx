"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import CountUp from "@/components/reactbits/CountUp";
import DecryptedText from "@/components/reactbits/DecryptedText";
import { truncateMiddle } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A live integer from an API. Renders the first value as is; only a later change counts
 * from the old value to the new one (no count-up from zero on load, no fake motion).
 */
export function LiveCount({ value, className }: { value: number; className?: string }) {
  const [first] = useState(value);
  return (
    <span className={cn("num", className)}>
      <CountUp from={first} to={value} duration={0.6} separator="," trigger="load" />
    </span>
  );
}

/**
 * A Merkle root (or other 32-byte hash) that decrypts into place when its value changes.
 * Truncated, with the full value in the title, the copy button and the accessible name.
 */
export function RootHash({
  value,
  head = 10,
  tail = 8,
  className,
}: {
  value: string;
  head?: number;
  tail?: number;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const short = truncateMiddle(value, head, tail);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: the full value is in the title */
    }
  }
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 align-middle", className)}>
      <span className="num truncate text-text" title={value}>
        <DecryptedText
          key={value}
          text={short}
          animateOn="view"
          sequential
          revealDirection="start"
          speed={28}
          characters="0123456789abcdef"
          encryptedClassName="text-faint"
        />
      </span>
      <button
        type="button"
        onClick={copy}
        className="inline-grid size-6 shrink-0 place-items-center rounded-s text-faint transition-colors hover:text-text"
        aria-label={copied ? "Copied" : `Copy ${value}`}
      >
        {copied ? <Check className="size-3.5 text-signal" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}
