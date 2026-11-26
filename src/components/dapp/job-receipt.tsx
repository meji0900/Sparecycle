"use client";

// Job receipts in the browser (feature brief #8, option B): the receipt panel of a paid job (next to its invoice),
// a "Verify" check modelled on the payout proof checker (proof-checker.tsx), and a standalone checker for a saved
// receipt file. The check recomputes the leaf, folds the proof and reads the Charged event of the charge transaction
// through the chain's public RPC (or an RPC URL the viewer pastes): never the Sparecycle API or the site's relay.
import { Download, FileUp } from "lucide-react";
import { useId, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Hex } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { StatusTag, type Tone } from "@/components/ui/status";
import { downloadJson } from "@/lib/dapp/invoice";
import { checkReceipt, checkRpcUrl, defaultVerifyRpc, savedVerifyRpc, saveVerifyRpc, type ReceiptState } from "@/lib/dapp/receipt";
import { formatEth } from "@/lib/dapp/paid-jobs";
import type { CheckStatus, JobReceipt, ReceiptOutcome, ReceiptVerification } from "@/lib/job-receipt";
import { cn } from "@/lib/utils";
import { Row } from "./ui";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const VERDICT: Record<JobReceipt["verdict"], string> = {
  agreed: "Matched",
  disagreed: "Did not match",
  expired: "Expired, no verdict in time",
  rejected: "Rejected by the safety check",
};
const CHARGE: Record<JobReceipt["chargeStatus"], string> = {
  pending: "Not charged yet",
  charged: "Charged",
  released: "Not charged",
  unpaid: "Not charged (balance withdrawn before the charge)",
};

/** What a receipt's state means, in one or two sentences. */
function stateText(r: JobReceipt): { tone: Tone; label: string; text: ReactNode } {
  if (r.state === "sealed") {
    return {
      tone: "live",
      label: "Sealed",
      text: (
        <>
          This job&apos;s line is in the jobs root committed on-chain with the charge of epoch <span className="num">{r.epochId}</span>. Anyone can
          check it against that transaction.
        </>
      ),
    };
  }
  const e = r.pending?.epochId;
  switch (r.pending?.reason) {
    case "no-anchor":
      return {
        tone: "off",
        label: "No on-chain anchor",
        text: (
          <>
            No on-chain anchor for this epoch: epoch <span className="num">{e}</span> closed without charging any job, so there is no Charged event
            that holds this receipt. If a later epoch charges a job, this receipt goes into that epoch&apos;s jobs root and can then be checked.
          </>
        ),
      };
    case "charge-unconfirmed":
      return {
        tone: "neutral",
        label: "Provisional",
        text: (
          <>
            The charge of epoch <span className="num">{e}</span> has been sent and is not confirmed yet. The receipt is sealed once it is.
          </>
        ),
      };
    case "charged-before-receipts":
      return {
        tone: "neutral",
        label: "Charged before receipts",
        text: (
          <>
            Charged in epoch <span className="num">{e}</span>, before job receipts existed. That epoch&apos;s published charge list names this job and
            its hash is in the Charged event, but there is no jobs-root proof to check here.
          </>
        ),
      };
    default:
      return {
        tone: "neutral",
        label: "Provisional",
        text: (
          <>
            The results were compared. The receipt is sealed when an epoch close commits this job&apos;s line to a jobs root on-chain: at the end of
            the epoch, if that close charges any job.
          </>
        ),
      };
  }
}

const CHECK_TONE: Record<CheckStatus, Tone> = { pass: "live", fail: "error", skip: "off" };
const CHECK_WORD: Record<CheckStatus, string> = { pass: "OK", fail: "Fails", skip: "Not checked" };

const OUTCOME: Record<ReceiptOutcome, { tone: Tone; label: string }> = {
  verified: { tone: "live", label: "Verifies on-chain" },
  failed: { tone: "error", label: "Does not verify" },
  provisional: { tone: "neutral", label: "Nothing on-chain to check yet" },
  "no-anchor": { tone: "off", label: "No on-chain anchor for this epoch" },
  unreachable: { tone: "warn", label: "RPC not reachable" },
};

