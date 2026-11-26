// GET /api/v1/catalog (also /v1/catalog): the public model catalog, no key needed (next-update brief §2 item 1). Exactly
// the models in MODELS (src/lib/protocol.ts), with what src/lib/catalog.ts says about each, the live price per work unit
// (priceWeiPerUnit, the price every job is quoted at), LIMITS, and live capacity per model (./capacity). /v1/models
// stays the OpenAI-shaped list behind an API key (./openai).
//
// Wording while every node is run by the project (decision N17, Default, not yet confirmed by Fabio): network.operators
// is "project-run" until a node of an outside owner passes the GPU gate and takes part in an agreed job.
import {
  CATALOG_INFO,
  CATALOG_MODEL_IDS,
  catalogLimits,
  exampleUnits,
  sourceUrl,
  type Catalog,
  type CatalogModel,
} from "@/lib/catalog";
import { jobPriceWei } from "@/lib/job-payment";
import { MODELS } from "@/lib/protocol";
import { modelCapacity, operatorsOf } from "./capacity";
import { nowSec } from "./db";
import { serverEnv } from "./env";
import { poolStartInfo } from "./gpu-pool";
import { priceWeiPerUnit } from "./payments";
import { paidJobsOn } from "./payments-v2";

/** What the catalog says about who runs the nodes, in one plain sentence. */
export const OPERATOR_NOTE: Record<Catalog["network"]["operators"], string> = {
  "project-run":
    "Every node today is run by the Sparecycle project, on project wallets. Each job still runs on two machines with different owner wallets, but both wallets belong to the project until outside nodes join.",
  mixed: "Nodes are run by the Sparecycle project and by outside owners. Each job runs on two machines with different owner wallets.",
};

export function catalogJson(now = nowSec()): Catalog {
  const pool = poolStartInfo(now);
  const capacity = modelCapacity(pool, now);
  const paid = paidJobsOn();
  const perUnit = paid ? priceWeiPerUnit() : 0n;
  const operators = operatorsOf(now);
  const models: CatalogModel[] = CATALOG_MODEL_IDS.map((id) => {
    const m = MODELS[id];
    const info = CATALOG_INFO[id];
    return {
      id,
      kind: m.kind,
      name: info.name,
      label: m.label,
      summary: info.summary,
      license: m.license,
      source: m.source,
      sourceUrl: sourceUrl(id),
      endpoint: info.endpoint,
      output: info.output,
      backends: [...m.backends],
      vramMb: m.vramMb,
      price: {
        priceWeiPerUnit: perUnit.toString(),
        units: info.units,
        example: { label: info.example.label, units: exampleUnits(id), priceWei: jobPriceWei(info.example.request, perUnit).toString() },
      },
      limits: catalogLimits(id) as unknown as Record<string, Record<string, number>>,
      notes: [...info.notes],
      capacity: capacity[id],
    };
  });
  return {
    object: "catalog",
    generatedAt: now,
    pricing: {
      currency: "ETH",
      priceWeiPerUnit: perUnit.toString(),
      paidJobs: paid,
      freeJobsPerHour: serverEnv.jobRateLimit(),
      charged: "A job is charged only when the two machines' results match. A job that ends without a match is not charged.",
    },
    network: {
      operators,
      note: OPERATOR_NOTE[operators],
      pool: { configured: pool.configured, canStart: pool.canStart, retryAfter: pool.retryAfter },
    },
    models,
  };
}
