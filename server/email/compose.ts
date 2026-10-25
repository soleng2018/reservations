import "server-only";
import { readFileSync } from "node:fs";
import ical, {
  ICalAttendeeStatus,
  ICalCalendarMethod,
  ICalEventStatus,
} from "ical-generator";
import MailComposer from "nodemailer/lib/mail-composer";
import { createElement, type ReactElement } from "react";
import { plainTextSelectors, render } from "react-email";
import {
  inviteFields,
  messageId,
  SENDER_NAME,
  type BookingEmailDetails,
  type ClientLogin,
  type BookingEmailKind,
  type InviteFields,
} from "@/lib/booking-email";
import { WELCOME_SUBJECT, type WelcomeEmailDetails } from "@/lib/welcome-email";
import { CancellationEmail } from "./templates/cancellation-email";
import { DETAILS_ROW } from "./templates/details-card";
import { LOGO_CID } from "./templates/email-frame";
import { LabAccessEmail } from "./templates/lab-access-email";
import { WelcomeEmail } from "./templates/welcome-email";

// Spec 0013 AC-15, AC-17: one booking email as one MIME message, ready for
// Gmail's messages.send; spec 0014 adds the set password email. Pure but for
// reading the logo once.

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

type Rendered = { readonly html: string; readonly text: string };

// The HTML and plain text parts of one template.
async function renderParts(element: ReactElement): Promise<Rendered> {
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

// `logins` show under their clients; a cancellation shows none.
export async function renderBookingEmail(
  kind: BookingEmailKind,
  details: BookingEmailDetails,
  logins: readonly ClientLogin[] = [],
  nileLogin: string | null = null,
): Promise<Rendered> {
  return renderParts(
    kind === "cancelled"
      ? createElement(CancellationEmail, { details })
      : createElement(LabAccessEmail, { kind, details, logins, nileLogin }),
  );
}

// Spec 0014 AC-7. `email` is the learner's address as stored.
export async function renderWelcomeEmail(
  details: WelcomeEmailDetails,
  email: string,
  url: string,
): Promise<Rendered> {
  return renderParts(createElement(WelcomeEmail, { details, email, url }));
}

export type ComposeInput = {
  readonly emailId: string;
  readonly bookingId: string;
  readonly bookingVersion: number;
  // The email row's created_at: the invite's fixed DTSTAMP.
  readonly createdAt: Date;
  readonly kind: BookingEmailKind;
  readonly details: BookingEmailDetails;
  // Read at send time, never stored (spec 0007).
  readonly logins: readonly ClientLogin[];
  // Spec 0019 AC-6: read at send time too, so it is never stored.
  readonly nileLogin?: string | null;
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
  const { html, text } = await renderBookingEmail(
    input.kind,
    input.details,
    input.logins,
    input.nileLogin ?? null,
  );
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
      // AC-15 (amended 2026-10-16): the invite once, beside the alternatives,
      // never inside them, so the HTML stays every client's preferred part.
      // Not icalEvent, which adds a text/calendar alternative last (iOS Mail
      // then shows no body) plus a second application/ics copy.
      {
        filename: "invite.ics",
        content: renderInvite(invite),
        contentType: `text/calendar; charset=utf-8; method=${invite.method}`,
        contentDisposition: "attachment",
      },
    ],
  }).compile();
  // Gmail reads Bcc from the raw message and drops it on delivery.
  node.keepBcc = true;
  return { subject, raw: base64url(await node.build()) };
}

export type WelcomeComposeInput = {
  // The email row's id, shared with the Message-ID (spec 0014 AC-6).
  readonly emailId: string;
  readonly details: WelcomeEmailDetails;
  // The learner's address as stored, shown in the body.
  readonly email: string;
  readonly url: string;
  readonly senderEmail: string;
  readonly to: string;
  readonly subjectPrefix: string;
};

// Spec 0014 AC-5, AC-7: HTML and text in multipart/alternative (plus the
// inline logo), no attachment, and never a Bcc.
export async function composeWelcomeEmail(
  input: WelcomeComposeInput,
): Promise<{ readonly subject: string; readonly raw: string }> {
  const subject = `${input.subjectPrefix}${WELCOME_SUBJECT}`;
  const { html, text } = await renderWelcomeEmail(
    input.details,
    input.email,
    input.url,
  );
  const node = new MailComposer({
    from: { name: SENDER_NAME, address: input.senderEmail },
    to: input.to,
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
  }).compile();
  return { subject, raw: base64url(await node.build()) };
}
