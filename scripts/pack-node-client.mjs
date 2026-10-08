// Packs node-client/ into the downloads the /nodes page links to:
//   public/downloads/sparecycle-node-windows.zip   (CRLF for .ps1, LF elsewhere)
//   public/downloads/sparecycle-node-linux.tar.gz  (LF everywhere)
//   public/downloads/SHA256SUMS.txt
// and src/lib/downloads.json (file names, sizes, sha256) for the page.
// Never packs bin/, models/, node_modules/, .venv/ or any key file. Run: node scripts/pack-node-client.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "node-client");
const OUT = join(ROOT, "public", "downloads");
const STAGE = join(ROOT, "data", "pack-stage");
const NAME = "sparecycle-node";
const SKIP_DIRS = new Set(["bin", "models", "node_modules", ".venv"]);
const SKIP_FILE = /(^|[\\/])(key\.json|.*\.key|.*\.part)$/i;
const TEXT = /\.(sh|ts|py|json|md|ps1|txt|gitignore)$/i;

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...files(p));
    } else if (!SKIP_FILE.test(p)) out.push(p);
  }
  return out;
}

function stage(eol) {
  const dest = join(STAGE, eol, NAME);
  rmSync(join(STAGE, eol), { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const f of files(SRC)) {
    const rel = relative(SRC, f);
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (TEXT.test(f) || rel === ".gitignore") {
      let text = readFileSync(f, "utf8").replace(/\r\n/g, "\n");
      if (eol === "win" && f.endsWith(".ps1")) text = text.replace(/\n/g, "\r\n");
      writeFileSync(to, text);
    } else cpSync(f, to);
  }
  // MIT attribution travels with the code it covers.
  cpSync(join(ROOT, "NOTICE"), join(dest, "NOTICE"));
  return join(STAGE, eol);
}

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const tarBin = process.platform === "win32" && existsSync("C:\\Windows\\System32\\tar.exe") ? "C:\\Windows\\System32\\tar.exe" : "tar";

mkdirSync(OUT, { recursive: true });
const winDir = stage("win");
const zip = join(OUT, `${NAME}-windows.zip`);
rmSync(zip, { force: true });
let r = spawnSync(tarBin, ["-a", "-cf", zip, "-C", winDir, NAME], { stdio: "inherit" });
if (r.status !== 0) throw new Error("zip failed (needs bsdtar: Windows tar.exe or libarchive's bsdtar)");

const linDir = stage("linux");
const tgz = join(OUT, `${NAME}-linux.tar.gz`);
rmSync(tgz, { force: true });
r = spawnSync(tarBin, ["-czf", tgz, "-C", linDir, NAME], { stdio: "inherit" });
if (r.status !== 0) throw new Error("tar.gz failed");

const entries = [
  { os: "windows", file: `${NAME}-windows.zip`, path: zip },
  { os: "linux", file: `${NAME}-linux.tar.gz`, path: tgz },
].map((e) => ({ os: e.os, file: e.file, bytes: statSync(e.path).size, sha256: sha(e.path) }));

writeFileSync(join(OUT, "SHA256SUMS.txt"), entries.map((e) => `${e.sha256}  ${e.file}`).join("\n") + "\n");
const version = JSON.parse(readFileSync(join(SRC, "package.json"), "utf8")).version;
writeFileSync(
  join(ROOT, "src", "lib", "downloads.json"),
  JSON.stringify({ version, packedFrom: "node-client/", files: Object.fromEntries(entries.map((e) => [e.os, e])) }, null, 2) + "\n",
);
rmSync(STAGE, { recursive: true, force: true });
for (const e of entries) console.log(`${e.file}  ${(e.bytes / 1024).toFixed(1)} KB  sha256 ${e.sha256}`);
