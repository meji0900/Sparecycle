"use client";

import Link from "next/link";
import { useCallback, useRef, useState, type FormEvent, type ReactNode } from "react";
import { zeroAddress, type Address, type Hex as HexString } from "viem";
import { useConfig, useReadContract, useReadContracts } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { Hex } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag, type Tone } from "@/components/ui/status";
import { sparecycleRewardsAbi } from "@/contracts/sparecycleRewards";
import { targetChain } from "@/lib/chain";
import { useApiGet, useNow } from "@/lib/dapp/use-api";
import { useWallet } from "@/lib/dapp/use-wallet";
import { formatBps, formatTime } from "@/lib/format";
import { repoFile } from "@/lib/site";
import {
  epochsLabel,
  explainStakeTxError,
  formatSpare,
  formatWait,
  parseEvidenceHash,
  parseSpareInput,
  proposalStatusName,
  spareInputValue,
  windowState,
  type WindowState,
} from "@/lib/staking";
import { erc20ErrorsAbi, nodeStakeAbi, spareTokenAbi } from "@/lib/token-contracts";
import { cn } from "@/lib/utils";
import { Dash, Skeleton } from "./ui";
import { WalletButton } from "./wallet-button";

// ---- Model ---------------------------------------------------------------------------------------------------------
// The container (StakePanel) reads the chain and sends transactions; the view (StakePanelView) only draws a model, so
// every state can be rendered and checked without a wallet.

export type Read<T> = { state: "loading" } | { state: "error" } | { state: "ok"; value: T };

/** The stake contract's settings (immutables, the minimum in force) and its token and reward contract. */
export type StakeRules = {
  token: Address;
  rewards: Address;
  minStakePerNode: bigint;
  epochLength: bigint;
  cooldownEpochs: bigint;
  appealWindowEpochs: bigint;
  decisionWindowEpochs: bigint;
  slashBps: number;
  graceEpochs: bigint;
  stallFactor: bigint;
};

/** The connected wallet: its SPARE, its approval for the stake contract and its record in the stake contract. */
export type StakeAccount = {
  balance: bigint;
  allowance: bigint;
  staked: bigint;
  unstaking: bigint;
  requestEpoch: bigint;
  requestedAt: bigint;
  lastProposal: bigint;
  /** openProposalOf(wallet): an open, unexpired proposal (the stake is frozen); 0 = none. */
  openProposal: bigint;
  canUnstake: boolean;
};

/** The latest slash proposal against the wallet (any status). */
export type StakeProposal = {
  id: bigint;
  /** proposalStatus(): the effective status (an undecided proposal past its decision window reads Expired). */
  status: number;
  amount: bigint;
  proposedEpoch: bigint;
  proposedAt: bigint;
  closedEpoch: bigint;
  closedAt: bigint;
  evidenceHash: HexString;
  appealHash: HexString;
  canAppeal: boolean;
  /** The public evidence bundle on this site (GET /api/v1/slashing/:id), when the scheduler serves it. */
  evidenceUrl: string | null;
};

export type TxAction = "approve" | "stake" | "request" | "cancel" | "unstake" | "appeal";
export type TxState =
  | { phase: "idle" }
  | { phase: "checking"; action: TxAction }
  | { phase: "wallet"; action: TxAction }
  | { phase: "pending"; action: TxAction; hash: HexString }
  | { phase: "confirmed"; action: TxAction; hash: HexString }
  | { phase: "failed"; action: TxAction; hash: HexString | null; message: string };

export type StakeModel = {
  /** SparecycleNodeStake on this network; null = not deployed here. */
  contract: Address | null;
  mounted: boolean;
  address: Address | undefined;
  connected: boolean;
  wrongNetwork: boolean;
  chainId: number | undefined;
  rules: Read<StakeRules>;
  /** Loading while no wallet is connected. */
  account: Read<StakeAccount>;
  /** The reward contract's current epoch and when it started; null when not read (no time estimates then). */
  epoch: { current: bigint; startedAt: bigint | null } | null;
  /** Null when the wallet has never had a proposal against it. */
  proposal: Read<StakeProposal> | null;
  /** Unix seconds, null before the first client tick. */
  now: number | null;
  tx: TxState;
  /** Confirmed stakes and appeals so far: each one clears its form (the amount or hash just sent). */
  resets: { stake: number; appeal: number };
};

export type StakeActions = {
  approve: (amount: bigint) => void;
  stake: (amount: bigint) => void;
  requestUnstake: (amount: bigint) => void;
  cancelUnstake: () => void;
  unstake: () => void;
  appeal: (proposalId: bigint, evidenceHash: HexString) => void;
  dismiss: () => void;
  retry: () => void;
};

const ZERO_HASH = `0x${"00".repeat(32)}`;

// ---- Container -----------------------------------------------------------------------------------------------------

const stakeAbi = [...nodeStakeAbi, ...erc20ErrorsAbi] as const;
const tokenAbi = [...spareTokenAbi, ...erc20ErrorsAbi] as const;

/**
 * "Stake SPARE (optional)": the connected owner wallet's SPARE, stake, cooldown and any slash proposal, with every
 * action on SparecycleNodeStake. Reads go through the site's RPC fallback (direct RPC, then /api/rpc); every write is
 * simulated first, so a call the contract would refuse is explained before the wallet opens.
 */
