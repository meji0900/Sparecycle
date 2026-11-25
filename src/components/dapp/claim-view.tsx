"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { getAddress, zeroAddress, type Hex } from "viem";
import {
  useReadContract,
  useReadContracts,
  useSimulateContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import Stepper, { Step as StepPane } from "@/components/reactbits/Stepper";
import { Hex as HexValue } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag, type Tone } from "@/components/ui/status";
import { sparecycleRewardsAbi, type EpochStruct } from "@/contracts/sparecycleRewards";
import { targetChain } from "@/lib/chain";
import { config, payoutAssetLabel } from "@/lib/config";
import { apiDown, type ApiFailure, type EpochsResponse, type ProofResponse, type TreeResponse } from "@/lib/dapp/api";
import { explainClaimError, revertName } from "@/lib/dapp/claim-errors";
import { formatPayout, payoutUnit } from "@/lib/dapp/payout";
import { useApiGet } from "@/lib/dapp/use-api";
import { useWallet } from "@/lib/dapp/use-wallet";
import { formatTime } from "@/lib/format";
import { buildTree, leafOf, verifyProof } from "@/lib/merkle";
import { useLiveJson, type ChainApi } from "@/lib/use-live";
import { cn } from "@/lib/utils";
import { PageHeader } from "./app-shell";
import { RootHash } from "./live-values";
import { MerkleTreePanel, type MerkleView } from "./merkle-tree-panel";
import { ProofChecker, type CheckedPath } from "./proof-checker";
import { Dash, Row } from "./ui";
import { WalletButton } from "./wallet-button";

const ZERO_ROOT = `0x${"00".repeat(32)}`;
/** Above this many leaves the browser does not rebuild the whole tree; the 3D view shows the path only. */
const MAX_TREE_LEAVES = 4096;

type Blocker = { tone: Tone; tag: string; title: string; body?: ReactNode };

/** Title row inside a Stepper pane. */
function PaneHead({ title, tag }: { title: string; tag?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-medium text-text">{title}</h2>
      {tag}
    </div>
  );
}

// React Bits Stepper restyled to the tokens: flat well, hairline tile, green only for a completed step.
const STEPPER_TOKENS = {
  "--stepper-frame": "transparent",
  "--stepper-frame-edge": "rgba(255, 255, 255, 0.08)",
  "--stepper-frame-highlight": "transparent",
  "--stepper-frame-shadow": "none",
  "--stepper-tile": "#1a1a1a",
  "--stepper-tile-edge": "rgba(255, 255, 255, 0.14)",
  "--stepper-tile-highlight": "transparent",
  "--stepper-tile-shadow": "none",
  "--stepper-well": "rgba(255, 255, 255, 0.03)",
  "--stepper-track": "rgba(255, 255, 255, 0.08)",
  "--stepper-ink": "#ededed",
  "--stepper-muted": "#9b9b9b",
  "--stepper-faint": "rgba(255, 255, 255, 0.2)",
  "--stepper-ring": "rgba(255, 255, 255, 0.3)",
  "--stepper-solid": "#00c805",
  "--stepper-solid-ink": "#041a05",
  "--stepper-hover": "none",
  "--stepper-hover-fill": "rgba(255, 255, 255, 0.03)",
} as CSSProperties;

function proofFailure(f: ApiFailure, epochId: number): Blocker {
  if (apiDown(f)) {
    return {
      tone: "error",
      tag: "Scheduler API not reachable",
      title: "Scheduler API not reachable",
      body: "Proofs come from the scheduler API in this MVP. A self-supplied proof is not the default, so claiming stays off until the API answers. You can still check a proof by hand below.",
    };
  }
  if (f.kind === "http" && f.code === "not-in-root") {
    return {
      tone: "neutral",
      tag: "Not in root",
      title: `This wallet is not in the root of epoch ${epochId}`,
      body: "It had no agreed jobs in that epoch, or the pot was empty when the epoch closed. Only the wallet linked as a node's owner appears in the tree.",
    };
  }
  if (f.kind === "http" && f.code === "epoch-open") {
    return { tone: "warn", tag: "Root not posted", title: "Claims open when this epoch is settled" };
  }
  if (f.kind === "http" && f.code === "unknown-epoch") {
    return { tone: "neutral", tag: "Unknown epoch", title: `The scheduler has no epoch ${epochId}` };
  }
  return {
    tone: "error",
    tag: "Proof unavailable",
    title: "The scheduler did not return a proof",
    body: f.kind === "http" ? `${f.status} ${f.code ?? ""} ${f.message ?? ""}`.trim() : undefined,
  };
}

