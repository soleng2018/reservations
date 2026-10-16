import "server-only";
import { sql } from "kysely";
import { BookingEmailDetails, BookingEmailKind } from "@/lib/booking-email";
import { routeEmail } from "@/lib/email-routing";
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
const UNREADABLE = "The queued email can't be read.";
const GMAIL_RETRY = "Gmail didn't take the message yet. Retrying.";
const gmailRefused = (status: number) =>
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
  if (new Date(details.data.endsAt) <= (await dbNow(trx)))
    return suppress(STALE);

  // AC-16.
  const route = routeEmail(row.to_address, ctx.cfg);
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
