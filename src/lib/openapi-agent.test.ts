// The agent-API OpenAPI fragments: every $ref resolves, every operation has responses, every route file exists.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { agentApiComponents, agentApiPaths } from "./openapi-agent";

test("every $ref points at a schema in agentApiComponents", () => {
  const refs = [...JSON.stringify({ agentApiPaths, agentApiComponents }).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 5);
  for (const r of refs) assert.ok(r in agentApiComponents.schemas, `missing schema ${r}`);
});

test("every path has a route file and every operation answers something", () => {
  for (const [path, ops] of Object.entries(agentApiPaths)) {
    const dir = path.replace(/^\/api\/v1/, "").replace(/\{id\}/g, "[id]");
    assert.ok(existsSync(join(process.cwd(), "src", "app", "api", "v1", dir, "route.ts")), `route for ${path}`);
    for (const [method, op] of Object.entries(ops)) assert.ok(Object.keys((op as { responses: object }).responses).length > 0, `${method} ${path}`);
  }
});
