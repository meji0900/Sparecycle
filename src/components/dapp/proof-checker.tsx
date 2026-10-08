"use client";

import { useState, type FormEvent } from "react";
import { getAddress, isAddress, type Hex } from "viem";
import { Hex as HexValue } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { StatusTag } from "@/components/ui/status";
import { sparecycleRewardsAbi } from "@/contracts/sparecycleRewards";
import { publicClient } from "@/lib/chain";
import { config } from "@/lib/config";
import { hashPair, leafOf, verifyProof } from "@/lib/merkle";
import { cn } from "@/lib/utils";
import { RootHash } from "./live-values";
import { Dash, Row } from "./ui";

export type CheckedPath = { epochId: number | null; leaf: Hex; proof: Hex[]; verified: boolean | null };

type Parsed = { epochId: number; account: `0x${string}`; amount: bigint; proof: Hex[]; root: Hex | null };

type Result = {
  parsed: Parsed;
  leaf: Hex;
  computedRoot: Hex;
  onchain: { settled: boolean; root: Hex } | { error: string } | null;
  verified: boolean | null;
};

const EXAMPLE = `{
  "epochId": 3,
  "account": "0x…",
  "amount": "1250000000000000",
  "proof": ["0x…", "0x…"]
}`;

const isHash = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

function parse(text: string): Parsed {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("That is not valid JSON.");
  }
  if (typeof body !== "object" || body === null) throw new Error("Expected a JSON object.");
  const o = body as Record<string, unknown>;
  const epochRaw = o.epochId ?? o.epoch;
  const epochId = typeof epochRaw === "number" ? epochRaw : typeof epochRaw === "string" && /^\d+$/.test(epochRaw) ? Number(epochRaw) : NaN;
  if (!Number.isSafeInteger(epochId) || epochId < 0) throw new Error("epochId must be a whole number.");
  if (typeof o.account !== "string" || !isAddress(o.account)) throw new Error("account must be a wallet address.");
  const amountRaw = o.amount;
  if (!(typeof amountRaw === "string" && /^\d{1,78}$/.test(amountRaw)) && !(typeof amountRaw === "number" && Number.isSafeInteger(amountRaw) && amountRaw >= 0)) {
    throw new Error("amount must be a whole number of base units, as a string.");
  }
  if (!Array.isArray(o.proof) || !o.proof.every(isHash)) throw new Error("proof must be a list of 32-byte hex hashes.");
  return {
    epochId,
    account: getAddress(o.account),
    amount: BigInt(amountRaw as string | number),
    proof: (o.proof as Hex[]).map((p) => p.toLowerCase() as Hex),
    root: isHash(o.root) ? (o.root.toLowerCase() as Hex) : null,
  };
}

