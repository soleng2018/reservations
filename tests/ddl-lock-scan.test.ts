import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0020: the cleanup gap migration tests run ALTER TABLE on bookings,
// which locks it until their rollback. A test that does so must run in
// inRollbackDdl (server/db/testing.ts), which holds the DDL advisory lock
// alone; in plain inRollback it starves the DB tests in other files and they
// fail at random with lock_not_available.
const DDL_HELPERS = ["applyBookingGapMigration(", "restoreOldOverlapRule("];
const DIRS = ["server", "lib", "worker", "scripts", "tests"];

const root = path.resolve(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? files(full)
      : /\.test\.tsx?$/.test(name)
        ? [full]
        : [];
  });

const testFiles = DIRS.flatMap((d) => files(path.join(root, d)))
  .map((f) => path.relative(root, f))
  .filter((f) => f !== "tests/ddl-lock-scan.test.ts");

// Each `it(` block, with its file and a line to point at.
const blocks = testFiles.flatMap((file) =>
  readFileSync(path.join(root, file), "utf8")
    .split(/\n(?=\s*it(?:\.\w+)?\()/)
    .map((body) => ({ file, body })),
);

describe("DDL tests hold the DDL lock", () => {
  const ddl = blocks.filter(({ body }) =>
    DDL_HELPERS.some((h) => body.includes(h)),
  );

  it("finds the tests it checks", () => {
    expect(ddl.length).toBeGreaterThan(0);
  });

  it("runs every test that changes the schema in inRollbackDdl", () => {
    const wrong = ddl
      .filter(({ body }) => !body.includes("inRollbackDdl("))
      .map(({ file, body }) => `${file}: ${body.trim().split("\n")[0]}`);
    expect(wrong).toEqual([]);
  });
});
