// One source for every address the site names: Sparecycle's own contracts and keys, the Pons contracts it uses and
// the testnet run. src/lib/proof.ts, /docs/contracts and the footer read from here; no other file repeats a literal
// (src/lib/addresses.test.ts checks proof.ts). Verification status carries the date it was last checked, because
// explorers change: re-check before changing a status, never assume.
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { PONS } from "./pons";

export const MAINNET_CHAIN_ID = 4663;
export const TESTNET_CHAIN_ID = 46630;
export const MAINNET_EXPLORER = "https://robinhoodchain.blockscout.com";
export const TESTNET_EXPLORER = "https://explorer.testnet.chain.robinhood.com";
export const SOURCIFY_REPO = "https://repo.sourcify.dev";

/** Robinhood Chain mainnet (4663). */
export const ADDR = {
  /** SparecycleRewards: the node pot per epoch, Merkle claims, no withdraw function. */
  rewards: "0x68A0569130551154FC1aABD71d99f65681c58Fe9",
  /** SparecycleJobPayments: customers' prepaid balances for paid jobs. No owner, no admin. */
  payments: "0x420716931E5Ff2a984840C6E95837d826a8BE7eB",
  /**
   * SparecycleNodeStake: voluntary SPARE stake per node owner; slashes are proposed by the scheduler and decided by the
   * treasury Safe. Deployed 26 Nov 2026 (tx 0xf1fa8339…2321, block 123,623,184) with a minimum stake of 0. Internal
   * review only, not externally audited.
   */
  nodeStake: "0x6565874F5c281c618DcFb5DF52c7E554ae8a866B",
  /**
   * SparecycleX402Escrow: x402 pay-per-job in USDG. Each payment is held per job, forwarded on agreement (95% to the
   * treasury Safe for conversion to ETH, 5% to the treasury) or refunded. Owner: the treasury Safe. Deployed 26 Nov 2026
   * (tx 0xb3056068…10aa, block 123,661,769) with caps of 1 USDG per job, 100 USDG held, 10 USDG per payer per epoch.
   * Internal review only, not externally audited.
   */
  x402Escrow: "0xd7A11d725F411f96E02F04991B377953e7D7B7fB",
  /**
   * SparecycleJobPaymentsV2: prepaid balances in ETH or SPARE. A charge sends 95% to the node pot; the 5% protocol share
   * splits 350 treasury / 0 burner / 150 holder pool (bps of the charge). SPARE at 0% discount, sold for ETH so the pot
   * gets the same 95%. Owner of every setting: the treasury Safe. Deployed 27 Nov 2026 (tx 0x2f7f78ed…e977, block
   * 123,925,640). Internal review only, not externally audited.
   */
  jobPaymentsV2: "0x898D6b3E4BE9F100330B6b96352983483e25559c",
  /**
   * SparecycleHolderPool: each epoch's holder share as a Merkle root; eligible SPARE holders claim it as spend-only compute
   * credits in V2. Deployed 27 Nov 2026 (tx 0xbbbf82b6…a3f4, block 123,925,668). Internal review only.
   */
  holderPool: "0x25cdf643aC1B6B06CcF11b7Eebc88659219744b5",
  /**
   * SparecycleBurner: buys and burns SPARE from its share of V2 charges. Its share is 0 (burn postponed by the owner), so
   * it holds nothing until the Safe changes the split. Deployed 27 Nov 2026 (tx 0x89934189…f0a8, block 123,925,607).
   */
  burner: "0xBE588f785300bA695e18F74854E9005b9c59C0F2",
  /**
   * UniswapV4SpareAdapter: swaps SPARE and ETH on the SPARE/ETH Uniswap v4 pool for V2 and the Burner. No owner, holds
   * nothing between calls. Deployed 27 Nov 2026 (tx 0x21be9848…1929, block 123,925,577).
   */
  spareAdapter: "0x0A86983bB475F984a5D75a71D51daB0F93b80961",
  /** USDG (Global Dollar, Paxos), the x402 payment asset: 6 decimals, EIP-3009 signed transfers. Not Sparecycle's. */
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  /** Treasury Safe (Safe 1.5.0, 2 of 3): 5% of every charge, and since 25 Nov 2026 the reward contract's owner. */
  treasurySafe: "0xb262E4436aD6760F91e987f14e2fAc5D6550c71B",
  /** The SafeL2 1.5.0 singleton the treasury Safe proxy delegates to (storage slot 0 of the proxy, read 26 Nov 2026). */
  safeL2Singleton: "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e",
  /** The treasury Safe's three signers. All three keys are currently held by the project owner. */
  safeSigners: [
    "0x310e38F441296070a73549176Df3ED1c3d80E22E",
    "0xf185f003840C35c6D3568F414038C7b648d854Ab",
    "0x783435E47AcE1905C1197b1d36526797d3dbE696",
  ],
  /** Deployed both contracts and launched CYCLE; the reward contract's owner until 25 Nov 2026. */
  launchWallet: "0x6C079ff20B77fBbc89Fb5C90c5f43Cf24166d7D4",
  /** Scheduler key: posts each epoch's payout root and charges paid jobs. Gas only. */
  scheduler: "0xc062625d4bD24bcE5C8b62F950A38C962CF240B6",
  /** Sweep bot key: moves Pons fees into the reward contract. Gas only. */
  sweepBot: "0xAd5ec8726b74e5c0c1455137beA80B1d13a2fEFa",
  /** Team wallet: launched SPARE and receives its creator fees. */
  teamWallet: "0xBA839DD7d615bD5100236f7bbAbB50EC920cC728",
  /** SpareCycle (SPARE), the official token, and its Pons bonding curve (both deployed by the Pons factory). */
  spareToken: "0x012D695B94377E0c7b9EdEE3d824259BaA37cf3A",
  spareCurve: "0x9A0a19563441797D4fec78C30d0433dAf784A783",
  /** Sparecycle (CYCLE), the earlier launch, and its curve (both deployed by the Pons factory). */
  cycleToken: "0x2DbDcAf731ed6fDD55176183Ae7202a0D77F3A02",
  cycleCurve: "0xFef520872712bb92Cc38D905b55d19d2d2660048",
} as const;

