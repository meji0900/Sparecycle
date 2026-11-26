// Copy that the token features make false (brief §0.7), as one flag-dependent table, so that turning a TOKEN_* flag on
// changes the copy in the same deploy. Browser-safe and pure: the server resolves the state (src/server/token-copy-state.ts:
// the flags, and minStakePerNode read from the chain) and passes the strings down, also into client components.
//
// Rules (docs/token-features.md "Copy"):
//   - With every flag off (TOKEN_COPY_OFF), every string here is byte-for-byte the copy of today
//     (src/lib/token-copy.test.ts pins each one).
//   - Each line switches with its own flag. Staking lines switch only when the stake gate is on AND the minimum stake per
//     node is above zero (or could not be read): with minStakePerNode = 0, "no token needed to run a node" stays true.
//   - "Not a yield product", "the token can go to zero" and "not financial advice" stay in the terms and disclosures;
//     nothing here removes them. New lines describe mechanics only and never use the words of brief §9.3.
//   - The wording of the "on" lines is for the legal review (brief §9.1) before any flag is turned on.
import { formatAmount } from "./format";

export type TokenCopyState = {
  burns: boolean;
  holders: boolean;
  stakeGate: boolean;
  holderPage: boolean;
  /** minStakePerNode() read from SparecycleNodeStake (wei of SPARE); null = gate off or the read failed. */
  minStakeWei: bigint | null;
  /** The stake gate is on and the minimum is above zero, or could not be read (never claim "no token" unverified). */
  stakeRequired: boolean;
};

export const TOKEN_COPY_OFF: TokenCopyState = {
  burns: false,
  holders: false,
  stakeGate: false,
  holderPage: false,
  minStakeWei: null,
  stakeRequired: false,
};

const stakeAmount = (s: TokenCopyState) =>
  s.minStakeWei !== null && s.minStakeWei > 0n ? `at least ${formatAmount(s.minStakeWei, 18, 2)} SPARE` : "the minimum SPARE stake";

/** Every switchable line, for the state. Off = today's copy. */
export function tokenCopy(s: TokenCopyState) {
  const stake = s.stakeRequired;
  return {
    /** src/components/landing/hero.tsx, one of the hero facts. */
    heroNoToken: stake ? "No token needed to pay for a job" : "No token needed to run a node or pay for a job",
    /** src/components/landing/feature-bento.tsx, the "No token needed" card. */
    bentoNoToken: stake
      ? {
          title: "No token to pay for a job",
          description: `Paying for a job needs no token. Running a node needs ${stakeAmount(s)} per active node, locked in a contract.`,
        }
      : { title: "No token needed", description: "You don't have to buy or lock the token to run a node or pay for a job." },
    /** src/components/landing/who-for.tsx, the third card. */
    whoForNoToken: stake
      ? { title: "You don't hold the token", body: "You don't need it to pay for a job. Running a node needs a SPARE stake per node." }
      : { title: "You don't hold the token", body: "You don't need it. Not to run a node, and not to pay for a job." },
    /** src/components/landing/sections.tsx, the last line of "Run a node". */
    runANodeToken: stake
      ? `You need ${stakeAmount(s)} per active node, locked in the stake contract. Repeated proven wrong results can cost part of it, which is burned.`
      : "You do not need to hold the token.",
    /** src/components/landing/sections.tsx, the first token fact. */
    tokenFactNeed: stake
      ? "You don't need the token to pay for a job. Running a node needs a SPARE stake per active node."
      : "You don't need the token for anything here: not to run a node, and not to pay for a job.",
    /** src/components/landing/sections.tsx, the second token fact when creator fees fund the pot (not the live SPARE case). */
    tokenFactFeesToPot: s.burns
      ? "Creator trading fees fund the job pot. Pons buybacks are off; separately, each epoch part of the treasury share is used to buy SPARE and burn it, and every transaction is listed. This is not a reason the token should go up."
      : "Creator trading fees fund the job pot. Buybacks are off. This is not a reason the token should go up, and it is not a yield on holding.",
    /** src/app/(dapp)/nodes/page.tsx, the end of the header description. */
    nodesIntroTail: stake ? "No hourly rate. Running a node needs a SPARE stake per active node." : "No hourly rate, and no token needed.",
    /** src/app/(dapp)/nodes/page.tsx, the "Hold" row of "At a glance". */
    nodesHold: stake
      ? `${stakeAmount(s)[0].toUpperCase()}${stakeAmount(s).slice(1)} per active node, locked in SparecycleNodeStake. Repeated proven wrong results can cost part of it.`
      : "Nothing. No token, no stake, no deposit.",
    /** Extra facts (landing disclosures, token page): empty while the flags are off. */
    facts: [
      ...(s.burns ? [BURN_FACT] : []),
      ...(s.holders ? [HOLDER_FACT] : []),
      ...(stake ? [stakeFact(s)] : []),
    ],
    /** Extra sections of /legal/disclosures: empty while the flags are off. */
    disclosures: [
      ...(s.burns ? [{ title: "Usage burn", body: `${BURN_FACT} ${BURN_DETAIL}` }] : []),
      ...(s.holders ? [{ title: "Holder share as compute credits", body: `${HOLDER_FACT} ${HOLDER_DETAIL}` }] : []),
      ...(stake ? [{ title: "Node staking and slashing", body: `${stakeFact(s)} ${STAKE_DETAIL}` }] : []),
    ],
    /** Appended to the summary line of /legal/terms: empty while the flags are off. */
    termsExtra: [
      ...(s.burns ? ["part of the treasury share buys and burns SPARE each epoch"] : []),
      ...(s.holders ? ["eligible holders can claim compute credits, which pay for jobs and cannot be withdrawn"] : []),
      ...(stake ? ["running a node needs a SPARE stake that proven wrong results can partly cost"] : []),
    ],
  };
}

export type TokenCopy = ReturnType<typeof tokenCopy>;

const BURN_FACT = "Each epoch, part of the treasury share is used to buy SPARE and burn it; every transaction is listed on the holder page.";
const BURN_DETAIL =
  "The treasury Safe executes each buy, capped per epoch because the SPARE pool is thin; what is not bought is carried to the next epoch. A burn is not a promise about the token's price.";
const HOLDER_FACT =
  "Eligible SPARE holders can claim part of the treasury share each epoch as compute credits. Credits pay for jobs and cannot be withdrawn as ETH.";
const HOLDER_DETAIL =
  "Eligibility is time-weighted over the epoch with a minimum; pools, contracts and project wallets are excluded. The amount depends on paid jobs and can be zero.";
const stakeFact = (s: TokenCopyState) =>
  `Running a node needs ${stakeAmount(s)} per active node. Repeated proven wrong results can cost part of the stake, which is burned.`;
const STAKE_DETAIL =
  "The scheduler attributes faults and the treasury Safe decides, so this is not trustless; every proposal comes with public evidence and an appeal window. Staking pays nothing by itself.";
