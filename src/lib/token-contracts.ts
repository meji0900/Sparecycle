// The on-chain interfaces the scheduler's token features (docs/token-features.md) are written against, in one place so
// they can be aligned with the real contracts when those are audited and deployed. The contracts are written elsewhere
// (brief stage 3); NOTHING HERE IS DEPLOYED (src/lib/addresses.ts: TOKEN_CONTRACTS are null).
//
// ALIGNED 26 Nov 2026 with the contracts in contracts/src (SparecycleNodeStake, SparecycleHolderPool, SparecycleBurner):
// event signatures and indexed fields below match their Solidity source; src/lib/token-contracts.test.ts checks them
// against the compiled ABIs in contracts/out when those exist. Notes kept from the first draft:
//   SparecycleNodeStake
//     - stakedOf(address owner) view returns (uint256): the owner's stake in SPARE wei, slashed amounts already removed.
//     - minStakePerNode() view returns (uint256).
//     - proposeSlash(address owner, uint256 amount, bytes32 evidenceHash): scheduler only. Prepared here, never sent.
//     - event Slashed(address owner, uint256 amount, uint256 proposalId, bytes32 evidenceHash): no indexed fields, as given.
//       The page sums it as "slashed"; the slashed SPARE is burned (N9).
//     - event SlashProposed(uint256 proposalId, address owner, uint256 amount, bytes32 evidenceHash): field order and
//       indexing ASSUMED (the brief gives only the name). The holder page matches its evidenceHash to /api/v1/slashing.
//     - staking moves SPARE with ERC-20 transfers: owner -> NodeStake on stake, NodeStake -> owner on unstake, and
//       NodeStake -> zero/dead when a slash is executed. src/server/holders.ts counts staked SPARE for its owner from
//       these transfers (N15).
//   SparecycleHolderPool
//     - postRoot(uint64 epochId, bytes32 root, uint256 totalEth): scheduler only. Prepared here, never sent.
//     - setMode(uint8 mode); event ModeSet(address holder, uint8 mode, uint64 effectiveEpoch): no indexed fields, as given.
//     - leaf = keccak256(abi.encodePacked(uint64 epochId, address holder, uint8 mode, uint256 amount)), sorted-pair tree
//       (OpenZeppelin MerkleProof), exactly like SparecycleRewards (src/lib/merkle.ts).
//     - claim(uint64 epochId, uint8 mode, uint256 amount, bytes32[] proof).
//     - event RootPosted(uint64 epochId, bytes32 root, uint256 totalEth) and event Claimed(uint64 epochId, address holder,
//       uint8 mode, uint256 amount): ASSUMED names and fields, read only by the holder page.
//     - the pool is funded with plain ETH (receive()) by the treasury Safe until V2 exists (brief §6.2 "Funding").
//     - mode codes as in the contract: 1 = credits, 2 = NVDA (claims revert NvdaModeNotAvailable), 0 = never chosen
//       (treated as credits, N18). src/lib/token-rules.ts HOLDER_MODE.
//     - epoch ids are SparecycleRewards' epoch ids.
//   SparecycleBurner (phase 2b, later)
//     - event Burned(uint64 epochId, uint256 ethIn, uint256 spareBurned): no indexed fields, as given.
//   SPARE (ADDR.spareToken): a standard ERC-20 with 18 decimals (Transfer, balanceOf). burn(uint256) is only used when
//     BURN_METHOD = "burn" (src/lib/token-rules.ts); its existence is a bytecode heuristic so far (brief §0.2).
//   Uniswap v4 (phase 2a buy): StateView getSlot0 / getLiquidity for the price read, the Universal Router's
//     execute(bytes commands, bytes[] inputs, uint256 deadline) with one V4_SWAP command (0x10) whose actions are
//     SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c) and TAKE (0x0e) or TAKE_ALL (0x0f), with
//     ExactInputSingleParams { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; bytes hookData }
//     as in v4-periphery 4.0. Check the router deployed on Robinhood Chain uses this layout before any payload is used.
//   Safe 1.5.0 (the treasury Safe): nonce(), the EIP-712 SafeTx hash, event ExecutionSuccess(bytes32 txHash, uint256 payment).
import { parseAbi } from "viem";

export const nodeStakeAbi = parseAbi([
  "function stakedOf(address owner) view returns (uint256)",
  "function minStakePerNode() view returns (uint256)",
  "function proposeSlash(address owner, uint256 amount, bytes32 evidenceHash) returns (uint256 proposalId)",
  "event Slashed(address indexed owner, uint256 amount, uint256 indexed proposalId, bytes32 evidenceHash)",
  "event SlashProposed(uint256 indexed proposalId, address indexed owner, uint256 amount, bytes32 evidenceHash, uint64 epoch)",
  "function meetsMinimum(address owner, uint256 activeNodes) view returns (bool)",
]);

export const holderPoolAbi = parseAbi([
  "function postRoot(uint64 epochId, bytes32 root, uint256 totalEth)",
  "function setMode(uint8 mode)",
  "function claim(uint64 epochId, uint8 mode, uint256 amount, bytes32[] proof)",
  "event ModeSet(address indexed holder, uint8 mode, uint64 effectiveEpoch)",
  "event RootPosted(uint64 indexed epochId, bytes32 root, uint256 totalEth, uint64 claimableUntilEpoch)",
  "event Claimed(uint64 indexed epochId, address indexed holder, uint8 mode, uint256 amount)",
  "function fund() payable",
]);

export const burnerAbi = parseAbi(["event Burned(uint64 indexed epochId, uint256 ethIn, uint256 spareBurned)"]);

export const spareTokenAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function burn(uint256 amount)",
]);

/** Uniswap v4 StateView (periphery lens over the PoolManager's storage). */
export const v4StateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

/** Uniswap v4 PoolManager's swap event: amount0 / amount1 are the swap's balance deltas. */
export const v4PoolManagerAbi = parseAbi([
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
]);

export const universalRouterAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

/** Universal Router command and v4-periphery action codes used by the burn buy. */
export const UR_COMMAND_V4_SWAP = 0x10;
export const V4_ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const;

export const safeAbi = parseAbi([
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
]);
