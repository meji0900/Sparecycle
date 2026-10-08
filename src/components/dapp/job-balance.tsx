"use client";

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
  request: "Withdrawal requested",
  cancel: "Withdrawal request cancelled",
  withdraw: "Withdrawal sent to your wallet",
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

/** Earliest time a withdrawal request can be executed: the next-but-one epoch start, or the 2-day timeout. */
function unlockTime(w: NonNullable<PaymentAccount["withdrawal"]>, status: StatusResponse | null) {
  const timeout = w.requestedAt + WITHDRAW_TIMEOUT_SECONDS;
  const e = status?.epoch;
  if (!e || e.clock === "scheduler-local") return { at: timeout, byEpoch: false };
  // The contract unlocks when its current epoch reaches request epoch + 2, i.e. when epoch + 1 closes.
  const toGo = w.epoch + 2 - e.id;
  // toGo <= 0: the scheduler's clock is past it but the contract has not closed the epoch yet; only the deadline is sure.
  if (toGo <= 0) return { at: timeout, byEpoch: false };
  const byEpoch = e.endsAt + (toGo - 1) * e.length;
  return byEpoch < timeout ? { at: byEpoch, byEpoch: true } : { at: timeout, byEpoch: false };
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
  const unlock = withdrawal && !withdrawal.ready ? unlockTime(withdrawal, status) : null;

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
            <Row label="Balance">{value(account?.balance, failure ? "Not read" : undefined)}</Row>
            <Row label="Held for running jobs">{value(account?.held, failure ? "Not read" : undefined)}</Row>
            <Row label="Available for new jobs">
              {account ? <Eth wei={account.available} className="font-medium" /> : value(null, failure ? "Not read" : undefined)}
            </Row>
            <Row label="Spend limit per epoch">
              {limit === null ? value(null, failure ? "Not read" : undefined) : limit === 0n ? <span className="text-muted">No limit</span> : <Eth wei={limit} />}
            </Row>
            <Row label="Pending withdrawal">
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
            {withdrawal && unlock ? (
              <Row label="Unlocks">
                <span className="text-muted">{unlock.byEpoch ? "about" : "by"}</span> <span className="num">{formatTime(unlock.at)}</span>
              </Row>
            ) : null}
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
              {withdrawal ? (
                <>
                  <p className="text-sm text-text">Withdraw</p>
                  <p className="text-xs leading-relaxed text-muted">
                    {withdrawal.ready ? (
                      <>Your request is unlocked. Withdraw sends up to <Eth wei={withdrawal.amount} /> to your wallet.</>
                    ) : (
                      <>
                        Requested in epoch <span className="num">{withdrawal.epoch}</span>. It unlocks once that epoch and the next one have
                        closed{epochs}, or 2 days after the request, whichever is first.
                      </>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" disabled={!canAct || !withdrawal.ready} onClick={() => send("withdraw", { functionName: "withdraw" })}>
                      Withdraw
                    </Button>
                    <Button variant="quiet" disabled={!canAct} onClick={() => send("cancel", { functionName: "cancelWithdraw" })}>
                      Cancel request
                    </Button>
                  </div>
                </>
              ) : (
                <AmountForm
                  id="withdraw-amount"
                  label="Request withdrawal"
                  hint={`Withdrawals take two steps. Request now; the amount stops being spendable on new jobs. Withdraw once the current epoch and the next one have closed${epochs}, or after 2 days at the latest.`}
                  button="Request"
                  disabled={!canAct || !account}
                  check={(wei) =>
                    account && wei > BigInt(account.balance) ? `That is more than your balance of ${formatEth(account.balance)} ETH.` : null
                  }
                  onSubmit={(wei) => send("request", { functionName: "requestWithdraw", args: [wei] })}
                />
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

/** Plain facts about where the money is and where a charge goes. */
export function PaymentsNote({ className }: { className?: string }) {
  if (!config.jobPayments) return null;
  return (
    <div className={cn("space-y-3 text-xs leading-relaxed text-muted", className)}>
      <ul className="space-y-2">
        <li>Your balance stays in the payments contract, not with the scheduler. Only your wallet can withdraw it.</li>
        <li>A paid job is charged only when two nodes agree on its result. Disagreed, expired and rejected jobs are never charged.</li>
        <li>
          Of each charge, 95% goes to the node reward pot and 5% to the treasury{config.treasury ? ", a Safe multisig" : ""}.
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
