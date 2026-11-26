"use client";

import { Download, FileCheck } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";
import { Hex } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status";
import type { PaidInvoice } from "@/lib/dapp/api";
import { downloadJson, sameHash, sha256OfFile, type InvoiceState } from "@/lib/dapp/invoice";
import { chargeWords } from "@/lib/dapp/paid-jobs";
import { formatTime } from "@/lib/format";
import { recheckLabel } from "@/lib/rounds";
import { cn } from "@/lib/utils";
import { Eth } from "./job-balance";
import { SignInToView } from "./private-output";
import { Row } from "./ui";

const VERDICT: Record<NonNullable<PaidInvoice["verdict"]>, string> = {
  agreed: "Matched",
  disagreed: "Did not match",
  expired: "Expired, no verdict in time",
  rejected: "Rejected by the safety check",
};

/** The Results row: the verdict, or that another pair is checking the job again, and on which pair it ended. */
function resultsText(inv: PaidInvoice): string | null {
  const round = inv.round ?? 0;
  if (!inv.verdict) return recheckLabel(round, inv.maxRounds);
  if (round === 0) return VERDICT[inv.verdict];
  if (inv.verdict === "agreed") return `Matched on pair ${round + 1} (an earlier pair did not match or did not finish)`;
  if (inv.verdict === "disagreed") return `Did not match on any of ${round + 1} pairs`;
  return `${VERDICT[inv.verdict]} (pair ${round + 1})`;
}

/** A label with a one-line explanation under it (left column of a Row). */
function Label({ children, hint }: { children: ReactNode; hint: ReactNode }) {
  return (
    <>
      {children}
      <span className="mt-0.5 block max-w-[260px] text-xs leading-snug text-faint">{hint}</span>
    </>
  );
}

/**
 * "Check this hash": the payer drops (or picks) the output file they downloaded; its sha256 is computed in this browser
 * and compared with the invoice's output hash. The file is never uploaded.
 */