export function StakePanel({ contract }: { contract: Address | null }) {
  const { mounted, address, chainId, isConnected } = useWallet();
  const wrongNetwork = isConnected && chainId !== targetChain.id;
  const cid = targetChain.id;
  const c = contract ?? zeroAddress;
  const who = address ?? zeroAddress;
  const nowMs = useNow(15_000);

  const rulesQ = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: c, abi: nodeStakeAbi, functionName: "token", chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "rewards", chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "minStakePerNode", chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "epochLength", chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "cooldownEpochs", chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "appealWindowEpochs", chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "decisionWindowEpochs", chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "slashBps", chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "PROPOSAL_GRACE_EPOCHS", chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "STALL_FACTOR", chainId: cid },
    ],
    query: { enabled: !!contract, refetchInterval: 120_000 },
  });
  const rd = rulesQ.data;
  const rulesOk = !!rd && rd.every((r) => r.status === "success");
  const rules: Read<StakeRules> = rulesOk
    ? {
        state: "ok",
        value: {
          token: rd[0].result as Address,
          rewards: rd[1].result as Address,
          minStakePerNode: rd[2].result as bigint,
          epochLength: rd[3].result as bigint,
          cooldownEpochs: rd[4].result as bigint,
          appealWindowEpochs: rd[5].result as bigint,
          decisionWindowEpochs: rd[6].result as bigint,
          slashBps: Number(rd[7].result),
          graceEpochs: rd[8].result as bigint,
          stallFactor: rd[9].result as bigint,
        },
      }
    : rulesQ.isPending
      ? { state: "loading" }
      : { state: "error" };
  const token = rules.state === "ok" ? rules.value.token : zeroAddress;
  const rewards = rules.state === "ok" ? rules.value.rewards : zeroAddress;

  const accountQ = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: token, abi: spareTokenAbi, functionName: "balanceOf", args: [who], chainId: cid },
      { address: token, abi: spareTokenAbi, functionName: "allowance", args: [who, c], chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "getAccount", args: [who], chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "canUnstake", args: [who], chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "openProposalOf", args: [who], chainId: cid },
    ],
    query: { enabled: !!contract && !!address && rules.state === "ok", refetchInterval: 30_000 },
  });
  const ad = accountQ.data;
  const acct = ad?.[2]?.status === "success" ? ad[2].result : null;
  const account: Read<StakeAccount> =
    ad && acct && ad[0].status === "success" && ad[1].status === "success" && ad[3].status === "success" && ad[4].status === "success"
      ? {
          state: "ok",
          value: {
            balance: ad[0].result,
            allowance: ad[1].result,
            staked: acct.staked,
            unstaking: acct.unstaking,
            requestEpoch: acct.requestEpoch,
            requestedAt: acct.requestedAt,
            lastProposal: acct.lastProposal,
            canUnstake: ad[3].result,
            openProposal: ad[4].result,
          },
        }
      : rules.state === "error"
        ? { state: "error" }
        : !address || rules.state === "loading" || accountQ.isPending
          ? { state: "loading" }
          : { state: "error" };

  const epochQ = useReadContract({
    address: rewards,
    abi: sparecycleRewardsAbi,
    functionName: "currentEpoch",
    chainId: cid,
    query: { enabled: rules.state === "ok", refetchInterval: 60_000 },
  });
  const epochInfoQ = useReadContract({
    address: rewards,
    abi: sparecycleRewardsAbi,
    functionName: "getEpoch",
    args: [epochQ.data ?? 0n],
    chainId: cid,
    query: { enabled: rules.state === "ok" && epochQ.data !== undefined, refetchInterval: 60_000 },
  });
  const epoch =
    epochQ.data !== undefined
      ? { current: epochQ.data, startedAt: epochInfoQ.data && epochInfoQ.data.index === epochQ.data ? epochInfoQ.data.startedAt : null }
      : null;

  const pid = account.state === "ok" ? account.value.lastProposal : 0n;
  const propQ = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: c, abi: nodeStakeAbi, functionName: "getProposal", args: [pid], chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "proposalStatus", args: [pid], chainId: cid },
      { address: c, abi: nodeStakeAbi, functionName: "canAppeal", args: [pid], chainId: cid },
    ],
    query: { enabled: !!contract && pid > 0n, refetchInterval: 30_000 },
  });
  // The public evidence bundles are served only while the scheduler's slashing is on; a 404 just means no link.
  const slashingQ = useApiGet<{ proposals: { evidenceHash: string; evidenceUrl: string }[] }>(pid > 0n ? "/slashing" : null, 120_000);
  const pd = propQ.data;
  const p = pd?.[0]?.status === "success" ? pd[0].result : null;
  const evidence = p && slashingQ.result?.ok ? slashingQ.result.data.proposals.find((x) => x.evidenceHash?.toLowerCase() === p.evidenceHash.toLowerCase()) : undefined;
  const proposal: Read<StakeProposal> | null =
    pid === 0n
      ? null
      : p && pd?.[1]?.status === "success" && pd?.[2]?.status === "success"
        ? {
            state: "ok",
            value: {
              id: pid,
              status: Number(pd[1].result),
              amount: p.amount,
              proposedEpoch: p.proposedEpoch,
              proposedAt: p.proposedAt,
              closedEpoch: p.closedEpoch,
              closedAt: p.closedAt,
              evidenceHash: p.evidenceHash,
              appealHash: p.appealHash,
              canAppeal: pd[2].result,
              evidenceUrl: evidence && /^\/api\/v1\/slashing\/\d+$/.test(evidence.evidenceUrl) ? evidence.evidenceUrl : null,
            },
          }
        : propQ.isPending
          ? { state: "loading" }
          : { state: "error" };

  // ---- transactions
  const wagmiConfig = useConfig();
  const [tx, setTx] = useState<TxState>({ phase: "idle" });
  const [resets, setResets] = useState({ stake: 0, appeal: 0 });
  const seq = useRef(0);
  const refetchRules = rulesQ.refetch;
  const refetchAccount = accountQ.refetch;
  const refetchProposal = propQ.refetch;
  const refetchAll = useCallback(() => {
    refetchRules();
    refetchAccount();
    refetchProposal();
  }, [refetchRules, refetchAccount, refetchProposal]);

  const run = useCallback(
    async (action: TxAction, simulate: () => Promise<{ request: unknown }>) => {
      const id = ++seq.current;
      const set = (s: TxState) => {
        if (seq.current === id) setTx(s);
      };
      let hash: HexString | null = null;
      set({ phase: "checking", action });
      try {
        const { request } = await simulate();
        set({ phase: "wallet", action });
        hash = await writeContract(wagmiConfig, request as Parameters<typeof writeContract>[1]);
        set({ phase: "pending", action, hash });
        const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: cid });
        if (receipt.status === "success") {
          set({ phase: "confirmed", action, hash });
          if (action === "stake" || action === "appeal") setResets((r) => ({ ...r, [action]: r[action] + 1 }));
        } else set({ phase: "failed", action, hash, message: "The transaction reverted on-chain. Nothing moved." });
      } catch (e) {
        set({
          phase: "failed",
          action,
          hash,
          // Sent but not confirmed as far as this page can tell: it may still land, so never invite a blind resend.
          message: hash
            ? "The wallet sent it, but this page could not read its confirmation. Check the transaction on the explorer before you send it again."
            : explainStakeTxError(e),
        });
      } finally {
        refetchAll();
        // Once more a few seconds later, in case the RPC that answered was a block behind.
        setTimeout(refetchAll, 4_000);
      }
    },
    [wagmiConfig, cid, refetchAll],
  );

  const sim = (functionName: "stake" | "requestUnstake" | "cancelUnstake" | "unstake" | "appeal", args: readonly unknown[]) => () =>
    simulateContract(wagmiConfig, {
      address: c,
      abi: stakeAbi,
      functionName,
      args,
      account: address,
      chainId: cid,
    } as Parameters<typeof simulateContract>[1]);

  const actions: StakeActions = {
    approve: (amount) =>
      void run("approve", () =>
        simulateContract(wagmiConfig, { address: token, abi: tokenAbi, functionName: "approve", args: [c, amount], account: address, chainId: cid }),
      ),
    stake: (amount) => void run("stake", sim("stake", [amount])),
    requestUnstake: (amount) => void run("request", sim("requestUnstake", [amount])),
    cancelUnstake: () => void run("cancel", sim("cancelUnstake", [])),
    unstake: () => void run("unstake", sim("unstake", [])),
    appeal: (proposalId, evidenceHash) => void run("appeal", sim("appeal", [proposalId, evidenceHash])),
    dismiss: () => {
      seq.current++;
      setTx({ phase: "idle" });
    },
    retry: refetchAll,
  };

  const model: StakeModel = {
    contract,
    mounted,
    address,
    connected: isConnected,
    wrongNetwork,
    chainId,
    rules,
    account,
    epoch,
    proposal,
    now: nowMs === null ? null : Math.floor(nowMs / 1000),
    tx,
    resets,
  };
  return <StakePanelView model={model} actions={actions} />;
}

