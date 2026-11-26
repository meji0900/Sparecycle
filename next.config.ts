import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Separate build dirs let parallel local servers (QA, e2e) run without sharing a lock.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The dApp reads live chain/scheduler state on every request; Cache Components adds no value here
  // and would force Suspense boundaries around every live read. Keep the classic dynamic model.
  cacheComponents: false,
  // node:sqlite and pngjs run only on the server (scheduler API).
  serverExternalPackages: ["pngjs"],
  turbopack: {
    resolveAlias: {
      "@coinbase/cdp-sdk": "./src/lib/stubs/cdp-sdk.ts",
    },
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
  // OpenAI-compatible base URL: SDK users set baseURL to https://<host>/v1 (src/server/openai.ts, /docs/api/openai).
  // Every /v1 path is served by the matching /api/v1 route; unknown paths still get the JSON 404 of api/v1/[...path].
  async rewrites() {
    return [{ source: "/v1/:path*", destination: "/api/v1/:path*" }];
  },
};

export default nextConfig;
