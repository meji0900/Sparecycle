// OpenAPI module: GET /staking, the public figures of SparecycleNodeStake (src/server/staking.ts, docs/node-staking.md).
import type { OpenApiModule } from "./openapi";

const wei = (description: string) => ({ type: "string", pattern: "^[0-9]+$", description });
const count = (description: string) => ({ type: "integer", minimum: 0, description });

export const stakingApi: OpenApiModule = {
  name: "staking",
  tags: [
    {
      name: "Staking",
      description:
        "Optional SPARE stake of node owners in SparecycleNodeStake. Voluntary, pays nothing; the minimum per node is 0 today, so running a node needs no token. Stake, unstake and appeal are wallet transactions on the contract, not API calls.",
    },
  ],
  paths: {
    "/staking": {
      get: {
        operationId: "getStaking",
        summary: "Total staked, total slashed, the minimum per node, how many owners stake, and the contract's rules",
        description: [
          "Read from SparecycleNodeStake at one block and cached for 30 seconds (Cache-Control: public, max-age=30). No wallet, no key.",
          "",
          "totalStakedWei is totalStaked(): every owner's active stake plus what waits in the unstake cooldown. totalSlashedWei is every executed slash; all of it was burned. Amounts are SPARE base units (18 decimals) as decimal strings.",
          "",
          "owners counts the wallets of the contract's Staked events whose getAccount() still holds SPARE: staking (active or in the cooldown), active, cooling (a wallet can be both). It is null, with ownersError, when the events could not be read; the other figures still are.",
          "",
          "A read that fails is 503 chain-read-failed, never a zero. 503 staking-not-deployed on a network without the contract.",
        ].join("\n"),
        tags: ["Staking"],
        responses: {
          "200": {
            description: "The figures, with the block they were read at.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/StakingStats" } } },
          },
          "503": {
            description: "chain-read-failed (the contract could not be read; retry later) or staking-not-deployed.",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      StakingStats: {
        type: "object",
        required: ["contract", "chainId", "explorerUrl", "token", "decimals", "block", "readAt", "totalStakedWei", "totalSlashedWei", "minStakePerNodeWei", "proposals", "owners", "ownersError", "rules", "notes"],
        properties: {
          contract: { $ref: "#/components/schemas/Address", description: "SparecycleNodeStake." },
          chainId: { type: "integer" },
          explorerUrl: { oneOf: [{ type: "string" }, { type: "null" }], description: "The contract on the block explorer." },
          token: { $ref: "#/components/schemas/Address", description: "The staked token (SPARE), as the contract reports it." },
          decimals: { type: "integer", const: 18 },
          block: { type: "string", pattern: "^[0-9]+$", description: "Block every figure was read at." },
          readAt: { type: "integer", description: "When, unix seconds." },
          totalStakedWei: wei("totalStaked(): active stake plus the unstake cooldown, all owners."),
          totalSlashedWei: wei("totalSlashed(): every executed slash, all burned."),
          minStakePerNodeWei: wei("minStakePerNode(): the minimum per active node in force now. 0 = staking is voluntary."),
          proposals: count("proposalCount(): slash proposals ever made, open or closed."),
          owners: {
            oneOf: [
              {
                type: "object",
                required: ["staking", "active", "cooling", "fromBlock"],
                properties: {
                  staking: count("Owner wallets holding SPARE in the contract (active or in the cooldown)."),
                  active: count("Owner wallets with active stake."),
                  cooling: count("Owner wallets with SPARE in the unstake cooldown."),
                  fromBlock: { type: "string", pattern: "^[0-9]+$", description: "First block scanned for Staked events (the deploy block)." },
                },
              },
              { type: "null" },
            ],
          },
          ownersError: { oneOf: [{ type: "string" }, { type: "null" }] },
          rules: {
            type: "object",
            description: "Fixed at deploy (immutables and code constants), read from the contract.",
            required: ["epochLengthSeconds", "cooldownEpochs", "appealWindowEpochs", "decisionWindowEpochs", "slashBps", "proposalGraceEpochs", "stallFactor"],
            properties: {
              epochLengthSeconds: count("The reward contract's minimum epoch length."),
              cooldownEpochs: count("Unstake cooldown. A new unstake request restarts it for everything waiting."),
              appealWindowEpochs: count("Appeal window after a slash proposal; the stake is frozen meanwhile."),
              decisionWindowEpochs: count("Epochs after the appeal window for the treasury Safe to decide before the proposal expires."),
              slashBps: count("Most one executed proposal can take, in basis points of the owner's stake (1000 = 10%)."),
              proposalGraceEpochs: count("No new proposal against the same owner for this many epochs after one ends."),
              stallFactor: count("If epochs stop closing, a window also ends after this many times its nominal length."),
            },
          },
          notes: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};
