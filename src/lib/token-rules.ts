// The token-feature rules of the next-update brief, section 10 (decisions N1–N25), as named constants. Browser-safe:
// the scheduler (src/server/{burns,holders,slashing}.ts) and the holder page read the same values.
//
// EVERY value here is a "Default, not yet confirmed by Fabio": a design choice to start from, not a measured number and
// not approved. None of them is live: the features that use them are behind TOKEN_* flags that default to off
// (docs/token-features.md). Where a contract will hold the real value (the split in SparecycleJobPaymentsV2, the minimum
// stake in SparecycleNodeStake), the page reads the contract, never these constants.

/** The treasury cut of every charge in SparecycleJobPayments (TREASURY_BPS, a constant in the live contract). */
export const TREASURY_CUT_BPS = 500;

// N1 below is the split of the phase-2a burn plan (src/server/burns.ts, TOKEN_BURNS, postponed by the owner on
// 26 Nov 2026). SparecycleJobPaymentsV2 holds the decided split on-chain: 350 treasury / 0 burner / 150 holder pool, with
// 4% slippage. The holder share (150) is the same in both.
/** N1: burn share of the 500 bps treasury cut. Default, not yet confirmed by Fabio. */
export const SPLIT_BURN_BPS = 150;
/** N1: holder-pool share of the 500 bps treasury cut. Default, not yet confirmed by Fabio. */
export const SPLIT_HOLDER_BPS = 150;
/** N1: what stays in the treasury of the 500 bps. Default, not yet confirmed by Fabio. */
export const SPLIT_TREASURY_BPS = 200;

/** N4: share of an owner's stake taken by one executed slash proposal, in bps (10%). Default, not yet confirmed by Fabio. */
export const SLASH_BPS = 1_000;
/** N5 (F): attributed faults of one node within the window that create a slash proposal. Default, not yet confirmed by Fabio. */
export const FAULTS_PER_PROPOSAL = 3;
/** N6 (W): the rolling fault window, in epochs (48 h). Default, not yet confirmed by Fabio. */
export const FAULT_WINDOW_EPOCHS = 8;
/** N7 (A): appeal window after a proposal, in epochs (24 h). Enforced by the contract. Default, not yet confirmed by Fabio. */
export const APPEAL_WINDOW_EPOCHS = 4;
/** N8 (C): unstake cooldown, in epochs (4 days). Enforced by the contract. Default, not yet confirmed by Fabio. */
export const UNSTAKE_COOLDOWN_EPOCHS = 16;
/** N9: slashed SPARE is burned, never paid to anyone. Default, not yet confirmed by Fabio. */
export const SLASHED_SPARE_GOES_TO = "burned" as const;

/** N11: holder-pool minimum, time-weighted SPARE (working proposal 0.01% of supply, 18 decimals). Default, not yet confirmed by Fabio. */
export const HOLDER_MIN_SPARE_WEI = 100_000n * 10n ** 18n;

/** N12: per-epoch buy cap as a share of the pool's quote-side (ETH) liquidity at epoch close, in bps (1%). Default, not yet confirmed by Fabio. */
export const BURN_CAP_BPS_OF_QUOTE_LIQUIDITY = 100;
/** N12: maximum slippage of a burn buy against the price read just before, in bps (2%). Default, not yet confirmed by Fabio. */
export const BURN_MAX_SLIPPAGE_BPS = 200;

/** N14: contracts get no holder weight unless allow-listed; LP positions (held by the PoolManager) are not counted. Default, not yet confirmed by Fabio. */
export const CONTRACTS_EXCLUDED_UNLESS_ALLOWLISTED = true;
/** N15: staked SPARE counts as held by its owner. Default, not yet confirmed by Fabio. */
export const STAKED_COUNTS_AS_HELD = true;
/** N16: every token feature means SPARE (ADDR.spareToken) only, never CYCLE. Default, not yet confirmed by Fabio. */
export const TOKEN_FEATURES_TOKEN = "SPARE" as const;

/** Holder modes as the HolderPool leaf encodes them (uint8). Only credits exists in this phase; NVDA mode is gated (§6.6). */
/** Mode codes as SparecycleHolderPool defines them (MODE_CREDITS = 1, MODE_NVDA = 2; 0 = never chosen -> credits). */
export const HOLDER_MODE = { credits: 1, nvda: 2 } as const;
export type HolderMode = (typeof HOLDER_MODE)[keyof typeof HOLDER_MODE];
/** N18: the mode of a holder who never chose. Default, not yet confirmed by Fabio. */
export const DEFAULT_HOLDER_MODE: HolderMode = HOLDER_MODE.credits;
/** Modes the scheduler puts in a root. NVDA mode stays out until gates G1–G3 pass; a holder who chose it gets credits. */
export const SUPPORTED_HOLDER_MODES: readonly HolderMode[] = [HOLDER_MODE.credits];
/** N19: unclaimed holder shares roll into the holder pool after this many epochs (enforced by the contract). Default, not yet confirmed by Fabio. */
export const UNCLAIMED_ROLLOVER_EPOCHS = 8;

/** N23: the burn path at launch is 2a (the treasury Safe executes a prepared transaction). Default, not yet confirmed by Fabio. */
export const BURN_PATH = "2a-safe" as const;

/**
 * How a 2a burn leaves the market: "dead" = the swap itself sends the bought SPARE to the dead address (one call, exact
 * amount); "burn" = the swap pays the Safe, then SPARE.burn(). The brief prefers burn(), but burn() is only known from a
 * bytecode heuristic (§0.2), so "dead" until burn() is confirmed against verified source. Default, not yet confirmed by Fabio.
 */
export const BURN_METHOD: "dead" | "burn" = "dead";

/**
 * Seconds a prepared burn transaction stays valid (the router deadline): one epoch. After it the swap reverts, nothing is
 * spent, and the amount is carried into the next epoch's plan. Default, not yet confirmed by Fabio.
 */
export const BURN_PAYLOAD_TTL_SECONDS = 21_600;

/** Burn share of a charge's treasury amount (N1): toTreasury × SPLIT_BURN_BPS / 500, floored. */
export const burnShareOf = (toTreasuryWei: bigint): bigint => (toTreasuryWei * BigInt(SPLIT_BURN_BPS)) / BigInt(TREASURY_CUT_BPS);
/** Holder share of a charge's treasury amount (N1): toTreasury × SPLIT_HOLDER_BPS / 500, floored. */
export const holderShareOf = (toTreasuryWei: bigint): bigint => (toTreasuryWei * BigInt(SPLIT_HOLDER_BPS)) / BigInt(TREASURY_CUT_BPS);

/** Words the token-feature copy must never use (brief §9.3). src/lib/token-rules.test.ts scans the new copy for them. */
export const FORBIDDEN_TOKEN_WORDS = [
  "yield",
  "earn",
  "passive income",
  "apy",
  "apr",
  "returns",
  "dividend",
  "deflationary",
  "value accrual",
] as const;
