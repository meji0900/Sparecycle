"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { Address } from "viem";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { Hex } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag } from "@/components/ui/status";
import { jobPaymentsAbi } from "@/contracts/jobPayments";
import { targetChain } from "@/lib/chain";
import { config } from "@/lib/config";
import { apiDown, type ApiFailure, type PaymentAccount, type StatusResponse } from "@/lib/dapp/api";
import { explainPaymentTxError, formatEth, parseEthInput, WITHDRAW_TIMEOUT_SECONDS } from "@/lib/dapp/paid-jobs";
import { durationLabel } from "@/lib/dapp/duration";
import { useApiGet } from "@/lib/dapp/use-api";
import { useWallet } from "@/lib/dapp/use-wallet";
import { formatTime } from "@/lib/format";
import { BILLING } from "@/lib/funding-copy";
import { isLowBalance, LOW_CREDIT_JOBS } from "@/lib/job-payment";
import { cn } from "@/lib/utils";
import { Dash, Row, Skeleton } from "./ui";
import { WalletButton } from "./wallet-button";

type JobAccount = {
  mounted: boolean;
  address: Address | undefined;
  isConnected: boolean;
  wrongNetwork: boolean;
  chainId: number | undefined;
  account: PaymentAccount | null;
  failure: ApiFailure | null;
  loading: boolean;
  reload: () => void;
};

const AccountContext = createContext<JobAccount | null>(null);

/**
 * The connected wallet's balance in the payments contract, shared by the balance panel and the job form.
 * Rendered only when paid jobs are on (config.jobPayments); without it `useJobAccount()` is null.
 */
export function JobAccountProvider({ children }: { children: ReactNode }) {
  const { mounted, address, chainId, isConnected } = useWallet();
  const q = useApiGet<PaymentAccount>(address ? `/payments/account?address=${address}` : null, 30_000);
  const value: JobAccount = {
    mounted,
    address,
    isConnected,
    chainId,
    wrongNetwork: isConnected && chainId !== targetChain.id,
    account: q.result?.ok ? q.result.data : null,
    failure: q.result && !q.result.ok ? q.result.failure : null,
    loading: q.loading,
    reload: q.reload,
  };
  return <AccountContext value={value}>{children}</AccountContext>;
}

/** Null when paid jobs are off on this deployment. */
export const useJobAccount = () => useContext(AccountContext);

/** "0.0012 ETH" with the number in the tabular face. */
export function Eth({ wei, className }: { wei: bigint | string; className?: string }) {
  return (
    <span className={className}>
      <span className="num">{formatEth(wei)}</span> <span className="text-muted">ETH</span>
    </span>
  );
}

/** Why the account could not be read, in words. */
export function accountFailureText(f: ApiFailure): { title: string; body: string } {
  if (f.kind === "http" && f.code === "payments-off") return { title: "Paid jobs are off on this scheduler", body: "Use the free trial instead." };
  if (f.kind === "http" && f.status === 500) {
    return { title: "Could not read your balance", body: "The scheduler could not read the payments contract on-chain. It retries every 30 seconds." };
  }
  if (apiDown(f)) return { title: "Scheduler API not reachable", body: "Your balance is safe in the contract; it just can't be shown right now." };
  return { title: "Could not read your balance", body: `${f.kind === "http" ? `${f.status} ${f.code ?? ""} ${f.message ?? ""}`.trim() : f.message}` };
}

type Action = "deposit" | "request" | "cancel" | "withdraw" | "limit" | "clear-limit";

const DONE: Record<Action, string> = {
  deposit: "Deposit confirmed",
  request: "Withdrawal started",
  cancel: "Withdrawal request cancelled",
  withdraw: "Withdrawal completed: sent to your wallet",
  limit: "Spend limit set",
  "clear-limit": "Spend limit removed",
};

const input =
  "num h-10 w-full min-w-0 rounded-m border border-line-strong bg-slate pr-12 pl-3 text-sm text-text placeholder:text-faint aria-[invalid=true]:border-rust/60";