// ---- View ----------------------------------------------------------------------------------------------------------

const DONE: Record<TxAction, string> = {
  approve: "Approval confirmed. You can stake now.",
  stake: "Staked",
  request: "Unstake requested: the cooldown has started",
  cancel: "Unstake cancelled: back in your active stake",
  unstake: "Withdrawn to your wallet",
  appeal: "Appeal recorded on-chain",
};

const FAILED: Record<TxAction, string> = {
  approve: "The approval did not go through",
  stake: "The stake did not go through",
  request: "The unstake request did not go through",
  cancel: "The cancel did not go through",
  unstake: "The withdrawal did not go through",
  appeal: "The appeal did not go through",
};

const isBusy = (tx: TxState) => tx.phase === "checking" || tx.phase === "wallet" || tx.phase === "pending";

/** The state of the last transaction, shown under the action that sent it. */
function TxNotice({ tx, actions, onDismiss }: { tx: TxState; actions: TxAction[]; onDismiss: () => void }) {
  if (tx.phase === "idle" || !actions.includes(tx.action)) return null;
  if (tx.phase === "checking") {
    return (
      <Notice tone="neutral" title="Checking with the contract">
        The call is simulated first, so a call the contract would refuse costs no gas.
      </Notice>
    );
  }
  if (tx.phase === "wallet") {
    return (
      <Notice tone="neutral" title="Confirm in your wallet">
        Nothing is sent until you confirm.
      </Notice>
    );
  }
  if (tx.phase === "pending") {
    return (
      <Notice tone="neutral" title="Waiting for confirmation">
        <span className="block">Sent and pending. Do not send it again.</span>
        <span className="mt-1 inline-flex flex-wrap items-center gap-2">
          Transaction <Hex value={tx.hash} kind="tx" />
        </span>
      </Notice>
    );
  }
  if (tx.phase === "confirmed") {
    return (
      <Notice
        tone="live"
        title={DONE[tx.action]}
        action={
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            Dismiss
          </Button>
        }
      >
        <span className="inline-flex flex-wrap items-center gap-2">
          Transaction <Hex value={tx.hash} kind="tx" />
        </span>
      </Notice>
    );
  }
  return (
    <Notice
      tone="error"
      title={FAILED[tx.action]}
      action={
        <Button size="sm" variant="secondary" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      <span className="block">{tx.message}</span>
      {tx.hash ? (
        <span className="mt-1 inline-flex flex-wrap items-center gap-2">
          Transaction <Hex value={tx.hash} kind="tx" />
        </span>
      ) : null}
    </Notice>
  );
}

const fieldClass =
  "num h-10 w-full min-w-0 rounded-m border border-line-strong bg-slate px-3 text-sm text-text placeholder:text-faint disabled:opacity-60 aria-[invalid=true]:border-rust/60";

/** A SPARE amount field with an optional fill button ("Max", "All"). */
function SpareField({
  id,
  label,
  value,
  onChange,
  error,
  fill,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  fill?: { label: string; value: bigint };
  disabled?: boolean;
}) {
  const canFill = !!fill && fill.value > 0n;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm text-text">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          className={cn(fieldClass, canFill ? "pr-28" : "pr-16")}
        />
        <span className="absolute inset-y-0 right-2 flex items-center gap-1">
          {canFill ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(spareInputValue(fill.value))}
              className="h-7 rounded-s border border-line px-2 text-xs text-muted transition-colors hover:border-line-strong hover:text-text disabled:opacity-45"
            >
              {fill.label}
            </button>
          ) : null}
          <span aria-hidden className="pointer-events-none px-1 text-xs text-faint">
            SPARE
          </span>
        </span>
      </div>
      {error ? (
        <p id={`${id}-err`} className="text-xs text-rust">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "1,234.5 SPARE" with the number in the tabular face. */
function Spare({ wei, className }: { wei: bigint; className?: string }) {
  return (
    <span className={className}>
      <span className="num">{formatSpare(wei)}</span> <span className="text-muted">SPARE</span>
    </span>
  );
}

/** A summary row: label (with a one-line hint) left, value right, and an optional full-width detail line below. */
function SummaryRow({ label, hint, children, detail }: { label: string; hint?: string; children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 py-3">
      <dt className="min-w-0 text-sm text-muted">
        {label}
        {hint ? <span className="mt-0.5 block max-w-[300px] text-xs leading-snug text-faint">{hint}</span> : null}
      </dt>
      <dd className="min-w-0 text-right text-sm text-text">{children}</dd>
      {detail ? <dd className="basis-full pt-1.5 text-xs leading-relaxed text-muted">{detail}</dd> : null}
    </div>
  );
}

/** A time with how far away it is: "2026-11-30 14:00 UTC (in about 3 days 2 h)". */
function When({ at, now }: { at: number; now: number | null }) {
  return (
    <>
      <span className="num text-text">{formatTime(at)}</span>
      {now !== null && at > now ? <span> ({formatWait(at - now).replace(/^about /, "in about ")})</span> : null}
    </>
  );
}

/** Heading of one action inside the panel. */
function ActionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium text-text">{title}</h3>
      {children ? <p className="text-xs leading-relaxed text-muted">{children}</p> : null}
    </div>
  );
}

