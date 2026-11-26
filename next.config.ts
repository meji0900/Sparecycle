import type { NextConfig } from "next";

/**
 * SparecycleJobPaymentsV2's address for the browser (src/lib/config.ts jobPaymentsV2), only while the scheduler runs it:
 * TOKEN_PAYMENTS_V2=on and a valid TOKEN_JOB_PAYMENTS_V2_ADDRESS. Empty otherwise, so the dapp is exactly as before V2.
 */
const paymentsV2Public = () => {
  const on = (process.env.TOKEN_PAYMENTS_V2 ?? "").trim().toLowerCase() === "on";
  const a = (process.env.TOKEN_JOB_PAYMENTS_V2_ADDRESS ?? "").trim();
  return on && /^0x[0-9a-fA-F]{40}$/.test(a) ? a : "";
};

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_JOB_PAYMENTS_V2_ADDRESS: paymentsV2Public() },
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
