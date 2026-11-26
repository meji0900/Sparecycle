// The OpenAPI description: well-formed 3.1, every $ref resolves, every route under src/app/api/v1 is described, the
// README's public endpoints are covered, and modules cannot overwrite each other. Run: npm test
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, test } from "node:test";
import { HTTP_METHODS, listOperations, mergeOpenApi, openApiDocument, type OpenApiModule } from "./openapi";

const ROOT = join(import.meta.dirname, "..", "..");
const API_DIR = join(ROOT, "src", "app", "api", "v1");

/** Route files under src/app/api/v1 as OpenAPI paths with their exported methods. */
function routeFiles(): { path: string; methods: string[] }[] {
  const out: { path: string; methods: string[] }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") {
        const rel = relative(API_DIR, dir).split(sep).join("/");
        if (rel.includes("[...")) continue; // the JSON 404 catch-all
        const path = "/" + rel.replace(/\[([^\]]+)\]/g, "{$1}");
        const src = readFileSync(full, "utf8");
        const methods = [...src.matchAll(/export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE|HEAD)\b/g)].map((m) => m[1].toLowerCase());
        out.push({ path, methods });
      }
    }
  };
  walk(API_DIR);
  return out;
}

describe("openapi", () => {
  const doc = openApiDocument();

  test("is an OpenAPI 3.1 document with unique operation ids, tags that exist and responses everywhere", () => {
    assert.equal(doc.openapi, "3.1.0");
    assert.ok(doc.info.title && doc.info.version);
    const tags = new Set(doc.tags.map((t) => t.name));
    const ids = new Set<string>();
    for (const { method, path, op } of listOperations(doc)) {
      assert.ok(path.startsWith("/"), path);
      assert.ok(op.operationId && !ids.has(op.operationId), `${method} ${path}: missing or duplicate operationId`);
      ids.add(op.operationId);
      assert.ok(op.summary, `${method} ${path}: no summary`);
      assert.ok(Object.keys(op.responses).length > 0, `${method} ${path}: no responses`);
      for (const t of op.tags) assert.ok(tags.has(t), `${method} ${path}: unknown tag ${t}`);
      for (const s of (op.security as Record<string, unknown>[] | undefined) ?? []) {
        for (const name of Object.keys(s)) assert.ok(name in doc.components.securitySchemes, `${method} ${path}: unknown security ${name}`);
      }
      const params = [...((doc.paths[path].parameters as { $ref?: string; name?: string }[]) ?? []), ...((op.parameters as { $ref?: string; name?: string }[]) ?? [])];
      for (const name of path.match(/\{([^}]+)\}/g) ?? []) {
        const n = name.slice(1, -1);
        const found = params.some((p) => p.name === n || (p.$ref && (doc.components.parameters[p.$ref.split("/").pop()!] as { name?: string })?.name === n));
        assert.ok(found, `${method} ${path}: path parameter ${n} is not declared`);
      }
    }
  });

  test("every $ref points at a component that exists", () => {
    const refs = JSON.stringify(doc).match(/"\$ref":"([^"]+)"/g) ?? [];
    assert.ok(refs.length > 0);
    for (const r of refs) {
      const target = r.slice(8, -1);
      const [, , kind, name] = target.split("/");
      assert.ok(target.startsWith("#/components/"), target);
      assert.ok((doc.components as Record<string, Record<string, unknown>>)[kind]?.[name], `unresolved ${target}`);
    }
  });

  test("every route under src/app/api/v1 is described, with each method it exports", () => {
    for (const { path, methods } of routeFiles()) {
      assert.ok(doc.paths[path], `${path} is not in the OpenAPI description (src/lib/openapi*.ts)`);
      for (const m of methods) assert.ok(doc.paths[path][m as (typeof HTTP_METHODS)[number]], `${m.toUpperCase()} ${path} is not described`);
    }
  });

  test("covers the public endpoints of the README API table", () => {
    const readme = [
      "get /health", "get /status", "get /epochs", "get /epochs/{id}/tree", "get /epochs/{id}/proof", "get /epochs/{id}/charges",
      "get /jobs", "post /jobs", "get /jobs/{id}", "get /nodes", "get /payments/account", "get /jobs/{id}/result",
      "get /auth/nonce", "post /auth/verify", "post /auth/logout",
    ];
    for (const e of readme) {
      const [m, p] = e.split(" ");
      assert.ok(doc.paths[p]?.[m as "get"], `${e} missing`);
    }
  });

  test("modules merge, and a second definition of the same operation or component is refused", () => {
    const base = { openapi: "3.1.0" as const, info: { title: "t", version: "1" }, servers: [] };
    const a: OpenApiModule = {
      name: "a",
      tags: [{ name: "X", description: "x" }],
      paths: { "/x": { get: { operationId: "x", summary: "x", tags: ["X"], responses: { "200": { description: "ok" } } } } },
      components: { schemas: { S: { type: "string" } } },
    };
    const b: OpenApiModule = {
      name: "b",
      paths: { "/x": { post: { operationId: "x2", summary: "x2", tags: ["X"], responses: { "200": { description: "ok" } } } } },
      components: { schemas: { S: { type: "string" } } },
    };
    const merged = mergeOpenApi(base, [a, b]);
    assert.ok(merged.paths["/x"].get && merged.paths["/x"].post);
    assert.throws(() => mergeOpenApi(base, [a, { ...b, paths: a.paths }]), /defined by both a and b/);
    assert.throws(() => mergeOpenApi(base, [a, { ...b, components: { schemas: { S: { type: "number" } } } }]), /conflicts/);
  });
});
