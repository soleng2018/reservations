import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0012 AC-11: the Cloudflare revoke takes its base URL and token from
// the CLOUDFLARE API key, never from env. Runtime code (web and worker)
// names no CLOUDFLARE_* variable. The setup script is not runtime code: its
// one run input CLOUDFLARE_TEAM_DOMAIN is allowed (spec 0003 AC-13). An env
// read is `process.env.CLOUDFLARE_…` or a quoted name (as `secret()` takes).
const ENV_READ = /(process\.env\.|process\.env\[\s*|["'`])CLOUDFLARE_[A-Z]/;
const DIRS = ["app", "components", "lib", "server", "worker"];

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

describe("CLOUDFLARE_* env source scan", () => {
  const scanned = DIRS.flatMap((d) => {
    try {
      return files(path.join(root, d));
    } catch {
      return [];
    }
  }).map((f) => path.relative(root, f));

  it("finds the files it checks", () => {
    expect(scanned).toContain("worker/index.ts");
    expect(scanned).toContain("server/env.ts");
  });

  it("reads no CLOUDFLARE_* variable in web or worker code", () => {
    const naming = scanned.filter((f) =>
      ENV_READ.test(readFileSync(path.join(root, f), "utf8")),
    );
    expect(naming).toEqual([]);
  });
});
