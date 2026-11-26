// The changelog: only what is live, newest first, each entry with the moment it went live and at least one piece of
// evidence anyone can open (a transaction, a published document or a live endpoint). Read by /changelog and
// /changelog.xml. When a roadmap item ships, add it here with its date and evidence and remove it from roadmap.ts.
// Commit hashes and commit dates are not used as evidence (the repository history has been rewritten).
import { MAINNET_TXS, OWNERSHIP_TXS, FIRST_PAYOUT_TXS, PAYMENTS_TX } from "./proof";
import { ADDR, explorerAddressUrl, sourcifyUrl } from "./addresses";
import { LIVE_SITE, repoFile } from "./site";

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
    id: "job-receipts",
    title: "Job receipts you can check in your browser",
    date: "2026-11-26",
    kind: "scheduler",
    summary:
      "A paid job's receipt is ready as soon as its two results are compared, with both nodes' signatures. Once the epoch's charge is on-chain, your browser checks the receipt against the jobs root in the payments contract's Charged event, read from the chain's public RPC, without trusting the Sparecycle server. Jobs that were not charged get a receipt too. A random salt in each receipt keeps the public list from linking a wallet to a job. An epoch with no charge has nothing on-chain to check against, and the receipt says so.",
    evidence: [
      { label: "Docs: Job receipts", url: `${LIVE_SITE}/docs/billing#receipts` },
      { label: "API description (receipt route)", url: `${LIVE_SITE}/api/v1/openapi.json` },
    ],
  },
  {
    id: "recheck-new-pair",
    title: "A mismatched paid job is checked again on a new pair",
    date: "2026-11-26",
    kind: "scheduler",
    summary:
      "When the two results of a paid job do not match, the job now runs again on two other nodes, with other owner wallets and other GPUs, up to three pairs in all, before it is left uncharged. Only the final pair's verdict counts and only that pair is paid. A new pair is tried only when one is registered; free trial jobs keep a single pair.",
    evidence: [
      { label: "Docs: When you are charged", url: `${LIVE_SITE}/docs/billing#charges` },
      { label: "Re-check tests", url: repoFile("src/server/recheck.test.ts") },
    ],
  },
  {
    id: "gpu-counts-home",
    title: "The home page shows GPUs working, ready and on standby",
    date: "2026-11-26",
    kind: "site",
    summary:
      "The home page now counts the network's GPUs by what they are doing: running a job right now, online and ready for the next one, paused by their owners, or on standby until a job waits. The node list API marks each GPU that is running a job.",
    evidence: [
      { label: "The network right now", url: `${LIVE_SITE}/#network` },
      { label: "Node list API", url: `${LIVE_SITE}/api/v1/nodes` },
    ],
  },
  {
    id: "gpu-pool-always-on",
    title: "One Sparecycle GPU stays on",
    date: "2026-11-26",
    kind: "scheduler",
    summary:
      "One Sparecycle GPU now stays online all the time, so a waiting job only needs its partner GPU to start instead of two. The pool never stops it, and the status API counts it.",
    evidence: [
      { label: "Status API (gpuPool.alwaysOn)", url: `${LIVE_SITE}/api/v1/status` },
      { label: "Pool start and stop test", url: repoFile("scripts/e2e-pool.mjs") },
    ],
  },
  {
    id: "agent-api",
    title: "API keys, an OpenAI-compatible API and an MCP server",
    date: "2026-11-26",
    kind: "scheduler",
    summary:
      "A wallet can create spend-only API keys, each with its own daily cap (UTC day) and an off switch; a key can never withdraw. With a key, OpenAI client libraries can call /v1/chat/completions (Qwen2.5-1.5B) and /v1/images/generations (Stable Diffusion 1.5) by changing only the base URL. Answers come back only after two nodes agree, asynchronously with polling; a mismatch is a not-charged error, never a made-up answer. An MCP server offers four tools: submit a job, its status, its result, the balance. Pay-per-request over HTTP (x402) is a written design only.",
    evidence: [
      { label: "Docs: OpenAI-compatible API", url: `${LIVE_SITE}/docs/api/openai` },
      { label: "Docs: API keys", url: `${LIVE_SITE}/docs/api/keys` },
      { label: "Docs: MCP server", url: `${LIVE_SITE}/docs/api/mcp` },
      { label: "x402 decision record", url: repoFile("docs/x402-decision.md") },
    ],
  },
  {
    id: "billing-invoice",
    title: "Private invoice for every paid job, and a clearer balance panel",
    date: "2026-11-26",
    kind: "scheduler",
    summary:
      "The payer of a job can open its invoice: price, the 5% protocol cut (rounded, charged per epoch batch), whether the two results matched, whether it was charged, and the output hash (not the file), which the browser can check against the downloaded output. The public job list no longer shows prices or charge status. The balance panel shows balance, held, withdrawal pending and available, starts a withdrawal in one click and shows when it can be completed; a banner warns when fewer than five jobs are left.",
    evidence: [
      { label: "Docs: billing", url: `${LIVE_SITE}/docs/billing` },
      { label: "API: GET /jobs/{id}/invoice", url: `${LIVE_SITE}/api/v1/openapi.json` },
    ],
  },
  {
    id: "idle-guard",
    title: "Idle Guard: the node list shows why a node is resting",
    date: "2026-11-26",
    kind: "node",
    summary:
      "Node client 0.4.0 reports its own state: active, paused because the owner is using the GPU, paused because the GPU is too hot, or paused outside its chosen hours. A paused node stays online and gets no job. The node sends only its state and when that state began, never temperatures or process names, and the public list shows the state but not when it began. The busy and heat checks are NVIDIA-only; other nodes pause on their hours.",
    evidence: [
      { label: "Node list", url: `${LIVE_SITE}/nodes` },
      { label: "Node client README: Idle Guard", url: repoFile("node-client/README.md") },
      { label: "Download checksums", url: `${LIVE_SITE}/downloads/SHA256SUMS.txt` },
    ],
  },
  {
    id: "docs-changelog-roadmap",
    title: "Docs, this changelog, a roadmap and an OpenAPI description",
    date: "2026-11-26",
    kind: "docs",
    summary:
      "Copy-paste guides from a first job to a first node online, a contracts page with every address and its verification status, billing and API references, an OpenAPI 3.1 description of the API, this changelog with an RSS feed, and a roadmap without dates.",
    evidence: [
      { label: "Docs", url: `${LIVE_SITE}/docs` },
      { label: "Contracts and keys", url: `${LIVE_SITE}/docs/contracts` },
      { label: "OpenAPI", url: `${LIVE_SITE}/api/v1/openapi.json` },
      { label: "RSS feed", url: `${LIVE_SITE}/changelog.xml` },
    ],
  },
  {
    id: "gpu-pool-busy-host",
    title: "Project GPU pool handles a busy host",
    date: "2026-11-26",
    kind: "scheduler",
    summary:
      "Sparecycle's on-demand GPUs are stopped when idle, and a stopped machine is not always free to start again right away. When a machine cannot start, the pool now cancels that start at once, stops machines that came up without a partner and tries again later. Each owner can keep a spare machine, so the pool still runs while one is unavailable.",
    evidence: [
      { label: "Status API (gpuPool)", url: `${LIVE_SITE}/api/v1/status` },
      { label: "Pool start and stop test", url: repoFile("scripts/e2e-pool.mjs") },
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
