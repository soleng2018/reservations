import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0020 AC-9: the cleanup gap is invisible to the learner. Only the slot
// rules read `GAP_MS`; screens, emails, the calendar mirror, and the access
// reconciler never see it, so none of them can show or extend the gap.
const ALLOWED = new Set([
  "lib/slots.ts",
  "server/booking/availability.ts",
  "server/booking/manage.ts",
]);
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

describe("GAP_MS source scan (spec 0020 AC-9)", () => {
  const scanned = DIRS.flatMap((d) => {
    try {
      return files(path.join(root, d));
    } catch {
      return [];
    }
  }).map((f) => path.relative(root, f));

  it("finds the files it checks, the slot rules among them", () => {
    expect(scanned).toContain("lib/slots.ts");
  });

  it("reads GAP_MS only in the slot rules", () => {
    const naming = scanned.filter((f) =>
      /\bGAP_MS\b/.test(readFileSync(path.join(root, f), "utf8")),
    );
    expect(naming.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });
});
