import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0007 AC-10: client OS passwords are plain text by design, so app code
// names their column in one file only, the catalog module that writes them
// and loads them for the admin's edit dialog. No learner page or public
// action can select it by accident. Feature 15's email builder joins this
// list on purpose. Tests and the generated schema types are not app code.
const ALLOWED = new Set(["server/catalog/testbeds.ts"]);
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

describe("os_password source scan", () => {
  const scanned = DIRS.flatMap((d) => {
    try {
      return files(path.join(root, d));
    } catch {
      return [];
    }
  })
    .map((f) => path.relative(root, f))
    .filter((f) => !SKIPPED.has(f));

  it("finds the files it checks, the catalog module among them", () => {
    expect(scanned).toContain("server/catalog/testbeds.ts");
  });

  it("names the column only in the catalog module", () => {
    const naming = scanned.filter((f) =>
      readFileSync(path.join(root, f), "utf8").includes("os_password"),
    );
    expect(naming).toEqual([...ALLOWED]);
  });
});
