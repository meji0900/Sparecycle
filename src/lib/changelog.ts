// The changelog: only what is live, newest first, each entry with the moment it went live and at least one piece of
// evidence anyone can open (a transaction, a published document or a live endpoint). Read by /changelog and
// /changelog.xml. When a roadmap item ships, add it here with its date and evidence and remove it from roadmap.ts.
// Commit hashes and commit dates are not used as evidence (the repository history has been rewritten).
import { MAINNET_TXS, OWNERSHIP_TXS, FIRST_PAYOUT_TXS, PAYMENTS_TX } from "./proof";
import { ADDR, explorerAddressUrl, sourcifyUrl } from "./addresses";
import { repoFile, REPO_URL } from "./site";

export type ChangelogKind = "contract" | "scheduler" | "node" | "site" | "docs";

export type Evidence = { label: string; tx?: string; url?: string };

export type ChangelogEntry = {
  /** Stable anchor on /changelog and the feed's guid. */
  id: string;
  title: string;
  /**
   * When it went live. Either an exact UTC instant ("2026-11-24T13:55:32Z", e.g. a block timestamp), or a calendar
   * day in WITA ("2026-11-25") when only the day is on record.
   */
  date: string;
  kind: ChangelogKind;
  summary: string;
  evidence: Evidence[];
};

export const KIND_LABEL: Record<ChangelogKind, string> = {
  contract: "Contract",
  scheduler: "Scheduler",
  node: "Node",
  site: "Site",
  docs: "Docs",
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "gpu-pool-busy-host",
    title: "Project GPU pool handles a busy host",
    date: "2026-11-26",
    kind: "scheduler",
    summary:
      "The project's own on-demand GPUs are stopped when idle, and while stopped their host GPU can be rented by someone else. When a host declines a start, the pool now cancels that queued start at once, stops machines that came up without a partner and tries again later. An owner can keep a spare machine so the pool still runs while one host is busy.",
    evidence: [
      { label: "README: Bootstrap GPU pool", url: `${REPO_URL}#bootstrap-gpu-pool-on-demand` },
      { label: "Test with a fake Vast API", url: repoFile("scripts/e2e-pool.mjs") },
    ],
  },
  {
    id: "gpu-bench-rtx50-rtx20",
    title: "GPU bench: RTX 50 (Blackwell) and RTX 20 (Turing)",
    date: "2026-11-25",
    kind: "node",
    summary:
      "An RTX 5060 Ti and an RTX 2070 were benched against the reference pair (RTX 3060 and RTX 4060). Images matched on every pair (8 of 8); text did not (3 of 10 and 6 of 10). Both families stay untested, so they are not listed as supported.",
    evidence: [
      { label: "Bench results", url: repoFile("bench/results/2026-11-25-cuda-blackwell-turing/README.md") },
      { label: "GPU support list", url: repoFile("docs/gpu-support.md") },
    ],
  },
  {
    id: "owner-treasury-safe",
    title: "Reward contract owned by the treasury Safe (2 of 3)",
    date: "2026-11-25T09:56:10Z",
    kind: "contract",
    summary:
      "The owner of SparecycleRewards moved from the launch wallet to the treasury Safe, so every owner action now needs 2 of its 3 signers and the launch wallet's owner calls revert. All three keys are held by the project owner: this guards against one lost or leaked key, not against the project owner.",
    evidence: OWNERSHIP_TXS.map((t) => ({ label: t.what, tx: t.hash })),
  },
  {
    id: "private-job-outputs",
    title: "Private job results",
    date: "2026-11-25",
    kind: "scheduler",
    summary:
      "A job's result can be read only by the browser that created it (a per-job read secret) or by the wallet that paid, after a gasless sign-in. Knowing a job id is no longer enough; the old public output link answers 410.",
    evidence: [
      { label: "Design and tests", url: repoFile("docs/private-outputs.md") },
      { label: "Live setting (outputAuth in the status API)", url: "/api/v1/status" },
    ],
  },
  {
    id: "first-mainnet-payout",
    title: "First payout on mainnet",
    date: FIRST_PAYOUT_TXS[FIRST_PAYOUT_TXS.length - 1].at,
    kind: "contract",
    summary:
      "Paid jobs whose two results matched were charged from customers' balances, the epoch's payout root was posted to the reward contract, and a node claimed its share. The claim went to the team's own GPU, openly labelled as a paid test node.",
    evidence: FIRST_PAYOUT_TXS.map((t) => ({ label: t.label, tx: t.hash })),
  },
  {
    id: "payments-contract",
    title: "Paid jobs: SparecycleJobPayments on mainnet",
    date: "2026-11-24T10:00:30Z",
    kind: "contract",
    summary:
      "Customers deposit ETH into a contract only they can withdraw from. Once per epoch the scheduler charges jobs whose two results matched: 95% goes to the node pot, 5% to the treasury Safe. No owner and no admin functions.",
    evidence: [
      { label: "Deploy transaction", tx: PAYMENTS_TX.hash },
      { label: "Verified source (Sourcify)", url: sourcifyUrl(ADDR.payments) },
    ],
  },
  {
    id: "reward-contract",
    title: "SparecycleRewards on mainnet",
    date: "2026-11-22T13:16:44Z",
    kind: "contract",
    summary:
      "The reward contract holds each six-hour epoch's pot; node owners claim their share with a Merkle proof. It has no withdraw function.",
    evidence: [
      { label: "Deploy transaction", tx: MAINNET_TXS[0].hash },
      { label: "Verified source (Sourcify)", url: sourcifyUrl(ADDR.rewards) },
      { label: "Contract on Blockscout", url: explorerAddressUrl(ADDR.rewards) },
    ],
  },
];

