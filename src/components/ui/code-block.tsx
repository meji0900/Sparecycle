"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** Plain command block: 1px border, mono, a copy button. No fake terminal chrome. */
export function CodeBlock({ code, label, className }: { code: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked; the text stays selectable */
    }
  }
  return (
    <div className={cn("overflow-hidden rounded-m border border-line bg-graphite", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <span className="text-xs text-muted">{label ?? "Shell"}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-s px-1.5 py-1 text-xs text-muted transition-colors hover:text-text"
          aria-label={copied ? "Copied" : `Copy ${label ?? "command"}`}
        >
          {copied ? <Check className="size-3.5 text-signal" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 text-[13px] leading-relaxed text-text">
        <code className="num">{code}</code>
      </pre>
    </div>
  );
}
