import "server-only";
import { readFileSync } from "node:fs";
import ical, {
  ICalAttendeeStatus,
  ICalCalendarMethod,
  ICalEventStatus,
} from "ical-generator";
import MailComposer from "nodemailer/lib/mail-composer";
import { createElement } from "react";
import { plainTextSelectors, render } from "react-email";
import {
  inviteFields,
  messageId,
  SENDER_NAME,
  type BookingEmailDetails,
  type BookingEmailKind,
  type InviteFields,
} from "@/lib/booking-email";
import { CancellationEmail } from "./templates/cancellation-email";
import { DETAILS_ROW } from "./templates/details-card";
import { LOGO_CID } from "./templates/email-frame";
import { LabAccessEmail } from "./templates/lab-access-email";

// Spec 0013 AC-15, AC-17: one booking email as one MIME message, ready for
// Gmail's messages.send. Pure but for reading the logo once.

// The committed 60 px copy of public/brand/nile-logo.png (AC-15), read once.
let logo: Buffer | undefined;
const nileLogo = () =>
  (logo ??= readFileSync(
    new URL("./assets/nile-logo-email.png", import.meta.url),
  ));

// AC-17, with ical-generator.
export function renderInvite(f: InviteFields): string {
  const calendar = ical({
    prodId: { company: "Nile", product: "Hands-On Labs", language: "EN" },
    method:
      f.method === "CANCEL"
        ? ICalCalendarMethod.CANCEL
        : ICalCalendarMethod.REQUEST,
  });
  calendar.createEvent({
    id: f.uid,
    sequence: f.sequence,
    stamp: f.stamp,
    start: f.start,
    end: f.end,
    summary: f.summary,
    description: f.description,
    organizer: { name: f.organizer.name, email: f.organizer.email },
    attendees: [
      {
        email: f.attendee,
        status: ICalAttendeeStatus.NEEDSACTION,
        rsvp: false,
      },
    ],
    ...(f.cancelled ? { status: ICalEventStatus.CANCELLED } : {}),
  });
  return calendar.toString();
}

export async function renderBookingEmail(
  kind: BookingEmailKind,
  details: BookingEmailDetails,
): Promise<{ readonly html: string; readonly text: string }> {
  const element =
    kind === "cancelled"
      ? createElement(CancellationEmail, { details })
      : createElement(LabAccessEmail, { kind, details });
  const [html, text] = await Promise.all([
    render(element),
    render(element, {
      plainText: true,
      htmlToTextOptions: {
        selectors: [
          ...plainTextSelectors,
          {
            selector: `table.${DETAILS_ROW}`,
            format: "dataTable",
            options: { colSpacing: 2 },
          },
        ],
      },
    }),
  ]);
  return { html, text };
}

export type ComposeInput = {
  readonly emailId: string;
  readonly bookingId: string;
  readonly bookingVersion: number;
  // The email row's created_at: the invite's fixed DTSTAMP.
  readonly createdAt: Date;
  readonly kind: BookingEmailKind;
  readonly details: BookingEmailDetails;
  // As stored; the route's prefix is added here.
  readonly subject: string;
  readonly senderEmail: string;
  readonly to: string;
  readonly bcc: string | null;
  readonly subjectPrefix: string;
};

const base64url = (b: Buffer) => b.toString("base64url");

export async function composeBookingEmail(
  input: ComposeInput,
): Promise<{ readonly subject: string; readonly raw: string }> {
  const subject = `${input.subjectPrefix}${input.subject}`;
  const { html, text } = await renderBookingEmail(input.kind, input.details);
  const invite = inviteFields({
    kind: input.kind,
    details: input.details,
    bookingId: input.bookingId,
    bookingVersion: input.bookingVersion,
    createdAt: input.createdAt,
    senderEmail: input.senderEmail,
    recipient: input.to,
  });
  const node = new MailComposer({
    from: { name: SENDER_NAME, address: input.senderEmail },
    to: input.to,
    ...(input.bcc ? { bcc: input.bcc } : {}),
    subject,
    messageId: messageId(input.emailId),
    text,
    html,
    attachments: [
      {
        filename: "nile-logo.png",
        content: nileLogo(),
        contentType: "image/png",
        cid: LOGO_CID,
      },
    ],
    // Both the text/calendar alternative and the invite.ics attachment.
    icalEvent: {
      method: invite.method,
      filename: "invite.ics",
      content: renderInvite(invite),
    },
  }).compile();
  // Gmail reads Bcc from the raw message and drops it on delivery.
  node.keepBcc = true;
  return { subject, raw: base64url(await node.build()) };
}
