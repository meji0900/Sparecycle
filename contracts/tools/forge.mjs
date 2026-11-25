#!/usr/bin/env node
// Runs `forge <args>` inside contracts/ with ~/.foundry/bin on PATH, so npm scripts work from any shell
// (cmd.exe, PowerShell, Git Bash) without Foundry on the global PATH. Exit code is forge's.
// Usage: node contracts/tools/forge.mjs test --match-path 'test/fork/*' -vv
//
// forge-std (the Foundry test library) is not vendored: when contracts/lib/forge-std is missing (a plain clone without
// submodules), it is fetched once from the official repo at the pinned commit below.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FORGE_STD_REPO = "https://github.com/foundry-rs/forge-std";
const FORGE_STD_COMMIT = "f3dae6e6ee381f25eb6a246f7da9b85c91a68219";

const contractsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const forgeStd = join(contractsDir, "lib", "forge-std");

if (!existsSync(join(forgeStd, "src", "Test.sol"))) {
  console.error(`forge-std not found: fetching ${FORGE_STD_REPO} at ${FORGE_STD_COMMIT.slice(0, 12)}`);
  const git = (args, cwd) => spawnSync("git", args, { cwd, stdio: "inherit" }).status === 0;
  const ok =
    git(["clone", "--quiet", FORGE_STD_REPO, forgeStd], contractsDir) &&
    git(["-c", "advice.detachedHead=false", "checkout", "--quiet", FORGE_STD_COMMIT], forgeStd);
  if (!ok) {
    console.error("could not fetch forge-std (needs git and network access)");
    process.exit(1);
  }
}

const env = { ...process.env, PATH: `${join(homedir(), ".foundry", "bin")}${delimiter}${process.env.PATH ?? ""}` };
const r = spawnSync("forge", process.argv.slice(2), { cwd: contractsDir, env, stdio: "inherit" });
if (r.error) {
  console.error(`could not run forge (${r.error.message}). Install Foundry: https://getfoundry.sh`);
  process.exit(1);
}
process.exit(r.status ?? 1);
