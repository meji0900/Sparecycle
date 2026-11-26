// Navigation of /docs: one list of sections and pages, read by the docs sidebar, the docs index and the footer.
// To add a page: create src/app/(site)/docs/<path>/page.tsx and add one entry here, in the section it belongs to
// (e.g. an API page under "API": { href: "/docs/api/keys", title: "API keys", description: "…" }).

export type DocsNavItem = { href: string; title: string; description: string };
export type DocsNavSection = { title: string; items: DocsNavItem[] };

export const DOCS_NAV: DocsNavSection[] = [
  {
    title: "Get started",
    items: [
      { href: "/docs", title: "Overview", description: "What is here and where to start." },
      {
        href: "/docs/first-job",
        title: "Your first job",
        description: "Free trial or prepaid balance, the playground, job status and your private result. With curl for the API.",
      },
      {
        href: "/docs/run-a-node",
        title: "Run a node",
        description: "Download, check the checksum, install, link your wallet, start, and see your node online.",
      },
    ],
  },
  {
    title: "API",
    items: [
      {
        href: "/docs/api",
        title: "API overview",
        description: "Every endpoint, how to authenticate, errors and limits. Machine-readable as OpenAPI.",
      },
      {
        href: "/docs/api/keys",
        title: "API keys",
        description: "Spend-only keys for your wallet: a daily cap, an off switch, and no way to withdraw.",
      },
      {
        href: "/docs/api/openai",
        title: "OpenAI-compatible API",
        description: "Change the base URL of an OpenAI SDK: chat and images through the two-node check, async with polling.",
      },
      {
        href: "/docs/api/mcp",
        title: "MCP server",
        description: "Four tools for agents: submit a job, check its status, read the result, see the balance.",
      },
    ],
  },
  {
    title: "Reference",
    items: [
      {
        href: "/docs/contracts",
        title: "Contracts and keys",
        description: "Every address with a copy button, an explorer link and its source verification status.",
      },
      {
        href: "/docs/billing",
        title: "Billing",
        description: "Deposit, what is held, when you are charged, job receipts you can check on-chain, and how to withdraw.",
      },
    ],
  },
  {
    title: "Help",
    items: [{ href: "/docs/support", title: "Support", description: "Ask a question or report a problem." }],
  },
];

export const DOCS_PAGES: DocsNavItem[] = DOCS_NAV.flatMap((s) => s.items);

/** Machine-readable and changelog links shown on the docs index and in the footer. */
export const DOCS_LINKS = {
  openapi: "/api/v1/openapi.json",
  changelog: "/changelog",
  feed: "/changelog.xml",
  roadmap: "/roadmap",
} as const;
