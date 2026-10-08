// Recorded evidence for /proof: mainnet transactions and pre-launch test results, each with a link anyone can open.
// Mainnet facts are re-read live on the page; this file only holds what a live read cannot return (transaction
// hashes, test runs). Every hash below was read back from the chain (receipts / event logs) when it was added.

export const MAINNET_EXPLORER = "https://robinhoodchain.blockscout.com";
export const TESTNET_EXPLORER = "https://explorer.testnet.chain.robinhood.com";
export const SOURCIFY_REPO = "https://repo.sourcify.dev";

export const MAINNET = {
  chainId: 4663,
  rewardContract: "0x68A0569130551154FC1aABD71d99f65681c58Fe9",
  owner: "0x6C079ff20B77fBbc89Fb5C90c5f43Cf24166d7D4",
  scheduler: "0xc062625d4bD24bcE5C8b62F950A38C962CF240B6",
  sweepBot: "0xAd5ec8726b74e5c0c1455137beA80B1d13a2fEFa",
  ponsFeeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  epochLengthSeconds: 21_600,
  /** Sourcify full match: the published source compiles to exactly the deployed bytecode. */
  sourcify: { status: "exact_match", checkedOn: "22 Nov 2026" },
} as const;

export type ProofTx = {
  date: string;
  what: string;
  detail: string;
  hash: string;
  block: number;
  from: string;
  to: string;
};

export const MAINNET_TXS: ProofTx[] = [
  {
    date: "22 Nov 2026, 13:16 UTC",
    what: "Deploy the reward contract",
    detail: "SparecycleRewards created with owner = launch wallet, scheduler = root poster, Pons v2 fee escrow, payout in ETH, 6-hour epochs. 1,796,425 gas.",
    hash: "0x94e69d1d5592e38d136ffa4b08e6d4d60d839e194acf374ee2972ce1c1e5b1aa",
    block: 120_653_539,
    from: MAINNET.owner,
    to: MAINNET.rewardContract,
  },
  {
    date: "22 Nov 2026, 13:20 UTC",
    what: "Gas for the scheduler",
    detail: "0.0003 ETH so the scheduler can post each epoch's Merkle root.",
    hash: "0x075db48ddee83ef2b3c9b689ec9bc6b1b0912301ea276e8b7d7d0bdc8fe01c00",
    block: 120_655_409,
    from: MAINNET.owner,
    to: MAINNET.scheduler,
  },
  {
    date: "22 Nov 2026, 13:20 UTC",
    what: "Gas for the sweep bot",
    detail: "0.0003 ETH so the bot can move Pons fees into the reward contract.",
    hash: "0xf695114d0c2c78c19cc9c648c5895fbde7b255173802ad491a4c676d994da772",
    block: 120_655_551,
    from: MAINNET.owner,
    to: MAINNET.sweepBot,
  },
];

/** The official token (the CA shown in the UI). Launched by 0xBA83…C728, whose wallet receives its creator fees. */
export const TOKEN = {
  name: "SpareCycle (SPARE)",
  address: "0x012d695b94377e0c7b9edee3d824259baa37cf3a",
  curve: "0x9A0a19563441797D4fec78C30d0433dAf784A783",
  launcher: "0xBA839DD7d615bD5100236f7bbAbB50EC920cC728",
  feeRecipient: "0xBA839DD7d615bD5100236f7bbAbB50EC920cC728",
  feeRecipientLabel: "the team wallet, not the node pot",
  creatorTaxBps: 190,
} as const;

/** The earlier launch from the project wallet. Its creator fees go to the reward contract (the node pot). */
export const EARLIER_TOKEN = {
  name: "Sparecycle (CYCLE)",
  address: "0x2DbDcAf731ed6fDD55176183Ae7202a0D77F3A02",
  curve: "0xFef520872712bb92Cc38D905b55d19d2d2660048",
} as const;

