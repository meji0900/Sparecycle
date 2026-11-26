// The public model catalog (next-update brief §2, "Serverless mode"): what each model in MODELS is, how its price is
// counted, its limits and where to call it. Browser-safe: the scheduler (GET /api/v1/catalog, src/server/catalog.ts),
// the /models page and the playground read it. The scheduler adds the live price per unit and the live capacity.
//
// Every model in MODELS (src/lib/protocol.ts) needs an entry in CATALOG_INFO: the Record type makes a missing one a
// type error, and src/server/catalog.test.ts fails at run time too. A model the scheduler cannot run is never listed.
import { LIMITS, MODEL_IDS, MODELS, workUnits, type JobRequest, type ModelId } from "./protocol";

export type CatalogInfo = {
  /** Short name for buttons, tabs and tables. */
  name: string;
  /** One plain sentence: what the model does here. */
  summary: string;
  /** The OpenAI-compatible create call for this model (also under /api/v1). */
  endpoint: "/v1/chat/completions" | "/v1/images/generations";
  /** What a finished job gives back. */
  output: "image/png" | "text/plain";
  /** How work units (the price basis) are counted, in words. The rule itself is workUnits() in src/lib/protocol.ts. */
  units: string;
  /** A typical job, to show what it costs. */
  example: { label: string; request: JobRequest };
  /** Plain facts a customer should know before paying. */
  notes: string[];
};

export const CATALOG_INFO: Record<ModelId, CatalogInfo> = {
  sd15: {
    name: "Stable Diffusion 1.5",
    summary: "Draws one PNG image from a text prompt.",
    endpoint: "/v1/images/generations",
    output: "image/png",
    units: "Width × height × steps × 160 ÷ (512 × 512), rounded up. A 512 × 512 image at 20 steps is 3,200 units.",
    example: {
      label: "512 × 512, 20 steps",
      request: { kind: "image", params: { model: "sd15", prompt: "x", negative: "", width: 512, height: 512, steps: 20, guidance: 7, seed: null } },
    },
    notes: [
      "Both machines draw the image with the same prompt and seed; you get it only if the two images match.",
      "Each machine's safety checker can refuse an image. A refused job is not charged.",
    ],
  },
  "qwen2.5-1.5b": {
    name: "Qwen2.5-1.5B",
    summary: "Writes a short text answer to one prompt, with an optional system message.",
    endpoint: "/v1/chat/completions",
    output: "text/plain",
    units:
      "8 per token of the length limit (maxTokens / max_tokens), plus 1 per 16 characters of prompt and system text, rounded up. You pay for the limit you set, not for the tokens actually written.",
    example: {
      label: "256 tokens, a 100-character prompt",
      request: { kind: "text", params: { model: "qwen2.5-1.5b", prompt: "x".repeat(100), system: "", maxTokens: 256 } },
    },
    notes: [
      "Decoding is greedy (temperature 0), so the two machines give the same text.",
      "One prompt per job: no multi-turn chat and no streaming.",
    ],
  },
};

/** Limits of a model's job requests (LIMITS of its kind), as published. */
export const catalogLimits = (model: ModelId) => LIMITS[MODELS[model].kind];

/** Work units of a model's example job. */
export const exampleUnits = (model: ModelId) => workUnits(CATALOG_INFO[model].example.request);

/** Where the model's weights come from (every source in MODELS is a Hugging Face repository id). */
export const sourceUrl = (model: ModelId) => `https://huggingface.co/${MODELS[model].source}`;

/** Every model the scheduler runs, in MODELS order. */
export const CATALOG_MODEL_IDS: readonly ModelId[] = MODEL_IDS;

// ---- The answer of GET /api/v1/catalog (built in src/server/catalog.ts) ------------------------------------------------

/**
 * Whether a pair of machines with different owners can take a job of this model:
 *   "online": two are online now; "pool": none online, but the project's GPU pool can start one (a minute or two);
 *   null: none can be reached now, so a new job of this model is refused with 503 no-node-pair.
 */
export type PairState = "online" | "pool" | null;

export type CatalogCapacity = {
  /** Machines online now that can run the model (not paused, past the GPU gate). */
  ready: number;
  /** Stopped project-run machines the GPU pool starts when a job waits. */
  standby: number;
  pair: PairState;
  /** pair !== null. */
  pairReachable: boolean;
  /** When pair is null because the pool is waiting after a failed start: seconds until it tries again. */
  retryAfter: number | null;
};

export type CatalogModel = {
  id: ModelId;
  kind: "image" | "text";
  name: string;
  label: string;
  summary: string;
  license: string;
  source: string;
  sourceUrl: string;
  endpoint: CatalogInfo["endpoint"];
  output: CatalogInfo["output"];
  backends: string[];
  vramMb: number;
  price: {
    /** Wei per work unit, decimal string. "0" when paid jobs are not enabled on this scheduler. */
    priceWeiPerUnit: string;
    units: string;
    example: { label: string; units: number; priceWei: string };
  };
  limits: Record<string, Record<string, number>>;
  notes: string[];
  capacity: CatalogCapacity;
};

export type Catalog = {
  object: "catalog";
  generatedAt: number;
  pricing: {
    currency: "ETH";
    priceWeiPerUnit: string;
    /** Paid jobs (prepaid balance or API key) are enabled on this scheduler. */
    paidJobs: boolean;
    /** Free trial jobs per IP address per hour (0 = closed). */
    freeJobsPerHour: number;
    charged: string;
  };
  network: {
    /** "project-run" until a node of an outside owner passes the GPU gate and takes part in an agreed job (decision N17). */
    operators: "project-run" | "mixed";
    note: string;
    pool: { configured: boolean; canStart: boolean; retryAfter: number | null };
  };
  models: CatalogModel[];
};

/** Words for a model's live capacity (the /models page and the playground). */
export function pairWords(c: Pick<CatalogCapacity, "pair" | "ready" | "standby" | "retryAfter">): { tone: "live" | "neutral" | "warn"; label: string; text: string } {
  if (c.pair === "online") {
    return { tone: "live", label: "Ready now", text: "At least two machines with different owners are online. A job starts within seconds." };
  }
  if (c.pair === "pool") {
    return {
      tone: "neutral",
      label: "Starts on demand",
      text: "No pair is online right now. The project's GPU pool starts one when a job waits; the first job can take 1 to 2 minutes.",
    };
  }
  return {
    tone: "warn",
    label: "No pair right now",
    text:
      c.retryAfter !== null
        ? `No two machines with different owners can take this model now. The GPU pool tries again in about ${Math.max(1, Math.ceil(c.retryAfter / 60))} min. New jobs are refused, not queued, and nothing is charged.`
        : "No two machines with different owners can take this model now. New jobs are refused, not queued, and nothing is charged.",
  };
}
