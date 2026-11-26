// Where node payouts come from, stated once. Before paid jobs go live (NEXT_PUBLIC_JOB_PAYMENTS_ADDRESS unset) the
// pot is trading fees only; after, it is trading fees plus customers' job payments (95% of each epoch's charged batch
// of matched jobs; 5% goes to the treasury Safe). Live today: `feesToTeamWallet` (node pot = 95% of paid jobs; the
// token's creator fees go to the team wallet). The team never tops up the pot directly; test jobs it pays for are
// labelled "team-funded".
import { config } from "./config";

export const paidJobsLive = config.jobPayments !== null;
/** The official token's creator fees go to a team wallet, not to the node pot. */
export const feesToTeamWallet = config.creatorFeeWallet !== null;

/**
 * How paid jobs are billed, in the words every page uses (SparecycleJobPayments + src/server/payments.ts). Exact on
 * purpose: a job that is not charged is "not charged" (nothing is taken, so nothing is "refunded"); a withdrawal
 * is started any time and completed after the contract's lock (never "instant").
 */
export const BILLING = {
  chargeRule: "Charged only when two results match; otherwise not charged.",
  notCharged:
    "If the two results do not match, the job expires without a verdict or the safety check rejects it, the job is not charged and the price held for it is released.",
  cutRule:
    "Charges are sent once per epoch as one batch. 5% of the batch goes to the treasury, taken only from matched jobs and rounded down on the batch total, so a single job's 5% is a rounded share.",
  potRule:
    "The other 95% goes into the open epoch's node pot, which is split by work units across all matched jobs of that epoch, not paid to the nodes of one job in particular.",
  withdrawRule:
    "Start a withdrawal any time and complete it after the lock: once the epoch of the request and the next one have closed, or 2 days after the request at the latest.",
} as const;

export const FUNDING = feesToTeamWallet
  ? {
      tagline: "Your idle GPU, paid when two machines agree.",
      short: "Idle GPUs paid per verified job, on Robinhood Chain.",
      metaDescription:
        "Sparecycle runs AI jobs on computers that would otherwise sit idle. You pay for a job, two separate machines run it, and their owners are paid only if the results match. There is no fixed return.",
      bannerLead: "Nodes are paid from verified job payments.",
      bannerRest: "The token's creator fees go to the team wallet, not to the node pot.",
      heroBody:
        "Sparecycle runs AI jobs on computers that would otherwise sit idle. You pay for a job, two separate machines run it, and the people who ran them get paid only if the results match. There is no fixed return.",
      noTopUp:
        "The pot is filled by job payments (and by any fees sent to the reward contract, all visible on-chain). Test jobs the team pays for itself are labelled team-funded on the jobs page.",
      potBody:
        "The pot is customers' payments for that epoch's verified jobs (95% of each charged batch; the 5% treasury share is taken only from matched jobs, rounded per epoch batch) plus anything else sent to the reward contract, and any leftover rolled from the previous epoch.",
      factTitle: "Creator fees go to the team wallet",
      factBody:
        "This token's creator fees and creator tax are paid to the team wallet set at launch, not to the node reward pot. Node payouts come from customers' payments for verified jobs. There is no promised rate.",
      disclosureItem:
        "Not a yield product and not a fixed return. Node payouts come from payments for verified jobs; the token's creator fees go to the team wallet.",
      termsSummary: "node payouts only from paid jobs and funds sent to the reward contract",
    }
  : paidJobsLive
  ? {
      tagline: "Idle GPUs, paid from trading fees and paid jobs.",
      short: "Idle GPUs paid from real trading fees and job payments, on Robinhood Chain.",
      metaDescription:
        "Idle GPUs run a small set of checked AI jobs. Nodes are paid from trading fees that actually arrive and from customers' payments for verified jobs. No fixed return, no passive-yield product.",
      bannerLead: "Nodes are paid from trading fees and job payments.",
      bannerRest: "The team does not top up the pot.",
      heroBody:
        "Sparecycle is a small network that runs checked AI jobs on machines that would otherwise sit idle. Node payouts come from trading fees that have actually been collected and from customers paying for verified jobs. There is no fixed return and no passive-yield product.",
      noTopUp:
        "The team does not top up the pot. Test jobs the team pays for itself are labelled team-funded on the jobs page.",
      potBody:
        "The pot is the fees successfully claimed for that epoch plus customers' payments for its verified jobs (95% of each charged batch; the 5% treasury share is taken only from matched jobs, rounded per epoch batch), and any leftover rolled from the previous epoch.",
      factTitle: "Payouts from fees and paid jobs",
      factBody:
        "Node payouts come from creator trading fees collected into the reward contract and from customers' payments for verified jobs. The team does not top up the pot, and team-paid test jobs are labelled. There is no promised rate.",
      disclosureItem:
        "Not a yield product and not a fixed return. Payouts come only from fees that were actually collected and from payments for verified jobs; a quiet period means a small or empty pot.",
      termsSummary: "payouts only from collected fees and paid jobs",
    }
  : {
      tagline: "Idle GPUs, paid from real trading fees only.",
      short: "Idle GPUs paid from real trading fees, on Robinhood Chain.",
      metaDescription:
        "Idle GPUs run a small set of checked AI jobs. Nodes are paid only from trading fees that actually arrive. No team top-up, no fixed return, no passive-yield product.",
      bannerLead: "Nodes are paid from real trading fees only.",
      bannerRest: "The pot is not topped up.",
      heroBody:
        "Sparecycle is a small network that runs checked AI jobs on machines that would otherwise sit idle. Node payouts come from trading fees that have actually been collected. There is no team top-up, no fixed return, and no passive-yield product.",
      noTopUp: "There is no team top-up.",
      potBody:
        "The pot is the amount successfully claimed for that epoch, plus any leftover rolled from the previous one. Nothing is topped up from a team wallet.",
      factTitle: "Payouts from fees only",
      factBody:
        "Node payouts come only from creator trading fees that were actually collected into the reward contract. There is no team top-up and no promised rate.",
      disclosureItem:
        "Not a yield product and not a fixed return. Payouts come only from fees that were actually collected; a quiet market means a small or empty pot.",
      termsSummary: "payouts only from collected fees",
    };