/** A window of the contract, judged with the page's clock and the reward contract's current epoch. */
function windowOf(m: StakeModel, r: StakeRules, startEpoch: bigint, startAt: bigint, epochs: bigint): WindowState | null {
  if (m.now === null) return null;
  return windowState({
    startEpoch,
    startAt,
    epochs,
    epochLength: r.epochLength,
    stallFactor: r.stallFactor,
    // Unknown epoch: judged as if none had closed, so only the time bounds count.
    currentEpoch: m.epoch?.current ?? startEpoch,
    currentEpochStartedAt: m.epoch ? m.epoch.startedAt : null,
    now: m.now,
  });
}

/** When the cooldown bucket can be withdrawn, in words: the epoch rule first, then approximate times. */
function CooldownText({ m, r, a }: { m: StakeModel; r: StakeRules; a: StakeAccount }) {
  if (a.canUnstake) return <>The cooldown is over: withdraw it any time. Until then it can still be slashed.</>;
  const w = windowOf(m, r, a.requestEpoch, a.requestedAt, r.cooldownEpochs);
  const notBefore = Number(a.requestedAt + r.cooldownEpochs * r.epochLength);
  return (
    <>
      Requested in epoch <span className="num">{a.requestEpoch.toString()}</span>. Ready once the reward contract reaches epoch{" "}
      <span className="num">{(a.requestEpoch + r.cooldownEpochs).toString()}</span>, and not before <When at={notBefore} now={m.now} />.
      {w ? (
        <>
          {" "}
          {!m.epoch ? (
            <>The current epoch could not be read, so there is no closer estimate. </>
          ) : w.waitingForEpochs ? (
            <>
              The time is up; it now waits for <span className="num">{w.epochsLeft.toString()}</span> more epoch{w.epochsLeft === 1n ? "" : "s"} to close
              on-chain.{" "}
            </>
          ) : w.expected !== null && w.expected > notBefore + 60 ? (
            <>
              At the pace epochs are closing, expect it around <When at={w.expected} now={m.now} />.{" "}
            </>
          ) : null}
          {w.over ? null : (
            <>
              At the latest <span className="num text-text">{formatTime(w.latest)}</span>, even if epochs stop closing.
            </>
          )}
        </>
      ) : null}
      {a.openProposal !== 0n ? <> A slash proposal against this wallet is open: nothing can leave until it is decided or expires.</> : null}
    </>
  );
}

