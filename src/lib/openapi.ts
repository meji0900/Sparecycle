// The OpenAPI 3.1 description served at GET /api/v1/openapi.json, built by merging modules. Each module brings its
// own paths, tags and components; mergeOpenApi refuses a path + method or a component name defined twice with
// different content, so modules cannot silently overwrite each other.
// To add endpoints: write a module (see ./openapi-core.ts), then add it to OPENAPI_MODULES below.
// src/lib/openapi.test.ts checks that every route under src/app/api/v1 is described.
import { agentApiComponents, agentApiPaths } from "./openapi-agent";
import { coreApi } from "./openapi-core";
import { stakingApi } from "./openapi-staking";

type Obj = Record<string, unknown>;

export const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type OpenApiOperation = Obj & { operationId: string; summary: string; tags: string[]; responses: Record<string, Obj> };
export type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>> & { parameters?: Obj[] };

export type OpenApiModule = {
  /** Shown in errors when two modules collide. */
  name: string;
  tags?: { name: string; description: string }[];
  /** Keys are paths relative to the server URL (/api/v1), e.g. "/jobs/{id}". */
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, Obj>;
    parameters?: Record<string, Obj>;
    responses?: Record<string, Obj>;
    securitySchemes?: Record<string, Obj>;
  };
};

export type OpenApiDocument = {
  openapi: "3.1.0";
  info: Obj;
  servers: Obj[];
  tags: { name: string; description: string }[];
  paths: Record<string, OpenApiPathItem>;
  components: Required<NonNullable<OpenApiModule["components"]>>;
  externalDocs?: Obj;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Merges modules into one document. Throws on a duplicate operation or a conflicting component, tag or path parameter. */
export function mergeOpenApi(base: Omit<OpenApiDocument, "paths" | "tags" | "components">, modules: OpenApiModule[]): OpenApiDocument {
  const doc: OpenApiDocument = {
    ...base,
    tags: [],
    paths: {},
    components: { schemas: {}, parameters: {}, responses: {}, securitySchemes: {} },
  };
  const owner = new Map<string, string>();
  for (const m of modules) {
    for (const tag of m.tags ?? []) {
      const existing = doc.tags.find((t) => t.name === tag.name);
      if (existing && !same(existing, tag)) throw new Error(`openapi: tag "${tag.name}" of ${m.name} conflicts with ${owner.get(`tag ${tag.name}`)}`);
      if (!existing) {
        doc.tags.push(tag);
        owner.set(`tag ${tag.name}`, m.name);
      }
    }
    for (const [path, item] of Object.entries(m.paths)) {
      const target: OpenApiPathItem = (doc.paths[path] ??= {});
      for (const [key, value] of Object.entries(item)) {
        if (key === "parameters") {
          if (target.parameters && !same(target.parameters, value)) {
            throw new Error(`openapi: path parameters of ${path} in ${m.name} conflict with ${owner.get(`params ${path}`)}`);
          }
          target.parameters = value as Obj[];
          owner.set(`params ${path}`, m.name);
          continue;
        }
        if (!(HTTP_METHODS as readonly string[]).includes(key)) throw new Error(`openapi: ${m.name} has an unknown key "${key}" on ${path}`);
        const method = key as HttpMethod;
        if (target[method]) throw new Error(`openapi: ${method.toUpperCase()} ${path} is defined by both ${owner.get(`${method} ${path}`)} and ${m.name}`);
        target[method] = value as OpenApiOperation;
        owner.set(`${method} ${path}`, m.name);
      }
    }
    for (const kind of ["schemas", "parameters", "responses", "securitySchemes"] as const) {
      for (const [name, value] of Object.entries(m.components?.[kind] ?? {})) {
        const existing = doc.components[kind][name];
        if (existing && !same(existing, value)) {
          throw new Error(`openapi: components.${kind}.${name} of ${m.name} conflicts with ${owner.get(`${kind} ${name}`)}`);
        }
        doc.components[kind][name] = value;
        owner.set(`${kind} ${name}`, m.name);
      }
    }
  }
  return doc;
}

/** Every module of the public API description, in display order. */
/** openapi-agent.ts writes full paths (/api/v1/...) without operationIds: make them relative and name each operation. */
function relativeWithIds(paths: Record<string, Record<string, unknown>>): OpenApiModule["paths"] {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [full, item] of Object.entries(paths)) {
    const path = full.replace(/^\/api\/v1(?=\/)/, "");
    const words = path.split(/[^A-Za-z0-9]+/).filter((w) => w && !/^id$/i.test(w));
    const base = words.map((w) => w[0].toUpperCase() + w.slice(1)).join("") || "Root";
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(item)) {
      const isOp = (HTTP_METHODS as readonly string[]).includes(key) && value && typeof value === "object";
      next[key] = isOp && !(value as Obj).operationId
        ? { operationId: `${key}${base}${/\{id\}/.test(path) ? "ById" : ""}`, ...(value as Obj) }
        : value;
    }
    out[path] = next;
  }
  return out as OpenApiModule["paths"];
}

/** API keys, the OpenAI-compatible routes (also under /v1 through a rewrite) and the MCP server. */
const agentApi: OpenApiModule = {
  name: "agent-api",
  tags: [
    { name: "API keys", description: "Spend-only keys per wallet: daily cap, kill switch, never withdraw. Managed with a wallet session." },
    { name: "OpenAI-compatible", description: "Chat completions and image generations through the two-node check; asynchronous by default." },
    { name: "MCP", description: "Model Context Protocol server (Streamable HTTP, stateless) with four tools." },
  ],
  paths: relativeWithIds(agentApiPaths as unknown as Record<string, Record<string, unknown>>),
  components: agentApiComponents as unknown as OpenApiModule["components"],
};

export const OPENAPI_MODULES: OpenApiModule[] = [coreApi, stakingApi, agentApi];

export function openApiDocument(modules: OpenApiModule[] = OPENAPI_MODULES): OpenApiDocument {
  return mergeOpenApi(
    {
      openapi: "3.1.0",
      info: {
        title: "Sparecycle scheduler API",
        version: "1",
        summary: "Submit checked AI jobs, read their status and private results, and read epochs, payouts and nodes.",
        description:
          "Every job runs on two nodes with different owners; a job is charged only when the two results match. JSON everywhere; errors are { \"error\": \"<code>\", \"message\": \"…\" }; amounts are decimal strings in wei; times are unix seconds. The scheduler is centralized in this MVP.",
        license: { name: "MIT", identifier: "MIT" },
      },
      servers: [{ url: "/api/v1", description: "This site's scheduler API" }],
      externalDocs: { description: "Guides and reference", url: "/docs/api" },
    },
    modules,
  );
}

/** Flat list of operations (for the docs page and tests). */
export function listOperations(doc: OpenApiDocument = openApiDocument()) {
  const out: { method: HttpMethod; path: string; op: OpenApiOperation }[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op) out.push({ method, path, op });
    }
  }
  return out;
}
