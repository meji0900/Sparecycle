#!/usr/bin/env node
// Local (anvil, chain 31337) deployment of SparecycleRewards + MockPonsFeeEscrow for development and e2e tests.
// Deploys from anvil's unlocked account 0 (no private key is read or printed), then writes
// src/contracts/deployments.json via scripts/sync-deployments.mjs and prints the env lines to set.
//
// Usage:
//   node scripts/deploy-local.mjs                       # anvil already running on 127.0.0.1:8545
//   node scripts/deploy-local.mjs --port 8547           # anvil already running on 8547
//   node scripts/deploy-local.mjs --start --port 8547   # start anvil on 8547 (left running; PID printed)
//   node scripts/deploy-local.mjs --start --port 8547 --stop-after   # start, deploy, verify, stop anvil
//   --epoch <seconds>   epoch length (default 60)
// Env overrides: ADMIN, SCHEDULER (default: anvil account 0).
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, http, parseAbi } from "viem";

const ANVIL_ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // public anvil/hardhat dev account
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDir = join(root, "contracts");
const env = { ...process.env, PATH: `${join(homedir(), ".foundry", "bin")}${delimiter}${process.env.PATH ?? ""}` };

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const port = Number(opt("--port", "8545"));
const epochLength = Number(opt("--epoch", "60"));
const start = flag("--start");
const stopAfter = flag("--stop-after");
const rpcUrl = `http://127.0.0.1:${port}`;
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad --port ${port}`);
if (!Number.isInteger(epochLength) || epochLength <= 0) throw new Error(`bad --epoch ${epochLength}`);

async function chainId() {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const json = await res.json();
  return Number(json.result);
}

async function waitForRpc(ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await chainId();
    } catch {
      if (Date.now() > deadline) throw new Error(`no JSON-RPC at ${rpcUrl}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

let anvil = null;
function stopAnvil() {
  if (!anvil) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(anvil.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(anvil.pid, "SIGTERM");
    console.log(`Stopped anvil (PID ${anvil.pid}).`);
  } catch (e) {
    console.error(`Could not stop anvil PID ${anvil.pid}: ${e.message}`);
  }
  anvil = null;
}

function run(cmd, cmdArgs, opts) {
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", env, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} exited with ${r.status}`);
}

async function main() {
  if (start) {
    try {
      await chainId();
      throw new Error(`something is already listening on ${rpcUrl}; pick a spare --port`);
    } catch (e) {
      if (e.message.startsWith("something")) throw e;
    }
    anvil = spawn("anvil", ["--port", String(port), "--silent"], {
      env,
      detached: !stopAfter,
      stdio: "ignore",
      windowsHide: true,
    });
    anvil.on("error", (e) => console.error(`anvil failed to start: ${e.message}`));
    if (!stopAfter) anvil.unref();
    console.log(`Started anvil on ${rpcUrl} (PID ${anvil.pid}).`);
  }

  const id = await waitForRpc(start ? 15_000 : 2_000).catch(() => {
    throw new Error(`No node at ${rpcUrl}. Start one with \`anvil --port ${port}\` or pass --start.`);
  });
  if (id !== 31337) throw new Error(`Refusing to deploy: ${rpcUrl} reports chain id ${id}, not anvil's 31337.`);

  const admin = process.env.ADMIN || ANVIL_ACCOUNT_0;
  const scheduler = process.env.SCHEDULER || ANVIL_ACCOUNT_0;
  console.log(`Deploying to ${rpcUrl} from anvil account 0 (unlocked) with epoch length ${epochLength}s…`);
  run(
    "forge",
    [
      "script",
      "script/Deploy.s.sol:Deploy",
      "--rpc-url",
      rpcUrl,
      "--broadcast",
      "--unlocked",
      "--sender",
      ANVIL_ACCOUNT_0,
    ],
    {
      cwd: contractsDir,
      env: {
        ...env,
        ADMIN: admin,
        SCHEDULER: scheduler,
        EPOCH_LENGTH: String(epochLength),
        DEPLOY_MOCK_ESCROW: "1",
        PAYOUT_TOKEN: "0x0000000000000000000000000000000000000000",
      },
    },
  );
  run(process.execPath, [join(root, "scripts", "sync-deployments.mjs"), "Deploy.s.sol", "--chain", "31337"], {
    cwd: root,
  });

  const { readFileSync } = await import("node:fs");
  const deployments = JSON.parse(readFileSync(join(root, "src", "contracts", "deployments.json"), "utf8"))["31337"];
  const rewards = deployments.SparecycleRewards;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const abi = parseAbi([
    "function currentEpoch() view returns (uint64)",
    "function epochLength() view returns (uint64)",
    "function feeEscrow() view returns (address)",
    "function owner() view returns (address)",
    "function scheduler() view returns (address)",
    "function payoutToken() view returns (address)",
    "function accounted() view returns (uint256)",
  ]);
  const read = (functionName) => client.readContract({ address: rewards, abi, functionName });
  const [epoch, len, escrow, owner, sched, token, acc] = await Promise.all(
    ["currentEpoch", "epochLength", "feeEscrow", "owner", "scheduler", "payoutToken", "accounted"].map(read),
  );
  if (escrow !== deployments.MockPonsFeeEscrow) throw new Error("feeEscrow is not the deployed mock");
  if (Number(len) !== epochLength) throw new Error("epochLength mismatch");
  console.log(
    `On-chain check: currentEpoch=${epoch} epochLength=${len}s owner=${owner} scheduler=${sched} ` +
      `payoutToken=${token} (ETH) feeEscrow=${escrow} accounted=${formatEther(acc)} ETH`,
  );

  console.log("\nSet these for the app (e.g. in .env.local):");
  console.log("NEXT_PUBLIC_NETWORK=local");
  console.log(`NEXT_PUBLIC_RPC_URL=${rpcUrl}`);
  console.log(`NEXT_PUBLIC_REWARD_CONTRACT_ADDRESS=${rewards}`);
  console.log(`NEXT_PUBLIC_SCHEDULER_ADDRESS=${sched}`);
  console.log(`NEXT_PUBLIC_EPOCH_LENGTH=${epochLength}`);
  console.log("NEXT_PUBLIC_NODE_PAYOUT_ASSET=ETH");
  console.log(
    "# Scheduler signer for local tests: anvil account 0 (its well-known dev key is printed by `anvil` at startup).",
  );
  console.log(`# Mock escrow (local only): ${deployments.MockPonsFeeEscrow}`);

  if (anvil && stopAfter) stopAnvil();
  else if (anvil) {
    const how = process.platform === "win32" ? `taskkill /PID ${anvil.pid} /T /F` : `kill ${anvil.pid}`;
    console.log(`\nanvil keeps running on ${rpcUrl} (PID ${anvil.pid}). Stop it with: ${how}`);
  }
}

main().catch((e) => {
  console.error(`deploy-local failed: ${e.message}`);
  stopAnvil();
  process.exit(1);
});