const PROPOSAL_TONE: Partial<Record<string, Tone>> = { Open: "warn", Cancelled: "neutral", Executed: "error", Expired: "neutral" };

/** The latest proposal against the wallet, in words: what it means now, the windows that matter, its evidence. */
function ProposalText({ m, r, p }: { m: StakeModel; r: StakeRules; p: StakeProposal }) {
  const name = proposalStatusName(p.status);
  const at = (w: WindowState | null) => (w ? (w.expected ?? w.notBefore) : null);
  const appealEnd = at(windowOf(m, r, p.proposedEpoch, p.proposedAt, r.appealWindowEpochs));
  const decisionEnd = at(windowOf(m, r, p.proposedEpoch, p.proposedAt, r.appealWindowEpochs + r.decisionWindowEpochs));
  const grace =
    name === "Cancelled" || name === "Executed"
      ? windowOf(m, r, p.closedEpoch, p.closedAt, r.graceEpochs)
      : name === "Expired"
        ? windowOf(m, r, p.proposedEpoch, p.proposedAt, r.appealWindowEpochs + r.decisionWindowEpochs + r.graceEpochs)
        : null;
  const graceEnd = grace && !grace.over ? at(grace) : null;
  return (
    <>
      {name === "Open" ? (
        <>
          Up to <Spare wei={p.amount} /> would be burned if the treasury Safe executes it.{" "}
          {p.canAppeal ? (
            <>
              You can appeal until about{" "}
              {appealEnd !== null ? <When at={appealEnd} now={m.now} /> : <>epoch {(p.proposedEpoch + r.appealWindowEpochs).toString()}</>} (under Appeal,
              below).
            </>
          ) : (
            <>
              The appeal window is over. The Safe executes or cancels it; if it does neither, it expires around{" "}
              {decisionEnd !== null ? (
                <When at={decisionEnd} now={m.now} />
              ) : (
                <>epoch {(p.proposedEpoch + r.appealWindowEpochs + r.decisionWindowEpochs).toString()}</>
              )}
              .
            </>
          )}{" "}
          Your stake is frozen meanwhile; staking more and cancelling an unstake still work.{" "}
        </>
      ) : name === "Executed" ? (
        <>
          <Spare wei={p.amount} /> was burned by the treasury Safe&apos;s decision.{" "}
        </>
      ) : name === "Cancelled" ? (
        <>The treasury Safe cancelled it; nothing was taken. </>
      ) : name === "Expired" ? (
        <>Nobody decided in time, so it expired and nothing was taken. </>
      ) : null}
      {graceEnd !== null ? (
        <>
          No new proposal against this wallet before about <When at={graceEnd} now={m.now} /> (the grace window).{" "}
        </>
      ) : null}
      {p.evidenceUrl ? (
        <a href={p.evidenceUrl} className="link" target="_blank" rel="noreferrer">
          Public evidence bundle
        </a>
      ) : (
        <span className="inline-flex flex-wrap items-center gap-1">
          Evidence hash <Hex value={p.evidenceHash} kind="hash" />
        </span>
      )}
      {p.appealHash !== ZERO_HASH ? (
        <span className="ml-3 inline-flex flex-wrap items-center gap-1">
          Your appeal <Hex value={p.appealHash} kind="hash" />
        </span>
      ) : null}
    </>
  );
}

/** Approve the exact amount, then stake it. */
function StakeAction({ m, a, actions, disabled }: { m: StakeModel; a: StakeAccount; actions: StakeActions; disabled: boolean }) {
  const [raw, setRaw] = useState("");
  const amount = parseSpareInput(raw);
  const error =
    raw.trim() === ""
      ? null
      : amount === null
        ? "Enter an amount of SPARE above zero, for example 100."
        : amount > a.balance
          ? `That is more than the ${formatSpare(a.balance)} SPARE in your wallet.`
          : null;
  const ok = amount !== null && !error ? amount : null;
  const approved = ok !== null && a.allowance >= ok;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (ok === null || disabled) return;
    if (approved) actions.stake(ok);
    else actions.approve(ok);
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <ActionHead title="Stake">
        Two transactions: approve exactly this amount for the stake contract (never an unlimited allowance), then stake it. Voluntary; it pays nothing, and
        part of it can be taken only through a slash proposal you can appeal.
      </ActionHead>
      <SpareField id="stake-amount" label="Amount to stake" value={raw} onChange={setRaw} error={error} fill={{ label: "Max", value: a.balance }} disabled={disabled} />
      {a.balance === 0n ? <p className="text-xs text-muted">This wallet holds no SPARE.</p> : null}
      <ol className="grid gap-2 sm:grid-cols-2">
        <li>
          <Button
            type="button"
            variant={ok !== null && !approved ? "primary" : "secondary"}
            className="w-full"
            disabled={disabled || ok === null || approved}
            onClick={() => ok !== null && actions.approve(ok)}
          >
            <span className="num text-xs opacity-60">1</span>
            {approved ? "Approved" : ok !== null ? `Approve ${formatSpare(ok)} SPARE` : "Approve"}
          </Button>
        </li>
        <li>
          <Button type="button" variant={approved ? "primary" : "secondary"} className="w-full" disabled={disabled || !approved} onClick={() => ok !== null && actions.stake(ok)}>
            <span className="num text-xs opacity-60">2</span>
            {ok !== null ? `Stake ${formatSpare(ok)} SPARE` : "Stake"}
          </Button>
        </li>
      </ol>
      {a.allowance > 0n ? (
        <p className="text-xs text-faint">
          Approved for the stake contract now: <Spare wei={a.allowance} />.
        </p>
      ) : null}
      <TxNotice tx={m.tx} actions={["approve", "stake"]} onDismiss={actions.dismiss} />
    </form>
  );
}

