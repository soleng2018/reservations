import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Last, so Prettier owns formatting and ESLint only flags real problems.
  prettier,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Esbuild bundles of the worker and migrate (npm run build:bundle).
    "dist/**",
    "out/**",
    "build/**",
    // Research prototypes that drive a live portal (docs/research/portal-scripts/README.md).
    "docs/research/portal-scripts/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
