// Single source of truth for every placeholder in the build brief.
// Unset values stay `null` and the UI fails closed ("Not configured" / "Not deployed yet").
// Never put an invented address, fee, ticker or URL here as a default.
import { getAddress, isAddress, type Address } from "viem";

const str = (v: string | undefined) => (v && v.trim() !== "" ? v.trim() : null);
const addr = (v: string | undefined): Address | null => {
  const s = str(v);
  return s && isAddress(s) ? getAddress(s) : null;
};
const int = (v: string | undefined) => {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
};
const oneOf = <T extends string>(v: string | undefined, options: readonly T[]): T | null => {
  const s = str(v)?.toUpperCase();
  return (options as readonly string[]).includes(s ?? "") ? (s as T) : null;
};

export type NetworkName = "mainnet" | "testnet" | "local";
const network = (str(process.env.NEXT_PUBLIC_NETWORK) ?? "mainnet") as NetworkName;

export const config = {
  appName: "Sparecycle",
  network: (["mainnet", "testnet", "local"] as const).includes(network) ? network : "mainnet",
  rpcUrl: str(process.env.NEXT_PUBLIC_RPC_URL),
  explorerUrl: str(process.env.NEXT_PUBLIC_EXPLORER_URL),

  // Token (exists only after the Pons launch transaction confirms)
  ticker: str(process.env.NEXT_PUBLIC_TICKER),
  /** Brand name shown with the ticker (e.g. SPARE). The on-chain ticker is always shown next to it. */
  tickerBrand: str(process.env.NEXT_PUBLIC_TICKER_BRAND),
  tokenAddress: addr(process.env.NEXT_PUBLIC_TOKEN_ADDRESS),
  curveAddress: addr(process.env.NEXT_PUBLIC_CURVE_ADDRESS),
  /** Receives the official token's creator fees when that is a wallet, not the reward contract. Disclosed in the UI. */
  creatorFeeWallet: addr(process.env.NEXT_PUBLIC_CREATOR_FEE_WALLET),
  launchConfigId: int(process.env.NEXT_PUBLIC_LAUNCH_CONFIG_ID),

  // Open product decisions (brief §1 "Decisions before build")
  pairAsset: oneOf(process.env.NEXT_PUBLIC_PAIR_ASSET, ["ETH", "USDG"] as const),
  pairTokenAddress: addr(process.env.NEXT_PUBLIC_PAIR_TOKEN_ADDRESS),
  creatorTaxBps: int(process.env.NEXT_PUBLIC_CREATOR_TAX_BPS),
  nodePayoutAsset: oneOf(process.env.NEXT_PUBLIC_NODE_PAYOUT_ASSET, ["ETH", "USDG", "TOKEN"] as const),

  // Deployments and operator addresses
  rewardContract: addr(process.env.NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS),
  /** Owner of the reward contract. A single wallet unless it equals NEXT_PUBLIC_MULTISIG_ADDRESS. */
  owner: addr(process.env.NEXT_PUBLIC_OWNER_ADDRESS),
  multisig: addr(process.env.NEXT_PUBLIC_MULTISIG_ADDRESS),
  schedulerAddress: addr(process.env.NEXT_PUBLIC_SCHEDULER_ADDRESS),
  sweepBotAddress: addr(process.env.NEXT_PUBLIC_SWEEP_BOT_ADDRESS),

  // Paid jobs (SparecycleJobPayments). Unset address = free jobs only.
  jobPayments: addr(process.env.NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS),
  /**
   * SparecycleJobPaymentsV2, only while the scheduler runs it (TOKEN_PAYMENTS_V2=on with TOKEN_JOB_PAYMENTS_V2_ADDRESS;
   * next.config.ts sets this public copy from them at build time). Null otherwise: the dapp behaves as before V2.
   * The browser's receipt check uses it to accept version 2 receipts charged on V2.
   */
  jobPaymentsV2: addr(process.env.NEXT_PUBLIC_JOB_PAYMENTS_V2_ADDRESS),
  /** Price of one work unit, wei. 0.5 gwei when unset. */
  jobPriceWeiPerUnit: /^\d{1,30}$/.test((process.env.NEXT_PUBLIC_JOB_PRICE_WEI_PER_UNIT ?? "").trim())
    ? BigInt(process.env.NEXT_PUBLIC_JOB_PRICE_WEI_PER_UNIT!.trim())
    : 500_000_000n,
  /** Receives 5% of job payments: a Safe multisig. */
  treasury: addr(process.env.NEXT_PUBLIC_TREASURY_ADDRESS),

  // Scheduler policy. The scheduler API is served by this app at /api/v1 unless overridden.
  schedulerApiUrl: str(process.env.NEXT_PUBLIC_SCHEDULER_API_URL) ?? "/api/v1",
  epochLength: int(process.env.NEXT_PUBLIC_EPOCH_LENGTH),
  claimWindow: str(process.env.NEXT_PUBLIC_CLAIM_WINDOW),

  // Links (footer / legal). Null = rendered as a labelled placeholder, never a dead link.
  links: {
    tos: str(process.env.NEXT_PUBLIC_TOS_URL),
    tosVersion: str(process.env.NEXT_PUBLIC_TOS_VERSION),
    privacy: str(process.env.NEXT_PUBLIC_PRIVACY_POLICY_URL),
    x: str(process.env.NEXT_PUBLIC_X_URL),
    github: str(process.env.NEXT_PUBLIC_GITHUB_URL),
    docs: str(process.env.NEXT_PUBLIC_DOCS_URL),
    telegram: str(process.env.NEXT_PUBLIC_TELEGRAM_URL),
  },
  domain: str(process.env.NEXT_PUBLIC_DOMAIN),
  walletConnectProjectId: str(process.env.NEXT_PUBLIC_WC_PROJECT_ID),
  /** Shown on the site; the date the brief's Pons facts were checked. */
  factsCheckedOn: "20 November 2026",
} as const;

export type AppConfig = typeof config;

/** Ticker for display: the real one once set, otherwise the literal placeholder. */
export const tickerLabel = () =>
  !config.ticker
    ? "[TICKER]"
    : config.tickerBrand && config.tickerBrand !== config.ticker
      ? `${config.tickerBrand} (on-chain: ${config.ticker})`
      : `${config.ticker}`;
/** Payout asset label for display, never guessed. */
export const payoutAssetLabel = () => config.nodePayoutAsset ?? "[NODE_PAYOUT_ASSET]";
export const pairAssetLabel = () => config.pairAsset ?? "[PAIR_ASSET]";