/** Robinhood Chain testnet (46630): the full-loop run of 20 Nov 2026. Pons is not on testnet, so a mock escrow. */
export const TESTNET_ADDR = {
  rewards: "0x42387abDf935BCca8484515453945fA6CD5C5661",
  mockEscrow: "0xc6168598bA048b23faBfED4EEec2EF417a30b554",
  ownerA: "0x503ecd2D1e47610882D27fD743bfB3a5c7611bD9",
  ownerB: "0xf9D7AD726Bb997DC601cF2A99a3AF80C79C4A711",
} as const;

// ---- Source verification, with the date of the check ----------------------------------------------------------

export type ExplorerCheck = {
  status: "verified" | "not-verified" | "standard-proxy";
  checkedOn: string;
  note?: string;
};
export type SourcifyCheck = { status: "exact_match"; checkedOn: string; verifiedAt: string };
export type SourceStatus = { blockscout: ExplorerCheck | null; sourcify: SourcifyCheck | null };

/**
 * Blockscout: read from its v2 API / address page (scripts are behind a Cloudflare check, so this is a browser
 * check); null = not recorded. Sourcify: GET https://sourcify.dev/server/v2/contract/4663/<address>.
 */
export const VERIFICATION = {
  rewards: {
    blockscout: { status: "verified", checkedOn: "25 Nov 2026" },
    sourcify: { status: "exact_match", checkedOn: "26 Nov 2026", verifiedAt: "2026-11-22T13:19:00Z" },
  },
  payments: {
    blockscout: { status: "verified", checkedOn: "26 Nov 2026" },
    sourcify: { status: "exact_match", checkedOn: "26 Nov 2026", verifiedAt: "2026-11-24T10:00:50Z" },
  },
  x402Escrow: {
    blockscout: null,
    sourcify: { status: "exact_match", checkedOn: "26 Nov 2026", verifiedAt: "2026-11-26T16:44:00Z" },
  },
  nodeStake: {
    blockscout: { status: "verified", checkedOn: "26 Nov 2026" },
    sourcify: { status: "exact_match", checkedOn: "26 Nov 2026", verifiedAt: "2026-11-26T13:40:00Z" },
  },
  jobPaymentsV2: {
    blockscout: null,
    sourcify: { status: "exact_match", checkedOn: "27 Nov 2026", verifiedAt: "2026-11-27T02:32:40Z" },
  },
  holderPool: {
    blockscout: null,
    sourcify: { status: "exact_match", checkedOn: "27 Nov 2026", verifiedAt: "2026-11-27T02:32:48Z" },
  },
  burner: {
    blockscout: null,
    sourcify: { status: "exact_match", checkedOn: "27 Nov 2026", verifiedAt: "2026-11-27T02:32:29Z" },
  },
  spareAdapter: {
    blockscout: null,
    sourcify: { status: "exact_match", checkedOn: "27 Nov 2026", verifiedAt: "2026-11-27T02:32:26Z" },
  },
  treasurySafe: {
    blockscout: {
      status: "standard-proxy",
      checkedOn: "25 Nov 2026",
      note: "A Safe proxy: standard Safe 1.5.0 bytecode that delegates to the SafeL2 singleton below. Blockscout recognises the singleton; proxies like this are not verified one by one.",
    },
    sourcify: null,
  },
  safeL2Singleton: {
    blockscout: null,
    sourcify: { status: "exact_match", checkedOn: "26 Nov 2026", verifiedAt: "2026-11-08T09:40:40Z" },
  },
} as const satisfies Record<string, SourceStatus>;

