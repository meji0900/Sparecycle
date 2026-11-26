// OpenAPI module of the holder-pool reads (src/server/holder-api.ts). Added to GET /api/v1/openapi.json only while
// TOKEN_HOLDERS is on (src/app/api/v1/openapi.json/route.ts), so with the flag off (the default) the description is
// exactly the one without these endpoints, like the endpoints themselves (served by the JSON 404 catch-all).
import type { OpenApiModule } from "./openapi";

type Obj = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Obj, description: string) => ({ description, content: { "application/json": { schema } } });
const error = (description: string) => ({ description, content: { "application/json": { schema: ref("Error") } } });
const nullable = (schema: Obj) => ({ oneOf: [schema, { type: "null" }] });
const wei = { type: "string", pattern: "^[0-9]+$", description: "Wei, decimal string." };
const hash = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const txLink = { type: "object", properties: { hash, url: { type: "string" } }, required: ["hash", "url"] };

const STATUSES = ["ready", "sent", "posted", "skipped", "unpostable", "conflict", "failed", "prepared", "nothing-due", "incomplete"];

export const holdersApi: OpenApiModule = {
  name: "holders",
  tags: [
    {
      name: "Holders",
      description:
        "Holder pool, credit mode: per-epoch Merkle roots of SPARE holder shares and each address's proofs. Eligible holders can claim compute credits, which pay for jobs and cannot be withdrawn or transferred. Served only while the feature is on.",
    },
  ],
  paths: {
    "/holders/epochs": {
      get: {
        operationId: "listHolderEpochs",
        summary: "Holder-pool roots per epoch: status, funding, total, holders and the postRoot transaction",
        tags: ["Holders"],
        responses: { "200": json(ref("HolderEpochs"), "The newest 100 computed epochs, newest first.") },
      },
    },
    "/holders/{address}": {
      parameters: [{ name: "address", in: "path", required: true, schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" } }],
      get: {
        operationId: "getHolderAccount",
        summary: "One address's holder shares: amount, Merkle proof, claim window and claimed state per epoch, and its credit balance",
        tags: ["Holders"],
        responses: { "200": json(ref("HolderAccount"), "The address's newest 50 leaves."), "400": error("bad-address") },
      },
    },
  },
  components: {
    schemas: {
      HolderRules: {
        type: "object",
        properties: {
          method: { type: "string" },
          minimumSpareWei: wei,
          rolloverEpochs: { type: "integer" },
          defaultMode: { type: "string" },
          modes: { type: "array", items: { type: "string" } },
          credits: { type: "string" },
          exclusions: {
            type: "array",
            items: { type: "object", properties: { label: { type: "string" }, address: nullable({ type: "string" }), why: { type: "string" } } },
          },
          contractsExcluded: { type: "string" },
        },
      },
      HolderEpochs: {
        type: "object",
        properties: {
          live: { type: "boolean", description: "True when SparecycleHolderPool and SparecycleJobPaymentsV2 are both configured." },
          contracts: { type: "object" },
          openEpoch: nullable({ type: "integer" }),
          lastComputedAt: nullable({ type: "integer", description: "Unix seconds of the newest computed root." }),
          rules: ref("HolderRules"),
          epochs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                epochId: { type: "integer" },
                status: { enum: STATUSES },
                root: nullable(hash),
                fundedWei: nullable(wei),
                totalWei: wei,
                holders: { type: "integer" },
                totalWeight: nullable(wei),
                note: nullable({ type: "string" }),
                computedAt: { type: "integer" },
                postedTx: nullable(txLink),
                pendingTx: nullable(txLink),
                postedAt: nullable({ type: "integer" }),
                claimableUntilEpoch: nullable({ type: "integer" }),
              },
            },
          },
        },
      },
      HolderAccount: {
        type: "object",
        properties: {
          address: { type: "string" },
          live: { type: "boolean" },
          openEpoch: nullable({ type: "integer" }),
          lastComputedAt: nullable({ type: "integer" }),
          creditWei: nullable({ ...wei, description: "Spend-only credits in SparecycleJobPaymentsV2 (creditOf); null when not readable." }),
          claimableWei: wei,
          rules: ref("HolderRules"),
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                epochId: { type: "integer" },
                state: { enum: ["claimable", "claimed", "expired", "pending", "not-posted", "unknown"] },
                mode: { type: "integer", description: "1 = compute credits." },
                modeLabel: { type: "string" },
                amountWei: wei,
                avgBalanceWei: { ...wei, description: "Time-weighted average SPARE (18 decimals) over the epoch." },
                leaf: hash,
                proof: { type: "array", items: hash },
                root: hash,
                rootStatus: { enum: STATUSES },
                postedTx: nullable(txLink),
                claimableUntilEpoch: nullable({ type: "integer" }),
                claimed: nullable({ type: "boolean" }),
                claim: nullable({ type: "object", description: "The call to make from this address: claim(epochId, mode, amount, proof)." }),
              },
            },
          },
        },
      },
    },
  },
};
