// Lets plain `node` (24+, built-in type stripping) import this app's TypeScript from scripts: resolves the `@/`
// path alias and extensionless relative imports under src/ to .ts files. Used by scripts/sweep.mjs and
// scripts/e2e-local.mjs. Import it before importing any src/ TypeScript.
import { registerHooks } from "node:module";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const probe = (base) => [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(isFile);
const asTs = (file) => ({ url: pathToFileURL(file).href, format: "module-typescript", shortCircuit: true });
const inSrc = (file) => file.toLowerCase().startsWith(SRC.toLowerCase());

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const f = probe(join(SRC, specifier.slice(2)));
      if (f) return asTs(f);
    }
    if (specifier.startsWith("file:") && specifier.endsWith(".ts") && inSrc(fileURLToPath(specifier))) {
      return asTs(fileURLToPath(specifier));
    }
    const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : null;
    if (parent && inSrc(parent) && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      const f = probe(resolve(dirname(parent), specifier));
      if (f && f.endsWith(".ts")) return asTs(f);
    }
    return nextResolve(specifier, context);
  },
});

/** import() of a file under src/, e.g. srcImport("lib/merkle.ts"). */
export const srcImport = (rel) => import(pathToFileURL(join(SRC, rel)).href);