// ---- The table on /docs/contracts ----------------------------------------------------------------------------

export type AddressRow = {
  id: string;
  name: string;
  /** What it does, in one or two sentences. */
  role: string;
  address: string;
  network: "mainnet" | "testnet";
  kind: "contract" | "key";
  /** Whose code it is: Sparecycle's, Pons's (we use it, we did not write or verify it), or Safe's standard contracts. */
  by: "sparecycle" | "pons" | "safe";
  source?: SourceStatus;
};

export const ADDRESS_ROWS: AddressRow[] = [
  {
    id: "rewards",
    name: "SparecycleRewards",
    role: "The node pot. Each six-hour epoch's pot is split by checked work and claimed with a Merkle proof. No withdraw function. Owner: the treasury Safe.",
    address: ADDR.rewards,
    network: "mainnet",
    kind: "contract",
    by: "sparecycle",
    source: VERIFICATION.rewards,
  },
  {
    id: "payments",
    name: "SparecycleJobPayments",
    role: "Customers' prepaid balances for paid jobs. Only the customer can withdraw. Charges send 95% to the node pot and 5% to the treasury Safe. No owner, no admin functions.",
    address: ADDR.payments,
    network: "mainnet",
    kind: "contract",
    by: "sparecycle",
    source: VERIFICATION.payments,
  },
  {
    id: "node-stake",
    name: "SparecycleNodeStake",
    role: "Voluntary SPARE stake per node owner. A slash is proposed by the scheduler only after repeated faults against two other owners' results, can be appealed, is decided by the treasury Safe, takes at most 10% per proposal and is burned. Minimum stake 0: running a node needs no token. Internal review only, not externally audited.",
    address: ADDR.nodeStake,
    network: "mainnet",
    kind: "contract",
    by: "sparecycle",
    source: VERIFICATION.nodeStake,
  },
  {
    id: "x402-escrow",
    name: "SparecycleX402Escrow",
    role: "x402 pay-per-job in USDG: each payment is held for one job, forwarded when the two results match (95% to the treasury Safe, which converts it to ETH for the node pot, 5% to the treasury) or refunded in full. Anyone can refund after the 12-hour deadline. Caps: 1 USDG per job, 100 USDG held, 10 USDG per payer per epoch. Owner: the treasury Safe. Internal review only, not externally audited.",
    address: ADDR.x402Escrow,
    network: "mainnet",
    kind: "contract",
    by: "sparecycle",
    source: VERIFICATION.x402Escrow,
  },
  {
    id: "job-payments-v2",
    name: "SparecycleJobPaymentsV2",
    role: "Prepaid balances for paid jobs in ETH or SPARE, from 27 Nov 2026. A charge sends 95% to the node pot; of the 5% protocol share, 3.5% goes to the treasury Safe and 1.5% to the holder pool (the burn share is 0). SPARE is taken at the pool price with no discount and sold for ETH, so the pot gets the same 95%; SPARE payments open once the Safe sets a reference price. Customers withdraw in two steps. Settings: the treasury Safe. Internal review only, not externally audited.",
    address: ADDR.jobPaymentsV2,
    network: "mainnet",
    kind: "contract",
    by: "sparecycle",
    source: VERIFICATION.jobPaymentsV2,
  },
  {
    id: "holder-pool",
    name: "SparecycleHolderPool",
    role: "Each epoch's holder share of charges, posted by the scheduler as a Merkle root. Eligible SPARE holders claim their part as compute credits that pay for jobs and cannot be withdrawn or transferred; unclaimed parts roll back into the pool after 8 epochs. Internal review only, not externally audited.",
    address: ADDR.holderPool,
    network: "mainnet",
    kind: "contract",
    by: "sparecycle",
    source: VERIFICATION.holderPool,
  },
  {
    id: "burner",
    name: "SparecycleBurner",
    role: "Buys and burns SPARE from its share of V2 charges. Its share is 0 (the burn is postponed), so it holds nothing until the treasury Safe changes the split. Internal review only, not externally audited.",
    address: ADDR.burner,
    network: "mainnet",
    kind: "contract",
    by: "sparecycle",
    source: VERIFICATION.burner,
  },
  {
    id: "spare-adapter",
    name: "UniswapV4SpareAdapter",
    role: "Swaps SPARE and ETH on the SPARE/ETH Uniswap v4 pool for SparecycleJobPaymentsV2 and the Burner, with a minimum output on every swap. No owner; it holds nothing between calls. Internal review only, not externally audited.",
    address: ADDR.spareAdapter,
    network: "mainnet",
    kind: "contract",
    by: "sparecycle",
    source: VERIFICATION.spareAdapter,
  },
  {
    id: "treasury-safe",
    name: "Treasury Safe (2 of 3)",
    role: "Receives 5% of every charge. Owner of SparecycleRewards since 25 Nov 2026: every owner action needs 2 of its 3 signers. All three keys are currently held by the project owner.",
    address: ADDR.treasurySafe,
    network: "mainnet",
    kind: "contract",
    by: "safe",
    source: VERIFICATION.treasurySafe,
  },
  {
    id: "safe-singleton",
    name: "SafeL2 1.5.0 singleton",
    role: "Safe's standard implementation contract that the treasury Safe proxy runs. Shared by every Safe of this version; not deployed by Sparecycle.",
    address: ADDR.safeL2Singleton,
    network: "mainnet",
    kind: "contract",
    by: "safe",
    source: VERIFICATION.safeL2Singleton,
  },
  {
    id: "scheduler",
    name: "Scheduler key",
    role: "Posts each epoch's payout root to SparecycleRewards and charges paid jobs in SparecycleJobPayments. Holds gas only.",
    address: ADDR.scheduler,
    network: "mainnet",
    kind: "key",
    by: "sparecycle",
  },
  {
    id: "sweep-bot",
    name: "Sweep bot key",
    role: "Moves creator fees from the Pons fee escrow into SparecycleRewards. Holds gas only.",
    address: ADDR.sweepBot,
    network: "mainnet",
    kind: "key",
    by: "sparecycle",
  },
  ...ADDR.safeSigners.map(
    (a, i): AddressRow => ({
      id: `safe-signer-${i + 1}`,
      name: `Safe signer ${i + 1} of 3`,
      role: "One of the treasury Safe's three signers. Held by the project owner, like the other two.",
      address: a,
      network: "mainnet",
      kind: "key",
      by: "sparecycle",
    }),
  ),
  {
    id: "launch-wallet",
    name: "Launch wallet",
    role: "Deployed both contracts and launched CYCLE. Owner of SparecycleRewards until 25 Nov 2026; its owner calls now revert.",
    address: ADDR.launchWallet,
    network: "mainnet",
    kind: "key",
    by: "sparecycle",
  },
  {
    id: "team-wallet",
    name: "Team wallet",
    role: "Launched SPARE and receives its creator fees (not the node pot).",
    address: ADDR.teamWallet,
    network: "mainnet",
    kind: "key",
    by: "sparecycle",
  },
  {
    id: "spare-token",
    name: "SpareCycle (SPARE) token",
    role: "The official token. Deployed by the Pons v2 factory at launch.",
    address: ADDR.spareToken,
    network: "mainnet",
    kind: "contract",
    by: "pons",
  },
  {
    id: "spare-curve",
    name: "SPARE bonding curve",
    role: "Pons v2 bonding curve of SPARE.",
    address: ADDR.spareCurve,
    network: "mainnet",
    kind: "contract",
    by: "pons",
  },
  {
    id: "cycle-token",
    name: "Sparecycle (CYCLE) token",
    role: "The earlier launch. Its creator fees go to SparecycleRewards. Deployed by the Pons v2 factory.",
    address: ADDR.cycleToken,
    network: "mainnet",
    kind: "contract",
    by: "pons",
  },
  {
    id: "cycle-curve",
    name: "CYCLE bonding curve",
    role: "Pons v2 bonding curve of CYCLE.",
    address: ADDR.cycleCurve,
    network: "mainnet",
    kind: "contract",
    by: "pons",
  },
  {
    id: "pons-factory",
    name: "Pons v2 factory",
    role: "Launched both tokens. Pons's contract, run by Pons.",
    address: PONS.factory,
    network: "mainnet",
    kind: "contract",
    by: "pons",
  },
  {
    id: "pons-fee-escrow",
    name: "Pons v2 fee escrow",
    role: "Holds creator fees until they are claimed; SparecycleRewards claims CYCLE's from here. Pons's contract.",
    address: PONS.feeEscrow,
    network: "mainnet",
    kind: "contract",
    by: "pons",
  },
  {
    id: "testnet-rewards",
    name: "SparecycleRewards (testnet)",
    role: "The reward contract of the full-loop testnet run (20 Nov 2026): two epochs settled, four claims paid.",
    address: TESTNET_ADDR.rewards,
    network: "testnet",
    kind: "contract",
    by: "sparecycle",
  },
  {
    id: "testnet-mock-escrow",
    name: "MockPonsFeeEscrow (testnet)",
    role: "A test stand-in for the Pons fee escrow, because Pons is not deployed on testnet.",
    address: TESTNET_ADDR.mockEscrow,
    network: "testnet",
    kind: "contract",
    by: "sparecycle",
  },
  {
    id: "testnet-owner-a",
    name: "Test owner A",
    role: "Test node-owner wallet of the testnet run.",
    address: TESTNET_ADDR.ownerA,
    network: "testnet",
    kind: "key",
    by: "sparecycle",
  },
  {
    id: "testnet-owner-b",
    name: "Test owner B",
    role: "Test node-owner wallet of the testnet run.",
    address: TESTNET_ADDR.ownerB,
    network: "testnet",
    kind: "key",
    by: "sparecycle",
  },
];

