// Node staking (SparecycleNodeStake, docs/node-staking.md): the pure parts shared by the owner's staking panel
// (src/components/dapp/stake-panel.tsx), the public staking figures and GET /api/v1/staking (src/server/staking.ts).
// Browser-safe: no env, no chain reads. Every window here mirrors the contract's `_windowOver`, so the page says what
// the contract will do; the contract's own `canUnstake` / `canAppeal` still decide whether a button is on.
//
// Copy rules (brief §9.3, docs/node-staking.md "This is not trustless"): staking is voluntary collateral and pays
// nothing. Never describe it as a return on anything.
import { BaseError, InsufficientFundsError, parseUnits, UserRejectedRequestError, type Hex } from "viem";
import { revertName } from "./dapp/claim-errors";
import { formatAmount } from "./format";
import { durationLabel } from "./dapp/duration";

/** SPARE (ADDR.spareToken) has 18 decimals. */
export const SPARE_DECIMALS = 18;

/**
 * Block of the transaction that deployed ADDR.nodeStake (tx 0xf1fa8339…2321, 26 Nov 2026). No event of that contract is
 * older, so log scans start here.
 */
export const NODE_STAKE_DEPLOY_BLOCK = 123_623_184n;

/** The contract's PROPOSAL_GRACE_EPOCHS (fixed in code): no new proposal against an owner this long after one ends. */
export const PROPOSAL_GRACE_EPOCHS = 2;

/** `Status` of a slash proposal, by its on-chain number (proposalStatus / getProposal). */
export const PROPOSAL_STATUS = ["None", "Open", "Cancelled", "Executed", "Expired"] as const;
export type ProposalStatusName = (typeof PROPOSAL_STATUS)[number];
export const proposalStatusName = (n: number | bigint): ProposalStatusName | "Unknown" => PROPOSAL_STATUS[Number(n)] ?? "Unknown";

// ---- Amounts ---------------------------------------------------------------------------------------------------

/**
 * A SPARE amount typed by a person, as base units (18 decimals). Null for anything that is not a plain positive
 * decimal number with at most 18 decimals: no signs, no exponents, no thousands separators, no zero.
 */