export function ProofChecker({
  className,
  unitLabel,
  onChecked,
}: {
  className?: string;
  unitLabel: (v: bigint) => { value: string; unit: string };
  onChecked: (p: CheckedPath | null) => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(e: FormEvent) {
    e.preventDefault();
    let parsed: Parsed;
    try {
      parsed = parse(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that JSON.");
      setResult(null);
      return;
    }
    setError(null);
    setBusy(true);
    const leaf = leafOf(BigInt(parsed.epochId), parsed.account, parsed.amount);
    const computedRoot = parsed.proof.reduce<Hex>((h, p) => hashPair(h, p), leaf);
    let onchain: Result["onchain"] = null;
    if (config.rewardContract) {
      try {
        const ep = await publicClient.readContract({
          address: config.rewardContract,
          abi: sparecycleRewardsAbi,
          functionName: "getEpoch",
          args: [BigInt(parsed.epochId)],
        });
        onchain = { settled: ep.settled, root: ep.merkleRoot };
      } catch (err) {
        onchain = { error: err instanceof Error ? err.message.split("\n")[0].slice(0, 140) : "read failed" };
      }
    }
    const verified = onchain && "root" in onchain && onchain.settled ? verifyProof(parsed.proof, onchain.root, leaf) : null;
    setResult({ parsed, leaf, computedRoot, onchain, verified });
    onChecked({ epochId: parsed.epochId, leaf, proof: parsed.proof, verified });
    setBusy(false);
  }

  function clear() {
    setText("");
    setError(null);
    setResult(null);
    onChecked(null);
  }

  const amount = result ? unitLabel(result.parsed.amount) : null;

  return (
    <details className={cn("group rounded-l border border-line", className)}>
      <summary className="flex cursor-pointer items-start justify-between gap-4 px-5 py-4">
        <span>
          <span className="block font-medium text-text">Check a proof</span>
          <span className="mt-1 block text-sm text-muted">
            No wallet needed. Paste an epoch, account, amount and proof, and this page checks it against the on-chain root.
          </span>
        </span>
        <span aria-hidden className="mt-0.5 text-lg leading-none text-faint transition-transform duration-150 group-open:rotate-45">
          +
        </span>
      </summary>
      <form onSubmit={check} className="space-y-4 border-t border-line px-5 py-4">
        <div>
          <label htmlFor="proof-json" className="text-sm text-muted">
            Proof JSON (the answer of <span className="num text-text">/api/v1/epochs/:id/proof?account=…</span> works as is)
          </label>
          <textarea
            id="proof-json"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            spellCheck={false}
            placeholder={EXAMPLE}
            aria-invalid={!!error}
            aria-describedby={error ? "proof-json-error" : undefined}
            className="num mt-1.5 block w-full resize-y rounded-m border border-line-strong bg-slate px-3 py-2.5 text-xs leading-relaxed text-text placeholder:text-faint"
          />
          {error ? (
            <p id="proof-json-error" className="mt-1.5 text-xs text-rust">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="secondary" disabled={busy || !text.trim()}>
            {busy ? "Checking…" : "Verify"}
          </Button>
          {text || result ? (
            <Button type="button" variant="quiet" onClick={clear}>
              Clear
            </Button>
          ) : null}
        </div>

        {result ? (
          <div aria-live="polite" className="space-y-3">
            <dl className="divide-y divide-line rounded-m border border-line">
              <Row label="Epoch">
                <span className="num">{result.parsed.epochId}</span>
              </Row>
              <Row label="Account">
                <HexValue value={result.parsed.account} />
              </Row>
              <Row label="Amount">
                <span className="num">{amount?.value}</span> <span className="text-muted">{amount?.unit}</span>
              </Row>
              <Row label="Leaf (computed here)">
                <HexValue value={result.leaf} kind="hash" head={10} tail={8} />
              </Row>
              <Row label="Root the proof leads to">
                <RootHash value={result.computedRoot} />
              </Row>
              {result.parsed.root ? (
                <Row label="Root in the pasted JSON">
                  {result.parsed.root === result.computedRoot ? (
                    <StatusTag tone="neutral">Same as computed</StatusTag>
                  ) : (
                    <StatusTag tone="error">Differs from computed</StatusTag>
                  )}
                </Row>
              ) : null}
              <Row label="On-chain root">
                {!config.rewardContract ? (
                  <Dash why="Reward contract not set" />
                ) : result.onchain && "error" in result.onchain ? (
                  <Dash why="Read failed" />
                ) : result.onchain && !result.onchain.settled ? (
                  <span className="text-muted">Unposted (epoch not settled)</span>
                ) : result.onchain ? (
                  <RootHash value={result.onchain.root} />
                ) : (
                  <Dash />
                )}
              </Row>
            </dl>
            <p className="flex flex-wrap items-center gap-2 text-sm">
              {result.verified === true ? (
                <StatusTag tone="live">Verifies against the on-chain root</StatusTag>
              ) : result.verified === false ? (
                <StatusTag tone="error">Does not verify</StatusTag>
              ) : (
                <StatusTag tone="off">Not checked on-chain</StatusTag>
              )}
              <span className="text-muted">
                {result.verified === true
                  ? "This leaf is in the posted root. Only the account itself can claim it."
                  : result.verified === false
                    ? "This proof does not lead to the posted root. The contract would reject it."
                    : !config.rewardContract
                      ? "There is no on-chain root to compare with until the reward contract is configured."
                      : result.onchain && "error" in result.onchain
                        ? "The contract read failed; nothing was verified."
                        : "The epoch is not settled, so there is no posted root yet."}
              </span>
            </p>
          </div>
        ) : null}
      </form>
    </details>
  );
}
