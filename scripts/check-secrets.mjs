// Blocks commits/CI when a private key, seed phrase, or filled .env file would be committed.
// Usage: node scripts/check-secrets.mjs [--staged]
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const staged = process.argv.includes("--staged");
const list = staged
  ? execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" })
  : execSync("git ls-files -co --exclude-standard", { encoding: "utf8" });
const files = list.split("\n").map((f) => f.trim()).filter(Boolean);

// Anvil's public dev keys are well known and safe to appear in docs/tests.
const ALLOW = new Set([
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
]);
const RULES = [
  { name: "private key", re: /(private[_-]?key|priv[_-]?key|secret[_-]?key|deployer[_-]?key|\bpk)\s*["'`]?\s*[:=]\s*["'`]?(0x)?([0-9a-fA-F]{64})\b/gi, group: 3 },
  { name: "seed phrase", re: /(mnemonic|seed[_-]?phrase|recovery[_-]?phrase)\s*["'`]?\s*[:=]\s*["'`]?((?:[a-z]+\s+){11,23}[a-z]+)/gi },
];
const SKIP = /(^|\/)(node_modules|\.next)\/|^contracts\/(lib|out|cache|broadcast)\/|package-lock\.json$|\.(png|jpe?g|gif|webp|ico|woff2?|mp4|glb|gltf|zip)$/i;

const problems = [];
for (const file of files) {
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".example")) {
    problems.push(`${file}: env file must not be committed (add to .gitignore)`);
    continue;
  }
  if (SKIP.test(file)) continue;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.group && ALLOW.has(m[rule.group].toLowerCase())) continue;
      const line = text.slice(0, m.index).split("\n").length;
      problems.push(`${file}:${line}: looks like a ${rule.name}`);
    }
  }
}

if (problems.length) {
  console.error("✗ Secret check failed:\n  " + problems.join("\n  "));
  console.error("Move secrets to .env.local / Railway variables / Foundry keystore. If a real key was committed, treat it as leaked: rotate it and move funds.");
  process.exit(1);
}
console.log(`✓ Secret check passed (${files.length} files)`);
