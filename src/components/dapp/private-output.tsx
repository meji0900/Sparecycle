"use client";

import type { ReactNode } from "react";
import { Notice } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { useOutputSignIn, useOutputsPrivate, type OutputState } from "@/lib/dapp/job-output";
import { WalletButton } from "./wallet-button";

/** What to say when an output can't be shown here: a free job without its key, or a paid job that needs sign-in. */
export function outputLockText(state: OutputState, paid: boolean): { title: string; body: string } | null {
  if (state !== "signin" && state !== "forbidden") return null;
  if (!paid) {
    return {
      title: "Only in the browser that made it",
      body: "A free result can be viewed only in the browser that created it, which keeps a key for it. This browser has no key for this job.",
    };
  }
  if (state === "forbidden") {
    return {
      title: "Not this wallet's job",
      body: "The signed-in wallet did not pay for this job. Connect the wallet that paid and sign in again.",
    };
  }
  return { title: "Sign in to view", body: "Sign a message with the wallet that paid for this job. No transaction and no gas." };
}

/** The sign-in button (or Connect Wallet first) for a paid output that this browser can't read yet. */
export function SignInToView({ className }: { className?: string }) {
  const s = useOutputSignIn();
  return (
    <div className={className}>
      {s.isConnected ? (
        <Button type="button" size="sm" variant="secondary" onClick={() => void s.signIn()} disabled={s.busy}>
          {s.busy ? "Waiting for signature" : "Sign in with wallet"}
        </Button>
      ) : (
        <WalletButton />
      )}
      {s.error ? (
        <p role="alert" className="mt-2 text-xs text-amber">
          {s.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The privacy notice above a job form. It claims private results only when the scheduler enforces them
 * (OUTPUT_AUTH=enforce, read from /status); otherwise, and while unknown, it shows `fallback`.
 */
export function OutputPrivacyNotice({ fallback, subject }: { fallback: ReactNode; subject: "image" | "result" }) {
  const enforced = useOutputsPrivate();
  if (!enforced) return <>{fallback}</>;
  return (
    <Notice tone="warn" title={`Your ${subject} is private. Your prompt is seen by the two GPUs.`}>
      Only this browser and, for paid jobs, the wallet that paid can view the {subject}. The two GPUs that make it see the prompt
      while they work, and that can&apos;t be recalled from their machines. Do not enter names, personal details or anything
      sensitive.
    </Notice>
  );
}