function outcomeText(v: ReceiptVerification, host: string): string {
  const r = v.receipt;
  switch (v.outcome) {
    case "verified":
      return `This receipt matches the Charged event of epoch ${r?.epochId} in transaction ${r?.chargeTx?.slice(0, 10)}…, read from ${host}.`;
    case "failed":
      return "At least one check failed: the receipt was changed, or it does not match the chain. Do not rely on it.";
    case "no-anchor":
      return "The epoch closed without a charge, so nothing on-chain holds this receipt yet. That is not a failed check. The node signatures were checked.";
    case "provisional":
      return r?.pending?.reason === "charged-before-receipts"
        ? "Charged before job receipts existed: there is no jobs-root proof. The node signatures were checked."
        : "The receipt is not sealed yet, so there is nothing on-chain to compare it with. The node signatures were checked. Save it again once it is sealed.";
    case "unreachable":
      return "";
  }
}

/** The plain statement of what this check covers and what it does not. */
export function ReceiptScopeNote({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-2 text-xs leading-relaxed text-muted", className)}>
      <p>
        <span className="text-text">Which root is checked.</span> The epoch&apos;s payout Merkle root covers node payouts, one leaf per node owner; jobs
        and payers are not in it. A job receipt is checked against a different root instead: the jobs root that the scheduler commits as{" "}
        <span className="num">listHash</span> in the payments contract&apos;s <span className="num">Charged</span> event of that epoch.
      </p>
      <p>
        <span className="text-text">What a pass shows.</span> This job&apos;s line (job id, wallet, price, verdict, charge status, output hash, with a
        random salt that only this receipt holds) is in the root committed on-chain with that charge. It does not show that the nodes computed the output correctly: the node signatures only show which
        node keys reported these results.
      </p>
    </div>
  );
}

/**
 * The Verify check of one receipt (an object from the API or the value read from a file). Reads the chain through the
 * public RPC, or another RPC URL the viewer pastes; never the Sparecycle API.
 */
