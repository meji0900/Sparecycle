// ABI of contracts/src/SparecycleX402Escrow.sol (x402 pay-per-job escrow, option X1). INTERNAL REVIEW ONLY — NOT
// EXTERNALLY AUDITED. Checked against the compiled contract by src/server/x402.test.ts.
import { parseAbi } from "viem";

export const x402EscrowAbi = parseAbi([
  "function TREASURY_BPS() view returns (uint16)",
  "function MIN_SETTLE_WINDOW() view returns (uint64)",
  "function MAX_SETTLE_WINDOW() view returns (uint64)",
  "function rewards() view returns (address)",
  "function asset() view returns (address)",
  "function treasury() view returns (address)",
  "function settleWindow() view returns (uint64)",
  "function potPaysInAsset() view returns (bool)",
  "function forwardTo() view returns (address)",
  "function maxPerJob() view returns (uint256)",
  "function maxTotalHeld() view returns (uint256)",
  "function maxPerPayerPerEpoch() view returns (uint256)",
  "function fundedInEpoch(address, uint64) view returns (uint256)",
  "function fundingPaused() view returns (bool)",
  "function totalHeld() view returns (uint256)",
  "function surplus() view returns (uint256)",
  "function escrows(bytes32) view returns (address payer, uint64 deadline, uint8 state, uint256 amount)",
  "function fund(bytes32 escrowId, address payer, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 authorizationNonce, uint8 v, bytes32 r, bytes32 s)",
  "function forward(bytes32 escrowId)",
  "function refund(bytes32 escrowId)",
  "function setForwardTo(address next)",
  "function setCaps(uint256 maxPerJob_, uint256 maxTotalHeld_, uint256 maxPerPayerPerEpoch_)",
  "function setFundingPaused(bool paused)",
  "function recoverSurplus(address token, address to) returns (uint256 amount)",
  "event Funded(bytes32 indexed escrowId, address indexed payer, uint256 amount, uint64 deadline, bytes32 authorizationNonce)",
  "event Forwarded(bytes32 indexed escrowId, address indexed payer, uint256 amount, uint256 toPot, uint256 toTreasury, address potRecipient, bool forConversion)",
  "event Refunded(bytes32 indexed escrowId, address indexed payer, uint256 amount, bool byScheduler)",
  "event ForwardToSet(address indexed previous, address indexed next)",
  "event CapsSet(uint256 maxPerJob, uint256 maxTotalHeld, uint256 maxPerPayerPerEpoch)",
  "event FundingPausedSet(bool paused)",
  "event SurplusRecovered(address indexed token, address indexed to, uint256 amount)",
  "error ZeroAddress()",
  "error ZeroAmount()",
  "error ZeroEscrowId()",
  "error NotAContract()",
  "error BadSettleWindow()",
  "error BadCaps()",
  "error NotScheduler()",
  "error FundingIsPaused()",
  "error EscrowExists(bytes32 escrowId)",
  "error OverJobCap(uint256 amount, uint256 maxPerJob)",
  "error OverTotalCap(uint256 wouldHold, uint256 maxTotalHeld)",
  "error OverPayerEpochCap(address payer, uint256 wouldBe, uint256 maxPerPayerPerEpoch)",
  "error AmountMismatch(uint256 expected, uint256 received)",
  "error NotHeld(bytes32 escrowId)",
  "error DeadlinePassed(bytes32 escrowId, uint64 deadline)",
  "error TooEarly(bytes32 escrowId, uint64 deadline)",
  "error PotFundingMismatch(uint256 expected, uint256 sent)",
  "error NothingToRecover()",
  "error RenounceDisabled()",
]);

/** `escrows(id).state` codes. */
export const ESCROW_STATE = ["none", "held", "forwarded", "refunded"] as const;
export type EscrowState = (typeof ESCROW_STATE)[number];

/** The EIP-3009 reads and the token error the scheduler relies on (USDG on Robinhood Chain answers all of them). */
export const eip3009Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function decimals() view returns (uint8)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