/** Request an unstake, behind a confirm that explains the cooldown and its restart. */
function RequestUnstakeAction({ m, r, a, actions, disabled }: { m: StakeModel; r: StakeRules; a: StakeAccount; actions: StakeActions; disabled: boolean }) {
  const [raw, setRaw] = useState("");
  const [confirming, setConfirming] = useState<bigint | null>(null);
  const amount = parseSpareInput(raw);
  const frozen = a.openProposal !== 0n;
  const error =
    raw.trim() === ""
      ? null
      : amount === null
        ? "Enter an amount of SPARE above zero."
        : amount > a.staked
          ? `That is more than your active stake of ${formatSpare(a.staked)} SPARE.`
          : null;
  const ok = amount !== null && !error ? amount : null;
  const newReady = m.now !== null ? m.now + Number(r.cooldownEpochs * r.epochLength) : null;
  const waiting = windowOf(m, r, a.requestEpoch, a.requestedAt, r.cooldownEpochs);
  return (
    <div className="space-y-3">
      <ActionHead title="Unstake">
        Two steps: request, then wait {epochsLabel(r.cooldownEpochs, r.epochLength)} and withdraw. Requested SPARE stops counting as stake at once but can
        still be slashed until it leaves.
      </ActionHead>
      {frozen ? (
        <Notice tone="warn" title="Frozen by an open slash proposal">
          No unstake can be requested or withdrawn while proposal #{a.openProposal.toString()} is open. That ends when the treasury Safe decides or the
          proposal expires.
        </Notice>
      ) : null}
      {confirming === null ? (
        <form
          noValidate
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok !== null && !disabled && !frozen) setConfirming(ok);
          }}
        >
          <SpareField
            id="unstake-amount"
            label="Amount to unstake"
            value={raw}
            onChange={setRaw}
            error={error}
            fill={{ label: "All", value: a.staked }}
            disabled={disabled || frozen}
          />
          <Button type="submit" variant="secondary" disabled={disabled || frozen || ok === null}>
            Request unstake…
          </Button>
        </form>
      ) : (
        <div role="group" aria-labelledby="unstake-confirm" className="space-y-3 rounded-m border border-amber/30 bg-amber-soft p-4">
          <p id="unstake-confirm" className="text-sm font-medium text-text">
            Start the cooldown for <Spare wei={confirming} />?
          </p>
          <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-text/90 marker:text-faint">
            <li>
              It leaves your active stake now. You can withdraw it after {epochsLabel(r.cooldownEpochs, r.epochLength)}
              {newReady !== null ? (
                <>
                  : no earlier than <When at={newReady} now={m.now} />
                </>
              ) : null}
              .
            </li>
            {a.unstaking > 0n ? (
              <li>
                <span className="font-medium text-amber">This restarts the whole cooldown.</span> The <Spare wei={a.unstaking} /> already waiting
                {a.canUnstake ? (
                  <> (ready to withdraw now)</>
                ) : waiting && !waiting.over ? (
                  <>
                    {" "}
                    (due around <When at={waiting.expected ?? waiting.notBefore} now={null} />)
                  </>
                ) : null}{" "}
                starts again with it: <Spare wei={a.unstaking + confirming} /> in all. To leave fastest, withdraw what is ready first, or request everything at
                once.
              </li>
            ) : (
              <li>A later request restarts the cooldown for everything waiting, so request everything you want to take out at once.</li>
            )}
            <li>Until you withdraw it, it no longer counts as stake but can still be slashed. You can move it back to your active stake at any time.</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled}
              onClick={() => {
                actions.requestUnstake(confirming);
                setConfirming(null);
                setRaw("");
              }}
            >
              {a.unstaking > 0n ? "Restart the cooldown" : "Start the cooldown"}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(null)}>
              Back
            </Button>
          </div>
        </div>
      )}
      <TxNotice tx={m.tx} actions={["request"]} onDismiss={actions.dismiss} />
    </div>
  );
}

/** Withdraw the cooldown bucket once the contract allows it, or move it back to active stake. */
function CooldownActions({ m, a, actions, disabled }: { m: StakeModel; a: StakeAccount; actions: StakeActions; disabled: boolean }) {
  return (
    <div className="space-y-3">
      <ActionHead title="Waiting in the cooldown">
        <Spare wei={a.unstaking} /> waits to be withdrawn. Withdraw it once the cooldown is over, or cancel the unstake to move it back to your active stake.
      </ActionHead>
      <div className="flex flex-wrap gap-2">
        <Button disabled={disabled || !a.canUnstake} onClick={actions.unstake}>
          Withdraw {formatSpare(a.unstaking)} SPARE
        </Button>
        <Button variant="secondary" disabled={disabled} onClick={actions.cancelUnstake}>
          Cancel unstake
        </Button>
      </div>
      {!a.canUnstake ? <p className="text-xs text-faint">Withdraw turns on when the contract says the cooldown is over and no proposal is open.</p> : null}
      <TxNotice tx={m.tx} actions={["unstake", "cancel"]} onDismiss={actions.dismiss} />
    </div>
  );
}