export function ClaimView() {
  const contract = config.rewardContract;
  const chain = useLiveJson<ChainApi>("/api/chain", 30_000);
  const unit = payoutUnit(chain.data);
  const epochsQ = useApiGet<EpochsResponse>("/epochs", 30_000);
  const { address, chainId, isConnected, mounted } = useWallet();
  const wrongNetwork = isConnected && chainId !== targetChain.id;

  const epochs = epochsQ.result?.ok ? epochsQ.result.data.epochs : null;
  const epochsDown = epochsQ.result && !epochsQ.result.ok ? epochsQ.result.failure : null;
  const candidates = useMemo(() => (epochs ?? []).filter((e) => e.status !== "open").slice(0, 24), [epochs]);

  // Settled flags on-chain for the scheduler's closed epochs.
  const flagReads = useReadContracts({
    contracts: candidates.map((e) => ({
      address: contract ?? zeroAddress,
      abi: sparecycleRewardsAbi,
      functionName: "getEpoch" as const,
      args: [BigInt(e.id)] as const,
      chainId: targetChain.id,
    })),
    query: { enabled: !!contract && candidates.length > 0 },
  });
  const options = useMemo(() => {
    if (!contract) return candidates.map((e) => ({ epoch: e, onchain: null as EpochStruct | null }));
    return candidates
      .map((e, i) => {
        const r = flagReads.data?.[i];
        return { epoch: e, onchain: r && r.status === "success" ? (r.result as EpochStruct) : null };
      })
      .filter((o) => o.onchain?.settled);
  }, [candidates, contract, flagReads.data]);

  const [selected, setSelected] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const reduced = useReducedMotion();
  const epochId = selected ?? options[0]?.epoch.id ?? null;
  const apiEpoch = epochs?.find((e) => e.id === epochId) ?? null;
  const idArg = epochId !== null ? BigInt(epochId) : 0n;

  // On-chain state of the selected epoch and the claim flags.
  const onchainQ = useReadContract({
    address: contract ?? zeroAddress,
    abi: sparecycleRewardsAbi,
    functionName: "getEpoch",
    args: [idArg],
    chainId: targetChain.id,
    query: { enabled: !!contract && epochId !== null },
  });
  const pausedQ = useReadContract({
    address: contract ?? zeroAddress,
    abi: sparecycleRewardsAbi,
    functionName: "claimsPaused",
    chainId: targetChain.id,
    query: { enabled: !!contract },
  });
  const claimedQ = useReadContract({
    address: contract ?? zeroAddress,
    abi: sparecycleRewardsAbi,
    functionName: "hasClaimed",
    args: [idArg, address ?? zeroAddress],
    chainId: targetChain.id,
    query: { enabled: !!contract && epochId !== null && !!address },
  });
  const onchain = onchainQ.data ?? null;

  // Proof and published tree from the scheduler.
  const proofQ = useApiGet<ProofResponse>(epochId !== null && address ? `/epochs/${epochId}/proof?account=${address}` : null);
  const proofData = proofQ.result?.ok ? proofQ.result.data : null;
  const proofFail = proofQ.result && !proofQ.result.ok ? proofQ.result.failure : null;
  const wantTree = epochId !== null && apiEpoch !== null && apiEpoch.status !== "open" && apiEpoch.leaves > 0 && apiEpoch.leaves <= MAX_TREE_LEAVES;
  const treeQ = useApiGet<TreeResponse>(wantTree ? `/epochs/${epochId}/tree` : null);
  const treeData = treeQ.result?.ok ? treeQ.result.data : null;

  const layers = useMemo(() => {
    if (!treeData || !treeData.leaves.length) return null;
    try {
      const t = buildTree(treeData.leaves.map((l) => l.leaf as Hex));
      return t.root.toLowerCase() === treeData.root.toLowerCase() ? t.layers : null;
    } catch {
      return null;
    }
  }, [treeData]);

  // Everything the browser checks before the claim button turns on.
  const check = useMemo(() => {
    if (!proofData || !address || epochId === null) return null;
    try {
      const account = getAddress(proofData.account);
      const amount = BigInt(proofData.amount);
      const proof = proofData.proof.map((p) => p.toLowerCase() as Hex);
      const leaf = leafOf(BigInt(proofData.epochId), account, amount);
      const onchainRoot = onchain ? onchain.merkleRoot : null;
      return {
        malformed: false as const,
        amount,
        proof,
        leaf,
        forAccount: account === getAddress(address),
        forEpoch: Number(proofData.epochId) === epochId,
        leafMatches: leaf.toLowerCase() === proofData.leaf.toLowerCase(),
        verifiesPublished: verifyProof(proof, proofData.root as Hex, leaf),
        rootMatch: onchainRoot ? onchainRoot.toLowerCase() === proofData.root.toLowerCase() : null,
        verifiesOnchain: onchainRoot && onchainRoot !== ZERO_ROOT ? verifyProof(proof, onchainRoot, leaf) : null,
      };
    } catch {
      return { malformed: true as const };
    }
  }, [proofData, address, epochId, onchain]);
  const good = check && !check.malformed ? check : null;

  // Epoch-level state (no wallet needed).
  const epochBlocker: Blocker | null = (() => {
    if (!contract) return { tone: "warn", tag: "Contract not configured", title: "Reward contract not set", body: "Claims are disabled until the reward contract address is configured. Proofs can still be checked below." };
    if (epochsDown && apiDown(epochsDown) && epochId === null) return proofFailure(epochsDown, 0);
    if (epochId === null) {
      if (epochsQ.loading || flagReads.isLoading) return { tone: "neutral", tag: "Loading", title: "Looking for settled epochs" };
      return { tone: "neutral", tag: "No settled epoch", title: "No epoch has been settled on-chain yet", body: "Claims open when an epoch is settled: the scheduler closes it and posts its Merkle root." };
    }
    if (onchainQ.isLoading) return { tone: "neutral", tag: "Reading", title: "Reading the epoch from the contract" };
    if (onchainQ.isError || !onchain) return { tone: "error", tag: "Read failed", title: "Could not read this epoch from the contract", body: "Claiming stays off until the read succeeds." };
    if (!onchain.settled) return { tone: "warn", tag: "Root not posted", title: "Claims open when this epoch is settled", body: `Epoch ${epochId} has no Merkle root on-chain yet.` };
    if (onchain.pot === 0n) return { tone: "warn", tag: "Pot empty", title: "No fees have been claimed into this epoch. There is nothing to pay." };
    if (pausedQ.data === true) return { tone: "warn", tag: "Claims paused", title: "Claims are paused by the contract owner", body: "The owner can pause claims in an emergency. It cannot withdraw the pot. Reserved amounts stay claimable after an unpause." };
    return null;
  })();

  // Wallet-level state.
  const walletBlocker: Blocker | null = (() => {
    if (!isConnected || !address) return { tone: "off", tag: "Disconnected", title: "Connect a wallet to fetch your proof" };
    if (wrongNetwork) return { tone: "warn", tag: "Wrong network", title: `Switch your wallet to ${targetChain.name} (chain id ${targetChain.id})` };
    if (epochId === null) return null;
    if (proofQ.loading) return { tone: "neutral", tag: "Loading", title: "Fetching your proof from the scheduler" };
    if (proofFail) return proofFailure(proofFail, epochId);
    if (!check) return null;
    if (check.malformed || !check.forAccount || !check.forEpoch || !check.leafMatches) {
      return { tone: "error", tag: "Invalid proof", title: "The proof does not match this wallet, epoch and amount", body: "Claiming is disabled." };
    }
    if (claimedQ.data === true) return { tone: "neutral", tag: "Already claimed", title: `This wallet has already claimed epoch ${epochId}` };
    if (check.rootMatch === false) {
      return { tone: "error", tag: "Root mismatch", title: "The scheduler's root differs from the on-chain root", body: "Claiming is disabled (fail closed). The posted root is the only one the contract accepts." };
    }
    if (check.verifiesOnchain === false) return { tone: "error", tag: "Invalid proof", title: "The proof does not lead to the on-chain root", body: "Claiming is disabled." };
    if (onchain && check.amount > onchain.reserved - onchain.claimed) {
      return { tone: "error", tag: "Exceeds reserved", title: "This amount is more than is still reserved for the epoch", body: "The contract would refuse it. Claiming is disabled." };
    }
    return null;
  })();

  const blocker = epochBlocker ?? walletBlocker;
  const ready = !blocker && !!good && good.verifiesOnchain === true && good.rootMatch === true && claimedQ.data === false;

  const sim = useSimulateContract({
    address: contract ?? zeroAddress,
    abi: sparecycleRewardsAbi,
    functionName: "claim",
    args: [idArg, good?.amount ?? 0n, good?.proof ?? []],
    account: address,
    chainId: targetChain.id,
    query: { enabled: ready },
  });
  const write = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash: write.data, chainId: targetChain.id, query: { enabled: !!write.data } });
  const [claimedAmount, setClaimedAmount] = useState<{ hash: string; amount: bigint; epoch: number } | null>(null);

  const { refetch: refetchClaimed } = claimedQ;
  const { refetch: refetchEpoch } = onchainQ;
  useEffect(() => {
    if (receipt.isSuccess) {
      refetchClaimed();
      refetchEpoch();
    }
  }, [receipt.isSuccess, refetchClaimed, refetchEpoch]);

  const simError = ready && sim.isError ? sim.error : null;
  const busy = write.isPending || (!!write.data && receipt.isLoading);
  const canClaim = ready && !!sim.data && !busy;

  function claim() {
    if (!sim.data || !good || epochId === null) return;
    const amount = good.amount;
    const epoch = epochId;
    write.writeContract(sim.data.request, {
      onSuccess: (hash) => setClaimedAmount({ hash, amount, epoch }),
    });
  }

  function loadTyped(e: FormEvent) {
    e.preventDefault();
    const v = typed.trim();
    if (!/^\d{1,15}$/.test(v)) {
      setTypedError("Enter a whole epoch number, for example 3.");
      return;
    }
    setTypedError(null);
    setSelected(Number(v));
    setPick(null);
    write.reset();
  }

  const fmt = (v: bigint | string | null | undefined) => {
    const f = formatPayout(v ?? null, unit);
    return (
      <>
        <span className="num">{f.value}</span> <span className="text-muted">{f.unit}</span>
      </>
    );
  };

  // 3D view: published tree with the path, else the path only, else the tree alone, else the example.
  const [manual, setManual] = useState<CheckedPath | null>(null);
  const verified = good ? (contract ? good.verifiesOnchain : good.verifiesPublished) : null;
  const view: MerkleView = manual
    ? { kind: "path", epochId: manual.epochId, leaf: manual.leaf, proof: manual.proof, verified: manual.verified }
    : good && layers
      ? { kind: "tree", epochId: epochId!, layers, leaf: good.leaf, verified }
      : good
        ? { kind: "path", epochId, leaf: good.leaf, proof: good.proof, verified }
        : layers && epochId !== null
          ? { kind: "tree", epochId, layers, leaf: null, verified: null }
          : { kind: "example" };

  const txError = write.error ?? receipt.error ?? (receipt.data?.status === "reverted" ? new Error("The transaction reverted. Nothing was paid.") : null);
  const succeeded = receipt.isSuccess && receipt.data?.status === "success" && claimedAmount && claimedAmount.hash === write.data;

  const walletTag = !isConnected ? (
    <StatusTag tone="off">Disconnected</StatusTag>
  ) : wrongNetwork ? (
    <StatusTag tone="warn">Wrong network</StatusTag>
  ) : (
    <StatusTag tone="live">Connected</StatusTag>
  );

  // The Stepper follows the real state: wallet → epoch → proof → claim → done. A click can go back to look at an
  // earlier step, never forward past what the state allows.
  const derived = (() => {
    if (!mounted) return 1;
    if (succeeded) return 5;
    if (!isConnected || wrongNetwork) return 1;
    if (epochId === null || (epochBlocker !== null && epochBlocker.tag !== "Contract not configured")) return 2;
    return !ready && !busy ? 3 : 4;
  })();
  const shown = pick !== null && pick <= derived ? pick : derived;
  const selectEpoch = (id: number | null) => {
    setSelected(id);
    setPick(null);
    write.reset();
  };

  const connectPane = (
    <div className="space-y-4">
      <PaneHead title="Connect your wallet" tag={walletTag} />
      {!isConnected ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">Use the wallet you linked as your node&apos;s owner. It is the account inside the Merkle leaf.</p>
          <WalletButton className="h-10 px-4" />
        </div>
      ) : wrongNetwork ? (
        <div className="space-y-4">
          <Notice tone="warn" title="Wrong network">
            Your wallet is on chain id <span className="num">{chainId}</span>. Claims work only on {targetChain.name} (chain id{" "}
            <span className="num">{targetChain.id}</span>).
          </Notice>
          <WalletButton className="h-10 px-4" />
        </div>
      ) : (
        <dl className="divide-y divide-line rounded-m border border-line">
          <Row label="Wallet">{address ? <HexValue value={address} head={8} tail={6} /> : <Dash />}</Row>
          <Row label="Network">
            {targetChain.name} <span className="num text-muted">{targetChain.id}</span>
          </Row>
        </dl>
      )}
    </div>
  );

  const epochPane = (
    <div className="space-y-4">
      <PaneHead
        title="Choose an epoch"
        tag={epochBlocker ? <StatusTag tone={epochBlocker.tone}>{epochBlocker.tag}</StatusTag> : <StatusTag tone="live">Settled</StatusTag>}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="epoch-select" className="text-sm text-muted">
            Settled epochs
          </label>
          <select
            id="epoch-select"
            className="mt-1.5 h-10 w-full rounded-m border border-line-strong bg-slate px-3 text-sm text-text disabled:opacity-50"
            value={epochId !== null && options.some((o) => o.epoch.id === epochId) ? String(epochId) : ""}
            disabled={!options.length}
            onChange={(e) => selectEpoch(e.target.value === "" ? null : Number(e.target.value))}
          >
            {!options.length ? <option value="">{epochsQ.loading ? "Loading epochs" : "No settled epoch yet"}</option> : null}
            {options.length && epochId !== null && !options.some((o) => o.epoch.id === epochId) ? <option value="">Epoch {epochId} (typed)</option> : null}
            {options.map((o) => (
              <option key={o.epoch.id} value={o.epoch.id}>
                Epoch {o.epoch.id} · {o.epoch.leaves} {o.epoch.leaves === 1 ? "leaf" : "leaves"}
                {o.epoch.status === "closed-unposted" ? " · not posted on-chain" : ""}
              </option>
            ))}
          </select>
        </div>
        <form onSubmit={loadTyped} className="min-w-0" noValidate>
          <label htmlFor="epoch-typed" className="text-sm text-muted">
            Or type an epoch number
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="epoch-typed"
              inputMode="numeric"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="e.g. 3"
              aria-invalid={!!typedError}
              aria-describedby={typedError ? "epoch-typed-error" : undefined}
              className="num h-10 min-w-0 flex-1 rounded-m border border-line-strong bg-slate px-3 text-sm text-text placeholder:text-faint"
            />
            <Button type="submit" variant="secondary">
              Load
            </Button>
          </div>
          {typedError ? (
            <p id="epoch-typed-error" className="mt-1.5 text-xs text-rust">
              {typedError}
            </p>
          ) : null}
        </form>
      </div>

      {epochBlocker && epochBlocker.tag !== "Contract not configured" ? (
        <p className="text-sm text-text">
          {epochBlocker.title}
          {epochBlocker.body ? <span className="mt-1 block text-muted">{epochBlocker.body}</span> : null}
        </p>
      ) : null}

      {epochId !== null ? (
        <dl className="divide-y divide-line rounded-m border border-line">
          <Row label="Epoch">
            <span className="num">{epochId}</span>
          </Row>
          <Row label="Settled on-chain">
            {!contract ? <Dash why="Reward contract not set" /> : onchain ? (onchain.settled ? "Yes" : "No") : <Dash why="Reading" />}
          </Row>
          {onchain ? (
            <>
              <Row label="Pot">{fmt(onchain.pot)}</Row>
              <Row label="Reserved in the root">{onchain.settled ? fmt(onchain.reserved) : <Dash why="Set at settlement" />}</Row>
              <Row label="Claimed so far">{onchain.settled ? fmt(onchain.claimed) : <Dash why="Set at settlement" />}</Row>
              <Row label="On-chain root">{onchain.settled ? <RootHash value={onchain.merkleRoot} /> : <span className="text-muted">Unposted</span>}</Row>
              {onchain.settled && onchain.endedAt > 0n ? (
                <Row label="Settled at">
                  <span className="num">{formatTime(onchain.endedAt)}</span>
                </Row>
              ) : null}
            </>
          ) : null}
          <Row label="Scheduler status">
            {apiEpoch ? (
              <StatusTag tone={apiEpoch.status === "posted" ? "live" : apiEpoch.status === "open" ? "neutral" : "warn"}>
                {apiEpoch.status === "posted" ? "Root posted" : apiEpoch.status === "open" ? "Open" : "Closed, not posted"}
              </StatusTag>
            ) : epochs ? (
              <Dash why="Unknown to the scheduler" />
            ) : (
              <Dash why={epochsDown ? "Scheduler API not reachable" : "Reading"} />
            )}
          </Row>
          {apiEpoch?.postedTx ? (
            <Row label="Root posted in">
              <HexValue value={apiEpoch.postedTx} kind="tx" />
            </Row>
          ) : null}
        </dl>
      ) : null}
      {derived > 2 && shown === 2 ? (
        <Button variant="secondary" onClick={() => setPick(null)}>
          Continue
        </Button>
      ) : null}
    </div>
  );

  const proofTag =
    walletBlocker && walletBlocker.tag !== "Disconnected" && walletBlocker.tag !== "Wrong network" ? (
      <StatusTag tone={walletBlocker.tone}>{walletBlocker.tag}</StatusTag>
    ) : good && good.verifiesOnchain ? (
      <StatusTag tone="live">Proof verifies</StatusTag>
    ) : undefined;

  const proofPane = (
    <div className="space-y-4">
      <PaneHead title="Check your proof" tag={proofTag} />
      {!isConnected ? (
        <p className="text-sm text-muted">Connect a wallet to fetch your proof for the selected epoch.</p>
      ) : epochId === null ? (
        <p className="text-sm text-muted">Choose a settled epoch first.</p>
      ) : proofQ.loading ? (
        <p className="text-sm text-muted">Fetching your proof from the scheduler…</p>
      ) : walletBlocker && !good ? (
        <p className="text-sm text-text">
          {walletBlocker.title}
          {walletBlocker.body ? <span className="mt-1 block text-muted">{walletBlocker.body}</span> : null}
        </p>
      ) : good ? (
        <>
          <ProofFacts
            check={good}
            unitLabel={formatPayout(good.amount, unit)}
            publishedRoot={proofData?.root ?? null}
            onchainRoot={onchain?.merkleRoot ?? null}
            contractSet={!!contract}
            claimed={claimedQ.data ?? null}
          />
          {walletBlocker || !contract ? (
            <p className="text-sm text-text">
              {walletBlocker ? walletBlocker.title : "Reward contract not set"}.{" "}
              <span className="text-muted">{walletBlocker ? (walletBlocker.body ?? "The claim button stays off.") : "Claiming stays off until it is configured."}</span>
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted">The scheduler returned a proof this page could not read. Claiming is disabled.</p>
      )}
      {derived > 3 && shown === 3 ? (
        <Button variant="secondary" onClick={() => setPick(null)}>
          Continue
        </Button>
      ) : null}
    </div>
  );

  const claimPane = (
    <div className="space-y-4">
      <PaneHead
        title="Claim"
        tag={blocker ? <StatusTag tone={blocker.tone}>{blocker.tag}</StatusTag> : ready ? <StatusTag tone="live">Ready</StatusTag> : undefined}
      />
      {good ? (
        <div className="flex flex-wrap items-end justify-between gap-4 rounded-m border border-line px-4 py-3">
          <div>
            <p className="text-xs text-faint">Epoch {epochId}, reserved for this wallet</p>
            <p className="mt-1 text-xl font-semibold tracking-[-0.02em] text-text">
              <span className="num">{formatPayout(good.amount, unit).value}</span>{" "}
              <span className="text-sm font-normal text-muted">{formatPayout(good.amount, unit).unit}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {good.rootMatch ? <StatusTag tone="live">Roots match</StatusTag> : null}
            {good.verifiesOnchain ? <StatusTag tone="live">Proof verifies</StatusTag> : null}
          </div>
        </div>
      ) : null}
      <p className="text-sm text-muted">
        {blocker ? (
          <>
            <span className="text-text">{blocker.title}.</span> The claim button stays off.
          </>
        ) : simError ? (
          <span className="text-text">{explainClaimError(simError, String(epochId))}</span>
        ) : ready && sim.isLoading ? (
          "Simulating the claim against the contract…"
        ) : ready ? (
          <>
            Calls <span className="num text-text">claim({epochId}, amount, proof)</span> on the reward contract from your wallet. You pay the gas.
          </>
        ) : (
          "Waiting for the checks above."
        )}
      </p>
      {simError && revertName(simError) === null ? (
        <Button variant="secondary" size="sm" onClick={() => sim.refetch()}>
          Run the check again
        </Button>
      ) : null}
      <Button size="lg" className="w-full sm:w-auto" disabled={!canClaim} onClick={claim} aria-describedby="claim-help">
        {write.isPending
          ? "Confirm in your wallet…"
          : write.data && receipt.isLoading
            ? "Waiting for confirmation…"
            : good
              ? `Claim ${formatPayout(good.amount, unit).value} ${formatPayout(good.amount, unit).unit}`
              : "Claim"}
      </Button>
      <p id="claim-help" className="sr-only">
        The button is enabled only when the proof verifies against the on-chain root, the epoch is settled, the wallet has not
        claimed and claims are not paused.
      </p>
      {write.data && receipt.isLoading ? (
        <Notice tone="neutral" title="Claim submitted">
          <span className="inline-flex flex-wrap items-center gap-2">
            Transaction <HexValue value={write.data} kind="tx" /> is waiting for confirmation. Do not submit again.
          </span>
        </Notice>
      ) : null}
      {txError && !busy ? (
        <Notice
          tone="error"
          title="The claim did not go through"
          action={
            <Button size="sm" variant="secondary" onClick={() => write.reset()}>
              Dismiss
            </Button>
          }
        >
          {explainClaimError(txError, String(epochId ?? ""))}
        </Notice>
      ) : null}
    </div>
  );

  const donePane =
    succeeded && claimedAmount ? (
      <div className="space-y-4">
        <PaneHead title="Claimed" tag={<StatusTag tone="live">Claimed</StatusTag>} />
        <Notice tone="live" title={`Claimed epoch ${claimedAmount.epoch}`}>
          <span className="block">{fmt(claimedAmount.amount)} sent to your wallet.</span>
          <span className="mt-1 inline-flex flex-wrap items-center gap-2">
            Transaction <HexValue value={claimedAmount.hash} kind="tx" />
          </span>
        </Notice>
        <Button variant="secondary" onClick={() => selectEpoch(null)}>
          Choose another epoch
        </Button>
      </div>
    ) : null;

  return (
    <>
      <PageHeader
        art="/art/banner-claim.webp"
        title="Claim"
        description="Claim your share of a settled epoch with a Merkle proof. The contract pays only the amount the posted root reserves for your wallet, and only once."
      />

      {!contract ? (
        <Notice tone="warn" title="Reward contract not set" className="mb-6">
          Claiming and the on-chain checks are off until the reward contract address is configured. The scheduler can still
          publish trees, and proofs can be checked by hand below.
        </Notice>
      ) : null}
      {epochsDown && apiDown(epochsDown) ? (
        <Notice
          tone="error"
          title="Scheduler API not reachable"
          className="mb-6"
          action={
            <Button size="sm" variant="secondary" onClick={epochsQ.reload}>
              Retry
            </Button>
          }
        >
          Epochs and proofs come from the scheduler API. A self-supplied proof is not the MVP default, so claiming fails closed
          until the API answers.
        </Notice>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] xl:grid-cols-[minmax(0,1fr)_480px]">
        <div className="min-w-0 lg:col-start-2 lg:row-start-1">
          <div className="space-y-6 lg:sticky lg:top-24">
            <MerkleTreePanel view={view} />
            <LeafEncoding className="hidden lg:block" />
          </div>
        </div>

        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <div className="rounded-l border border-line bg-coal p-3 sm:p-4">
            <Stepper
              step={shown}
              onStepChange={(n) => setPick(n)}
              linear
              showFooter={false}
              frame={false}
              radius={8}
              width="100%"
              transition={reduced ? "none" : "slide"}
              style={STEPPER_TOKENS}
              completedContent={donePane}
              aria-label="Claim steps"
            >
              <StepPane title="Connect wallet">{connectPane}</StepPane>
              <StepPane title="Choose epoch">{epochPane}</StepPane>
              <StepPane title="Check proof">{proofPane}</StepPane>
              <StepPane title="Claim">{claimPane}</StepPane>
            </Stepper>
          </div>

          <ProofChecker className="mt-8" unitLabel={(v) => formatPayout(v, unit)} onChecked={setManual} />
          <LeafEncoding className="mt-8 lg:hidden" />
        </div>
      </div>
    </>
  );
}

function ProofFacts({
  check,
  unitLabel,
  publishedRoot,
  onchainRoot,
  contractSet,
  claimed,
}: {
  check: {
    amount: bigint;
    proof: Hex[];
    leaf: Hex;
    leafMatches: boolean;
    verifiesPublished: boolean;
    rootMatch: boolean | null;
    verifiesOnchain: boolean | null;
  };
  unitLabel: { value: string; unit: string };
  publishedRoot: string | null;
  onchainRoot: string | null;
  contractSet: boolean;
  claimed: boolean | null;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm text-muted">Amount reserved for this wallet</p>
        <p className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-text">
          <span className="num">{unitLabel.value}</span> <span className="text-base font-normal text-muted">{unitLabel.unit}</span>
        </p>
        <p className="mt-1 text-xs text-faint">Payout asset: {unitLabel.unit.startsWith("base units") ? payoutAssetLabel() : unitLabel.unit}</p>
      </div>
      <dl className="divide-y divide-line rounded-m border border-line">
        <Row label="Leaf">
          <HexValue value={check.leaf} kind="hash" head={10} tail={8} />
        </Row>
        <Row label="Proof">
          <span className="num">{check.proof.length}</span> sibling hash{check.proof.length === 1 ? "" : "es"}
        </Row>
        <Row label="Proof root (scheduler)">{publishedRoot ? <RootHash value={publishedRoot} /> : <Dash />}</Row>
        <Row label="On-chain root">
          {!contractSet ? <Dash why="Reward contract not set" /> : onchainRoot ? <RootHash value={onchainRoot} /> : <Dash why="Reading" />}
        </Row>
        <Row label="Roots">
          {check.rootMatch === null ? (
            <StatusTag tone="off">Not compared</StatusTag>
          ) : check.rootMatch ? (
            <StatusTag tone="live">Match</StatusTag>
          ) : (
            <StatusTag tone="error">Mismatch</StatusTag>
          )}
        </Row>
        <Row label="Leaf recomputed in this browser">
          {check.leafMatches ? <StatusTag tone="live">Matches</StatusTag> : <StatusTag tone="error">Differs</StatusTag>}
        </Row>
        <Row label="Proof verified in this browser">
          {check.verifiesOnchain === null ? (
            check.verifiesPublished ? (
              <StatusTag tone="neutral">Verifies against the scheduler root only</StatusTag>
            ) : (
              <StatusTag tone="error">Does not verify</StatusTag>
            )
          ) : check.verifiesOnchain ? (
            <StatusTag tone="live">Verifies on-chain root</StatusTag>
          ) : (
            <StatusTag tone="error">Does not verify</StatusTag>
          )}
        </Row>
        <Row label="Claimed by this wallet">
          {claimed === null ? <Dash why={contractSet ? "Reading" : "Reward contract not set"} /> : claimed ? <StatusTag tone="neutral">Already claimed</StatusTag> : "Not yet"}
        </Row>
      </dl>
      <details className="group rounded-m border border-line">
        <summary className="flex cursor-pointer items-center justify-between px-4 py-2.5 text-sm text-muted hover:text-text">
          Show the proof hashes
          <span aria-hidden className="text-faint transition-transform duration-150 group-open:rotate-45">+</span>
        </summary>
        <ol className="space-y-1 border-t border-line px-4 py-3">
          {check.proof.map((p, i) => (
            <li key={p + i} className="flex items-center gap-3 text-xs">
              <span className="num w-5 shrink-0 text-faint">{i}</span>
              <HexValue value={p} kind="hash" head={12} tail={10} />
            </li>
          ))}
          {!check.proof.length ? <li className="text-xs text-muted">Empty proof: the leaf is the root (a one-leaf tree).</li> : null}
        </ol>
      </details>
    </div>
  );
}

export function LeafEncoding({ className }: { className?: string }) {
  return (
    <section aria-labelledby="leaf-encoding" className={cn("rounded-l border border-line", className)}>
      <h2 id="leaf-encoding" className="border-b border-line px-5 py-3.5 font-medium text-text">
        How a leaf and the tree are built
      </h2>
      <div className="space-y-3 px-5 py-4 text-sm leading-relaxed text-muted">
        <p>One leaf per wallet per epoch:</p>
        <pre className="num overflow-x-auto rounded-m border border-line bg-graphite px-3 py-2.5 text-xs leading-relaxed text-text">
          {"keccak256(abi.encodePacked(\n  uint64 epochId,\n  address account,\n  uint256 amount\n))"}
        </pre>
        <p>
          That is 60 bytes in, so a leaf can never be mistaken for a 64-byte inner node. Leaves are sorted, and each parent is{" "}
          <span className="num text-text">keccak256(min(a, b) ‖ max(a, b))</span>, the sorted-pair rule of OpenZeppelin{" "}
          <span className="num text-text">MerkleProof</span>. An odd node at the end of a level moves up unchanged.
        </p>
        <p>
          This page recomputes your leaf from the epoch, your address and the amount, walks the proof to a root and compares it
          with <span className="num text-text">getEpoch(id).merkleRoot</span> read from the contract. The claim button stays off
          unless they match.
        </p>
        <p>
          A centralized scheduler computes the tree in this MVP. The contract checks only that your proof leads to the posted
          root and that the total paid never exceeds what the root reserved. Unclaimed amounts stay claimable{" "}
          {config.claimWindow ? `for ${config.claimWindow}` : "indefinitely"}.
        </p>
      </div>
    </section>
  );
}

