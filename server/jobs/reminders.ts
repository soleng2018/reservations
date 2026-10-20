import "server-only";
import {
  sql,
  type Expression,
  type ExpressionBuilder,
  type Kysely,
  type RawBuilder,
} from "kysely";
import { z } from "zod";
import { LEAD_MS, REMINDER_LEAD_MS } from "@/lib/slots";
import type { DB } from "@/server/db/types";
import { queueReminder } from "./booking-notice";

// Spec 0015 AC-2 to AC-4: the worker's "reminders" step. Each tick it finds
// the confirmed bookings that just crossed their 24 hour mark and queues one
// reminder per booking version, so a cancelled booking is never picked and a
// rescheduled one is judged again by its new time.

export const REMINDER_BUDGET_MS = 20_000;

// AC-2: elapsed time, so a daylight saving change never shifts it.
const interval = (ms: number) =>
  sql<string>`make_interval(secs => ${sql.lit(ms)} / 1000.0)`;

const DB_NOW = sql<Date>`now()`;

// AC-3: the notice row of the booking's current version, the booked or
// rescheduled email that version queued (earliest if both somehow exist).
type BookingScope = ExpressionBuilder<DB & { b: DB["bookings"] }, "b">;
const noticeOf = (eb: BookingScope) =>
  eb
    .selectFrom("email_messages as n")
    .whereRef("n.booking_id", "=", "b.id")
    .whereRef("n.booking_version", "=", "b.version")
    .where("n.kind", "in", ["booked", "rescheduled"])
    .orderBy("n.created_at")
    .limit(1);

// AC-2: the due rules, all by `now` (the DB clock; tests pass a fixed
// moment read from it). A version with no notice row compares to null and
// is never due.
function dueBookings(db: Kysely<DB>, now: Expression<Date>) {
  return db
    .selectFrom("bookings as b")
    .select((eb) => [
      "b.id",
      "b.version",
      noticeOf(eb).select("n.details").as("noticeDetails"),
    ])
    .where("b.status", "=", "confirmed")
    .where(
      "b.starts_at",
      "<=",
      sql<Date>`${now} + ${interval(REMINDER_LEAD_MS)}`,
    )
    .where("b.starts_at", ">=", sql<Date>`${now} + ${interval(LEAD_MS)}`)
    .where((eb) =>
      eb(
        noticeOf(eb).select("n.created_at"),
        "<=",
        sql<Date>`b.starts_at - ${interval(REMINDER_LEAD_MS)}`,
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("email_messages as r")
            .select("r.id")
            .whereRef("r.booking_id", "=", "b.id")
            .whereRef("r.booking_version", "=", "b.version")
            .where("r.kind", "=", "reminder"),
        ),
      ),
    );
}

// AC-5: every notice row the app writes carries the app the learner used.
const NoticeApp = z.object({ appUrl: z.url() });

export type RemindersDeps = {
  // The process clock, for the step's own time budget only.
  readonly clock?: () => number;
  // Tests only: a fixed moment in place of now(), read from the DB clock.
  readonly now?: Date;
};

// AC-4: one booking in its own transaction. Lock it FOR SHARE, then check
// the due rules again with a fresh read; a miss queues nothing. The user is
// read without a lock, so this can wait behind a cancel or reschedule but
// never holds a lock they take first.
async function queueOne(
  conn: Kysely<DB>,
  bookingId: string,
  now: Expression<Date>,
): Promise<boolean> {
  return conn.transaction().execute(async (trx) => {
    await trx
      .selectFrom("bookings")
      .select("id")
      .where("id", "=", bookingId)
      .forShare()
      .execute();
    const due = await dueBookings(trx, now)
      .where("b.id", "=", bookingId)
      .executeTakeFirst();
    if (!due) return false;
    // A notice with no usable appUrl is hand edited data: throw, so this
    // booking is logged and tried again next tick.
    const notice = NoticeApp.parse(due.noticeDetails);
    return queueReminder(trx, due.id, due.version, notice);
  });
}

// AC-2, AC-4: read the due bookings once, oldest start first, then queue
// them one by one while the budget lasts (checked before each). A failing
// booking is logged and never stops the others; what is left waits for the
// next tick.
export async function queueReminders(
  conn: Kysely<DB>,
  deps: RemindersDeps = {},
): Promise<{ readonly queued: number }> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const now: RawBuilder<Date> =
    deps.now === undefined ? DB_NOW : sql<Date>`${deps.now}::timestamptz`;
  const due = await dueBookings(conn, now)
    .orderBy("b.starts_at")
    .orderBy("b.id")
    .execute();
  let queued = 0;
  for (const { id } of due) {
    if (clock() - started >= REMINDER_BUDGET_MS) break;
    try {
      if (await queueOne(conn, id, now)) queued += 1;
    } catch (e) {
      console.error(
        `reminders: ${id} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return { queued };
}