/** Appeal an open proposal with the hash of an appeal bundle. Advanced, so collapsed. */
function AppealAction({ m, a, p, actions, disabled }: { m: StakeModel; a: StakeAccount; p: StakeProposal | null; actions: StakeActions; disabled: boolean }) {
  const [raw, setRaw] = useState("");
  const hash = parseEvidenceHash(raw);
  const open = p && a.openProposal !== 0n && p.id === a.openProposal ? p : null;
  const error = raw.trim() !== "" && !hash ? "Enter a 32-byte hash: 0x and 64 hex characters, not all zero." : null;
  return (
    <details className="rounded-m border border-line">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm text-muted hover:text-text">
        <span>Appeal a slash proposal (advanced)</span>
        {open ? <StatusTag tone="warn">Proposal #{open.id.toString()} open</StatusTag> : <span className="text-xs text-faint">No open proposal</span>}
      </summary>
      <div className="space-y-3 border-t border-line px-4 py-4 text-xs leading-relaxed text-muted">
        <p>
          An appeal records the keccak256 hash of your appeal bundle on-chain during the appeal window. Send the bundle itself through the{" "}
          <Link href="/docs/support" className="link">
            support page
          </Link>
          ; its format is in{" "}
          <a href={repoFile("docs/node-staking.md#appeal-bundle")} className="link" target="_blank" rel="noreferrer">
            docs/node-staking.md
          </a>
          . You can appeal again with a new hash while the window is open; the latest counts. An appeal does not stop the clock: the treasury Safe decides.
        </p>
        {!open ? (
          <p className="text-text">There is no open proposal against this wallet, so there is nothing to appeal.</p>
        ) : (
          <form
            noValidate
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (hash && open.canAppeal && !disabled) actions.appeal(open.id, hash);
            }}
          >
            <label htmlFor="appeal-hash" className="block text-sm text-text">
              Appeal bundle hash for proposal #{open.id.toString()}
            </label>
            <input
              id="appeal-hash"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "appeal-hash-err" : undefined}
              className={fieldClass}
            />
            {error ? (
              <p id="appeal-hash-err" className="text-xs text-rust">
                {error}
              </p>
            ) : null}
            {!open.canAppeal ? <p className="text-text">The appeal window of this proposal is over.</p> : null}
            <Button type="submit" variant="secondary" disabled={disabled || !open.canAppeal || !hash}>
              Record the appeal
            </Button>
          </form>
        )}
        <TxNotice tx={m.tx} actions={["appeal"]} onDismiss={actions.dismiss} />
      </div>
    </details>
  );
}

