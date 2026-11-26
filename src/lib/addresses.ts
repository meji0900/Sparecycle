// One source for every address the site names: Sparecycle's own contracts and keys, the Pons contracts it uses and
// the testnet run. src/lib/proof.ts, /docs/contracts and the footer read from here; no other file repeats a literal
// (src/lib/addresses.test.ts checks proof.ts). Verification status carries the date it was last checked, because
// explorers change: re-check before changing a status, never assume.
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
    blockscout: {
      status: "not-verified",
      checkedOn: "25 Nov 2026",
      note: "Blockscout has not imported the Sourcify match yet. The source is published and matches the deployed bytecode exactly on Sourcify.",
    },
    sourcify: { status: "exact_match", checkedOn: "26 Nov 2026", verifiedAt: "2026-11-24T10:00:50Z" },
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