/** The token launch on Pons (null until it confirmed). */
export const LAUNCH_TX: ProofTx | null = {
  date: "24 Nov 2026, 08:12 UTC",
  what: "Launch Sparecycle (CYCLE) on Pons",
  detail:
    "1,000,000,000 CYCLE minted to the Pons bonding curve, none to the team. Pair ETH, 1% creator tax, creator fee recipient = the reward contract (permanent), buybacks off, no initial buy. 3,730,061 gas plus the 0.0005 ETH Pons launch fee.",
  hash: "0xef58abf4806e2baed99d3306afad69226cd136f2acdf0233b51b53e3250f3a01",
  block: 122_078_056,
  from: MAINNET.owner,
  to: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
};

/** SparecycleJobPayments: customers' prepaid balances for paid jobs (no owner, no admin). */
export const PAYMENTS = {
  address: "0x420716931E5Ff2a984840C6E95837d826a8BE7eB",
  sourcify: { status: "exact_match", checkedOn: "24 Nov 2026" },
} as const;

export const PAYMENTS_TX: ProofTx = {
  date: "24 Nov 2026, 10:00 UTC",
  what: "Deploy the payments contract",
  detail:
    "SparecycleJobPayments on the reward contract above, treasury = the Safe below (5% of each charge, fixed). No owner and no admin functions. 1,148,463 gas.",
  hash: "0x5591b60486632e484c83509835fa461c9aa2e776b2a25c35cc3082d6766bab37",
  block: 122_139_640,
  from: MAINNET.owner,
  to: PAYMENTS.address,
};

/** Every mainnet transaction on /proof, oldest first. */
export const ALL_MAINNET_TXS: ProofTx[] = [...MAINNET_TXS, ...(LAUNCH_TX ? [LAUNCH_TX] : []), PAYMENTS_TX];

/** Testnet run of the full loop (20 Nov 2026): Pons is not on testnet, so a mock escrow stands in for it. */
export const TESTNET = {
  chainId: 46630,
  rewardContract: "0x42387abDf935BCca8484515453945fA6CD5C5661",
  mockEscrow: "0xc6168598bA048b23faBfED4EEec2EF417a30b554",
  ownerA: "0x503ecd2D1e47610882D27fD743bfB3a5c7611bD9",
  ownerB: "0xf9D7AD726Bb997DC601cF2A99a3AF80C79C4A711",
  events: [
    { what: "Reward contract deployed", amount: null, hash: "0xa67b336e9578af102fb1b73784154ebbb418ec9edd764f65e97ea593231a7060" },
    { what: "Epoch 0: fees claimed from the escrow into the pot", amount: "0.002 ETH", hash: "0x2cecddd73715ed665b592e61cb2146d04646ebe549ae3f3b63d86484f312bf49" },
    { what: "Epoch 0 settled: Merkle root posted, whole pot reserved", amount: "0.005 ETH", hash: "0x30f0f8631f553f4be797300dcc5c5d8f8fbf525432eb83b9ab7de9258c8158a4" },
    { what: "Epoch 0: owner A claims", amount: "0.0025 ETH", hash: "0xf0cf54d3bb58c4cdd563b6a0613270209d633fbc62b71be0f6b0dcf38ad4a30c" },
    { what: "Epoch 0: owner B claims", amount: "0.0025 ETH", hash: "0xc88d755596103e6844f09c6369738ac05017bb98d03ff61a6c255767883fe436" },
    { what: "Epoch 1: fees claimed from the escrow into the pot", amount: "0.0004 ETH", hash: "0xac65f1a20196a338ff248814f3848717c50356dbbf8aaf0ed7d11b2b850f150a" },
    { what: "Epoch 1 settled: two real Vulkan nodes did the work", amount: "0.0012 ETH", hash: "0x6db3589ecbd16268a3bfe23e10908be25e1ef0231b30421da7da748edf5ab765" },
    { what: "Epoch 1: owner A claims", amount: "0.0006 ETH", hash: "0xde4b0bd2b6ef0c7eb4a57b7f413e4d0f311d6323e17537c7b5bf9c929b3e0fd5" },
    { what: "Epoch 1: owner B claims", amount: "0.0006 ETH", hash: "0x37b0a5b5304afe6f65b2bc3ca156f7c537b67e164f16d69e573da990abb5d94b" },
  ],
} as const;

