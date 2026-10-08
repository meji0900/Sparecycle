// Pons v2 on Robinhood Chain (chain id 4663). External protocol: integrate, never fork.
// Addresses: official deployed-address list at https://docs.ponsfamily.com/v2 (#contracts).
// Every selector below was checked against the deployed bytecode on 20 Nov 2026
// (escrow: claim, claimToken, balanceOf, balanceOfToken; factory: canLaunch, launchFee, maxCreatorTaxBps,
// launchEnabled, getLaunchConfig, previewLaunchEconomics, getLaunchFeePolicy, transferCreatorFeeRecipient,
// approvedPairTokens, pairTokenEconomics, getLaunchedToken; hook: pendingFees, pendingCreatorTax, sweepPoolFees).
// Curve functions whose types the docs do not give (quoteFeeBalance, creatorTaxBalance, sweepFees) are
// read defensively and fail closed.
import { parseAbi, type Address } from "viem";

export const PONS_DOCS_URL = "https://docs.ponsfamily.com/v2";

export const PONS = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  feeEscrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  memeHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  buybackVault: "0x42df2a798f82289E177311362e8f5ccC45c1219c",
  launchLocker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952",
  launchAndBuy: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  launchDeployer: "0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42",
  graduationExecutor: "0xC7819B64A1dAECD7eC19856d026cb14EfBd89046",
  graduationGuard: "0xf5695117b99B6f6401e67d4195BD653628176C6C",
} as const satisfies Record<string, Address>;

export const PONS_LABELS: Record<keyof typeof PONS, string> = {
  factory: "Factory",
  feeEscrow: "Fee escrow",
  memeHook: "Meme hook (Uniswap v4)",
  buybackVault: "Buyback vault (unused: buybacks off)",
  launchLocker: "Launch locker",
  launchAndBuy: "Launch and buy router",
  launchDeployer: "Launch deployer",
  graduationExecutor: "Graduation executor",
  graduationGuard: "Graduation guard",
};

/** Known USDG token on Robinhood Chain (Paxos). `approvedPairTokens` returned true on 20 Nov 2026; re-verify. */
export const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

export const ponsFactoryAbi = parseAbi([
  "struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }",
  "struct FeePolicy { address protocolFeeRecipient; uint16 protocolFeeShareBps; uint16 buybackBurnBps; uint16 hookFeeBps; uint16 maxInternalPriceImpactBps; }",
  "struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }",
  "function launchFee() view returns (uint256)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function launchEnabled() view returns (bool)",
  "function canLaunch(address account) view returns (bool)",
  "function getLaunchConfig(uint256 id) view returns (LaunchConfig)",
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function getLaunchFeePolicy(address token) view returns (FeePolicy)",
  "function approvedPairTokens(address token) view returns (bool)",
  "function getLaunchedToken(address token) view returns (LaunchedToken)",
  "function transferCreatorFeeRecipient(address token, address newRecipient)",
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
]);

export const ponsEscrowAbi = parseAbi([
  "function claim()",
  "function claimToken(address token)",
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
]);

export const ponsCurveAbi = parseAbi([
  "function feeBps() view returns (uint256)",
  "function creatorTaxBps() view returns (uint256)",
  "function buybackEnabled() view returns (bool)",
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  // Types not given in the docs; uint256 assumed. Calls are wrapped and fail closed.
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function sweepFees(uint256 minBuybackTokensOut)",
]);

export const ponsHookAbi = parseAbi([
  "function pendingFees(bytes32 poolId, address currency) view returns (uint256)",
  "function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256)",
  "function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)",
]);

/** LaunchedToken.phase per the docs. */
export const LAUNCH_PHASES = ["Not graduated", "Swept", "Pool created", "Rescued"] as const;
