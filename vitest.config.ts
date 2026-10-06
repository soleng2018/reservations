import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      // Vitest loads node_modules outside Vite, so the react-server condition
      // below never reaches it; point straight at the empty stub.
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
    conditions: ["react-server"],
  },
  test: {
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    passWithNoTests: true,
    // .env.local feeds the DB integration tests; without it (CI) they skip.
    env: loadEnv(mode, process.cwd(), ""),
  },
}));
