// Bundles the worker and the migrate script into dist/ for the image (spec
// 0001: the standalone build has no separate process). `server-only` maps to
// the package's own empty.js, as worker/server-only-hook.mjs does under tsx,
// so React Email still loads react-dom/server. Run by `npm run build:bundle`.
import { build } from "esbuild";

const ENTRIES = {
  worker: "worker/index.ts",
  migrate: "scripts/migrate.ts",
} as const;

build({
  entryPoints: ENTRIES,
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  jsx: "automatic",
  alias: { "server-only": "./node_modules/server-only/empty.js" },
  // pg loads pg-native only when asked for it; it is not installed.
  external: ["pg-native"],
  // Some bundled CommonJS calls require(); ESM has none, so give it one.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "warning",
}).catch(() => {
  // esbuild has already printed the errors.
  process.exit(1);
});
