import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0017 AC-4: the owner makes the Authentik groups, so no app code
// creates, updates, or deletes one. It only reads them and changes their
// membership. This scan fails when the SDK's group write calls appear in app
// code, and also on the raw `core/groups` path, which would be a direct fetch
// around the SDK (and around the guard). Tests are not app code; the in
// memory fake Authentik is test support and names the path to answer it.
const FORBIDDEN = [
  "coreGroupsCreate",
  "coreGroupsUpdate",
  "coreGroupsPartialUpdate",
  "coreGroupsDestroy",
  "core/groups",
];
const SKIPPED = new Set(["server/authentik/testing.ts"]);
const DIRS = ["app", "lib", "server", "worker"];

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

describe("group writes source scan (spec 0017 AC-4)", () => {
  const scanned = DIRS.flatMap((d) => files(path.join(root, d)))
    .map((f) => path.relative(root, f))
    .filter((f) => !SKIPPED.has(f));

  it("finds the files it checks, the group module among them", () => {
    expect(scanned).toContain("server/authentik/groups.ts");
    expect(scanned).toContain("server/worker/reconcile.ts");
    expect(scanned).not.toContain("server/authentik/testing.ts");
  });

  it("calls no group create, update, or delete, and no raw groups path", () => {
    const found = scanned.flatMap((f) => {
      const text = readFileSync(path.join(root, f), "utf8");
      return FORBIDDEN.filter((word) => text.includes(word)).map(
        (word) => `${f}: ${word}`,
      );
    });
    expect(found).toEqual([]);
  });

  it("catches a forbidden call when one is written (the scan itself works)", () => {
    const sample = "await api.coreGroupsDestroy({ groupUuid });";
    expect(FORBIDDEN.some((word) => sample.includes(word))).toBe(true);
    const raw = 'fetch(`${base}/api/v3/core/groups/`, { method: "POST" })';
    expect(FORBIDDEN.some((word) => raw.includes(word))).toBe(true);
  });
});