// ---- Dates: WITA (UTC+8, no daylight saving) with UTC alongside ------------------------------------------------

const WITA_OFFSET_MS = 8 * 3600 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export const isDayOnly = (date: string) => DAY_ONLY.test(date);
export const isValidChangelogDate = (date: string) =>
  (DAY_ONLY.test(date) || INSTANT.test(date)) && !Number.isNaN(Date.parse(DAY_ONLY.test(date) ? `${date}T00:00:00Z` : date));

const pad = (n: number) => String(n).padStart(2, "0");
const dayText = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const timeText = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;

/** The moment as a UTC Date: an instant as given; a WITA day as its first moment (00:00 WITA). */
export function changelogInstant(date: string): Date {
  return DAY_ONLY.test(date) ? new Date(Date.parse(`${date}T00:00:00Z`) - WITA_OFFSET_MS) : new Date(date);
}

/** The WITA calendar day of an entry, "YYYY-MM-DD" (used to keep the list newest first). */
export function witaDay(date: string): string {
  if (DAY_ONLY.test(date)) return date;
  const w = new Date(Date.parse(date) + WITA_OFFSET_MS);
  return `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
}

/** Display text: { wita: "24 Nov 2026, 21:55 WITA", utc: "13:55 UTC" } or, for a day-only entry, { wita: "25 Nov 2026 (WITA)", utc: null }. */
export function formatChangelogDate(date: string): { wita: string; utc: string | null } {
  if (DAY_ONLY.test(date)) return { wita: `${dayText(new Date(`${date}T00:00:00Z`))} (WITA)`, utc: null };
  const utc = new Date(date);
  const wita = new Date(utc.getTime() + WITA_OFFSET_MS);
  const sameDay = utc.getUTCDate() === wita.getUTCDate();
  return {
    wita: `${dayText(wita)}, ${timeText(wita)} WITA`,
    utc: sameDay ? `${timeText(utc)} UTC` : `${dayText(utc)}, ${timeText(utc)} UTC`,
  };
}

/** RFC 822 date for RSS, in WITA: "Tue, 24 Nov 2026 21:55:32 +0800". */
export function rfc822Wita(date: string): string {
  const w = new Date(changelogInstant(date).getTime() + WITA_OFFSET_MS);
  return `${DAYS[w.getUTCDay()]}, ${pad(w.getUTCDate())} ${MONTHS[w.getUTCMonth()]} ${w.getUTCFullYear()} ${pad(w.getUTCHours())}:${pad(
    w.getUTCMinutes(),
  )}:${pad(w.getUTCSeconds())} +0800`;
}
