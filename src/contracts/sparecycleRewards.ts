// ABI of contracts/src/SparecycleRewards.sol. This human-readable ABI is the interface contract between
// the Solidity code, the scheduler (root posting) and the dApp (status + claim). The Foundry test
// `test/AbiSync.t.sol` / `npm run contracts:abi-check` fails if the compiled ABI drifts from it.
import { parseAbi } from "viem";

export const sparecycleRewardsAbi = parseAbi([
  "struct Epoch { uint64 index; uint64 startedAt; uint64 endedAt; uint256 pot; uint256 reserved; uint256 claimed; bytes32 merkleRoot; bool settled; }",
  // reads
  "function currentEpoch() view returns (uint64)",
  "function getEpoch(uint64 epochId) view returns (Epoch)",
  "function epochLength() view returns (uint64)",
  "function payoutToken() view returns (address)",
  "function feeEscrow() view returns (address)",
  "function scheduler() view returns (address)",
  "function owner() view returns (address)",
  "function claimsPaused() view returns (bool)",
  "function hasClaimed(uint64 epochId, address account) view returns (bool)",
  "function accounted() view returns (uint256)",
  "function unaccounted() view returns (uint256)",
  "function canClose(uint64 epochId) view returns (bool)",
  "function leafOf(uint64 epochId, address account, uint256 amount) pure returns (bytes32)",
  // writes
  "function fund() payable",
  "function fundToken(uint256 amount)",
  "function sync() returns (uint256 credited)",
  "function claimFeesFromEscrow() returns (uint256 credited)",
  "function claimFeesFromEscrowToken() returns (uint256 credited)",
  "function closeEpochAndPostRoot(uint64 epochId, bytes32 merkleRoot, uint256 reserved)",
  "function claim(uint64 epochId, uint256 amount, bytes32[] proof)",
  "function setScheduler(address newScheduler)",
  "function pauseClaims()",
  "function unpauseClaims()",
  "function rescueToken(address token, address to, uint256 amount)",
  // events
  "event PotFunded(uint64 indexed epochId, address indexed from, uint256 amount)",
  "event FeesClaimedFromEscrow(uint64 indexed epochId, uint256 amount)",
  "event EpochStarted(uint64 indexed epochId, uint64 startedAt, uint256 rolledIn)",
  "event EpochSettled(uint64 indexed epochId, bytes32 merkleRoot, uint256 reserved, uint256 pot)",
  "event RolledOver(uint64 indexed fromEpoch, uint64 indexed toEpoch, uint256 amount)",
  "event Claimed(uint64 indexed epochId, address indexed account, uint256 amount)",
  "event SchedulerUpdated(address indexed previousScheduler, address indexed newScheduler)",
  "event ClaimsPaused(address indexed by)",
  "event ClaimsUnpaused(address indexed by)",
  // errors
  "error NotScheduler()",
  "error WrongEpoch()",
  "error EpochNotOver()",
  "error AlreadySettled()",
  "error ReservedExceedsPot()",
  "error EmptyRootWithReserved()",
  "error NotSettled()",
  "error AlreadyClaimed()",
  "error InvalidProof()",
  "error ClaimExceedsReserved()",
  "error ClaimsArePaused()",
  "error WrongPayoutMode()",
  "error CannotRescuePayoutToken()",
  "error ZeroAddress()",
  "error TransferFailed()",
]);

export type EpochStruct = {
  index: bigint;
  startedAt: bigint;
  endedAt: bigint;
  pot: bigint;
  reserved: bigint;
  claimed: bigint;
  merkleRoot: `0x${string}`;
  settled: boolean;
};
