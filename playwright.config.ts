import { defineConfig, devices } from "@playwright/test";

// Runs against the already running dev server. Dev signs in through the LAN
// IP, because the Authentik proxy refuses requests that mention localhost.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://10.1.255.18:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