/** The panel, drawn from a model only. */
export function StakePanelView({ model: m, actions }: { model: StakeModel; actions: StakeActions }) {
  const r = m.rules.state === "ok" ? m.rules.value : null;
  const a = m.account.state === "ok" ? m.account.value : null;
  const p = m.proposal?.state === "ok" ? m.proposal.value : null;
  const disabled = !m.connected || m.wrongNetwork || isBusy(m.tx) || !r || !a;
  const readError = m.rules.state === "error" || (m.connected && m.account.state === "error");

  const tag = !m.contract ? (
    <StatusTag tone="off">Not on this network</StatusTag>
  ) : !m.mounted ? null : !m.connected ? (
    <StatusTag tone="off">Disconnected</StatusTag>
  ) : m.wrongNetwork ? (
    <StatusTag tone="warn">Wrong network</StatusTag>
  ) : readError ? (
    <StatusTag tone="error">Not read</StatusTag>
  ) : a ? (
    <StatusTag tone="live">Connected</StatusTag>
  ) : (
    <StatusTag tone="neutral">Reading</StatusTag>
  );

  /** A value, its loading bar, or a dash that says it was not read: never a zero in place of a failed read. */
  const val = (v: ReactNode | null, state: Read<unknown>["state"]) => (v !== null ? v : state === "loading" ? <Skeleton /> : <Dash why="Not read" />);

  return (
    <section aria-labelledby="stake-title" id="stake" className="min-w-0 scroll-mt-24 rounded-l border border-line bg-coal">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
        <h2 id="stake-title" className="font-medium text-text">
          Your stake
        </h2>
        {tag}
      </div>

      {!m.contract ? (
        <div className="px-5 py-4">
          <Notice tone="warn" title="Staking is not available on this network">
            The stake contract is not deployed here. Running a node needs no stake.
          </Notice>
        </div>
      ) : !m.mounted ? (
        <div className="px-5 py-5">
          <Skeleton className="w-40" />
        </div>
      ) : !m.connected ? (
        <div className="space-y-4 px-5 py-5">
          <p className="text-sm leading-relaxed text-muted">
            Connect the wallet you linked as your nodes&apos; owner to see its SPARE, its stake and any slash proposal against it, and to stake or unstake.
          </p>
          <p className="text-sm leading-relaxed text-muted">
            You don&apos;t have to. Staking is optional collateral and pays nothing.{" "}
            {r && r.minStakePerNode > 0n ? (
              <>
                The minimum is <Spare wei={r.minStakePerNode} className="text-text" /> per active node.
              </>
            ) : (
              <>The minimum stake per node is 0, so a node runs, and is paid for checked work, without any token.</>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <WalletButton className="h-10 px-4" />
            <Link href="/docs/run-a-node#staking" className="link text-sm">
              How staking works
            </Link>
          </div>
        </div>
      ) : (
        <>
          <dl className="divide-y divide-line border-b border-line">
            <SummaryRow label="Wallet">{m.address ? <Hex value={m.address} /> : <Dash />}</SummaryRow>
            <SummaryRow label="SPARE in your wallet" hint="Not staked. Only this wallet can move it.">
              {val(a ? <Spare wei={a.balance} /> : null, m.account.state)}
            </SummaryRow>
            <SummaryRow label="Staked" hint="Locked in the stake contract. Counts toward the minimum; only a slash proposal you can appeal can take part of it.">
              {val(a ? <Spare wei={a.staked} className="font-medium" /> : null, m.account.state)}
            </SummaryRow>
            <SummaryRow
              label="Unstaking"
              hint="Requested and waiting out the cooldown. No longer counts as stake; can still be slashed until withdrawn."
              detail={a && r && a.unstaking > 0n ? <CooldownText m={m} r={r} a={a} /> : undefined}
            >
              {!a ? (
                val(null, m.account.state)
              ) : a.unstaking === 0n ? (
                <span className="text-muted">None</span>
              ) : (
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  <Spare wei={a.unstaking} />
                  {a.canUnstake ? (
                    <StatusTag tone="live">Ready</StatusTag>
                  ) : a.openProposal !== 0n ? (
                    <StatusTag tone="warn">Frozen</StatusTag>
                  ) : (
                    <StatusTag tone="neutral">In cooldown</StatusTag>
                  )}
                </span>
              )}
            </SummaryRow>
            <SummaryRow
              label="Slash proposal"
              hint="Proposed by the scheduler, decided by the treasury Safe; you can appeal while its appeal window is open."
              detail={p && r ? <ProposalText m={m} r={r} p={p} /> : undefined}
            >
              {!a ? (
                val(null, m.account.state)
              ) : a.lastProposal === 0n ? (
                <span className="text-muted">None</span>
              ) : p ? (
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  <span className="num">#{p.id.toString()}</span>
                  <StatusTag tone={PROPOSAL_TONE[proposalStatusName(p.status)] ?? "neutral"}>{proposalStatusName(p.status)}</StatusTag>
                </span>
              ) : (
                <span className="inline-flex flex-wrap items-center justify-end gap-2">
                  <span className="num">#{a.lastProposal.toString()}</span>
                  {m.proposal?.state === "error" ? <Dash why="Status not read" /> : <Skeleton className="w-16" />}
                </span>
              )}
            </SummaryRow>
            <SummaryRow
              label="Minimum stake per node"
              hint="Per active node, read from the contract. Only the treasury Safe can change it, with at least one epoch's notice."
              detail={r && r.minStakePerNode === 0n ? "Zero: running a node needs no token and no stake." : undefined}
            >
              {val(r ? <Spare wei={r.minStakePerNode} /> : null, m.rules.state)}
            </SummaryRow>
          </dl>

          <div className="space-y-7 px-5 py-5">
            {m.wrongNetwork ? (
              <div className="space-y-3">
                <Notice tone="warn" title="Wrong network">
                  Your wallet is on chain id <span className="num">{m.chainId}</span>. Staking works only on {targetChain.name} (chain id{" "}
                  <span className="num">{targetChain.id}</span>). The figures above are read from {targetChain.name} either way.
                </Notice>
                <WalletButton className="h-10 px-4" />
              </div>
            ) : null}

            {readError ? (
              <Notice
                tone="error"
                title={m.rules.state === "error" ? "Could not read the stake contract" : "Could not read your stake"}
                action={
                  <Button size="sm" variant="secondary" onClick={actions.retry}>
                    Retry
                  </Button>
                }
              >
                The chain did not answer. Nothing is shown rather than a zero, and the buttons stay off until it answers. Your SPARE stays where it is.
              </Notice>
            ) : null}

            {r && a ? (
              <>
                {/* A confirmed stake or appeal remounts its form, so the amount or hash just sent is not left in the field. */}
                <StakeAction key={`stake-${m.resets.stake}`} m={m} a={a} actions={actions} disabled={disabled} />
                {a.staked > 0n ? <RequestUnstakeAction m={m} r={r} a={a} actions={actions} disabled={disabled} /> : null}
                {a.unstaking > 0n ? <CooldownActions m={m} a={a} actions={actions} disabled={disabled} /> : null}
                <AppealAction key={`appeal-${m.resets.appeal}`} m={m} a={a} p={p} actions={actions} disabled={disabled} />
              </>
            ) : null}
          </div>
        </>
      )}

      <div className="space-y-1.5 border-t border-line px-5 py-4 text-xs leading-relaxed text-faint">
        {m.contract ? (
          <p className="flex flex-wrap items-center gap-x-1.5">
            SparecycleNodeStake <Hex value={m.contract} />
          </p>
        ) : null}
        <p>
          {r ? `At most ${formatBps(r.slashBps)} of a stake per proposal, and it is burned. ` : null}Not trustless: the scheduler proposes, the treasury Safe
          decides. Internal review only, not externally audited.{" "}
          <a href={repoFile("docs/node-staking.md")} className="link" target="_blank" rel="noreferrer">
            The rules in full
          </a>
        </p>
      </div>
    </section>
  );
}
