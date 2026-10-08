"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** A command with a copy button. Mono, 1px border, no fake terminal chrome. */
export function CodeBlock({ code, label, className }: { code: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  }
  return (
    <div className={cn("min-w-0 overflow-hidden rounded-m border border-line bg-graphite", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line py-1 pr-1 pl-3.5">
        <span className="truncate text-xs text-faint">{label ?? "Command"}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-s px-2 text-xs text-muted transition-colors hover:bg-white/[0.04] hover:text-text"
          aria-label={copied ? "Copied" : `Copy: ${code}`}
        >
          {copied ? <Check className="size-3.5 text-signal" /> : <Copy className="size-3.5" />}
          <span aria-hidden>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="num overflow-x-auto px-3.5 py-3 text-[13px] leading-relaxed whitespace-pre text-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}
