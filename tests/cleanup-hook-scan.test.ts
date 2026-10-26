import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0021 AC-9: the hook URL and signing secret stay in memory for one
// call. The secret is decrypted only in the API keys module, the web process
// never calls the hook, and nothing logs a URL or a secret. Tests and
// generated types are not app code.
const DIRS = ["app", "components", "lib", "server", "worker", "scripts"];
const root = path.resolve(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? files(full)
      : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)
        ? [full]
        : [];
  });

const scanned = DIRS.flatMap((d) => {
  try {
    return files(path.join(root, d));
  } catch {
    return [];
  }
})
  .map((f) => path.relative(root, f))
  .filter((f) => f !== "server/db/types.ts" && !f.endsWith("/testing.ts"));

const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const naming = (word: string) =>
  scanned.filter((f) => read(f).includes(word)).sort();

describe("cleanup hook source scan (spec 0021 AC-9)", () => {
  it("finds the files it checks", () => {
    expect(scanned).toContain("server/jobs/cleanup-hook.ts");
  });

  // The worker alone reads the decrypted config.
  it("reads the hook config only in the worker", () => {
    expect(naming("cleanupHookConfig")).toEqual([
      "server/catalog/api-keys.ts",
      "worker/index.ts",
    ]);
  });

  // Only the worker's step calls out; the web process queues.
  it("calls the hook from one file", () => {
    expect(naming("X-HOL-Signature")).toEqual(["server/jobs/cleanup-hook.ts"]);
    expect(naming("signHook")).toEqual(["server/jobs/cleanup-hook.ts"]);
  });

  it("never logs a URL, a secret, or a config", () => {
    for (const f of [
      "server/jobs/cleanup-hook.ts",
      "server/jobs/cleanup-queue.ts",
    ])
      for (const line of read(f)
        .split("\n")
        .filter((l) => l.includes("console.")))
        expect(line).not.toMatch(/url|secret|config|payload|body/i);
  });

  it("keeps the URL out of every job payload and audit row", () => {
    const queue = read("server/jobs/cleanup-queue.ts");
    expect(queue).not.toMatch(/baseUrl|base_url|cleanupHookConfig/);
    const hook = read("server/jobs/cleanup-hook.ts");
    const audits = hook.split("audit(conn, {")[1]?.split("});")[0] ?? "";
    expect(audits).not.toMatch(/url|secret|config/i);
  });

  it("shows the API Keys list and edit form a masked URL only", () => {
    const page = read("app/admin/api-keys/page.tsx");
    expect(page).toContain("maskHookUrl(k.baseUrl)");
    expect(page).toContain('baseUrl: k.type === "CLEANUP" ? "" : k.baseUrl');
  });
});
