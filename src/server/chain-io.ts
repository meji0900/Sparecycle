// On-chain I/O of the scheduler: reads of the reward contract and the one write it makes,
// closeEpochAndPostRoot. The signer key comes only from SCHEDULER_SIGNER_KEY and is never logged.
import { BaseError, ContractFunctionRevertedError, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "@/lib/config";
import { publicClient, targetChain } from "@/lib/chain";
import { sparecycleRewardsAbi, type EpochStruct } from "@/contracts/sparecycleRewards";
import { serverEnv } from "./env";

export const rewardAddress = (): Address | null => config.rewardContract;

function need(): Address {
  const a = rewardAddress();
  if (!a) throw new Error("reward contract not configured");
  return a;
}

export async function readCurrentEpoch(): Promise<bigint> {
  return publicClient.readContract({ address: need(), abi: sparecycleRewardsAbi, functionName: "currentEpoch" });
}

export async function readEpoch(id: bigint): Promise<EpochStruct> {
  return (await publicClient.readContract({
    address: need(),
    abi: sparecycleRewardsAbi,
    functionName: "getEpoch",
    args: [id],
  })) as EpochStruct;
}

export async function readEpochLength(): Promise<bigint> {
  return publicClient.readContract({ address: need(), abi: sparecycleRewardsAbi, functionName: "epochLength" });
}

/** What the epoch will hold at close: its pot plus anything not yet credited (closeEpochAndPostRoot syncs first). */
export async function readPotAtClose(id: bigint): Promise<bigint> {
  const [epoch, unaccounted] = await Promise.all([
    readEpoch(id),
    publicClient.readContract({ address: need(), abi: sparecycleRewardsAbi, functionName: "unaccounted" }),
  ]);
  return epoch.pot + unaccounted;
}

export async function readCanClose(id: bigint): Promise<boolean> {
  return publicClient.readContract({ address: need(), abi: sparecycleRewardsAbi, functionName: "canClose", args: [id] });
}

export async function readScheduler(): Promise<Address> {
  return publicClient.readContract({ address: need(), abi: sparecycleRewardsAbi, functionName: "scheduler" });
}

/** The root-posting account, or null when SCHEDULER_SIGNER_KEY is not set. */
export function schedulerAccount() {
  const key = serverEnv.signerKey();
  return key ? privateKeyToAccount(key) : null;
}

export const rootPostingConfigured = () => rewardAddress() !== null && schedulerAccount() !== null;

/** Short, secret-free error text (decoded revert name when there is one). */
export function describeChainError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) return `reverted: ${revert.data.errorName}`;
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Sends closeEpochAndPostRoot(epochId, root, reserved) from the scheduler key, after a simulation.
 * `onSent` is called with the tx hash before waiting, so a crash mid-wait still leaves a trace in the DB.
 */
export async function postRoot(
  epochId: bigint,
  root: Hex,
  reserved: bigint,
  onSent: (hash: Hex) => void,
): Promise<{ hash: Hex; success: boolean; endedAt: bigint | null }> {
  const account = schedulerAccount();
  if (!account) throw new Error("SCHEDULER_SIGNER_KEY not set");
  const address = need();
  const onChainScheduler = await readScheduler();
  if (onChainScheduler.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`signer ${account.address} is not the contract's scheduler (${onChainScheduler})`);
  }
  const { request } = await publicClient.simulateContract({
    account,
    address,
    abi: sparecycleRewardsAbi,
    functionName: "closeEpochAndPostRoot",
    args: [epochId, root, reserved],
  });
  const wallet = createWalletClient({ account, chain: targetChain, transport: http(targetChain.rpcUrls.default.http[0]) });
  const hash = await wallet.writeContract(request);
  onSent(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") return { hash, success: false, endedAt: null };
  const settled = await readEpoch(epochId);
  return { hash, success: true, endedAt: settled.endedAt };
}
