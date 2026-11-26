"use client";

// "API keys" panel on /jobs (src/server/apikeys.ts, /docs/api/keys): create a key, sign its link message once, copy the
// key (shown once), see what each key spent today (UTC day), lower or raise its cap, disable, delete, disable all.
// Management needs a wallet sign-in (session cookie). A key can pay for jobs; it can never withdraw.
import { Check, Copy } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useSignMessage } from "wagmi";
import { Hex } from "@/components/ui/address";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag } from "@/components/ui/status";
import { spendLimitWarning, type ApiKeyInfo, type ApiKeyList } from "@/lib/api-keys";
import { apiFetch, type ApiFailure } from "@/lib/dapp/api";
import { useOutputSignIn } from "@/lib/dapp/job-output";
import { explainSignError, formatEth, parseEthInput } from "@/lib/dapp/paid-jobs";
import { useApiGet } from "@/lib/dapp/use-api";
import { formatTime } from "@/lib/format";
import { useJobAccount } from "./job-balance";
import { Dash, Skeleton } from "./ui";
import { WalletButton } from "./wallet-button";

const input =
  "num h-10 w-full min-w-0 rounded-m border border-line-strong bg-slate px-3 text-sm text-text placeholder:text-faint aria-[invalid=true]:border-rust/60";

