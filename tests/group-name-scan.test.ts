import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0018 AC-5: the Authentik group name is admin side only. App code names
// `group_name` or `groupName` only in the group facing files below, so a
// learner facing read (email, invite, screens) cannot leak it by accident.
// Tests and the generated schema types are not app code.
// server/db/constraint-errors.ts is on the list because it maps the unique
// index `testbeds_group_name_lower_uq` (a name, not a read).
const ALLOWED = new Set([
  // Spec 0023 AC-42: the reset engine's automation account joins the
  // testbed's access group, so these name it.
  "server/authentik/portal-automation.ts",
  "server/portal-engine/connect.ts",
  "scripts/portal-automation-check.ts",
  "server/catalog/testbeds.ts",
  "server/worker/reconcile.ts",
  "lib/reconcile.ts",
  "server/audit-log.ts",
  "lib/testbeds.ts",
  "lib/catalog-input.ts",
  "components/admin/testbed-fields.tsx",
  "app/admin/testbeds/page.tsx",
  "app/admin/actions.ts",
  "server/db/testing.ts",
  "server/db/constraint-errors.ts",
]);
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

describe("group_name source scan (spec 0018 AC-5)", () => {
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

  it("names the group name only in the group facing files", () => {
    const naming = scanned.filter((f) =>
      /group_name|groupName/.test(readFileSync(path.join(root, f), "utf8")),
    );
    expect(naming.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });
});
