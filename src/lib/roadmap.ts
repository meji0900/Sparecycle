// The roadmap: what is being worked on, with a status and no dates, quarters, numeric targets or "soon".
// Read by /roadmap and the landing page excerpt. When an item ships, move it to changelog.ts with its date and
// evidence. src/lib/roadmap.test.ts fails on date patterns, digits followed by a time unit and timing words.

export type RoadmapStatus = "in-progress" | "planned" | "exploring";

export type RoadmapItem = {
  id: string;
  title: string;
  status: RoadmapStatus;
  summary: string;
};

export const ROADMAP_STATUSES: { id: RoadmapStatus; label: string; note: string }[] = [
  { id: "in-progress", label: "In progress", note: "Being built now." },
  { id: "planned", label: "Planned", note: "Decided and designed, not started." },
  { id: "exploring", label: "Exploring", note: "Looking at it. It may not happen." },
];

export const ROADMAP: RoadmapItem[] = [
  {
    id: "browser-verified-receipts",
    title: "Receipts you can verify in your browser",
    status: "in-progress",
    summary:
      "A receipt for every paid job, matched or not charged, that your browser checks against what the payments contract recorded on-chain, without trusting the Sparecycle server.",
  },
  {
    id: "recheck-on-new-pair",
    title: "Re-check a mismatched job on a new node pair",
    status: "in-progress",
    summary:
      "When the two results of a paid job do not match, run it again on a different pair of nodes, with other owners and other GPUs, before leaving it uncharged.",
  },
  {
    id: "independent-signer",
    title: "An independent signer on the treasury Safe",
    status: "planned",
    summary:
      "Today the project owner holds every key of the treasury Safe that owns the reward contract. One of them should belong to someone outside the project, so the owner alone can no longer act.",
  },
  {
    id: "vulkan-reference-bench",
    title: "AMD and Vulkan reference bench",
    status: "exploring",
    summary:
      "Bench AMD, Intel and integrated GPUs on Vulkan against a reference pair, so those cards can be listed as supported once their results match.",
  },
  {
    id: "x402-pay-per-job",
    title: "Pay per job over HTTP (x402)",
    status: "exploring",
    summary:
      "An agent asks for a job, gets the price in an HTTP payment-required answer, and pays in the retry. The payments contract only takes prepaid balances today, so this needs its own design first.",
  },
];

export const roadmapByStatus = (status: RoadmapStatus) => ROADMAP.filter((i) => i.status === status);