export const explorerAddressUrl = (address: string, network: AddressRow["network"] = "mainnet") =>
  `${network === "testnet" ? TESTNET_EXPLORER : MAINNET_EXPLORER}/address/${address}`;
export const explorerTxUrl = (hash: string, network: AddressRow["network"] = "mainnet") =>
  `${network === "testnet" ? TESTNET_EXPLORER : MAINNET_EXPLORER}/tx/${hash}`;
export const sourcifyUrl = (address: string, chainId = MAINNET_CHAIN_ID) => `${SOURCIFY_REPO}/${chainId}/${address}`;

// ---- Token features (docs/token-features.md): contracts and settings that are NOT live yet ---------------------
// Everything below is behind feature flags that default to off (TOKEN_* in src/server/env.ts), pending the legal
// review, the external audits and the Safe key split (F2). Nothing here is in ADDRESS_ROWS, so /docs/contracts does
// not change. A null is a contract that is not deployed, or an address that is not recorded and checked yet: the UI
// shows NOT_LIVE_YET for it, never a zero or a sample value.
//
// Each value can be set without a code change by a server environment variable (read when the server starts; static
// pages read it at build time), so the flags can be turned on once the audited contracts are deployed. Set a value
// only after checking it on the explorer. A malformed value is ignored (stays null). Once a value is final, it can also
// be written here as the default, like the addresses above.
//   TOKEN_NODE_STAKE_ADDRESS, TOKEN_HOLDER_POOL_ADDRESS, TOKEN_BURNER_ADDRESS, TOKEN_JOB_PAYMENTS_V2_ADDRESS
//   TOKEN_V4_POOL_MANAGER_ADDRESS, TOKEN_V4_STATE_VIEW_ADDRESS, TOKEN_V4_UNIVERSAL_ROUTER_ADDRESS
//   TOKEN_V4_POOL_KEY = "fee,tickSpacing,hooks" (currency0 is native ETH, currency1 is SPARE; it must hash to the pool id)
//   TOKEN_SAFE_MULTISEND_CALL_ONLY_ADDRESS, TOKEN_SPARE_START_BLOCK