export function parseSpareInput(raw: string): bigint | null {
  const s = raw.trim();
  if (!/^(\d+(\.\d{0,18})?|\.\d{1,18})$/.test(s)) return null;
  try {
    const wei = parseUnits(s.startsWith(".") ? `0${s}` : s, SPARE_DECIMALS);
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

/**
 * SPARE for display: thousands separators, at most `digits` decimals, cut (never rounded up, so a balance is never
 * overstated). A positive amount too small to show is "< 0.0001", never "0".
 */
export function formatSpare(wei: bigint, digits = 4): string {
  if (wei === 0n) return "0";
  if (wei < 0n) return `-${formatSpare(-wei, digits)}`;
  const s = formatAmount(wei, SPARE_DECIMALS, digits);
  return s === "0" ? `< ${(1 / 10 ** digits).toFixed(digits)}` : s;
}

/** The exact amount as a plain decimal string (all decimals, no separators): what an input field should be filled with. */
export function spareInputValue(wei: bigint): string {
  const whole = wei / 10n ** BigInt(SPARE_DECIMALS);
  const frac = (wei % 10n ** BigInt(SPARE_DECIMALS)).toString().padStart(SPARE_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

// ---- Windows (cooldown, appeal window, decision window, grace) --------------------------------------------------

export type WindowInput = {
  /** Reward-contract epoch the window started in (requestEpoch, proposedEpoch, closedEpoch). */
  startEpoch: bigint;
  /** Timestamp it started at (requestedAt, proposedAt, closedAt). */
  startAt: bigint;
  /** Length of the window in epochs (cooldownEpochs, appealWindowEpochs, …). */
  epochs: bigint;
  /** The stake contract's epochLength (seconds): the reward contract's minimum epoch length. */
  epochLength: bigint;
  /** The stake contract's STALL_FACTOR (2). */
  stallFactor: bigint;
  /** rewards.currentEpoch() now. */
  currentEpoch: bigint;
  /** startedAt of the current reward epoch; null when not read (then no estimate is given). */
  currentEpochStartedAt: bigint | null;
  /** Now, unix seconds. */
  now: number;
};

export type WindowState = {
  /** The window is over by the contract's rule, judged with this clock. */
  over: boolean;
  /** The reward-contract epoch the window waits for: startEpoch + epochs. */
  targetEpoch: bigint;
  /** Epoch closes still needed before targetEpoch is reached (0 when reached). */
  epochsLeft: bigint;
  /** Never before this time: start + epochs x epochLength. */
  notBefore: number;
  /** At the latest, even if no epoch closes any more: start + STALL_FACTOR x epochs x epochLength. */
  latest: number;
  /**
   * Best estimate of the end if every epoch closes after its minimum length: max(notBefore, current epoch start +
   * epochsLeft x epochLength), never after `latest`. Null when over, or when the current epoch's start is unknown.
   */
  expected: number | null;
  /** The time part is over; it now waits for the reward contract to close epochs (or for `latest`). */
  waitingForEpochs: boolean;
};

/**
 * Whether a window of `epochs` epochs is over, exactly as SparecycleNodeStake._windowOver decides it: at least
 * epochs x epochLength seconds have passed AND either the reward contract has reached startEpoch + epochs, or (if
 * epochs stopped closing) STALL_FACTOR times that many seconds have passed. Plus when it should end.
 */
export function windowState(i: WindowInput): WindowState {
  const span = Number(i.epochs * i.epochLength);
  const start = Number(i.startAt);
  const notBefore = start + span;
  const latest = start + Number(i.stallFactor) * span;
  const targetEpoch = i.startEpoch + i.epochs;
  const epochsLeft = targetEpoch > i.currentEpoch ? targetEpoch - i.currentEpoch : 0n;
  const timeOk = i.now >= notBefore;
  const over = timeOk && (epochsLeft === 0n || i.now >= latest);
  let expected: number | null = null;
  if (!over) {
    const byEpochs = epochsLeft === 0n ? notBefore : i.currentEpochStartedAt === null ? null : Number(i.currentEpochStartedAt) + Number(epochsLeft * i.epochLength);
    if (byEpochs !== null) expected = Math.min(Math.max(notBefore, byEpochs), latest);
  }
  return { over, targetEpoch, epochsLeft, notBefore, latest, expected, waitingForEpochs: !over && timeOk && epochsLeft > 0n };
}

/** "about 4 days 2 h", "about 35 min", "less than a minute": a wait, approximate by design. */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return "less than a minute";
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days >= 2) return `about ${days} days${hours ? ` ${hours} h` : ""}`;
  const h = days * 24 + hours;
  if (h > 0) return `about ${h} h${minutes ? ` ${minutes} min` : ""}`;
  return `about ${minutes} min`;
}

/** "16 epochs (at least 4 days)" for a window length; "1 epoch (at least 6 h)". */
export function epochsLabel(epochs: bigint | number, epochLength: bigint | number | null): string {
  const n = Number(epochs);
  const base = `${n} ${n === 1 ? "epoch" : "epochs"}`;
  return epochLength === null ? base : `${base} (at least ${durationLabel(n * Number(epochLength))})`;
}

// ---- Inputs --------------------------------------------------------------------------------------------------------

/** A 32-byte hash typed by a person (0x + 64 hex), lowercased; null when malformed or zero (the contract refuses zero). */
export function parseEvidenceHash(raw: string): Hex | null {
  const s = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(s) || /^0x0{64}$/.test(s)) return null;
  return s.toLowerCase() as Hex;
}

// ---- Errors --------------------------------------------------------------------------------------------------------

const TX_SENTENCES: Record<string, string> = {
  ZeroAmount: "The amount must be above zero. Nothing was sent.",
  InsufficientStake: "That is more than your active stake. Nothing moved.",
  NothingToUnstake: "Nothing is in the cooldown, so there is nothing to withdraw or to move back. Nothing moved.",
  CooldownNotOver: "The cooldown is not over yet. Nothing moved; try again once the page says the withdrawal is ready.",
  StakeFrozen:
    "A slash proposal against this wallet is open, so the stake is frozen: an unstake cannot be started or finished until the treasury Safe decides or the proposal expires. Staking more and moving the cooldown back to active stake still work.",
  NotOpen: "This proposal is no longer open, so it cannot be appealed.",
  AppealWindowOver: "The appeal window of this proposal is over. The treasury Safe decides without a new appeal.",
  NotProposalOwner: "Only the wallet the proposal is against can appeal it.",
  ZeroEvidence: "The evidence hash must not be zero.",
  UnexpectedBalanceChange: "The token moved a different amount than asked, so the contract refused the transfer. Nothing moved.",
  SafeERC20FailedOperation: "The SPARE transfer failed. Check the approval and your SPARE balance. Nothing moved.",
  ERC20InsufficientAllowance: "The approval is lower than the amount. Approve the exact amount first, then stake.",
  ERC20InsufficientBalance: "Your wallet holds less SPARE than this amount.",
};

/** A failed or refused staking transaction, in one plain sentence. */
export function explainStakeTxError(error: unknown): string {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return "You rejected the request in your wallet. Nothing was sent.";
    if (error.walk((e) => e instanceof InsufficientFundsError)) return "Your wallet does not hold enough ETH for the gas.";
    const name = revertName(error);
    if (name && TX_SENTENCES[name]) return TX_SENTENCES[name];
    if (name) return `The contract refused the transaction (${name}). Nothing moved.`;
    return error.shortMessage || "The transaction failed.";
  }
  return error instanceof Error ? error.message : "The transaction failed.";
}
