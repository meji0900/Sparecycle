// Human sentences for the reward contract's custom errors (src/contracts/sparecycleRewards.ts) and wallet errors.
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

const SENTENCES: Record<string, (epoch: string) => string> = {
  AlreadyClaimed: (e) => `This wallet has already claimed epoch ${e}. Each leaf can be claimed once.`,
  InvalidProof: () =>
    "The contract rejected the proof: it does not lead from this wallet and amount to the posted root. Nothing was paid.",
  NotSettled: (e) => `Epoch ${e} is not settled on-chain yet. Claims open when this epoch is settled.`,
  ClaimsArePaused: () =>
    "Claims are paused by the contract owner. The reserved amount stays in the contract; try again after claims are unpaused.",
  ClaimExceedsReserved: (e) =>
    `This claim would take more than is still reserved for epoch ${e}, so the contract refused it. Nothing was paid.`,
  TransferFailed: () => "The contract could not transfer the payout to this wallet. Nothing was paid.",
};

/** The contract error name inside a viem/wagmi error, if any. */
export function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason ?? null;
  return null;
}

export function explainClaimError(error: unknown, epochId: string): string {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) {
      return "You rejected the request in your wallet. Nothing was sent.";
    }
    const name = revertName(error);
    if (name && SENTENCES[name]) return SENTENCES[name](epochId);
    if (name) return `The contract refused the claim (${name}). Nothing was paid.`;
    return error.shortMessage || "The transaction failed. Nothing was paid.";
  }
  return error instanceof Error ? error.message : "The transaction failed. Nothing was paid.";
}
