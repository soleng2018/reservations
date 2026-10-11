import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0006 AC-8 and key invariants: app code names the encrypted secret
// column in one file only, the one that writes it. Tests and the generated
// schema types are not app code.
const ALLOWED = new Set(["server/catalog/api-keys.ts"]);
const SKIPPED = new Set(["server/db/types.ts"]);
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

describe("secret_ciphertext source scan", () => {
  const scanned = DIRS.flatMap((d) => {
    try {
      return files(path.join(root, d));
    } catch {
      return [];
    }
  })
    .map((f) => path.relative(root, f))
    .filter((f) => !SKIPPED.has(f));

  it("finds the files it checks, the writer among them", () => {
    expect(scanned).toContain("server/catalog/api-keys.ts");
  });

  it("names the column only where the secret is written", () => {
    const naming = scanned.filter((f) =>
      readFileSync(path.join(root, f), "utf8").includes("secret_ciphertext"),
    );
    expect(naming).toEqual([...ALLOWED]);
  });
});