/** ETH amount field with its own label, error line and submit button. */
function AmountForm({
  id,
  label,
  hint,
  button,
  disabled,
  onSubmit,
  check,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  button: string;
  disabled: boolean;
  onSubmit: (wei: bigint) => void;
  /** Extra check on a parsed amount; a returned string is shown as the error. */
  check?: (wei: bigint) => string | null;
  children?: ReactNode;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const wei = parseEthInput(value);
    if (wei === null) {
      setError("Enter an amount in ETH above zero, for example 0.002.");
      return;
    }
    const problem = check?.(wei) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    onSubmit(wei);
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-1.5">
      <label htmlFor={id} className="block text-sm text-text">
        {label}
      </label>
      {hint ? <p className="text-xs leading-relaxed text-muted">{hint}</p> : null}
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-err` : undefined}
            className={input}
          />
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-faint">
            ETH
          </span>
        </div>
        <Button type="submit" variant="secondary" disabled={disabled}>
          {button}
        </Button>
      </div>
      {error ? (
        <p id={`${id}-err`} className="text-xs text-rust">
          {error}
        </p>
      ) : null}
      {children}
    </form>
  );
}

/**
 * When a withdrawal request can be completed, as a range, never a promise. The contract allows it once its epoch
 * reaches request epoch + 2 (the request's epoch and the next one have closed) or WITHDRAW_TIMEOUT after the request,
 * whichever is first. `earliest`: the scheduled end of epoch + 1 on the on-chain epoch clock (epochs close a little
 * after their end, when the scheduler posts the root); null when unknown or not before the timeout. `latest`: the
 * contract's timeout, a hard bound. `overdue`: the clock is past epoch + 1's end but the contract has not closed it.
 */
function unlockWindow(w: NonNullable<PaymentAccount["withdrawal"]>, status: StatusResponse | null) {
  const latest = w.requestedAt + WITHDRAW_TIMEOUT_SECONDS;
  const e = status?.epoch;
  if (!e || e.clock === "scheduler-local") return { earliest: null, latest, overdue: false };
  const toGo = w.epoch + 2 - e.id;
  if (toGo <= 0) return { earliest: null, latest, overdue: true };
  const byEpoch = e.endsAt + (toGo - 1) * e.length;
  return { earliest: byEpoch < latest ? byEpoch : null, latest, overdue: false };
}

/** A balance figure's label with its one-line explanation. */
function Figure({ children, hint }: { children: ReactNode; hint: ReactNode }) {
  return (
    <>
      {children}
      <span className="mt-0.5 block max-w-[220px] text-xs leading-snug text-faint">{hint}</span>
    </>
  );
}

/** "Your balance": the customer's prepaid ETH in the payments contract and every action on it. */
export function JobBalance() {
  const acct = useJobAccount();
  const contract = config.jobPayments;
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data, chainId: targetChain.id, query: { enabled: !!write.data } });
  const [sent, setSent] = useState<{ hash: string; action: Action } | null>(null);
  const [lastAction, setLastAction] = useState<Action | null>(null);
  const withdrawal = acct?.account?.withdrawal ?? null;
  // Epoch clock for the unlock estimate and the epoch length in the copy.
  const statusQ = useApiGet<StatusResponse>(acct?.isConnected ? "/status" : null, 60_000);
  const status = statusQ.result?.ok ? statusQ.result.data : null;
  const epochLength = status?.epoch?.length ?? config.epochLength;
  const epochs = epochLength ? ` (epochs last ${durationLabel(epochLength)})` : "";

  const reload = acct?.reload;
  const confirmed = receipt.isSuccess && receipt.data?.status === "success";
  useEffect(() => {
    if (!confirmed || !reload) return;
    // Read again now and once more a few seconds later, in case the scheduler's RPC is a block behind.
    reload();
    const t = setTimeout(reload, 4_000);
    return () => clearTimeout(t);
  }, [confirmed, reload, receipt.data?.transactionHash]);

  if (!acct || !contract) return null;
  const { account, address, isConnected, wrongNetwork, failure, loading, mounted } = acct;

  const busy = write.isPending || (!!write.data && receipt.isLoading);
  const canAct = isConnected && !wrongNetwork && !busy;
  const txError = write.error ?? receipt.error ?? (receipt.data?.status === "reverted" ? new Error("The transaction reverted. Nothing changed.") : null);
  const done = confirmed && sent && sent.hash === write.data ? sent.action : null;

  function send(action: Action, call: { functionName: "deposit"; value: bigint } | { functionName: "requestWithdraw" | "setSpendLimit"; args: [bigint] } | { functionName: "cancelWithdraw" | "withdraw" }) {
    if (!contract) return;
    setLastAction(action);
    write.reset();
    write.writeContract(
      { address: contract, abi: jobPaymentsAbi, chainId: targetChain.id, ...call } as Parameters<typeof write.writeContract>[0],
      { onSuccess: (hash) => setSent({ hash, action }) },
    );
  }

  const limit = account ? BigInt(account.spendLimitPerEpoch) : null;
  const available = account ? BigInt(account.available) : null;
  const unlock = withdrawal && !withdrawal.ready ? unlockWindow(withdrawal, status) : null;

  const tag = !mounted ? null : !isConnected ? (
    <StatusTag tone="off">Disconnected</StatusTag>
  ) : wrongNetwork ? (
    <StatusTag tone="warn">Wrong network</StatusTag>
  ) : failure ? (
    <StatusTag tone="error">Not read</StatusTag>
  ) : account ? (
    <StatusTag tone="live">Connected</StatusTag>
  ) : (
    <StatusTag tone="neutral">Reading</StatusTag>
  );

  const value = (v: string | null | undefined, why?: string) =>
    v !== null && v !== undefined ? <Eth wei={v} /> : loading && !failure ? <Skeleton /> : <Dash why={why} />;

  return (
    <section aria-labelledby="balance-title" id="balance" className="min-w-0 scroll-mt-24 rounded-l border border-line bg-coal">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
        <h2 id="balance-title" className="font-medium text-text">
          Your balance
        </h2>
        {tag}
      </div>

      {!mounted ? (
        <div className="px-5 py-4">
          <Skeleton className="w-40" />
        </div>
      ) : !isConnected ? (
        <div className="space-y-4 px-5 py-4">
          <p className="text-sm leading-relaxed text-muted">
            Connect the wallet you pay from to see your balance, deposit ETH and pay for jobs. Free trial jobs need no wallet.
          </p>
          <WalletButton className="h-10 px-4" />
        </div>
      ) : (
        <>
          <dl className="divide-y divide-line border-b border-line">
            <Row label="Wallet">{address ? <Hex value={address} /> : <Dash />}</Row>
            <Row label={<Figure hint="All the ETH you hold in the payments contract. Only your wallet can withdraw it.">Balance</Figure>}>
              {value(account?.balance, failure ? "Not read" : undefined)}
            </Row>
            <Row label={<Figure hint="Prices of your jobs not charged yet: still running, or matched and waiting for the epoch close.">Held for running jobs</Figure>}>
              {value(account?.held, failure ? "Not read" : undefined)}
            </Row>
            <Row label={<Figure hint="Asked to withdraw; it can no longer pay for new jobs.">Withdrawal pending</Figure>}>
              {!account ? (
                value(null, failure ? "Not read" : undefined)
              ) : withdrawal ? (
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  <Eth wei={withdrawal.amount} />
                  <StatusTag tone={withdrawal.ready ? "live" : "neutral"}>{withdrawal.ready ? "Ready" : "Locked"}</StatusTag>
                </span>
              ) : (
                <span className="text-muted">None</span>
              )}
            </Row>
            <Row label={<Figure hint="Balance minus what is held and what is pending withdrawal: what new jobs can use.">Available</Figure>}>
              {account ? <Eth wei={account.available} className="font-medium" /> : value(null, failure ? "Not read" : undefined)}
            </Row>
            <Row label="Spend limit per epoch">
              {limit === null ? value(null, failure ? "Not read" : undefined) : limit === 0n ? <span className="text-muted">No limit</span> : <Eth wei={limit} />}
            </Row>
          </dl>

          <div className="space-y-5 px-5 py-4">
            {wrongNetwork ? (
              <div className="space-y-3">
                <Notice tone="warn" title="Wrong network">
                  Your wallet is on chain id <span className="num">{acct.chainId}</span>. Deposits and withdrawals work only on {targetChain.name} (chain id{" "}
                  <span className="num">{targetChain.id}</span>).
                </Notice>
                <WalletButton className="h-10 px-4" />
              </div>
            ) : null}

            {failure ? (
              <Notice
                tone="error"
                title={accountFailureText(failure).title}
                action={
                  <Button size="sm" variant="secondary" onClick={acct.reload}>
                    Retry
                  </Button>
                }
              >
                {accountFailureText(failure).body}
              </Notice>
            ) : null}

            <AmountForm
              id="deposit-amount"
              label="Deposit"
              hint="Sends ETH from your wallet into your balance. You pay the gas."
              button="Deposit"
              disabled={!canAct}
              onSubmit={(wei) => send("deposit", { functionName: "deposit", value: wei })}
            />

            <div className="space-y-2">
              <p className="text-sm text-text">Withdraw</p>
              {withdrawal ? (
                <>
                  <p className="text-xs leading-relaxed text-muted">
                    {withdrawal.ready ? (
                      <>
                        The lock is over. Complete the withdrawal to send up to <Eth wei={withdrawal.amount} /> to your wallet.
                      </>
                    ) : (
                      <>
                        Started in epoch <span className="num">{withdrawal.epoch}</span>. Ready after epoch <span className="num">{withdrawal.epoch + 1}</span>{" "}
                        closes (the contract&apos;s epoch reaches <span className="num">{withdrawal.epoch + 2}</span>) or by{" "}
                        <span className="num">{formatTime(withdrawal.requestedAt + WITHDRAW_TIMEOUT_SECONDS)}</span> (2 days after the request),
                        whichever is first{epochs}.
                      </>
                    )}
                  </p>
                  {unlock ? (
                    <p className="text-xs leading-relaxed text-muted">
                      {unlock.earliest !== null ? (
                        <>
                          Expected between about <span className="num text-text">{formatTime(unlock.earliest)}</span>, if that epoch closes on
                          schedule, and <span className="num text-text">{formatTime(unlock.latest)}</span> at the latest.
                        </>
                      ) : unlock.overdue ? (
                        <>
                          Waiting for epoch <span className="num">{withdrawal.epoch + 1}</span> to close on-chain; by{" "}
                          <span className="num text-text">{formatTime(unlock.latest)}</span> at the latest.
                        </>
                      ) : (
                        <>
                          Expected by <span className="num text-text">{formatTime(unlock.latest)}</span> at the latest.
                        </>
                      )}
                    </p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" disabled={!canAct || !withdrawal.ready} onClick={() => send("withdraw", { functionName: "withdraw" })}>
                      Complete withdrawal
                    </Button>
                    <Button variant="quiet" disabled={!canAct} onClick={() => send("cancel", { functionName: "cancelWithdraw" })}>
                      Cancel request
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs leading-relaxed text-muted">
                    Start a withdrawal any time; complete it after the lock: once the current epoch and the next one have closed{epochs}, or
                    2 days after the request at the latest. The amount stops being spendable on new jobs at once. Prices held for running
                    jobs stay held until those jobs settle.
                  </p>
                  <Button
                    variant="secondary"
                    disabled={!canAct || available === null || available === 0n}
                    onClick={() => {
                      if (available !== null && available > 0n) send("request", { functionName: "requestWithdraw", args: [available] });
                    }}
                  >
                    {available !== null && available > 0n ? (
                      <>
                        Withdraw <Eth wei={available} />
                      </>
                    ) : (
                      "Withdraw"
                    )}
                  </Button>
                  {available === 0n ? (
                    <p className="text-xs text-muted">
                      Nothing is available to withdraw right now{account && BigInt(account.held) > 0n ? ": the rest is held for running jobs" : ""}.
                    </p>
                  ) : null}
                  <details className="pt-1">
                    <summary className="cursor-pointer text-xs text-muted hover:text-text">Withdraw a different amount</summary>
                    <div className="pt-3">
                      <AmountForm
                        id="withdraw-amount"
                        label="Amount to withdraw"
                        button="Start"
                        disabled={!canAct || !account}
                        check={(wei) =>
                          available !== null && wei > available
                            ? `That is more than your available balance of ${formatEth(available)} ETH. Prices held for running jobs stay held until those jobs settle.`
                            : null
                        }
                        onSubmit={(wei) => send("request", { functionName: "requestWithdraw", args: [wei] })}
                      />
                    </div>
                  </details>
                </>
              )}
            </div>

            <AmountForm
              id="spend-limit"
              label="Spend limit per epoch"
              hint="The most the scheduler may charge you in one epoch. Jobs over the limit are charged in a later epoch."
              button="Set"
              disabled={!canAct}
              onSubmit={(wei) => send("limit", { functionName: "setSpendLimit", args: [wei] })}
            >
              {limit !== null && limit > 0n ? (
                <Button
                  variant="quiet"
                  size="sm"
                  className="-ml-3"
                  disabled={!canAct}
                  onClick={() => send("clear-limit", { functionName: "setSpendLimit", args: [0n] })}
                >
                  Remove the limit
                </Button>
              ) : null}
            </AmountForm>

            {write.isPending ? (
              <Notice tone="neutral" title="Confirm in your wallet">
                Nothing is sent until you confirm.
              </Notice>
            ) : write.data && receipt.isLoading ? (
              <Notice tone="neutral" title="Waiting for confirmation">
                <span className="inline-flex flex-wrap items-center gap-2">
                  Transaction <Hex value={write.data} kind="tx" /> is pending. Do not send it again.
                </span>
              </Notice>
            ) : done ? (
              <Notice tone="live" title={DONE[done]}>
                <span className="inline-flex flex-wrap items-center gap-2">
                  Transaction <Hex value={write.data!} kind="tx" />
                </span>
              </Notice>
            ) : txError && !busy ? (
              <Notice
                tone="error"
                title={lastAction === "deposit" ? "The deposit did not go through" : "The transaction did not go through"}
                action={
                  <Button size="sm" variant="secondary" onClick={() => write.reset()}>
                    Dismiss
                  </Button>
                }
              >
                {explainPaymentTxError(txError)}
              </Notice>
            ) : null}
          </div>
        </>
      )}

      <PaymentsNote className="border-t border-line px-5 py-4" />
    </section>
  );
}

/** Plain facts about where the money is, where a charge goes, and what is public. */
export function PaymentsNote({ className }: { className?: string }) {
  if (!config.jobPayments) return null;
  return (
    <div className={cn("space-y-3 text-xs leading-relaxed text-muted", className)}>
      <ul className="space-y-2">
        <li>Your balance stays in the payments contract, not with the scheduler. Only your wallet can withdraw it. {BILLING.withdrawRule}</li>
        <li>
          {BILLING.chargeRule} {BILLING.notCharged}
        </li>
        <li>
          {BILLING.cutRule} {BILLING.potRule}
          {config.treasury ? " The treasury is a Safe multisig." : ""}
        </li>
        <li>
          <span className="text-text">What is public.</span> Each charge emits a CustomerCharged event on-chain with your wallet and the amount
          charged in that epoch, and the epoch&apos;s charge list (/api/v1/epochs/&#123;id&#125;/charges) lists each charged job with its wallet
          and price. The public job lists show only whether a job was paid; each job&apos;s price, charge status and output hash are on its
          private invoice.
        </li>
      </ul>
      <dl className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <dt>Payments contract</dt>
          <dd className="min-w-0">
            <Hex value={config.jobPayments} />
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <dt>Treasury Safe</dt>
          <dd className="min-w-0">{config.treasury ? <Hex value={config.treasury} /> : <Dash why="Not published yet" />}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * Low-credit warning (D20 in the feature brief, a default: LOW_CREDIT_JOBS jobs). Shown when the connected wallet's
 * available balance covers fewer than LOW_CREDIT_JOBS jobs at the current settings (`priceWei` is the live quote, so
 * no price is hard-coded), and only for a wallet that pays: paid mode is on, or it holds a balance. It goes away after
 * a deposit (the account is read again). When paid mode is on and this one job does not fit, the payment box says so.
 */
export function LowCreditNotice({
  priceWei,
  paid,
  depositHref,
  className,
}: {
  priceWei: bigint | null;
  paid: boolean;
  depositHref: string;
  className?: string;
}) {
  const acct = useJobAccount();
  const account = acct?.account;
  if (!account || priceWei === null || priceWei <= 0n || !/^\d+$/.test(account.available) || !/^\d+$/.test(account.balance)) return null;
  const available = BigInt(account.available);
  if (!paid && BigInt(account.balance) === 0n) return null;
  if (!isLowBalance(available, priceWei)) return null;
  if (paid && available < priceWei) return null;
  const left = available / priceWei;
  return (
    <Notice tone="warn" title="Low balance" className={className}>
      {left === 0n ? (
        <>
          Your available balance (<Eth wei={available} />) does not cover one job at these settings (<Eth wei={priceWei} />).
        </>
      ) : (
        <>
          Your available balance (<Eth wei={available} />) covers <span className="num text-text">{left.toString()}</span> more job
          {left === 1n ? "" : "s"} at these settings (<Eth wei={priceWei} /> each), fewer than {LOW_CREDIT_JOBS}.
        </>
      )}{" "}
      <Link href={depositHref} className="link">
        Deposit more
      </Link>{" "}
      to keep paying from your balance.
    </Notice>
  );
}
