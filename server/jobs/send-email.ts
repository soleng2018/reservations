import "server-only";
import { sql } from "kysely";
import { BookingEmailDetails, BookingEmailKind } from "@/lib/booking-email";
import { routeEmail } from "@/lib/email-routing";
import { LEAD_MS } from "@/lib/slots";
import { dbNow } from "@/server/db/bookings";
import { composeBookingEmail } from "@/server/email/compose";
import { sendRaw } from "@/server/google/gmail";
import { sendEmailPayload } from "./booking-notice";
import type { JobHandler, JobOutcome } from "./runner";

// Spec 0013 AC-15 to AC-18: the send_email handler. It runs in the job's
// transaction and locks its email row first, so running it twice never
// sends twice: a row that is gone or no longer queued finishes the job.
// Kept apart from booking-notice.ts so the web process (which queues) never
// loads the renderer.

export const STALE = "The booking had already ended.";
export const UNREADABLE = "The queued email can't be read.";
// Spec 0015 AC-8.
export const REMINDER_CHANGED =
  "The booking changed before the reminder went out.";
export const REMINDER_TOO_CLOSE = "Too close to the start to send a reminder.";
export const GMAIL_RETRY = "Gmail didn't take the message yet. Retrying.";
export const gmailRefused = (status: number) =>
  `Gmail refused the message (${status}).`;

const DONE: JobOutcome = { kind: "done" };

export const runSendEmail: JobHandler = async (trx, job, ctx) => {
  const payload = sendEmailPayload.safeParse(job.payload);
  if (!payload.success) return { kind: "final", error: UNREADABLE };
  const row = await trx
    .selectFrom("email_messages")
    .select([
      "id",
      "kind",
      "status",
      "booking_id",
      "booking_version",
      "to_address",
      "subject",
      "details",
      "created_at",
    ])
    .where("id", "=", payload.data.emailMessageId)
    .forUpdate()
    .executeTakeFirst();
  if (!row || row.status !== "queued") return DONE;

  const kind = BookingEmailKind.safeParse(row.kind);
  const details = BookingEmailDetails.safeParse(row.details);
  if (
    !kind.success ||
    !details.success ||
    row.booking_id === null ||
    row.booking_version === null
  )
    return { kind: "final", error: UNREADABLE };

  const suppress = async (reason: string) => {
    await trx
      .updateTable("email_messages")
      .set({ status: "suppressed", last_error: reason })
      .where("id", "=", row.id)
      .execute();
    return DONE;
  };

  // AC-18: by the DB clock.
  const now = await dbNow(trx);
  if (new Date(details.data.endsAt) <= now) return suppress(STALE);

  // Spec 0015 AC-8: a reminder goes out only for the same confirmed version,
  // and never in the last hour. The booking is read without a lock (holding
  // one across the Gmail call would block a cancel); a change that commits
  // after this read is covered by its own email.
  if (kind.data === "reminder") {
    const booking = await trx
      .selectFrom("bookings")
      .select(["status", "version"])
      .where("id", "=", row.booking_id)
      .executeTakeFirst();
    if (
      !booking ||
      booking.status !== "confirmed" ||
      booking.version !== row.booking_version
    )
      return suppress(REMINDER_CHANGED);
    if (new Date(details.data.startsAt).getTime() < now.getTime() + LEAD_MS)
      return suppress(REMINDER_TOO_CLOSE);
  }

  // AC-16, AC-36; spec 0015 AC-9: a reminder never has a Bcc.
  const route = routeEmail(
    row.to_address,
    kind.data === "reminder" ? { ...ctx.cfg, opsBcc: null } : ctx.cfg,
  );
  if (route.kind === "suppress") return suppress(route.reason);

  const { raw } = await composeBookingEmail({
    emailId: row.id,
    bookingId: row.booking_id,
    bookingVersion: row.booking_version,
    createdAt: row.created_at,
    kind: kind.data,
    details: details.data,
    subject: row.subject,
    senderEmail: ctx.cfg.senderEmail,
    to: route.to,
    bcc: route.bcc,
    subjectPrefix: route.subjectPrefix,
  });
  const sent = await ctx.google((token) => sendRaw(ctx.fetch, token, raw));
  if (sent.ok) {
    await trx
      .updateTable("email_messages")
      .set({
        status: "sent",
        provider_message_id: sent.value.id,
        sent_to: route.to,
        sent_at: sql<Date>`now()`,
        last_error: null,
      })
      .where("id", "=", row.id)
      .execute();
    return DONE;
  }
  const e = sent.error;
  if (e === "breaker") return { kind: "breaker" };
  if (e === "retry") return { kind: "retry", error: GMAIL_RETRY };
  return { kind: "final", error: gmailRefused(e.status) };
};
