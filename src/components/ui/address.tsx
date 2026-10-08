"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { explorerAddress, explorerTx } from "@/lib/chain";
import { truncateMiddle } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A truncated on-chain value (address, tx hash, Merkle root) with copy and optional explorer link.
 * The full value is in the title, the copy button and the accessible name (brief: full value available).
 */
export function Hex({
  value,
  kind = "address",
  head = 6,
  tail = 4,
  link = true,
  className,
}: {
  value: string;
  kind?: "address" | "tx" | "hash";
  head?: number;
  tail?: number;
  link?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const href = !link ? null : kind === "address" ? explorerAddress(value) : kind === "tx" ? explorerTx(value) : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: value is still selectable in the title */
    }
  }

  return (
    <span className={cn("inline-flex max-w-full items-center gap-1 align-middle", className)}>
      <span className="num truncate text-text" title={value}>
        {truncateMiddle(value, head, tail)}
      </span>
      <button
        type="button"
        onClick={copy}
        className="inline-grid size-6 shrink-0 place-items-center rounded-s text-faint transition-colors hover:text-text"
        aria-label={copied ? "Copied" : `Copy ${value}`}
      >
        {copied ? <Check className="size-3.5 text-signal" /> : <Copy className="size-3.5" />}
      </button>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-grid size-6 shrink-0 place-items-center rounded-s text-faint transition-colors hover:text-text"
          aria-label="Open in block explorer"
        >
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </span>
  );
}
