#!/usr/bin/env node
// Sparecycle sweep / claim bot CLI.
//
//   node scripts/sweep.mjs                    dry-run report (reads + simulations, no transactions)
//   node scripts/sweep.mjs --send             transact from SWEEP_SIGNER_KEY (SWEEP_ENABLED=0 refuses)
//   node scripts/sweep.mjs --interval 300     repeat every 5 minutes (always-on mode)
//   node scripts/sweep.mjs --self-check       offline: ABI selectors vs contracts/test/fork/PonsEscrowFork.t.sol
//
// Pre-graduation path (verified on a mainnet fork): hook.feeSweepOperator() -> operator.sweepCurve(curve) ->
// reward.claimFeesFromEscrow(). The curve's own sweepFees() is not used (NotFeeSweepOperator() for the bot).
//
// Reads the same NEXT_PUBLIC_* env as the site (token, curve, reward contract, multisig, RPC). The logic lives in
// src/server/sweep.ts; Node 24 runs it directly (built-in type stripping) with the app's `@/` alias resolved by
// src/server/node-ts-hooks.mjs.
import { srcImport } from "../src/server/node-ts-hooks.mjs";

const { runSweepCli } = await srcImport("server/sweep.ts");
process.exitCode = await runSweepCli(process.argv.slice(2));