const tokenEnv = (name: string): string | null => {
  const v = typeof process !== "undefined" ? process.env?.[name] : undefined;
  return v && v.trim() !== "" ? v.trim() : null;
};
const tokenEnvAddress = (name: string): Address | null => {
  const v = tokenEnv(name);
  return v && isAddress(v, { strict: false }) ? getAddress(v) : null;
};

/** The placeholder every UI shows for a contract or value that does not exist on-chain yet. */
export const NOT_LIVE_YET = "[NOT LIVE YET]";

/** Sparecycle's token-feature contracts (brief §3, §4, §6). null = not deployed. Interfaces: src/lib/token-contracts.ts. */
export const TOKEN_CONTRACTS: {
  nodeStake: Address | null;
  holderPool: Address | null;
  burner: Address | null;
  jobPaymentsV2: Address | null;
} = {
  /** SparecycleNodeStake: SPARE stake per owner wallet, slash proposals (brief §3). Deployed 26 Nov 2026 (ADDR.nodeStake). */
  nodeStake: tokenEnvAddress("TOKEN_NODE_STAKE_ADDRESS") ?? getAddress(ADDR.nodeStake),
  /** SparecycleHolderPool: per-epoch Merkle root of holder shares (brief §6.2). Deployed 27 Nov 2026 (ADDR.holderPool); the scheduler uses it when TOKEN_HOLDER_POOL_ADDRESS is set. */
  holderPool: tokenEnvAddress("TOKEN_HOLDER_POOL_ADDRESS"),
  /** SparecycleBurner: phase 2b burn path (brief §4). Deployed 27 Nov 2026 (ADDR.burner) with a share of 0. */
  burner: tokenEnvAddress("TOKEN_BURNER_ADDRESS"),
  /** SparecycleJobPaymentsV2: configurable split of the 5%, creditFor (brief §6.3). Deployed 27 Nov 2026 (ADDR.jobPaymentsV2); used when TOKEN_PAYMENTS_V2=on and TOKEN_JOB_PAYMENTS_V2_ADDRESS is set. */
  jobPaymentsV2: tokenEnvAddress("TOKEN_JOB_PAYMENTS_V2_ADDRESS"),
};