const send = (path: string, method: string, body?: unknown) =>
  apiFetch<Record<string, unknown>>(path, {
    method,
    credentials: "include",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function failureText(f: ApiFailure): string {
  if (f.kind === "unreachable") return "The scheduler API is not reachable. Try again in a moment.";
  if (f.status === 401) return "Your sign-in expired. Sign in again.";
  return f.message ? `${f.message}.` : `The scheduler answered ${f.status}.`;
}

/** The new key, shown once with a copy button; it disappears when dismissed. */
function ShownOnce({ fullKey, onDone }: { fullKey: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(fullKey);
      setCopied(true);
    } catch {
      /* clipboard blocked: the key stays selectable */
    }
  }
  return (
    <Notice tone="live" title="Copy your API key now. It is shown once and never again.">
      <div className="mt-2 space-y-3">
        <code className="block rounded-m border border-line bg-slate px-3 py-2 text-[13px] break-all text-text select-all">{fullKey}</code>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={copy}>
            {copied ? <Check className="size-3.5 text-signal" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy key"}
          </Button>
          <Button size="sm" variant="quiet" onClick={onDone}>
            I saved it
          </Button>
        </div>
        <p className="text-xs">
          Anyone holding this key can spend from your balance up to its daily cap. Sparecycle stores only its hash. Lost it? Delete the key and make a new one.
        </p>
      </div>
    </Notice>
  );
}

function KeyRow({ k, onChanged, onError }: { k: ApiKeyInfo; onChanged: () => void; onError: (m: string | null) => void }) {
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState("");

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    onError(null);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  const patch = (body: Record<string, unknown>) =>
    act(async () => {
      const r = await send(`/keys/${k.keyId}`, "PATCH", body);
      if (r.ok) return;
      // Raising the cap needs a new link signature (A3): sign the message the scheduler sent and send it back.
      if (r.failure.kind === "http" && r.failure.code === "link-signature-required") {
        const message = String(r.failure.extra.linkMessage ?? "");
        let signature: string;
        try {
          signature = await signMessageAsync({ message });
        } catch (e) {
          onError(explainSignError(e));
          return;
        }
        const again = await send(`/keys/${k.keyId}`, "PATCH", { ...body, issued: r.failure.extra.issued, signature });
        if (!again.ok) onError(failureText(again.failure));
        return;
      }
      onError(failureText(r.failure));
    });

  function submitCap(e: FormEvent) {
    e.preventDefault();
    const wei = parseEthInput(cap);
    if (wei === null) {
      onError("Enter a daily cap in ETH above zero, for example 0.001.");
      return;
    }
    void patch({ dailyCapWei: wei.toString() }).then(() => setCap(""));
  }

  return (
    <li className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text">{k.label || "Unnamed key"}</p>
          <p className="num text-xs text-muted">
            {k.prefix}_… · fingerprint {k.fingerprint}
          </p>
        </div>
        <StatusTag tone={k.status === "active" ? "live" : k.status === "pending" ? "warn" : "off"}>
          {k.status === "active" ? "Active" : k.status === "pending" ? "Waiting for signature" : "Disabled"}
        </StatusTag>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-faint">Daily cap</dt>
          <dd className="num text-text">{formatEth(k.dailyCapWei)} ETH</dd>
        </div>
        <div>
          <dt className="text-faint">Spent today (UTC)</dt>
          <dd className="num text-text">{formatEth(k.spentTodayWei)} ETH</dd>
        </div>
        <div>
          <dt className="text-faint">Last used</dt>
          <dd className="num text-text">{k.lastUsedAt ? formatTime(k.lastUsedAt) : <Dash why="Not used yet" />}</dd>
        </div>
        <div>
          <dt className="text-faint">Created</dt>
          <dd className="num text-text">{formatTime(k.createdAt)}</dd>
        </div>
      </dl>
      {k.status !== "pending" ? (
        <form onSubmit={submitCap} noValidate className="flex flex-wrap items-center gap-2">
          <label htmlFor={`cap-${k.keyId}`} className="sr-only">
            New daily cap in ETH
          </label>
          <input
            id={`cap-${k.keyId}`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="New daily cap, ETH"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            className={`${input} h-8 max-w-[12rem]`}
          />
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !cap}>
            Change cap
          </Button>
          {k.status === "active" ? (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => patch({ status: "disabled" })}>
              Disable
            </Button>
          ) : (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => patch({ status: "active" })}>
              Enable
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Delete ${k.label || k.prefix}? It stops working at once and cannot be restored.`)) {
                void act(async () => {
                  const r = await send(`/keys/${k.keyId}`, "DELETE");
                  if (!r.ok) onError(failureText(r.failure));
                });
              }
            }}
          >
            Delete
          </Button>
        </form>
      ) : null}
    </li>
  );
}

/** "API keys": next to "Your balance" on /jobs. Rendered only when paid jobs are on (inside JobAccountProvider). */
export function ApiKeysPanel() {
  const acct = useJobAccount();
  const signIn = useOutputSignIn();
  const { signMessageAsync } = useSignMessage();
  const q = useApiGet<ApiKeyList>(acct?.isConnected ? "/keys" : null, 60_000);
  const [label, setLabel] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  if (!acct) return null;
  const list = q.result?.ok ? q.result.data : null;
  const needsSignIn = q.result && !q.result.ok && q.result.failure.kind === "http" && q.result.failure.status === 401;
  const otherWallet = list && acct.address && list.owner.toLowerCase() !== acct.address.toLowerCase();

  async function create(e: FormEvent) {
    e.preventDefault();
    const wei = parseEthInput(cap);
    if (wei === null) {
      setError("Enter a daily cap in ETH above zero, for example 0.001.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await send("/keys", "POST", { label, dailyCapWei: wei.toString() });
      if (!c.ok) {
        setError(failureText(c.failure));
        return;
      }
      let signature: string;
      try {
        signature = await signMessageAsync({ message: String(c.data.linkMessage) });
      } catch (err) {
        setError(`${explainSignError(err).replace("Nothing was submitted or charged.", "")}The key stays inactive and expires in 10 minutes.`);
        return;
      }
      const a = await send(`/keys/${String(c.data.keyId)}/activate`, "POST", { signature });
      if (!a.ok) {
        setError(failureText(a.failure));
        return;
      }
      setCreated(String(a.data.key));
      setLabel("");
      setCap("");
    } finally {
      setBusy(false);
      q.reload();
    }
  }

  const disableAll = async () => {
    if (!window.confirm("Disable every API key of this wallet? Their queued jobs are cancelled and never charged.")) return;
    const r = await send("/keys/disable-all", "POST");
    if (!r.ok) setError(failureText(r.failure));
    q.reload();
  };

  return (
    <section aria-labelledby="api-keys-title" id="api-keys" className="min-w-0 scroll-mt-24 rounded-l border border-line bg-coal">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
        <h2 id="api-keys-title" className="font-medium text-text">
          API keys
        </h2>
        {list ? (
          <span className="text-xs text-muted">
            <span className="num">{list.keys.filter((k) => k.status !== "disabled").length}</span> of <span className="num">{list.maxKeys}</span>
          </span>
        ) : null}
      </div>

      <div className="space-y-4 px-5 py-4">
        <p className="text-sm leading-relaxed text-muted">
          A key lets a script, the OpenAI-compatible API or an MCP agent pay for jobs from your balance without signing each job. Each key has its own daily
          cap and can be switched off at once. A key can never withdraw: withdrawals stay with your wallet.{" "}
          <Link href="/docs/api/keys" className="link">
            How keys work
          </Link>
        </p>

        {acct.account && spendLimitWarning(acct.account.spendLimitPerEpoch) ? (
          <Notice tone="warn" title="Set a spend limit per epoch">
            Your spend limit in the payments contract is 0, which means no limit. It is the only cap that does not depend on the Sparecycle scheduler: a leaked
            key could spend up to its daily cap, and only the on-chain limit stops more than that per epoch. Set it in Your balance.
          </Notice>
        ) : null}

        {!acct.mounted ? (
          <Skeleton className="w-40" />
        ) : !acct.isConnected ? (
          <WalletButton className="h-10 px-4" />
        ) : needsSignIn ? (
          <div className="space-y-2">
            <p className="text-sm text-muted">Sign in with your wallet to see and manage its keys. It is a signature, not a transaction: no gas.</p>
            <Button variant="secondary" disabled={signIn.busy} onClick={() => void signIn.signIn().then(q.reload)}>
              {signIn.busy ? "Waiting for the wallet" : "Sign in"}
            </Button>
            {signIn.error ? <p className="text-xs text-rust">{signIn.error}</p> : null}
          </div>
        ) : !list ? (
          q.result && !q.result.ok ? <p className="text-sm text-rust">{failureText(q.result.failure)}</p> : <Skeleton className="w-48" />
        ) : (
          <>
            {otherWallet ? (
              <Notice tone="warn" title="Signed in as another wallet">
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  These keys belong to <Hex value={list.owner} />. Sign in again with the connected wallet to manage its keys.
                </span>
              </Notice>
            ) : null}
            {created ? <ShownOnce fullKey={created} onDone={() => setCreated(null)} /> : null}

            <form onSubmit={create} noValidate className="space-y-2">
              <div className="grid gap-2 sm:grid-cols-[1fr_10rem_auto]">
                <label className="sr-only" htmlFor="key-label">
                  Label
                </label>
                <input id="key-label" placeholder="Label, e.g. my agent" maxLength={64} value={label} onChange={(e) => setLabel(e.target.value)} className={input} />
                <label className="sr-only" htmlFor="key-cap">
                  Daily cap in ETH
                </label>
                <input id="key-cap" inputMode="decimal" autoComplete="off" placeholder="Daily cap, ETH" value={cap} onChange={(e) => setCap(e.target.value)} className={input} />
                <Button type="submit" variant="secondary" disabled={busy || !!otherWallet}>
                  {busy ? "Sign in your wallet" : "Create key"}
                </Button>
              </div>
              <p className="text-xs text-muted">
                Creating a key asks your wallet to sign one message that names the key, its fingerprint and its daily cap. No gas. Raising a cap later needs a
                new signature; lowering it does not.
              </p>
            </form>

            {error ? <p className="text-xs text-rust">{error}</p> : null}

            {list.keys.length ? (
              <ul className="-mx-5 divide-y divide-line border-y border-line">
                {list.keys.map((k) => (
                  <KeyRow key={k.keyId} k={k} onChanged={q.reload} onError={setError} />
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No keys yet.</p>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
              <span>
                Daily caps reset at 00:00 UTC. Next reset: <span className="num">{formatTime(list.nextResetAt)}</span>
                {" "}(<span className="num">{new Date(list.nextResetAt * 1000).toLocaleString()}</span> your time).
              </span>
              {list.keys.some((k) => k.status === "active") ? (
                <Button size="sm" variant="quiet" onClick={() => void disableAll()}>
                  Disable all keys
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
