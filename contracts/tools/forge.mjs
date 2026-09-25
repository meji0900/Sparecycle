#!/usr/bin/env node
// Runs `forge <args>` inside contracts/ with ~/.foundry/bin on PATH, so npm scripts work from any shell
// (cmd.exe, PowerShell, Git Bash) without Foundry on the global PATH. Exit code is forge's.
// Usage: node contracts/tools/forge.mjs test --match-path 'test/fork/*' -vv
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const contractsDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, PATH: `${join(homedir(), ".foundry", "bin")}${delimiter}${process.env.PATH ?? ""}` };
const r = spawnSync("forge", process.argv.slice(2), { cwd: contractsDir, env, stdio: "inherit" });
if (r.error) {
  console.error(`could not run forge (${r.error.message}). Install Foundry: https://getfoundry.sh`);
  process.exit(1);
}
process.exit(r.status ?? 1);
