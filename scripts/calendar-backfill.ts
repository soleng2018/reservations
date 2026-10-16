// Spec 0013 AC-20: `npm run calendar:backfill` queues a calendar_upsert for
// every confirmed booking that has not ended, so the shared "HOL bookings"
// calendar shows bookings made before the GOOGLE key existed. A dry run by
// default; `-- --apply` writes. It queues no emails, and a second run queues
// nothing new. Dev and production share one database: the worker picks the
// jobs up on its next tick.
import { db } from "@/server/db";
import { queueCalendarBackfill } from "@/server/jobs/calendar-sync";

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  const conn = db();
  try {
    const count = await queueCalendarBackfill(conn, apply);
    console.log(
      apply
        ? `calendar backfill: queued ${count} calendar job(s)`
        : `calendar backfill (dry run): ${count} booking(s) would be queued; run again with -- --apply to queue them`,
    );
    return 0;
  } finally {
    await conn.destroy();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error("calendar backfill failed", e);
    process.exit(1);
  },
);
