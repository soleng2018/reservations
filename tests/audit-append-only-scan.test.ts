import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Spec 0016 AC-11: the audit log is append only from the app. Postgres
// refuses an update, delete, or truncate anyway (spec 0002 AC-7); this scan
// stops one in review. Migrations, tests, and the generated schema types
// are not app code.
const SKIPPED = new Set(["server/db/types.ts"]);
const DIRS = ["app", "components", "lib", "server", "worker", "scripts"];

const WRITES: readonly (readonly [string, RegExp])[] = [
  ["Kysely update", /updateTable\(\s*["'`]audit_events/],
  ["Kysely delete", /deleteFrom\(\s*["'`]audit_events/],
  ["SQL update", /\bupdate\s+(?:hol_app\.)?"?audit_events\b/i],
  ["SQL delete", /\bdelete\s+from\s+(?:hol_app\.)?"?audit_events\b/i],
  ["SQL truncate", /\btruncate\s+(?:table\s+)?(?:hol_app\.)?"?audit_events\b/i],
];

const root = path.resolve(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? files(full)
      : /\.(?:tsx?|mjs|sql)$/.test(name) && !/\.test\.tsx?$/.test(name)
        ? [full]
        : [];
  });

const writesIn = (text: string): readonly string[] =>
  WRITES.filter(([, re]) => re.test(text)).map(([rule]) => rule);

describe("audit_events append only source scan", () => {
  const scanned = DIRS.flatMap((d) => {
    try {
      return files(path.join(root, d));
    } catch {
      return [];
    }
  })
    .map((f) => path.relative(root, f))
    .filter((f) => !SKIPPED.has(f));

  it("finds the files it checks, the audit writer among them", () => {
    expect(scanned).toContain("server/audit.ts");
    expect(scanned).toContain("server/audit-log.ts");
  });

  it("finds no update, delete, or truncate of audit_events in app code", () => {
    const hits = scanned.flatMap((f) =>
      writesIn(readFileSync(path.join(root, f), "utf8")).map(
        (rule) => `${f}: ${rule}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  // The scan would catch a planted write in each form.
  it.each([
    ['db.deleteFrom("audit_events").execute()', "Kysely delete"],
    ["trx.updateTable('audit_events').set({ summary: 'x' })", "Kysely update"],
    ["sql`update hol_app.audit_events set summary = ''`", "SQL update"],
    ["sql`DELETE FROM audit_events where true`", "SQL delete"],
    ["sql`truncate table hol_app.audit_events`", "SQL truncate"],
  ])("flags %s", (planted, rule) => {
    expect(writesIn(planted)).toEqual([rule]);
  });

  it("does not flag reads or the one insert", () => {
    expect(
      writesIn(
        'db.selectFrom("audit_events"); db.insertInto("audit_events"); sql`select * from hol_app.audit_events`',
      ),
    ).toEqual([]);
  });
});
