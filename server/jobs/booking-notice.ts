import "server-only";
import type { Kysely } from "kysely";
import { z } from "zod";
import {
  BookingEmailDetails,
  emailSubject,
  type BookingEmailKind,
} from "@/lib/booking-email";
import { TestbedClientKind } from "@/lib/db-enums";
import { isTimeZone } from "@/lib/timezones";
import type { DB } from "@/server/db/types";
import { appUrl } from "@/server/env";

// Spec 0013 AC-6, AC-11: a booking change's notices, queued inside the same
// transaction as the change, so they exist if and only if it commits. Google
// is never called here (AC-7); the worker sends later.

export const sendEmailPayload = z.object({ emailMessageId: z.uuid() });
export const calendarPayload = z.object({ bookingId: z.uuid() });

export const emailJobKey = (
  bookingId: string,
  kind: BookingEmailKind,
  version: number,
) => `email:${bookingId}:${kind}:${version}`;

export const calendarJobKey = (bookingId: string, version: number) =>
  `calendar:${bookingId}:${version}`;

// AC-6, AC-11 (amended 2026-10-16): what the /book screen showed, passed only
// by confirmGuestBooking. A returning learner who books as a guest keeps their
// stored zone, so the booked email follows the screen, not users.timezone.
export type ShownAtBooking = {
  readonly timezone: string;
  readonly newAccount: boolean;
};

const ZoneOnly = z.object({ timezone: z.string() });

// AC-11 (amended 2026-10-17): the zone a booking speaks, the one its booked
// email used, so every email for that booking agrees. A booking with no
// usable booked row (made before this feature, a bad zone) gets the
// fallback; never throws, so an email can't roll back the change (AC-7).
export async function bookingZone(
  trx: Kysely<DB>,
  bookingId: string,
  fallback: string,
): Promise<string> {
  const row = await trx
    .selectFrom("email_messages")
    .select("details")
    .where("booking_id", "=", bookingId)
    .where("kind", "=", "booked")
    .orderBy("booking_version")
    .limit(1)
    .executeTakeFirst();
  const parsed = ZoneOnly.safeParse(row?.details);
  return parsed.success && isTimeZone(parsed.data.timezone)
    ? parsed.data.timezone
    : fallback;
}

// AC-11: one explicit column read (never a client's OS login), from the
// booking row as the change left it. Links only for booked and rescheduled.
async function readDetails(
  trx: Kysely<DB>,
  bookingId: string,
  kind: BookingEmailKind,
  shown: ShownAtBooking | undefined,
): Promise<{
  readonly userId: string;
  readonly email: string;
  readonly details: BookingEmailDetails;
}> {
  const row = await trx
    .selectFrom("bookings as b")
    .innerJoin("users as u", "u.id", "b.user_id")
    .innerJoin("testbeds as t", "t.id", "b.testbed_id")
    .innerJoin("testbed_types as ty", "ty.id", "b.testbed_type_id")
    .select([
      "b.user_id",
      "b.testbed_id",
      "b.starts_at",
      "b.ends_at",
      "u.email",
      "u.name as learnerName",
      "u.timezone",
      "t.name as testbedName",
      "t.portal_url",
      "t.lms_url",
      "ty.name as labTypeName",
    ])
    .where("b.id", "=", bookingId)
    .executeTakeFirstOrThrow();
  const links =
    kind === "cancelled"
      ? null
      : {
          portalUrl: row.portal_url,
          lmsUrl: row.lms_url,
          clients: (
            await trx
              .selectFrom("testbed_clients")
              .select(["name", "kind", "url"])
              .where("testbed_id", "=", row.testbed_id)
              .orderBy("position")
              .execute()
          ).map((c) => ({
            name: c.name,
            kind: TestbedClientKind.parse(c.kind),
            url: c.url,
          })),
        };
  const timezone =
    kind === "booked"
      ? (shown?.timezone ?? row.timezone)
      : await bookingZone(trx, bookingId, row.timezone);
  return {
    userId: row.user_id,
    email: row.email,
    details: BookingEmailDetails.parse({
      learnerName: row.learnerName,
      timezone,
      newAccount: shown?.newAccount ?? false,
      labTypeName: row.labTypeName,
      testbedName: row.testbedName,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      appUrl: appUrl(),
      links,
    }),
  };
}

// AC-6. The email id is made here so the job can name it. A repeat of the
// same (booking, kind, version) finds its job key taken and queues nothing.
export async function queueBookingNotice(
  trx: Kysely<DB>,
  bookingId: string,
  version: number,
  kind: BookingEmailKind,
  shown?: ShownAtBooking,
): Promise<void> {
  const emailMessageId = crypto.randomUUID();
  const job = await trx
    .insertInto("jobs")
    .values({
      kind: "send_email",
      payload: JSON.stringify({ emailMessageId } satisfies z.infer<
        typeof sendEmailPayload
      >),
      idempotency_key: emailJobKey(bookingId, kind, version),
    })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!job) return;

  const { userId, email, details } = await readDetails(
    trx,
    bookingId,
    kind,
    shown,
  );
  await trx
    .insertInto("email_messages")
    .values({
      id: emailMessageId,
      user_id: userId,
      booking_id: bookingId,
      booking_version: version,
      job_id: job.id,
      kind,
      to_address: email,
      subject: emailSubject(kind, details),
      details: JSON.stringify(details),
    })
    .execute();

  await trx
    .insertInto("jobs")
    .values({
      kind: kind === "cancelled" ? "calendar_delete" : "calendar_upsert",
      payload: JSON.stringify({ bookingId } satisfies z.infer<
        typeof calendarPayload
      >),
      idempotency_key: calendarJobKey(bookingId, version),
    })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .execute();
}