export type V4PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

/** TOKEN_V4_POOL_KEY "fee,tickSpacing,hooks" as the native-ETH / SPARE pool key, or null. */
function poolKeyFromEnv(): V4PoolKey | null {
  const v = tokenEnv("TOKEN_V4_POOL_KEY");
  if (!v) return null;
  const [fee, tick, hooks] = v.split(",").map((x) => x.trim());
  if (!/^\d{1,8}$/.test(fee ?? "") || !/^-?\d{1,7}$/.test(tick ?? "") || !hooks || !isAddress(hooks, { strict: false })) return null;
  return { currency0: "0x0000000000000000000000000000000000000000", currency1: ADDR.spareToken, fee: Number(fee), tickSpacing: Number(tick), hooks: getAddress(hooks) };
}

/**
 * Uniswap v4 on Robinhood Chain (4663), verified 27 Nov 2026 (evidence in docs/uniswap-v4-adapter.md):
 * - The three contracts are Uniswap's own: each is listed under "Robinhood Chain: 4663" on
 *   developers.uniswap.org/docs/protocols/v4/deployments and in github.com/Uniswap/contracts deployments/4663.json,
 *   has code on-chain and is verified on Sourcify (match). StateView.poolManager() returns the PoolManager.
 * - The pool key is read from the PoolManager's Initialize event for the pool id (block 123,451,046, tx
 *   0x8d9b666219ad3fcf09127b8115ae5b398fd16d296a6ab7cad1dc0c7db85274b5): native ETH / SPARE, fee 0, tick spacing 200,
 *   hooks = the Pons v2 meme hook (PONS.memeHook). keccak256(abi.encode(key)) equals `spareEthPoolId`, the id
 *   DexScreener also lists. The hook takes 2.90% of every swap's output (100 bps hook fee + 190 bps creator tax,
 *   frozen for this pool when Pons registered it), so a quote that ignores the hook is 2.90% too high.
 * Each value can still be overridden by its TOKEN_V4_* environment variable.
 */