function HashCheck({ expected, jobId }: { expected: string; jobId: string }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ name: string; hash: string } | "error" | null>(null);
  const inputId = `hash-check-${jobId.slice(2, 12)}`;

  async function check(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      setResult({ name: file.name, hash: await sha256OfFile(file) });
    } catch {
      setResult("error");
    } finally {
      setBusy(false);
    }
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    void check(e.dataTransfer.files[0]);
  }

  const match = result && result !== "error" ? sameHash(result.hash, expected) : null;
  return (
    <div className="space-y-2">
      <p className="text-sm text-text">Check this hash</p>
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cn(
          "flex cursor-pointer flex-col items-center gap-1.5 rounded-m border border-dashed px-4 py-4 text-center text-xs leading-relaxed text-muted transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-signal",
          over ? "border-signal/60 bg-signal-soft" : "border-line-strong hover:border-[rgba(255,255,255,0.32)]",
        )}
      >
        <FileCheck className="size-4 text-faint" strokeWidth={1.75} aria-hidden />
        <span className="text-sm text-text">{busy ? "Computing…" : "Drop the downloaded output file here, or choose it"}</span>
        <span>Its sha256 is computed in this browser and compared with the output hash above. The file is not uploaded.</span>
        <input id={inputId} type="file" className="sr-only" onChange={(e) => void check(e.target.files?.[0])} />
      </label>
      <div aria-live="polite">
        {result === "error" ? (
          <p className="text-xs text-rust">This browser could not read the file or compute its hash.</p>
        ) : result ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <StatusTag tone={match ? "live" : "warn"}>{match ? "Matches" : "Does not match"}</StatusTag>
            <span className="min-w-0 break-all">
              <span className="text-faint">{result.name}:</span> <span className="num">{result.hash}</span>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The invoice of a paid or team job: every figure the payer needs, the output's fingerprint, and the tx links. */
function InvoiceBody({ inv }: { inv: PaidInvoice }) {
  const words = chargeWords(inv);
  const notCharged = inv.chargeStatus === "released" || inv.chargeStatus === "unpaid";
  const cutHint = (
    <>
      {inv.protocolCutBps / 100}% of the price, rounded. Charged per epoch batch: the contract takes it from the epoch&apos;s charged total, only for matched
      jobs.
    </>
  );
  return (
    <>
      <dl className="divide-y divide-line">
        <Row label="Price">
          <Eth wei={inv.priceWei} className="font-medium" />
        </Row>
        <Row label={<Label hint={cutHint}>Protocol cut</Label>}>{notCharged ? <span className="text-muted">None, not charged</span> : <Eth wei={inv.protocolCutWei} />}</Row>
        <Row
          label={
            <Label hint="The rest goes to the open epoch's node pot, shared by work units across all matched jobs of that epoch.">To the node pot</Label>
          }
        >
          {notCharged ? <span className="text-muted">None, not charged</span> : <Eth wei={inv.toPotWei} />}
        </Row>
        <Row label="Results">{resultsText(inv) ?? <span className="text-muted">Not compared yet</span>}</Row>
        <Row label="Charge">
          <span className="inline-block max-w-[320px] text-right">{words.text}</span>
        </Row>
        <Row label={<Label hint="The epoch open when the results were compared.">Epoch</Label>}>
          {inv.epochId !== null ? (
            <span className="inline-flex flex-wrap items-center justify-end gap-2">
              <span className="num">{inv.epochId}</span>
              {inv.links.epochRootTx ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted">
                  root <Hex value={inv.links.epochRootTx.hash} kind="tx" />
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted">Not yet</span>
          )}
        </Row>
        {inv.chargedEpoch !== null ? (
          <Row label="Charged in epoch">
            <span className="inline-flex flex-wrap items-center justify-end gap-2">
              <span className="num">{inv.chargedEpoch}</span>
              {inv.links.chargeTx ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted">
                  charge <Hex value={inv.links.chargeTx.hash} kind="tx" />
                </span>
              ) : null}
            </span>
          </Row>
        ) : null}
        <Row label={<Label hint="sha256 of the output file, not the file itself.">Output hash</Label>}>
          {inv.outputHash ? <Hex value={inv.outputHash} kind="hash" head={10} tail={8} link={false} /> : <span className="text-muted">None (no agreed output)</span>}
        </Row>
        <Row label="Submitted">
          <span className="num text-muted">{formatTime(inv.createdAt)}</span>
        </Row>
      </dl>
      <div className="space-y-4 border-t border-line px-5 py-4">
        <Button type="button" size="sm" variant="secondary" onClick={() => downloadJson(`sparecycle-invoice-${inv.jobId.slice(2, 10)}.json`, inv)}>
          <Download className="size-4" strokeWidth={1.75} aria-hidden />
          Download JSON
        </Button>
        {inv.outputHash ? <HashCheck expected={inv.outputHash} jobId={inv.jobId} /> : null}
        <p className="text-xs leading-relaxed text-muted">
          Private: only the wallet that paid, or a browser holding this job&apos;s key, can open this invoice. The charge itself is public
          on-chain: the payments contract records your wallet and the amount charged in each epoch.
        </p>
      </div>
    </>
  );
}

/**
 * The invoice panel of a paid or team job (feature brief #4). `state` comes from useJobInvoice. A free job's stub
 * renders nothing: the job is already marked "Free trial", with no charge.
 */
export function JobInvoicePanel({ state, className }: { state: InvoiceState; className?: string }) {
  if (state.state === "ready" && !state.invoice.invoice) return null;
  const inv = state.state === "ready" && state.invoice.invoice ? state.invoice : null;
  const words = inv ? chargeWords(inv) : null;
  return (
    <section aria-label="Invoice" className={cn("min-w-0 rounded-m border border-line", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3">
        <h3 className="text-sm font-medium text-text">Invoice</h3>
        {words ? <StatusTag tone={words.tone}>{words.label}</StatusTag> : null}
      </div>
      {inv ? (
        <InvoiceBody inv={inv} />
      ) : state.state === "signin" || state.state === "forbidden" ? (
        <div className="space-y-3 px-5 py-4 text-sm text-muted">
          <p>
            {state.state === "signin"
              ? "Sign in with the wallet that paid for this job to see its invoice. No transaction and no gas."
              : "The signed-in wallet did not pay for this job. Connect the wallet that paid and sign in again."}
          </p>
          <SignInToView />
        </div>
      ) : (
        <p className="px-5 py-4 text-sm text-muted">
          {state.state === "loading" ? "Loading the invoice…" : state.state === "missing" ? "This scheduler has no invoice for this job." : "Could not load the invoice."}
        </p>
      )}
    </section>
  );
}
