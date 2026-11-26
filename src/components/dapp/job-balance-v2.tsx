"use client";

// The SparecycleJobPaymentsV2 part of "Your balance" (only while the scheduler runs V2: TOKEN_PAYMENTS_V2). New
// deposits go here: ETH (withdrawable), the spend-only credits a holder claimed from the holder pool (spent first,
// never withdrawable) and SPARE (approve, then depositSpare; the same two-step withdrawal as ETH). SPARE-paid jobs cost
// the job's ETH price in SPARE at the epoch's SPARE price, with no discount.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { parseUnits, type Address } from "viem";
import { useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { Hex } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag } from "@/components/ui/status";
import { erc20Abi, jobPaymentsV2Abi } from "@/contracts/jobPaymentsV2";
import { targetChain } from "@/lib/chain";
import type { PaymentAccountV2, PaymentWithdrawal } from "@/lib/dapp/api";
import { explainPaymentTxError, formatEth, parseEthInput, WITHDRAW_TIMEOUT_SECONDS } from "@/lib/dapp/paid-jobs";
import { formatTime } from "@/lib/format";
import { formatSpare } from "./pay-from";
import { Row } from "./ui";

type Action =
  | "deposit"
  | "request"
  | "cancel"
  | "withdraw"
  | "limit"
  | "approve"
  | "deposit-spare"
  | "request-spare"
  | "cancel-spare"
  | "withdraw-spare";

const DONE: Record<Action, string> = {
  deposit: "Deposit confirmed",
  request: "Withdrawal started",
  cancel: "Withdrawal request cancelled",
  withdraw: "Withdrawal completed: sent to your wallet",
  limit: "Spend limit set",
  approve: "SPARE approved for the deposit",
  "deposit-spare": "SPARE deposit confirmed",
  "request-spare": "SPARE withdrawal started",
  "cancel-spare": "SPARE withdrawal request cancelled",
  "withdraw-spare": "SPARE withdrawal completed: sent to your wallet",
};

const input =
  "num h-10 w-full min-w-0 rounded-m border border-line-strong bg-slate pr-16 pl-3 text-sm text-text placeholder:text-faint aria-[invalid=true]:border-rust/60";

