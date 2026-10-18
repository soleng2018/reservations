import "server-only";
import { sql, type Kysely } from "kysely";
import { isTestAddress } from "@/lib/email-routing";
import type { Result } from "@/lib/result";
import type { DB } from "@/server/db/types";
import {
  deleteEvent,
  insertEvent,
  putEvent,
  type CalendarEvent,
} from "@/server/google/calendar";
import type { GoogleCallError } from "@/server/google/http";
import { calendarJobKey, calendarPayload } from "./booking-notice";
import type { GoogleFailure, JobHandler, JobOutcome } from "./runner";

// Spec 0013 AC-19, AC-20: every booking mirrored onto the shared "HOL
// bookings" calendar. calendar_upsert and calendar_delete both sync the
// booking's current row, so a late or repeated job still leaves the right
// event. A failed calendar job never touches the email.

const UNREADABLE = "The calendar job can't be read.";
const CALENDAR_RETRY = "Google Calendar didn't take the change yet. Retrying.";
const calendarRefused = (status: number) =>
  `Google Calendar refused the change (${status}).`;

// A valid Google event id (base32hex), stable per booking, so a rerun
// targets the same event.
export const eventIdFor = (bookingId: string) => bookingId.replaceAll("-", "");

const DONE: JobOutcome = { kind: "done" };

const outcomeOf = (e: GoogleFailure): JobOutcome =>
  e === "breaker"
    ? { kind: "breaker" }
    : e === "retry"
      ? { kind: "retry", error: CALENDAR_RETRY }
      : { kind: "final", error: calendarRefused(e.status) };

export const syncBookingEvent: JobHandler = async (trx, job, ctx) => {
  const payload = calendarPayload.safeParse(job.payload);
  if (!payload.success) return { kind: "final", error: UNREADABLE };
  const { bookingId } = payload.data;
  const row = await trx
    .selectFrom("bookings as b")
    .innerJoin("users as u", "u.id", "b.user_id")
    .innerJoin("testbeds as t", "t.id", "b.testbed_id")
    .innerJoin("testbed_types as ty", "ty.id", "b.testbed_type_id")
    .select([
      "b.status",
      "b.starts_at",
      "b.ends_at",
      "u.name as learnerName",
      "u.email",
      "u.company",
      "t.name as testbedName",
      "ty.name as labTypeName",
    ])
    .where("b.id", "=", bookingId)
    .executeTakeFirst();
  if (!row || row.status === "provisioning") return DONE;

  const eventId = eventIdFor(bookingId);
  const call = (token: string) => ({
    fetch: ctx.fetch,
    token,
    calendarId: ctx.cfg.calendarId,
    eventId,
  });
  const stamp = (id: string | null) =>
    trx
      .updateTable("bookings")
      .set({ calendar_event_id: id })
      .where("id", "=", bookingId)
      .execute();

  if (row.status === "cancelled") {
    const gone = await ctx.google((token) => deleteEvent(call(token)));
    if (!gone.ok) return outcomeOf(gone.error);
    await stamp(null);
    return DONE;
  }

  const event: CalendarEvent = {
    summary: `${isTestAddress(row.email) ? "[dev] " : ""}${row.learnerName} · ${row.labTypeName} · ${row.testbedName}`,
    description: [
      `Learner: ${row.email}`,
      `Company: ${row.company ?? "none"}`,
      `Booking: ${bookingId}`,
    ].join("\n"),
    start: row.starts_at,
    end: row.ends_at,
  };
  // PUT, then POST on 404, then one more PUT if a concurrent run inserted.
  const upsert = async (
    token: string,
  ): Promise<Result<unknown, GoogleCallError>> => {
    const put = await putEvent(call(token), event);
    if (!put.ok || put.value === "updated") return put;
    const inserted = await insertEvent(call(token), event);
    if (!inserted.ok || inserted.value === "inserted") return inserted;
    return putEvent(call(token), event);
  };
  const synced = await ctx.google(upsert);
  if (!synced.ok) return outcomeOf(synced.error);
  await stamp(eventId);
  return DONE;
};

// AC-20: a calendar_upsert for every confirmed booking that has not ended,
// keyed like the booking change's own job, so a run twice queues nothing
// new. A dry run only counts.
export async function queueCalendarBackfill(
  conn: Kysely<DB>,
  apply: boolean,
): Promise<number> {
  const due = conn
    .selectFrom("bookings as b")
    .select(["b.id", "b.version"])
    .where("b.status", "=", "confirmed")
    .where("b.ends_at", ">", sql<Date>`now()`)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("jobs as j")
            .select("j.id")
            .whereRef(
              "j.idempotency_key",
              "=",
              sql<string>`'calendar:' || b.id || ':' || b.version`,
            ),
        ),
      ),
    );
  const rows = await due.execute();
  if (!apply || rows.length === 0) return rows.length;
  const inserted = await conn
    .insertInto("jobs")
    .values(
      rows.map((b) => ({
        kind: "calendar_upsert",
        payload: JSON.stringify({ bookingId: b.id }),
        idempotency_key: calendarJobKey(b.id, b.version),
      })),
    )
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .returning("id")
    .execute();
  return inserted.length;
}
