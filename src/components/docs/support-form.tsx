"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/status";
import { cn } from "@/lib/utils";

type Topic = { id: string; label: string };
type State = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; text: string };

const field = "mt-1.5 w-full rounded-m border border-line-strong bg-slate px-3 text-sm text-text placeholder:text-faint disabled:opacity-60";

/**
 * The support form. Disabled (every control, with a plain note above it) until the server has SUPPORT_WEBHOOK_URL.
 * Posts JSON to /api/support; shows only "sent" or the error code's meaning, never the message back.
 */
export function SupportForm({ enabled, topics, maxChars }: { enabled: boolean; topics: readonly Topic[]; maxChars: number }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [message, setMessage] = useState("");
  const off = !enabled || state.kind === "sending";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!enabled) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    setState({ kind: "sending" });
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          topic: f.get("topic"),
          wallet: f.get("wallet"),
          jobId: f.get("jobId"),
          message: f.get("message"),
          website: f.get("website"),
        }),
      });
      if (res.ok) {
        setState({ kind: "sent" });
        setMessage("");
        form.reset();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      const text =
        body.error === "rate-limited"
          ? "Too many messages from this address in the last hour. Try again later."
          : body.error === "support-off"
            ? "The support form is not switched on yet."
            : body.error === "support-unavailable"
              ? "The message could not be delivered and was not kept. Try again later."
              : (body.message ?? "The message was not sent.");
      setState({ kind: "error", text });
    } catch {
      setState({ kind: "error", text: "The site could not be reached. Nothing was sent." });
    }
  }

  return (
    <form onSubmit={onSubmit} className="relative space-y-4 rounded-l border border-line p-5" aria-describedby={!enabled ? "support-off" : undefined}>
      {!enabled ? (
        <p id="support-off" className="rounded-m border border-line bg-graphite px-4 py-3 text-sm text-muted">
          <span className="font-medium text-text">This form is not switched on yet.</span> Nothing you type here can be sent.
          It goes live once the channel that receives messages is set up; until then, use the options below.
        </p>
      ) : null}
      <fieldset disabled={off} className="space-y-4">
        <div>
          <label htmlFor="support-topic" className="text-sm text-muted">
            Topic
          </label>
          <select id="support-topic" name="topic" required defaultValue="" className={cn(field, "h-10")}>
            <option value="" disabled>
              Choose one
            </option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor="support-wallet" className="text-sm text-muted">
              Wallet <span className="text-faint">(optional)</span>
            </label>
            <input id="support-wallet" name="wallet" placeholder="0x…" spellCheck={false} autoComplete="off" className={cn(field, "num h-10")} />
          </div>
          <div className="min-w-0">
            <label htmlFor="support-job" className="text-sm text-muted">
              Job id <span className="text-faint">(optional)</span>
            </label>
            <input id="support-job" name="jobId" placeholder="0x…" spellCheck={false} autoComplete="off" className={cn(field, "num h-10")} />
          </div>
        </div>
        <div>
          <label htmlFor="support-message" className="text-sm text-muted">
            Message
          </label>
          <textarea
            id="support-message"
            name="message"
            required
            minLength={10}
            maxLength={maxChars}
            rows={6}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className={cn(field, "py-2 leading-relaxed")}
          />
          <p className="mt-1 text-xs text-faint">
            <span className="num">{message.length}</span> / <span className="num">{maxChars}</span>. Never include a private
            key or a seed phrase: nobody from the project will ask for one.
          </p>
        </div>
        {/* Not for people: bots that fill every field fill this one too. */}
        <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label htmlFor="support-website">Website</label>
          <input id="support-website" name="website" tabIndex={-1} autoComplete="off" />
        </div>
        <Button type="submit" disabled={off}>
          {state.kind === "sending" ? "Sending…" : "Send"}
        </Button>
      </fieldset>
      <div aria-live="polite">
        {state.kind === "sent" ? (
          <Notice tone="live" title="Sent">
            Your message was forwarded. This site kept no copy of it.
          </Notice>
        ) : state.kind === "error" ? (
          <Notice tone="error" title="Not sent">
            {state.text}
          </Notice>
        ) : null}
      </div>
    </form>
  );
}
