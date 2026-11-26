"use client";

// The claim panel of /token/holders (docs/token-features.md), shown only with TOKEN_HOLDERS on. A connected wallet sees
// its share per epoch from GET /api/v1/holders/:address and claims it as compute credits: one claim transaction per
// epoch (SparecycleHolderPool has no batch claim), mode 1 only, proof checked in this browser first. Any address can be
// looked up read-only (addresses and amounts are public on-chain anyway). Credits pay for Sparecycle jobs and cannot be
// withdrawn or transferred; unclaimed shares roll back into the pool after the claim window.
import { useState, type FormEvent } from "react";
import { BaseError, getAddress, isAddress, UserRejectedRequestError, zeroAddress, type Address, type Hex } from "viem";
import { useConfig, useReadContract } from "wagmi";
import { simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { Hex as HexValue } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag, type Tone } from "@/components/ui/status";
import { targetChain } from "@/lib/chain";
import { revertName } from "@/lib/dapp/claim-errors";
import { useApiGet } from "@/lib/dapp/use-api";
import { useWallet } from "@/lib/dapp/use-wallet";
import { formatAmount } from "@/lib/format";
import { holderLeafOf, verifyProof } from "@/lib/merkle";
import { holderPoolAbi, jobPaymentsV2Abi } from "@/lib/token-contracts";
import { Dash, Panel, TableBox, TableMessage, td, th } from "./ui";
import { WalletButton } from "./wallet-button";

type Entry = {
  epochId: number;
  state: "claimable" | "claimed" | "expired" | "pending" | "not-posted" | "unknown";
  mode: number;
  amountWei: string;
  leaf: Hex;
  proof: Hex[];
  root: Hex;
  postedTx: { hash: string; url: string } | null;
  claimableUntilEpoch: number | null;
};
type Account = { address: Address; live: boolean; openEpoch: number | null; creditWei: string | null; claimableWei: string; entries: Entry[] };
type TxState = { phase: "checking" | "signing" | "pending" | "confirmed" | "failed"; hash?: Hex; error?: string };

const eth = (wei: bigint | string) => formatAmount(BigInt(wei), 18, 6);

const STATE: Record<Entry["state"], { tone: Tone; label: string }> = {
  claimable: { tone: "live", label: "Claimable" },
  claimed: { tone: "neutral", label: "Claimed" },
  expired: { tone: "off", label: "Rolled back to the pool" },
  pending: { tone: "warn", label: "Root not posted yet" },
  "not-posted": { tone: "off", label: "Not posted" },
  unknown: { tone: "warn", label: "Could not read" },
};

const ERRORS: Record<string, (epoch: number) => string> = {
  AlreadyClaimed: (e) => `This wallet has already claimed epoch ${e}.`,
  ClaimWindowClosed: (e) => `The claim window of epoch ${e} has closed. Its unclaimed shares roll back into the pool.`,
  InvalidProof: () => "The contract rejected the proof: it does not lead from this wallet and amount to the posted root. Nothing was sent.",
  NotPosted: (e) => `The root of epoch ${e} is not posted on-chain yet.`,
  ClaimExceedsTotal: (e) => `This claim would take more than the root of epoch ${e} holds, so the contract refused it.`,
  UnknownMode: () => "The contract refused the mode. Only compute credits can be claimed.",
  NvdaModeNotAvailable: () => "The contract refused the mode. Only compute credits can be claimed.",
};

function explain(error: unknown, epoch: number): string {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return "You rejected the request in your wallet. Nothing was sent.";
    const name = revertName(error);
    if (name && ERRORS[name]) return ERRORS[name](epoch);
    if (name) return `The contract refused the claim (${name}). Nothing was credited.`;
    return error.shortMessage || "The transaction failed. Nothing was credited.";
  }
  return error instanceof Error ? error.message : "The transaction failed. Nothing was credited.";
}

