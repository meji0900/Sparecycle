import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // React Three Fiber render loops mutate three.js objects every frame by design
    // (positions, colours, draw ranges). The React Compiler immutability rule targets
    // React state, not these imperative scene objects.
    files: ["src/components/three/**/*.tsx"],
    rules: { "react-hooks/immutability": "off" },
  },
  globalIgnores([
    ".next/**",
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    ".recon/**",
    ".check/**",
    ".check-live/**",
    "data/**",
    "contracts/**",
    "node-client/**",
    "src/components/reactbits/**",
    "videos/**",
  ]),
]);

export default eslintConfig;
