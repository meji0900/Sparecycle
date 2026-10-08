"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { explorerAddress } from "@/lib/chain";
import { config } from "@/lib/config";
import { truncateMiddle } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The official token contract address (CA): copy on click, explorer link on the address. Hidden until set. */
export function CaChip({ className, long = false }: { className?: string; long?: boolean }) {
  const [copied, setCopied] = useState(false);
  const ca = config.tokenAddress;
  if (!ca) return null;
  const href = explorerAddress(ca);
  async function copy() {
    try {
      await navigator.clipboard.writeText(ca!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: the full address is in the title */
    }
  }
  return (
    <span className={cn("inline-flex h-9 items-center gap-1.5 rounded-m border border-line pr-1 pl-2.5 text-sm", className)}>
      <span className="text-faint">CA</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="num text-text hover:underline" title={ca}>
          {long ? ca : truncateMiddle(ca, 6, 4)}
        </a>
      ) : (
        <span className="num text-text" title={ca}>
          {long ? ca : truncateMiddle(ca, 6, 4)}
        </span>
      )}
      <button
        type="button"
        onClick={copy}
        className="inline-grid size-7 place-items-center rounded-s text-faint transition-colors hover:text-text"
        aria-label={copied ? "Copied" : `Copy contract address ${ca}`}
      >
        {copied ? <Check className="size-3.5 text-signal" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}