export function HolderClaims({
  live,
  pool,
  jobPaymentsV2,
  rolloverEpochs,
}: {
  live: boolean;
  pool: Address | null;
  jobPaymentsV2: Address | null;
  rolloverEpochs: number;
}) {
  const wagmiConfig = useConfig();
  const { address, chainId, isConnected, mounted } = useWallet();
  const wrongNetwork = isConnected && chainId !== targetChain.id;
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const [viewed, setViewed] = useState<Address | null>(null);
  const target = viewed ?? address ?? null;
  const own = !!address && !!target && target.toLowerCase() === address.toLowerCase();

  const q = useApiGet<Account>(live && target ? `/holders/${target}` : null, 30_000);
  const account = q.result?.ok ? q.result.data : null;
  const failure = q.result && !q.result.ok ? q.result.failure : null;
  const credit = useReadContract({
    address: jobPaymentsV2 ?? zeroAddress,
    abi: jobPaymentsV2Abi,
    functionName: "creditOf",
    args: [target ?? zeroAddress],
    chainId: targetChain.id,
    query: { enabled: live && !!jobPaymentsV2 && !!target },
  });
  const creditWei = credit.data ?? (account?.creditWei ? BigInt(account.creditWei) : null);
  const [txs, setTxs] = useState<Record<number, TxState>>({});
  const busy = Object.values(txs).some((t) => t.phase === "checking" || t.phase === "signing" || t.phase === "pending");

  function lookUp(e: FormEvent) {
    e.preventDefault();
    const v = typed.trim();
    if (v === "") {
      setViewed(null);
      setTypedError(null);
      return;
    }
    if (!isAddress(v, { strict: false })) {
      setTypedError("Enter a 0x address (40 hex characters).");
      return;
    }
    setTypedError(null);
    setViewed(getAddress(v));
  }

  async function claim(entry: Entry) {
    if (!pool || !address) return;
    const set = (t: TxState) => setTxs((m) => ({ ...m, [entry.epochId]: t }));
    set({ phase: "checking" });
    try {
      const amount = BigInt(entry.amountWei);
      const leaf = holderLeafOf(BigInt(entry.epochId), getAddress(address), entry.mode, amount);
      if (leaf.toLowerCase() !== entry.leaf.toLowerCase() || !verifyProof(entry.proof, entry.root, leaf)) {
        throw new Error("The proof from the scheduler does not match this wallet and amount. Nothing was sent.");
      }
      const { request } = await simulateContract(wagmiConfig, {
        address: pool,
        abi: holderPoolAbi,
        functionName: "claim",
        args: [BigInt(entry.epochId), entry.mode, amount, entry.proof],
        account: address,
        chainId: targetChain.id,
      });
      set({ phase: "signing" });
      const hash = await writeContract(wagmiConfig, request);
      set({ phase: "pending", hash });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: targetChain.id });
      set(receipt.status === "success" ? { phase: "confirmed", hash } : { phase: "failed", hash, error: "The transaction reverted. Nothing was credited." });
    } catch (e) {
      setTxs((m) => ({ ...m, [entry.epochId]: { phase: "failed", hash: m[entry.epochId]?.hash, error: explain(e, entry.epochId) } }));
    } finally {
      q.reload();
      void credit.refetch();
    }
  }

  if (!live) {
    return (
      <Notice tone="warn" title="Claiming is not live yet">
        SparecycleHolderPool and SparecycleJobPaymentsV2 are not deployed. Once both are, each epoch&apos;s holder share is
        posted as a Merkle root and eligible holders can claim it here as compute credits.
      </Notice>
    );
  }

  const entries = account?.entries ?? [];
  const claimable = entries.filter((e) => e.state === "claimable");
  const until = (e: Entry) => {
    if (e.claimableUntilEpoch === null) return <Dash why="Set when the root is posted" />;
    const left = account?.openEpoch === null || account?.openEpoch === undefined ? null : e.claimableUntilEpoch - account.openEpoch;
    return (
      <span>
        Epoch <span className="num">{e.claimableUntilEpoch}</span>
        {e.state === "claimable" && left !== null ? (
          <span className="ml-1.5 text-faint">
            ({left === 0 ? "last epoch" : `${left} epoch${left === 1 ? "" : "s"} left`})
          </span>
        ) : null}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <Panel
          title={own ? "Your holder shares" : target ? "Holder shares of this address" : "Holder shares"}
          aside={
            !mounted ? null : !isConnected ? (
              <StatusTag tone="off">Disconnected</StatusTag>
            ) : wrongNetwork ? (
              <StatusTag tone="warn">Wrong network</StatusTag>
            ) : (
              <StatusTag tone="live">Connected</StatusTag>
            )
          }
        >
          <dl className="grid gap-px overflow-hidden sm:grid-cols-3 [&>*]:shadow-[0_0_0_1px_#1f1f1f]">
            <div className="flex min-w-0 flex-col gap-1.5 bg-coal px-5 py-3.5">
              <dt className="text-sm text-muted">Address</dt>
              <dd className="min-h-6 min-w-0 text-[15px] text-text">{target ? <HexValue value={target} head={8} tail={6} /> : <Dash why="Connect a wallet" />}</dd>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 bg-coal px-5 py-3.5">
              <dt className="text-sm text-muted">Claimable now</dt>
              <dd className="min-h-6 text-[15px] text-text">
                {account ? (
                  <>
                    <span className="num">{eth(account.claimableWei)}</span> <span className="text-sm text-muted">ETH of credits</span>
                  </>
                ) : (
                  <Dash why={target ? (q.loading ? "Reading" : "Not available") : undefined} />
                )}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5 bg-coal px-5 py-3.5">
              <dt className="text-sm text-muted">Compute credits</dt>
              <dd className="min-h-6 text-[15px] text-text">
                {creditWei !== null ? (
                  <>
                    <span className="num">{eth(creditWei)}</span> <span className="text-sm text-muted">ETH</span>
                  </>
                ) : (
                  <Dash why={target ? "Reading" : undefined} />
                )}
              </dd>
              <dd className="text-xs text-faint">Spend-only balance in SparecycleJobPaymentsV2.</dd>
            </div>
          </dl>
          <div className="border-t border-line px-5 py-4">
            {!mounted ? null : !isConnected ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted">Connect the wallet that holds your SPARE to see and claim its share.</p>
                <WalletButton className="h-10 px-4" />
              </div>
            ) : wrongNetwork ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-text">
                  Switch your wallet to {targetChain.name} (chain id <span className="num">{targetChain.id}</span>) to claim.
                </p>
                <WalletButton className="h-10 px-4" />
              </div>
            ) : (
              <p className="text-sm text-muted">
                {claimable.length && own
                  ? `${claimable.length} epoch${claimable.length === 1 ? "" : "s"} to claim. Each claim is its own transaction; you pay the gas.`
                  : own
                    ? "Nothing to claim for this wallet right now."
                    : "Viewing another address: only its own wallet can claim."}
              </p>
            )}
          </div>
        </Panel>

        <Panel title="Look up an address">
          <form onSubmit={lookUp} className="space-y-2 px-5 py-4" noValidate>
            <label htmlFor="holder-lookup" className="text-sm text-muted">
              Any address, read only
            </label>
            <div className="flex gap-2">
              <input
                id="holder-lookup"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="0x…"
                aria-invalid={!!typedError}
                aria-describedby={typedError ? "holder-lookup-error" : undefined}
                className="num h-10 min-w-0 flex-1 rounded-m border border-line-strong bg-slate px-3 text-sm text-text placeholder:text-faint"
              />
              <Button type="submit" variant="secondary">
                {typed.trim() === "" && viewed ? "Back to my wallet" : "Look up"}
              </Button>
            </div>
            {typedError ? (
              <p id="holder-lookup-error" className="text-xs text-rust">
                {typedError}
              </p>
            ) : null}
          </form>
        </Panel>
      </div>

      {failure ? (
        <Notice tone="error" title="Could not read the holder shares">
          {failure.kind === "http" ? `${failure.status} ${failure.code ?? ""}`.trim() : "The scheduler API did not answer."} Claiming stays off until it does.
        </Notice>
      ) : null}

      <Panel title="Shares per epoch" footer={`Unclaimed shares roll back into the pool ${rolloverEpochs} epochs after their root is posted. Claimed shares become compute credits at once.`}>
        <TableBox label="Holder shares per epoch" minWidth={760}>
          <thead>
            <tr>
              <th className={th}>Epoch</th>
              <th className={th}>Share</th>
              <th className={th}>State</th>
              <th className={th}>Claim until</th>
              <th className={th}>Root</th>
              <th className={th}>
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {!target ? (
              <TableMessage colSpan={6}>Connect a wallet or look up an address.</TableMessage>
            ) : q.loading && !account ? (
              <TableMessage colSpan={6}>Reading the holder shares…</TableMessage>
            ) : !entries.length ? (
              <TableMessage colSpan={6}>
                No share for this address yet. An address gets one for an epoch when its time-weighted SPARE is at or above the minimum and it is not excluded.
              </TableMessage>
            ) : (
              entries.map((e) => {
                const t = txs[e.epochId];
                const s = t?.phase === "confirmed" ? { tone: "live" as Tone, label: "Claimed just now" } : STATE[e.state];
                const canClaim = e.state === "claimable" && own && !wrongNetwork && !!pool && !busy && t?.phase !== "confirmed";
                return (
                  <tr key={e.epochId}>
                    <td className={`${td} num text-text`}>{e.epochId}</td>
                    <td className={`${td} text-text`}>
                      <span className="num">{eth(e.amountWei)}</span> <span className="text-muted">ETH</span>
                    </td>
                    <td className={td}>
                      <StatusTag tone={s.tone}>{s.label}</StatusTag>
                    </td>
                    <td className={`${td} text-muted`}>{until(e)}</td>
                    <td className={td}>{e.postedTx ? <HexValue value={e.postedTx.hash} kind="tx" head={6} tail={4} /> : <Dash />}</td>
                    <td className={`${td} text-right`}>
                      {e.state === "claimable" && own ? (
                        <Button size="sm" disabled={!canClaim} onClick={() => claim(e)}>
                          {t?.phase === "checking"
                            ? "Checking…"
                            : t?.phase === "signing"
                              ? "Confirm in your wallet…"
                              : t?.phase === "pending"
                                ? "Waiting for confirmation…"
                                : "Claim as compute credits"}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </TableBox>
      </Panel>

      {Object.entries(txs)
        .filter(([, t]) => t.phase === "pending" || t.phase === "confirmed" || t.phase === "failed")
        .map(([epoch, t]) => (
          <Notice
            key={epoch}
            tone={t.phase === "confirmed" ? "live" : t.phase === "failed" ? "error" : "neutral"}
            title={t.phase === "confirmed" ? `Epoch ${epoch} claimed as compute credits` : t.phase === "failed" ? `The claim of epoch ${epoch} did not go through` : `Claim of epoch ${epoch} submitted`}
            action={
              t.phase !== "pending" ? (
                <Button size="sm" variant="secondary" onClick={() => setTxs((m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== epoch)))}>
                  Dismiss
                </Button>
              ) : undefined
            }
          >
            <span className="inline-flex flex-wrap items-center gap-2">
              {t.phase === "failed" ? <span>{t.error}</span> : null}
              {t.phase === "confirmed" ? (
                <span>
                  Your credit balance is now <span className="num">{creditWei !== null ? eth(creditWei) : "being read"}</span> ETH. Credits pay for jobs and cannot be withdrawn or transferred.
                </span>
              ) : null}
              {t.phase === "pending" ? <span>Waiting for confirmation. Do not submit again.</span> : null}
              {t.hash ? (
                <span className="inline-flex items-center gap-1.5">
                  Transaction <HexValue value={t.hash} kind="tx" />
                </span>
              ) : null}
            </span>
          </Notice>
        ))}
    </div>
  );
}
