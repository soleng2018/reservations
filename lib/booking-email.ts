import { z } from "zod";
import { TestbedClientKind } from "./db-enums";
import { formatEmailDateTime } from "./format-time";
import { err, ok, type Result } from "./result";

// Spec 0013: the booking email's pure parts. Safe on both sides.

// AC-3. The JSON key Google Cloud downloads for a service account. Only these
// fields are read; the rest (project_id, token_uri, and so on) are dropped.
export const GoogleServiceAccountKey = z.object({
  type: z.literal("service_account"),
  client_id: z.string().regex(/^\d+$/),
  client_email: z.email().endsWith(".iam.gserviceaccount.com"),
  private_key: z.string().startsWith("-----BEGIN PRIVATE KEY-----"),
  private_key_id: z.string().min(1),
});
export type GoogleServiceAccountKey = z.infer<typeof GoogleServiceAccountKey>;

// AC-3. One answer for every failure, invalid JSON included, and the input
// never reaches an error: the file holds a private key.
export function parseGoogleKeyFile(
  text: string,
): Result<GoogleServiceAccountKey, "invalid"> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return err("invalid");
  }
  const parsed = GoogleServiceAccountKey.safeParse(json);
  return parsed.success ? ok(parsed.data) : err("invalid");
}

// The three booking notices (AC-6), plus the reminder before start (spec
// 0015 AC-5), which the worker queues, never a booking change.
export const BookingEmailKind = z.enum([
  "booked",
  "rescheduled",
  "cancelled",
  "reminder",
]);
export type BookingEmailKind = z.infer<typeof BookingEmailKind>;
export type BookingNoticeKind = Exclude<BookingEmailKind, "reminder">;

// Every link in an email must be https (the admin forms already enforce it
// with HttpsUrl); this guards the snapshot itself.
const HttpsLink = z.url({ protocol: /^https$/ });

// AC-11: the spec 0012 LabLinks shape.
const EmailLabLinks = z.object({
  portalUrl: HttpsLink,
  lmsUrl: HttpsLink,
  clients: z.array(
    z.object({ name: z.string(), kind: TestbedClientKind, url: HttpsLink }),
  ),
});

// AC-11: what an email shows, captured when it was queued, so each email
// describes its own booking version. Times are ISO strings in the jsonb.
// `links` is null for a cancellation. `newAccount` (amended 2026-10-16) is
// true only on a booked email whose booking created the account; rows queued
// before it existed parse as false.
export const BookingEmailDetails = z.object({
  learnerName: z.string(),
  timezone: z.string(),
  newAccount: z.boolean().default(false),
  labTypeName: z.string(),
  testbedName: z.string(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  appUrl: z.url(),
  links: EmailLabLinks.nullable(),
});
export type BookingEmailDetails = z.infer<typeof BookingEmailDetails>;

const when = (iso: string, details: BookingEmailDetails) =>
  formatEmailDateTime(new Date(iso), details.timezone);

export const emailStart = (details: BookingEmailDetails) =>
  when(details.startsAt, details);
export const emailEnd = (details: BookingEmailDetails) =>
  when(details.endsAt, details);

// AC-12, AC-13. As stored, before any "[dev] " routing prefix.
export function emailSubject(
  kind: BookingEmailKind,
  details: BookingEmailDetails,
): string {
  const start = emailStart(details);
  switch (kind) {
    case "booked":
      return `Your Nile Hands-On Lab access - ${start}`;
    case "rescheduled":
      return `Updated: Your Nile Hands-On Lab access - ${start}`;
    case "cancelled":
      return `Cancelled: Your Nile Hands-On Lab reservation - ${start}`;
    // Spec 0015 AC-6.
    case "reminder":
      return `Reminder: Your Nile Hands-On Lab starts ${start}`;
    default: {
      const never: never = kind;
      return never;
    }
  }
}

// AC-12, AC-13: the manage and reserve links, on the app the learner used.
export const manageUrl = (details: BookingEmailDetails) =>
  `${details.appUrl}/reservations`;
export const reserveUrl = (details: BookingEmailDetails) =>
  `${details.appUrl}/book`;

// AC-17: the invite's UID never depends on which process sent it.
export const inviteUid = (bookingId: string) =>
  `${bookingId}@nile-hol-reservations`;

// AC-15: so a rare duplicate send is visible in Sent.
export const messageId = (emailId: string) =>
  `<${emailId}@nile-hol-reservations>`;

export const SENDER_NAME = "Nile Hands-On Labs";

// AC-17: the invite's fields, pure. server/email/compose.ts renders them
// with ical-generator.
export type InviteFields = {
  readonly method: "REQUEST" | "CANCEL";
  readonly cancelled: boolean;
  readonly uid: string;
  readonly sequence: number;
  readonly stamp: Date;
  readonly start: Date;
  readonly end: Date;
  readonly summary: string;
  readonly description: string;
  readonly organizer: { readonly name: string; readonly email: string };
  readonly attendee: string;
};

export function inviteFields(input: {
  readonly kind: BookingEmailKind;
  readonly details: BookingEmailDetails;
  readonly bookingId: string;
  readonly bookingVersion: number;
  readonly createdAt: Date;
  readonly senderEmail: string;
  readonly recipient: string;
}): InviteFields {
  const { kind, details } = input;
  const cancelled = kind === "cancelled";
  return {
    method: cancelled ? "CANCEL" : "REQUEST",
    cancelled,
    uid: inviteUid(input.bookingId),
    sequence: input.bookingVersion,
    stamp: input.createdAt,
    start: new Date(details.startsAt),
    end: new Date(details.endsAt),
    summary: `Nile Hands-On Lab: ${details.labTypeName}`,
    description: [
      cancelled
        ? "Your Nile Hands-On Lab reservation was cancelled."
        : "Your Nile Hands-On Lab reservation.",
      `Lab type: ${details.labTypeName}`,
      `Testbed: ${details.testbedName}`,
      `Starts: ${emailStart(details)}`,
      `Ends: ${emailEnd(details)}`,
      cancelled
        ? `Reserve a new lab: ${reserveUrl(details)}`
        : `Manage your reservation: ${manageUrl(details)}`,
    ].join("\n"),
    organizer: { name: SENDER_NAME, email: input.senderEmail },
    attendee: input.recipient,
  };
}
