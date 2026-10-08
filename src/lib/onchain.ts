import "server-only";
// Live reads only. Every section is independent: one failing read never invents a value for another.
import { erc20Abi, type Address } from "viem";
import { sparecycleRewardsAbi } from "@/contracts/sparecycleRewards";
import { publicClient, targetChain } from "./chain";
import { config } from "./config";
import { LAUNCH_PHASES, PONS, ponsCurveAbi, ponsFactoryAbi, USDG_ADDRESS } from "./pons";

type Ok<T> = { ok: true; data: T; readAt: number };
type Err = { ok: false; error: string; readAt: number };
export type Read<T> = Ok<T> | Err;

const s = (v: bigint) => v.toString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : "read failed");

async function read<T>(fn: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, data: await fn(), readAt: Date.now() };
  } catch (e) {
    return { ok: false, error: errMsg(e), readAt: Date.now() };
  }
}

export async function readNetwork() {
  return read(async () => {
    const [chainId, block] = await Promise.all([publicClient.getChainId(), publicClient.getBlock()]);
    return { chainId, expectedChainId: targetChain.id, blockNumber: s(block.number), blockTime: Number(block.timestamp) };
  });
}

/** Pons v2 factory parameters. Only meaningful on Robinhood Chain mainnet. */
export async function readPonsFactory() {
  if (targetChain.id !== 4663) return { ok: false, error: "pons-not-on-this-network", readAt: Date.now() } as Err;
  const id = BigInt(config.launchConfigId ?? 0);
  return read(async () => {
    const f = { address: PONS.factory, abi: ponsFactoryAbi } as const;
    const [launchFee, maxCreatorTaxBps, launchEnabled, launchConfig, usdgApproved] = await Promise.all([
      publicClient.readContract({ ...f, functionName: "launchFee" }),
      publicClient.readContract({ ...f, functionName: "maxCreatorTaxBps" }),
      publicClient.readContract({ ...f, functionName: "launchEnabled" }),
      publicClient.readContract({ ...f, functionName: "getLaunchConfig", args: [id] }),
      publicClient.readContract({ ...f, functionName: "approvedPairTokens", args: [USDG_ADDRESS] }),
    ]);
    return {
      launchConfigId: s(id),
      launchConfigIdIsDefault: config.launchConfigId === null,
      launchFee: s(launchFee),
      maxCreatorTaxBps: s(maxCreatorTaxBps),
      launchEnabled,
      config: {
        supply: s(launchConfig.supply),
        curveFeeBps: s(launchConfig.curveFeeBps),
        graduationThreshold: s(launchConfig.graduationThreshold),
        enabled: launchConfig.enabled,
      },
      usdgApproved,
    };
  });
}

export async function readRewards() {
  const address = config.rewardContract;
  if (!address) return null;
  return read(async () => {
    const c = { address, abi: sparecycleRewardsAbi } as const;
    const current = await publicClient.readContract({ ...c, functionName: "currentEpoch" });
    const [epoch, previous, unaccounted, payoutToken, scheduler, owner, paused, epochLength, canClose] = await Promise.all([
      publicClient.readContract({ ...c, functionName: "getEpoch", args: [current] }),
      current > 0n ? publicClient.readContract({ ...c, functionName: "getEpoch", args: [current - 1n] }) : null,
      publicClient.readContract({ ...c, functionName: "unaccounted" }),
      publicClient.readContract({ ...c, functionName: "payoutToken" }),
      publicClient.readContract({ ...c, functionName: "scheduler" }),
      publicClient.readContract({ ...c, functionName: "owner" }),
      publicClient.readContract({ ...c, functionName: "claimsPaused" }),
      publicClient.readContract({ ...c, functionName: "epochLength" }),
      publicClient.readContract({ ...c, functionName: "canClose", args: [current] }),
    ]);
    let decimals = 18;
    let symbol = "ETH";
    if (payoutToken !== "0x0000000000000000000000000000000000000000") {
      [decimals, symbol] = await Promise.all([
        publicClient.readContract({ address: payoutToken, abi: erc20Abi, functionName: "decimals" }),
        publicClient.readContract({ address: payoutToken, abi: erc20Abi, functionName: "symbol" }),
      ]);
    }
    const ep = (e: typeof epoch) => ({
      index: s(e.index),
      startedAt: Number(e.startedAt),
      endedAt: Number(e.endedAt),
      pot: s(e.pot),
      reserved: s(e.reserved),
      claimed: s(e.claimed),
      merkleRoot: e.merkleRoot,
      settled: e.settled,
    });
    return {
      address,
      currentEpoch: s(current),
      epoch: ep(epoch),
      previous: previous ? ep(previous) : null,
      unaccounted: s(unaccounted),
      payoutToken,
      payout: { symbol, decimals },
      scheduler,
      owner,
      claimsPaused: paused,
      epochLength: Number(epochLength),
      canClose,
    };
  });
}

export async function readToken() {
  const token = config.tokenAddress;
  if (!token) return null;
  return read(async () => {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }),
    ]);
    let launch: Record<string, unknown> | null = null;
    let curve: Address | null = config.curveAddress;
    if (targetChain.id === 4663) {
      const [lt, fp] = await Promise.all([
        publicClient.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "getLaunchedToken", args: [token] }),
        publicClient.readContract({ address: PONS.factory, abi: ponsFactoryAbi, functionName: "getLaunchFeePolicy", args: [token] }),
      ]);
      curve = curve ?? lt.curve;
      launch = {
        exists: lt.exists,
        curve: lt.curve,
        creatorFeeRecipient: lt.creatorFeeRecipient,
        pairToken: lt.pairToken,
        graduationThreshold: s(lt.graduationThreshold),
        creatorTaxBps: lt.creatorTaxBps,
        buybackEnabled: lt.buybackEnabled,
        phase: LAUNCH_PHASES[lt.phase] ?? `Unknown (${lt.phase})`,
        protocolFeeShareBps: fp.protocolFeeShareBps,
      };
    }
    let curveReads: Record<string, unknown> | null = null;
    if (curve) {
      const c = { address: curve, abi: ponsCurveAbi } as const;
      const [feeBps, creatorTaxBps, buybackEnabled] = await Promise.all([
        publicClient.readContract({ ...c, functionName: "feeBps" }),
        publicClient.readContract({ ...c, functionName: "creatorTaxBps" }),
        publicClient.readContract({ ...c, functionName: "buybackEnabled" }),
      ]);
      curveReads = { address: curve, feeBps: s(feeBps), creatorTaxBps: s(creatorTaxBps), buybackEnabled };
    }
    return { address: token, name, symbol, decimals, totalSupply: s(totalSupply), launch, curve: curveReads };
  });
}

let cache: { at: number; value: Promise<ChainSnapshot> } | null = null;
export type ChainSnapshot = {
  network: Awaited<ReturnType<typeof readNetwork>>;
  pons: Awaited<ReturnType<typeof readPonsFactory>>;
  rewards: Awaited<ReturnType<typeof readRewards>>;
  token: Awaited<ReturnType<typeof readToken>>;
};

/** One snapshot of every live read, shared by all requests for 15 s (public RPC is rate-limited). */
export function chainSnapshot(): Promise<ChainSnapshot> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const value = (async () => {
    const [network, pons, rewards, token] = await Promise.all([readNetwork(), readPonsFactory(), readRewards(), readToken()]);
    return { network, pons, rewards, token };
  })();
  cache = { at: Date.now(), value };
  return value;
}
