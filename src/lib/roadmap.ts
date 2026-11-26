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
    id: "node-staking",
    title: "Node staking with partial slashing",
    status: "in-progress",
    summary:
      "The staking contract is live with a minimum stake of zero. Next: staking from the node page, and the scheduler reading stakes and proposing slashes. A part of a stake is burned only after repeated faults proven against two other owners' results, with an appeal window, and never for a single mismatch. The scheduler proposes, the treasury Safe decides; it is not trustless.",
  },
];

export const roadmapByStatus = (status: RoadmapStatus) => ROADMAP.filter((i) => i.status === status);