export const UNISWAP_V4_DEFAULTS = {
  /** PoolManager (v4-core). Holds every v4 pool's tokens. */
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
  /** StateView (v4-periphery lens over the PoolManager's storage). */
  stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
  /**
   * Universal Router 2.1.2, `latest.UniversalRouter` in deployments/4663.json (the docs also list an earlier router,
   * 0x8876789976dEcBfCbBbe364623C63652db8C0904). Both decode v4 ExactInputSingleParams with minHopPriceX36 (Sourcify
   * source); src/server/burns.ts encodes that layout, and a fork test ran that payload on both routers.
   */
  universalRouter: "0x204FAca1764B154221e35c0d20aBb3c525710498",
  /** The SPARE/ETH pool key, from the Initialize event (see above). */
  spareEthPoolKey: {
    currency0: "0x0000000000000000000000000000000000000000",
    currency1: ADDR.spareToken,
    fee: 0,
    tickSpacing: 200,
    hooks: PONS.memeHook,
  },
  /**
   * The Pons hook's cut of every swap's output on this pool, in bps: hookFeeBps 100 + creatorTaxBps 190, read from the
   * hook's launches(poolId) (fixed at registration; no setter changes them).
   */
  spareEthPoolHookCutBps: 290,
} as const satisfies {
  poolManager: Address;
  stateView: Address;
  universalRouter: Address;
  spareEthPoolKey: V4PoolKey;
  spareEthPoolHookCutBps: number;
};

/**
 * Uniswap v4 on Robinhood Chain, as the burn path (phase 2a) and the swap adapter need it: the verified defaults above,
 * each overridable by env. `spareEthPoolId` is the SPARE/ETH pool id (PoolManager Initialize event); a pool key set by
 * env must hash to it (src/server/burns.ts checks this) or no payload is prepared.
 */
export const UNISWAP_V4: {
  poolManager: Address | null;
  stateView: Address | null;
  universalRouter: Address | null;
  spareEthPoolId: Hex;
  spareEthPoolKey: V4PoolKey | null;
  /** The hook's cut of each swap's output (bps); quotes for this pool must take it off. */
  spareEthPoolHookCutBps: number;
} = {
  poolManager: tokenEnvAddress("TOKEN_V4_POOL_MANAGER_ADDRESS") ?? UNISWAP_V4_DEFAULTS.poolManager,
  stateView: tokenEnvAddress("TOKEN_V4_STATE_VIEW_ADDRESS") ?? UNISWAP_V4_DEFAULTS.stateView,
  universalRouter: tokenEnvAddress("TOKEN_V4_UNIVERSAL_ROUTER_ADDRESS") ?? UNISWAP_V4_DEFAULTS.universalRouter,
  spareEthPoolId: "0x6c779d26cc59abb9f22d348257ee013b66d2a5f0d9dcf1bb9fa9338874eab1bd",
  spareEthPoolKey: poolKeyFromEnv() ?? { ...UNISWAP_V4_DEFAULTS.spareEthPoolKey },
  spareEthPoolHookCutBps: UNISWAP_V4_DEFAULTS.spareEthPoolHookCutBps,
};