export type TestRun = { title: string; date: string; result: string; detail: string };

export const TEST_RUNS: TestRun[] = [
  {
    title: "Payments contract and paid jobs",
    date: "24 Nov 2026",
    result: "20 contract tests, live-fork charge, 100/100 end to end",
    detail:
      "SparecycleJobPayments: deposits, two-step withdrawals with the 2-day fallback, charges only by the live scheduler and only for the open epoch, the customer's spend limit, 95/5 split, reentrancy. On a mainnet fork a charge landed in the live reward contract's pot. End to end on a local chain: a signed paid job is held, charged at close, its list hash matches the event, and node claims include it.",
  },
  {
    title: "Reward contract test suite",
    date: "22 Nov 2026",
    result: "94 tests pass",
    detail:
      "Unit tests, fuzz tests (512 random runs each) and invariant tests (256 runs) of SparecycleRewards: the pot can never pay out more than it holds, a leaf can be claimed once, only the scheduler posts roots, unclaimed funds roll over. A separate fork suite runs against the live Pons contracts.",
  },
  {
    title: "Mainnet dress rehearsal",
    date: "22 Nov 2026",
    result: "Deploy and launch succeed; fees reach the pot",
    detail:
      "A dry run from the real launch wallet against live mainnet state, with the final settings (ETH pair, 1% creator tax, Sparecycle / CYCLE). It deploys the reward contract, launches through the real Pons factory, buys 0.1 ETH in the opening second, sweeps the curve and claims the escrow: the pot ends at exactly the claimed amount. 6.93M gas for deploy + launch.",
  },
  {
    title: "Mainnet fork",
    date: "20 Nov 2026",
    result: "Fee path proven on the real Pons contracts",
    detail:
      "On a fork of mainnet: launch a test token through the Pons factory, buy 1 ETH, call operator.sweepCurve(curve) from a random address, then claimFeesFromEscrow(). The pot grew by 0.007 ETH. The real escrow rejects an empty claim with NoBalance(), and the contract handles that.",
  },
  {
    title: "Testnet, full loop",
    date: "20 Nov 2026",
    result: "2 epochs settled, 4 claims paid, pot = reserved = claimed",
    detail:
      "Jobs were run by nodes, checked against a second copy, closed into epochs, posted as Merkle roots and claimed by two owner wallets. Epoch 1 was worked by two real nodes on a Ryzen 7 5700U iGPU (Vulkan). 16 transactions, 0.0000326 ETH in gas.",
  },
  {
    title: "Same answer on different GPUs",
    date: "22 Nov 2026",
    result: "Images 8/8, text 10/10 identical",
    detail:
      "Rented RTX 3060 (Ampere) and RTX 4060 (Ada). SD 1.5 images matched within 4 bits of dHash (a different seed differs by 24 or more). Text matched 5/10 with llama.cpp defaults and 10/10 with a micro-batch of 1, now the node default. Cost of the test: $0.32.",
  },
];

/** Treasury for paid jobs: receives 5% of every charge. A Safe; both keys are currently the project owner's. */
export const TREASURY = {
  safe: "0xb262E4436aD6760F91e987f14e2fAc5D6550c71B",
  owners: ["0x6C079ff20B77fBbc89Fb5C90c5f43Cf24166d7D4", "0x783435E47AcE1905C1197b1d36526797d3dbE696"],
  threshold: 2,
  version: "Safe 1.5.0",
  createdOn: "24 Nov 2026",
} as const;
