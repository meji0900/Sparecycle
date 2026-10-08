"use client";

import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { getAddress, isAddress } from "viem";
import { useSignMessage } from "wagmi";
import { Button } from "@/components/ui/button";
import { Notice, StatusTag } from "@/components/ui/status";
import { config } from "@/lib/config";
import { hoursFlag, hoursFrom } from "@/lib/dapp/hours";
import { useWallet } from "@/lib/dapp/use-wallet";
import { linkMessage } from "@/lib/protocol";
import { CodeBlock } from "./code-block";
import { IdlePlanner } from "./idle-planner";
import { WalletButton } from "./wallet-button";

/** The URL nodes pass as --network: the scheduler API's site (the client appends /api/v1). */
function useNetworkUrl() {
  const origin = useSyncExternalStore(
    () => () => undefined,
    () => window.location.origin,
    () => null,
  );
  const api = config.schedulerApiUrl;
  if (/^https?:\/\//.test(api)) return api.replace(/\/api\/v1\/?$/, "");
  if (config.domain) return `https://${config.domain.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  return origin ?? "<SCHEDULER_URL>";
}

export function InstallStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="grid gap-4 border-t border-line py-8 first:border-t-0 first:pt-0 md:grid-cols-[220px_minmax(0,1fr)] md:gap-10">
      <h3 className="flex items-start gap-3 font-medium text-text">
        <span aria-hidden className="num grid size-6 shrink-0 place-items-center rounded-s border border-line-strong text-xs text-muted">
          {n}
        </span>
        <span>
          <span className="sr-only">Step {n}: </span>
          {title}
        </span>
      </h3>
      <div className="min-w-0 space-y-4 text-sm leading-relaxed text-muted">{children}</div>
    </li>
  );
}

/** Steps 3 to 6 of the install guide: link the wallet, plan idle hours, start, confirm. */
export function NodeSetup({
  os,
  backend = "cuda",
}: {
  /** When set, only that OS's commands are shown. */
  os?: "windows" | "linux";
  backend?: "cuda" | "vulkan" | "cpu";
} = {}) {
  const network = useNetworkUrl();
  const { address, isConnected } = useWallet();
  const [nodeKey, setNodeKey] = useState("");
  const [ownerTyped, setOwnerTyped] = useState("");
  const [sigTyped, setSigTyped] = useState("");
  const [hours, setHours] = useState<boolean[]>(() => hoursFrom([1, 8]));
  const sign = useSignMessage();

  const owner = ownerTyped.trim() || address || "";
  const ownerOk = isAddress(owner);
  const keyOk = isAddress(nodeKey.trim());
  const message = keyOk && ownerOk ? linkMessage(getAddress(nodeKey.trim()), getAddress(owner)) : null;
  const signedFor = sign.variables?.message;
  const signature = sign.data && signedFor === message ? sign.data : null;
  const sig = sigTyped.trim() || signature || "";
  const flag = hoursFlag(hours);
  const all = hours.every(Boolean);

  const start = [
    "node src/agent.ts start",
    `--network ${network}`,
    `--owner ${ownerOk ? getAddress(owner) : "0xYOUR_WALLET"}`,
    `--owner-sig ${/^0x[0-9a-fA-F]+$/.test(sig) ? sig : "0xSIGNATURE"}`,
    ...(all ? [] : [flag ? `--hours ${flag}` : "--hours <pick hours above>"]),
    ...(backend === "cuda" ? [] : [`--backend ${backend}`]),
  ].join(" \\\n  ");
  const startWin = start.replaceAll(" \\\n  ", " `\n  ");

  return (
    <>
      <InstallStep n={3} title="Link your wallet (once, no gas)">
        <p>
          The node key only signs scheduler requests and job receipts. Your <span className="text-text">owner wallet</span> is
          the account in the payout Merkle tree; the node never needs its private key. Print the message to sign:
        </p>
        <CodeBlock label="Linux or Windows, in the sparecycle-node folder" code="node src/agent.ts link-message --owner 0xYOUR_WALLET" />
        <p>
          Sign the printed message exactly as shown with that wallet (&quot;Sign message&quot;, personal_sign). It looks like{" "}
          <span className="num text-text">Sparecycle: link node 0x… to wallet 0x…</span>. You can also sign it here:
        </p>

        <div className="space-y-4 rounded-l border border-line p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor="node-key" className="text-sm text-muted">
                Node key (printed by the installer)
              </label>
              <input
                id="node-key"
                value={nodeKey}
                onChange={(e) => setNodeKey(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={nodeKey !== "" && !keyOk}
                className="num mt-1.5 h-10 w-full rounded-m border border-line-strong bg-slate px-3 text-sm text-text placeholder:text-faint"
              />
              {nodeKey !== "" && !keyOk ? <p className="mt-1 text-xs text-rust">That is not an address.</p> : null}
            </div>
            <div className="min-w-0">
              <label htmlFor="owner" className="text-sm text-muted">
                Owner wallet {address && !ownerTyped ? "(connected)" : ""}
              </label>
              <input
                id="owner"
                value={ownerTyped}
                onChange={(e) => setOwnerTyped(e.target.value)}
                placeholder={address ?? "0x…"}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={ownerTyped !== "" && !ownerOk}
                className="num mt-1.5 h-10 w-full rounded-m border border-line-strong bg-slate px-3 text-sm text-text placeholder:text-faint"
              />
              {ownerTyped !== "" && !ownerOk ? <p className="mt-1 text-xs text-rust">That is not an address.</p> : null}
            </div>
          </div>

          {message ? (
            <div>
              <p className="text-xs text-faint">Message</p>
              <p className="num mt-1 text-xs break-all text-text">{message}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            {!isConnected ? (
              <WalletButton className="h-10 px-4" />
            ) : address && ownerOk && getAddress(owner) !== getAddress(address) ? (
              <p className="text-xs text-amber">The connected wallet is not the owner above. Sign with the owner wallet, or paste its signature below.</p>
            ) : (
              <Button
                variant="secondary"
                disabled={!message || sign.isPending}
                onClick={() => message && sign.signMessage({ message })}
              >
                {sign.isPending ? "Confirm in your wallet…" : "Sign the link message"}
              </Button>
            )}
            {signature ? <StatusTag tone="live">Signed</StatusTag> : null}
          </div>
          {sign.error && !sign.isPending ? (
            <Notice tone="error" title="Not signed">
              {sign.error.message.includes("rejected") ? "You rejected the request in your wallet." : sign.error.message.split("\n")[0]}
            </Notice>
          ) : null}

          <div className="min-w-0">
            <label htmlFor="owner-sig" className="text-sm text-muted">
              Signature {signature && !sigTyped ? "(from your wallet)" : "(or paste one you made elsewhere)"}
            </label>
            <input
              id="owner-sig"
              value={sigTyped || signature || ""}
              onChange={(e) => setSigTyped(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              className="num mt-1.5 h-10 w-full rounded-m border border-line-strong bg-slate px-3 text-sm text-text placeholder:text-faint"
            />
          </div>
          <p className="text-xs text-faint">Signing costs no gas and moves no funds. Nothing here is sent to a server.</p>
        </div>
      </InstallStep>

      <InstallStep n={4} title="Choose the hours it may work">
        <p>
          The node only takes jobs inside these hours, and pauses on its own when another program needs the GPU. Pick the
          hours your computer is usually idle.
        </p>
        <IdlePlanner hours={hours} onChange={setHours} />
      </InstallStep>

      <InstallStep n={5} title="Start the node">
        <p>This command updates as you fill in the steps above.</p>
        {os !== "windows" ? <CodeBlock label="Linux (bash)" code={start} /> : null}
        {os !== "linux" ? <CodeBlock label="Windows (PowerShell)" code={startWin} /> : null}
        <p>
          <span className="num text-text">--network</span> is the Sparecycle site; the client calls its{" "}
          <span className="num text-text">/api/v1</span> endpoints. Add <span className="num text-text">--no-image</span> or{" "}
          <span className="num text-text">--no-text</span> to skip one job type. <span className="num text-text">Ctrl+C</span>{" "}
          finishes the current job and stops. On Linux, run it inside tmux or screen so it keeps working after you close the
          terminal.
        </p>
      </InstallStep>

      <InstallStep n={6} title="Check that the scheduler sees it">
        <p>
          On start the node prints <span className="num text-text">registered with … · payouts go to 0x…</span>. Within two
          minutes it appears as Online under{" "}
          <Link href="/app#nodes" className="link">
            Registered nodes
          </Link>{" "}
          on the status page, listed by your owner wallet.
        </p>
        <CodeBlock label="Or ask the scheduler directly" code={`curl ${network}/api/v1/nodes`} />
      </InstallStep>
    </>
  );
}