/**
 * Safe's MultiSendCallOnly on Robinhood Chain: needed only to batch the swap and SPARE.burn() in one Safe transaction
 * (BURN_METHOD "burn"). Not recorded yet.
 */
export const SAFE_MULTISEND_CALL_ONLY: Address | null = tokenEnvAddress("TOKEN_SAFE_MULTISEND_CALL_ONLY_ADDRESS");

/** The two burn sinks: SPARE sent to either counts as burned (brief §4). */
export const BURN_SINKS = {
  zero: "0x0000000000000000000000000000000000000000",
  dead: "0x000000000000000000000000000000000000dEaD",
} as const satisfies Record<string, Address>;

/**
 * First block to read SPARE Transfer logs from (the SPARE launch transaction's block; TOKEN_SPARE_START_BLOCK). On
 * mainnet that is block 122,170,534: SPARE's first Transfer, the mint from 0x0 in tx 0x0e116401…9b48 (24 Nov 2026
 * 10:55:47 UTC), found with eth_getLogs. Unset: holder weights cannot be computed (a holder's balance at an epoch start
 * needs the full history) and the holder page reads no burn rows.
 */
export const SPARE_START_BLOCK: bigint | null = (() => {
  const v = tokenEnv("TOKEN_SPARE_START_BLOCK");
  return v && /^\d{1,12}$/.test(v) ? BigInt(v) : null;
})();

export type HolderExclusion = { address: Address | null; label: string; why: string };

/**
 * Addresses that never get a holder weight (brief §6.1, N14), shown on the holder page. On top of this list, every
 * address with contract code is excluded unless it is in HOLDER_CONTRACT_ALLOWLIST (an EIP-7702 delegated EOA counts
 * as an EOA). A null entry is not deployed or not recorded yet; it is listed so the page shows it as NOT_LIVE_YET.
 */
export const HOLDER_EXCLUSIONS: HolderExclusion[] = [
  { address: UNISWAP_V4.poolManager, label: "Uniswap v4 PoolManager", why: "Holds every v4 pool's tokens, LP positions included (LPs are not counted, N14)." },
  { address: PONS.memeHook, label: "Pons meme hook (Uniswap v4)", why: "A pool hook contract." },
  { address: ADDR.spareCurve, label: "SPARE bonding curve (Pons)", why: "The Pons curve." },
  { address: PONS.feeEscrow, label: "Pons fee escrow", why: "Holds creator fees for Pons launches." },
  { address: PONS.buybackVault, label: "Pons buyback vault", why: "Pons's vault (buybacks are off for SPARE)." },
  { address: PONS.launchLocker, label: "Pons launch locker", why: "Holds the locked launch liquidity." },
  { address: ADDR.teamWallet, label: "Team wallet", why: "Launched SPARE and receives its creator fees." },
  { address: ADDR.launchWallet, label: "Launch wallet", why: "Deployed the contracts." },
  { address: ADDR.treasurySafe, label: "Treasury Safe", why: "Receives 5% of every charge and runs the burns." },
  { address: TOKEN_CONTRACTS.nodeStake, label: "SparecycleNodeStake", why: "Staked SPARE counts for its owner instead (N15)." },
  { address: TOKEN_CONTRACTS.burner, label: "SparecycleBurner", why: "The burn contract (phase 2b)." },
  { address: TOKEN_CONTRACTS.holderPool, label: "SparecycleHolderPool", why: "The holder pool itself." },
  { address: BURN_SINKS.zero, label: "Zero address", why: "Burned." },
  { address: BURN_SINKS.dead, label: "Dead address", why: "Burned." },
];

/** Contracts that may hold a holder weight despite having code (N14). Empty: no contract is allow-listed. */
export const HOLDER_CONTRACT_ALLOWLIST: Address[] = [];