/** Parses a SPARE amount (18 decimals) above zero, or null. */
function parseSpareInput(raw: string): bigint | null {
  const s = raw.trim().replace(/,/g, "");
  if (!/^(\d+(\.\d{0,18})?|\.\d{1,18})$/.test(s)) return null;
  try {
    const v = parseUnits(s.startsWith(".") ? `0${s}` : s, 18);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

function Amount({ unit, children }: { unit: "ETH" | "SPARE"; children: bigint | string }) {
  return (
    <span>
      <span className="num">{unit === "ETH" ? formatEth(children) : formatSpare(children)}</span> <span className="text-muted">{unit}</span>
    </span>
  );
}

function AmountField({
  id,
  label,
  hint,
  unit,
  button,
  disabled,
  max,
  onSubmit,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  unit: "ETH" | "SPARE";
  button: string;
  disabled: boolean;
  max?: bigint | null;
  onSubmit: (amount: bigint) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const v = unit === "ETH" ? parseEthInput(value) : parseSpareInput(value);
    if (v === null) {
      setError(`Enter an amount in ${unit} above zero.`);
      return;
    }
    if (max !== undefined && max !== null && v > max) {
      setError(`That is more than the ${unit === "ETH" ? formatEth(max) : formatSpare(max)} ${unit} available.`);
      return;
    }
    setError(null);
    onSubmit(v);
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
            {unit}
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
    </form>
  );
}

function Withdrawal({
  w,
  unit,
  canAct,
  onWithdraw,
  onCancel,
}: {
  w: NonNullable<PaymentWithdrawal>;
  unit: "ETH" | "SPARE";
  canAct: boolean;
  onWithdraw: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed text-muted">
        {w.ready ? (
          <>
            The lock is over. Complete the withdrawal to send up to <Amount unit={unit}>{w.amount}</Amount> to your wallet.
          </>
        ) : (
          <>
            Started in epoch <span className="num">{w.epoch}</span>. Ready after epoch <span className="num">{w.epoch + 1}</span> closes or by{" "}
            <span className="num">{formatTime(w.requestedAt + WITHDRAW_TIMEOUT_SECONDS)}</span> (2 days after the request), whichever is first.
          </>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={!canAct || !w.ready} onClick={onWithdraw}>
          Complete withdrawal
        </Button>
        <Button variant="quiet" disabled={!canAct} onClick={onCancel}>
          Cancel request
        </Button>
      </div>
    </div>
  );
}

/**
 * V2's balances and actions. `connected` is the wallet state from the balance panel; `reload` reads the account again
 * after a confirmed transaction.
 */
export function V2Balance({ v2, address, canTransact, reload }: { v2: PaymentAccountV2; address: Address | undefined; canTransact: boolean; reload: () => void }) {
  const contract = v2.contract as Address;
  const token = v2.spareToken as Address;
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data, chainId: targetChain.id, query: { enabled: !!write.data } });
  const [sent, setSent] = useState<{ hash: string; action: Action } | null>(null);
  const [lastAction, setLastAction] = useState<Action | null>(null);
  /** A SPARE deposit waiting for its approval to confirm. */
  const [afterApprove, setAfterApprove] = useState<bigint | null>(null);
  const allowance = useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, contract] : undefined,
    chainId: targetChain.id,
    query: { enabled: !!address },
  });

  const confirmed = receipt.isSuccess && receipt.data?.status === "success";
  const busy = write.isPending || (!!write.data && receipt.isLoading);
  const canAct = canTransact && !busy;
  const done = confirmed && sent && sent.hash === write.data ? sent.action : null;
  const txError = write.error ?? receipt.error ?? (receipt.data?.status === "reverted" ? new Error("The transaction reverted. Nothing changed.") : null);

  function send(action: Action, call: { address: Address; abi: typeof jobPaymentsV2Abi | typeof erc20Abi; functionName: string; args?: readonly unknown[]; value?: bigint }) {
    setLastAction(action);
    write.reset();
    write.writeContract({ chainId: targetChain.id, ...call } as Parameters<typeof write.writeContract>[0], { onSuccess: (hash) => setSent({ hash, action }) });
  }
  const v2call = (action: Action, functionName: string, args?: readonly unknown[], value?: bigint) =>
    send(action, { address: contract, abi: jobPaymentsV2Abi, functionName, args, value });

  const refetchAllowance = allowance.refetch;
  useEffect(() => {
    if (!confirmed || !done) return;
    reload();
    const t = setTimeout(reload, 4_000);
    let next: ReturnType<typeof setTimeout> | undefined;
    if (done === "approve" && afterApprove !== null) {
      // The approval is in: the deposit itself is the second transaction.
      const amount = afterApprove;
      void refetchAllowance();
      next = setTimeout(() => {
        setAfterApprove(null);
        setLastAction("deposit-spare");
        write.reset();
        write.writeContract(
          { chainId: targetChain.id, address: contract, abi: jobPaymentsV2Abi, functionName: "depositSpare", args: [amount] },
          { onSuccess: (hash) => setSent({ hash, action: "deposit-spare" }) },
        );
      }, 0);
    }
    return () => {
      clearTimeout(t);
      if (next) clearTimeout(next);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per confirmed transaction
  }, [confirmed, receipt.data?.transactionHash]);

  function depositSpare(amount: bigint) {
    const have = allowance.data ?? 0n;
    if (have >= amount) v2call("deposit-spare", "depositSpare", [amount]);
    else {
      setAfterApprove(amount);
      send("approve", { address: token, abi: erc20Abi, functionName: "approve", args: [contract, amount] });
    }
  }

  const spare = v2.spare;
  const spareAvailable = BigInt(spare.available);
  const limit = BigInt(v2.spendLimitPerEpoch);

  return (
    <div className="border-b border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
        <h3 className="text-sm font-medium text-text">Balance in the V2 payments contract</h3>
        <StatusTag tone="live">New deposits</StatusTag>
      </div>
      <p className="px-5 pt-1 text-xs leading-relaxed text-muted">
        New deposits go here. Jobs are paid from here first; a job is paid from one balance only, never split.
      </p>
      <dl className="mt-3 divide-y divide-line border-y border-line">
        <Row label="ETH deposited">
          <Amount unit="ETH">{v2.balance}</Amount>
        </Row>
        <Row label={<span>Credits<span className="mt-0.5 block max-w-[220px] text-xs leading-snug text-faint">From the holder pool. Spent before deposits; they pay for jobs only and can never be withdrawn.</span></span>}>
          <Amount unit="ETH">{v2.credits}</Amount>
        </Row>
        <Row label="Held for running jobs">
          <Amount unit="ETH">{v2.held}</Amount>
        </Row>
        <Row label="Withdrawal pending">{v2.withdrawal ? <Amount unit="ETH">{v2.withdrawal.amount}</Amount> : <span className="text-muted">None</span>}</Row>
        <Row label="Available (ETH)">
          <span className="font-medium">
            <Amount unit="ETH">{v2.available}</Amount>
          </span>
        </Row>
        <Row label="Spend limit per epoch">{limit === 0n ? <span className="text-muted">No limit</span> : <Amount unit="ETH">{limit}</Amount>}</Row>
        <Row label="SPARE balance">
          <Amount unit="SPARE">{spare.balance}</Amount>
        </Row>
        <Row label="SPARE held for running jobs">
          <Amount unit="SPARE">{spare.held}</Amount>
        </Row>
        <Row label="SPARE withdrawal pending">{spare.withdrawal ? <Amount unit="SPARE">{spare.withdrawal.amount}</Amount> : <span className="text-muted">None</span>}</Row>
        <Row label="SPARE available">
          <span className="font-medium">
            <Amount unit="SPARE">{spare.available}</Amount>
          </span>
        </Row>
      </dl>

      <div className="space-y-5 px-5 py-4">
        {spare.waiting ? (
          <Notice tone="warn" title={`${spare.waiting.jobs} SPARE-paid job${spare.waiting.jobs === 1 ? "" : "s"} waiting`}>
            {spare.waiting.text}
          </Notice>
        ) : null}

        <AmountField
          id="v2-deposit"
          label="Deposit ETH"
          unit="ETH"
          hint="Sends ETH from your wallet into your V2 balance. You pay the gas. Only your wallet can withdraw it."
          button="Deposit"
          disabled={!canAct}
          onSubmit={(wei) => v2call("deposit", "deposit", [], wei)}
        />

        <div className="space-y-2">
          <p className="text-sm text-text">Withdraw ETH</p>
          {v2.withdrawal ? (
            <Withdrawal
              w={v2.withdrawal}
              unit="ETH"
              canAct={canAct}
              onWithdraw={() => v2call("withdraw", "withdraw")}
              onCancel={() => v2call("cancel", "cancelWithdraw")}
            />
          ) : (
            <AmountField
              id="v2-withdraw"
              label="Amount to withdraw"
              unit="ETH"
              hint="Two steps, as for every balance: start now, complete once the current epoch and the next one have closed (2 days at the latest). Credits cannot be withdrawn."
              button="Start"
              disabled={!canAct || BigInt(v2.balance) === 0n}
              max={BigInt(v2.balance)}
              onSubmit={(wei) => v2call("request", "requestWithdraw", [wei])}
            />
          )}
        </div>

        <AmountField
          id="v2-limit"
          label="Spend limit per epoch"
          unit="ETH"
          hint="The most the scheduler may charge you in one epoch, ETH and SPARE-paid jobs together (SPARE at its ETH price). Jobs over it are charged later."
          button="Set"
          disabled={!canAct}
          onSubmit={(wei) => v2call("limit", "setSpendLimit", [wei])}
        />

        <div className="space-y-3 rounded-m border border-line px-4 py-3">
          <p className="text-sm text-text">SPARE</p>
          <p className="text-xs leading-relaxed text-muted">
            A SPARE-paid job costs the job&apos;s ETH price in SPARE at the epoch&apos;s SPARE price, with no discount
            {spare.priceWeiPer1e18Spare ? (
              <>
                {" "}
                (reference price now: <span className="num text-text">{formatEth(spare.priceWeiPer1e18Spare)}</span> ETH per SPARE)
              </>
            ) : null}
            . The SPARE is sold for ETH so the node pot still gets 95% of the job&apos;s price; the pool&apos;s 2.90% hook cut on that sale
            comes out of the 5% protocol share, not out of your balance. The SPARE price can move between epochs, so the SPARE taken
            can be more or less than the amount shown when you submit.
          </p>
          {!spare.open ? (
            <Notice tone="neutral" title="SPARE payments are not open yet">
              They open once the treasury Safe sets the first SPARE reference price. You can deposit SPARE now; jobs are paid from ETH
              until then.
            </Notice>
          ) : null}
          <AmountField
            id="v2-deposit-spare"
            label="Deposit SPARE"
            unit="SPARE"
            hint="Two transactions the first time: approve the amount for the payments contract, then the deposit itself."
            button="Deposit"
            disabled={!canAct}
            onSubmit={depositSpare}
          />
          {spare.withdrawal ? (
            <Withdrawal
              w={spare.withdrawal}
              unit="SPARE"
              canAct={canAct}
              onWithdraw={() => v2call("withdraw-spare", "withdrawSpare")}
              onCancel={() => v2call("cancel-spare", "cancelWithdrawSpare")}
            />
          ) : (
            <AmountField
              id="v2-withdraw-spare"
              label="Withdraw SPARE"
              unit="SPARE"
              hint="Two steps, like ETH: start now, complete after the lock."
              button="Start"
              disabled={!canAct || spareAvailable === 0n}
              max={BigInt(spare.balance)}
              onSubmit={(v) => v2call("request-spare", "requestWithdrawSpare", [v])}
            />
          )}
        </div>

        {write.isPending ? (
          <Notice tone="neutral" title="Confirm in your wallet">
            {afterApprove !== null && lastAction === "approve" ? "First the approval, then the deposit. " : ""}Nothing is sent until you confirm.
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
            title={lastAction === "deposit" || lastAction === "deposit-spare" ? "The deposit did not go through" : "The transaction did not go through"}
            action={
              <Button size="sm" variant="secondary" onClick={() => write.reset()}>
                Dismiss
              </Button>
            }
          >
            {explainPaymentTxError(txError)}
          </Notice>
        ) : null}
        <p className="text-xs text-muted">
          V2 payments contract <Hex value={contract} />
        </p>
      </div>
    </div>
  );
}