export function ReceiptVerifier({ receipt, className }: { receipt: unknown; className?: string }) {
  const [rpc, setRpc] = useState(() => (typeof window === "undefined" ? defaultVerifyRpc() : (savedVerifyRpc() ?? defaultVerifyRpc())));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ v: ReceiptVerification; host: string } | null>(null);
  const host = hostOf(rpc);
  const fieldId = useId();

  async function run(url = rpc) {
    setBusy(true);
    try {
      const v = await checkReceipt(receipt, url);
      setResult({ v, host: hostOf(url) });
      if (v.outcome === "unreachable") setEditing(true);
    } finally {
      setBusy(false);
    }
  }

  function submitOther(e: FormEvent) {
    e.preventDefault();
    const why = checkRpcUrl(draft);
    setDraftError(why);
    if (why) return;
    const url = draft.trim();
    setRpc(url);
    saveVerifyRpc(url === defaultVerifyRpc() ? null : url);
    setEditing(false);
    void run(url);
  }

  function reset() {
    setRpc(defaultVerifyRpc());
    saveVerifyRpc(null);
    setEditing(false);
    setDraft("");
    setDraftError(null);
  }

  const v = result?.v ?? null;
  const outcome = v ? OUTCOME[v.outcome] : null;
  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => void run()} disabled={busy}>
          {busy ? "Checking…" : "Verify in this browser"}
        </Button>
        <span className="text-xs text-muted">
          Reads the chain through <span className="num text-text">{host}</span>, not through Sparecycle.{" "}
          <button type="button" className="link" onClick={() => setEditing((x) => !x)}>
            {editing ? "Keep this RPC" : "Use another RPC"}
          </button>
          {rpc !== defaultVerifyRpc() ? (
            <>
              {" · "}
              <button type="button" className="link" onClick={reset}>
                Back to the public RPC
              </button>
            </>
          ) : null}
        </span>
      </div>

      {v?.outcome === "unreachable" ? (
        <p role="alert" className="text-sm text-amber">
          Could not reach <span className="num">{result?.host}</span>. Some internet providers, including many in Indonesia, block this RPC by DNS. Paste
          another Robinhood Chain RPC URL you trust and check again. Sparecycle&apos;s own relay is not used for this check.
        </p>
      ) : null}

      {editing ? (
        <form onSubmit={submitOther} noValidate className="space-y-1.5">
          <label htmlFor={fieldId} className="text-xs text-muted">
            Another Robinhood Chain RPC URL, from any provider except Sparecycle (its chain id is checked first)
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={fieldId}
              type="url"
              inputMode="url"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://…"
              aria-invalid={!!draftError}
              aria-describedby={draftError ? `${fieldId}-error` : undefined}
              className="num h-8 min-w-0 flex-1 rounded-m border border-line-strong bg-slate px-3 text-xs text-text placeholder:text-faint"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={!draft.trim() || busy}>
              Check with this RPC
            </Button>
          </div>
          {draftError ? (
            <p id={`${fieldId}-error`} className="text-xs text-rust">
              {draftError}
            </p>
          ) : null}
        </form>
      ) : null}

      {v && outcome ? (
        <div aria-live="polite" className="space-y-3">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <StatusTag tone={outcome.tone}>{outcome.label}</StatusTag>
            {v.outcome !== "unreachable" ? <span className="text-muted">{outcomeText(v, result!.host)}</span> : null}
          </p>
          <dl className="divide-y divide-line rounded-m border border-line">
            {v.checks.map((c) => (
              <div key={c.id} className="flex flex-col gap-1 px-4 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <dt className="shrink-0 text-sm text-muted">{c.label}</dt>
                <dd className="flex min-w-0 flex-wrap items-baseline gap-2 text-xs text-muted sm:justify-end sm:text-right">
                  <span className="min-w-0 break-words">{c.detail}</span>
                  <StatusTag tone={CHECK_TONE[c.status]}>{CHECK_WORD[c.status]}</StatusTag>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

/** The receipt panel of a paid or team job, under its invoice. `state` comes from useJobReceipt. */
export function JobReceiptPanel({ state, className }: { state: ReceiptState; className?: string }) {
  // Free jobs have no receipt; sign-in prompts come from the invoice panel above.
  if (state.state === "free" || state.state === "signin" || state.state === "forbidden") return null;
  const r = state.state === "ready" ? state.receipt : null;
  const s = r ? stateText(r) : null;
  return (
    <section aria-label="Receipt" className={cn("min-w-0 rounded-m border border-line", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3">
        <h3 className="text-sm font-medium text-text">Receipt</h3>
        {s ? <StatusTag tone={s.tone}>{s.label}</StatusTag> : null}
      </div>
      {r && s ? (
        <>
          <p className="px-5 pt-4 text-sm leading-relaxed text-muted">{s.text}</p>
          <dl className="mt-2 divide-y divide-line">
            <Row label="Results">{VERDICT[r.verdict]}</Row>
            <Row label="Charge">
              {CHARGE[r.chargeStatus]}
              {r.chargeStatus === "charged" ? (
                <>
                  {" "}
                  · <span className="num">{formatEth(r.priceWei)}</span> ETH
                </>
              ) : null}
            </Row>
            <Row label="Node signatures">
              {r.nodes.length ? (
                <span className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                  {r.nodes.map((n, i) => (
                    <Hex key={i} value={n.node} kind="address" link={false} />
                  ))}
                </span>
              ) : (
                <span className="text-muted">None (no node answered in time)</span>
              )}
            </Row>
            {r.anchor ? (
              <>
                <Row label="Jobs root (listHash)">
                  <Hex value={r.anchor.listHash} kind="hash" head={10} tail={8} link={false} />
                </Row>
                <Row label="Charge transaction">
                  <Hex value={r.chargeTx!} kind="tx" />
                </Row>
              </>
            ) : null}
          </dl>
          <div className="space-y-4 border-t border-line px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="secondary" onClick={() => downloadJson(`sparecycle-receipt-${r.jobId.slice(2, 10)}.json`, r)}>
                <Download className="size-4" strokeWidth={1.75} aria-hidden />
                Save receipt (JSON)
              </Button>
              <span className="text-xs text-muted">
                {r.state === "sealed"
                  ? "The file can be checked later on the Jobs page, even when the Sparecycle API is unreachable. Keep it private: its salt links your wallet to this job's public leaf."
                  : "Save it again once it is sealed: a provisional receipt has no proof yet."}
              </span>
            </div>
            <ReceiptVerifier receipt={r} />
            <ReceiptScopeNote />
          </div>
        </>
      ) : (
        <p className="px-5 py-4 text-sm text-muted">
          {state.state === "loading"
            ? "Loading the receipt…"
            : state.state === "no-verdict"
              ? "The receipt appears as soon as the two results are compared."
              : state.state === "missing"
                ? "This scheduler has no receipt for this job."
                : "Could not load the receipt."}
        </p>
      )}
    </section>
  );
}

/**
 * Check a saved receipt file (or pasted JSON) in this browser. Nothing is sent to Sparecycle: the only network call
 * is to the RPC shown.
 */
export function ReceiptChecker({ className }: { className?: string }) {
  const [text, setText] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<{ value: unknown; key: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load(raw: string, from: string | null) {
    setText(raw);
    setName(from);
    try {
      setParsed({ value: JSON.parse(raw), key: Date.now() });
      setError(null);
    } catch {
      setParsed(null);
      setError(raw.trim() ? "That is not valid JSON." : null);
    }
  }

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 256_000) {
      setError("That file is too large to be a receipt.");
      return;
    }
    try {
      load(await file.text(), file.name);
    } catch {
      setError("This browser could not read the file.");
    }
  }

  return (
    <details id="check-receipt" className={cn("group rounded-l border border-line", className)}>
      <summary className="flex cursor-pointer items-start justify-between gap-4 px-5 py-4">
        <span>
          <span className="block font-medium text-text">Check a job receipt</span>
          <span className="mt-1 block text-sm text-muted">
            Load a saved receipt file. This page checks it against the chain in your browser, without the Sparecycle API.
          </span>
        </span>
        <span aria-hidden className="mt-0.5 text-lg leading-none text-faint transition-transform duration-150 group-open:rotate-45">
          +
        </span>
      </summary>
      <div className="space-y-4 border-t border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <label
            htmlFor="receipt-file"
            className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-m border border-line-strong px-3 text-sm font-medium text-text transition-colors hover:border-[rgba(255,255,255,0.32)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal"
          >
            <FileUp className="size-4" strokeWidth={1.75} aria-hidden />
            Load a receipt file
            <input id="receipt-file" type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void pick(e)} />
          </label>
          {name ? <span className="num text-xs text-muted">{name}</span> : <span className="text-xs text-faint">or paste it below</span>}
        </div>
        <div>
          <label htmlFor="receipt-json" className="text-sm text-muted">
            Receipt JSON (the answer of <span className="num text-text">/api/v1/jobs/:id/receipt</span>, or a saved file)
          </label>
          <textarea
            id="receipt-json"
            value={text}
            onChange={(e) => load(e.target.value, null)}
            rows={6}
            spellCheck={false}
            placeholder='{ "format": "sparecycle-job-receipt", "version": 1, … }'
            aria-invalid={!!error}
            aria-describedby={error ? "receipt-json-error" : undefined}
            className="num mt-1.5 block w-full resize-y rounded-m border border-line-strong bg-slate px-3 py-2.5 text-xs leading-relaxed text-text placeholder:text-faint"
          />
          {error ? (
            <p id="receipt-json-error" className="mt-1.5 text-xs text-rust">
              {error}
            </p>
          ) : null}
        </div>
        {parsed ? <ReceiptVerifier key={parsed.key} receipt={parsed.value} /> : null}
        <ReceiptScopeNote />
      </div>
    </details>
  );
}
