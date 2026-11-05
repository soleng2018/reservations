// Spec 0026 AC-14, AC-15: `npm run typegroups:backfill` gives every live
// Testbed Type that has no Authentik group its group (or links a safe same
// name one). A dry run by default; `-- --apply` writes. Safe to run again: a
// type that already has a group is not touched. Dev and production share one
// Authentik and one database, so --apply makes real groups. Exit code 1 only
// when Authentik could not be reached; skipped types are reported, not failed.
import { authentik } from "@/server/authentik/client";
import { backfillTypeGroups } from "@/server/catalog/type-groups-backfill";
import { db } from "@/server/db";

const WORDS = {
  created: "would create a group for",
  linked: "would link the existing group to",
} as const;
const DONE = {
  created: "created a group for",
  linked: "linked a group to",
} as const;

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  const conn = db();
  try {
    const report = await backfillTypeGroups(conn, authentik(), apply);
    for (const l of report.lines)
      console.log(
        l.result === "skipped"
          ? `skipped (${l.reason}): ${l.name}`
          : `${(apply ? DONE : WORDS)[l.result]}: ${l.name}`,
      );
    const skipped = report.lines.filter((l) => l.result === "skipped").length;
    console.log(
      `type groups backfill${apply ? "" : " (dry run)"}: ${report.lines.length - skipped} done or planned, ${skipped} skipped${apply ? "" : "; run again with -- --apply to write"}`,
    );
    if (report.stopped) {
      console.error("type groups backfill: Authentik could not be reached");
      return 1;
    }
    return 0;
  } finally {
    await conn.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error("type groups backfill failed", e);
    process.exit(1);
  },
);
