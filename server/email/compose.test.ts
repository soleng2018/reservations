import { describe, expect, it } from "vitest";
import type { BookingEmailDetails } from "@/lib/booking-email";
import {
  composeBookingEmail,
  renderBookingEmail,
  renderInvite,
} from "./compose";
import { inviteFields } from "@/lib/booking-email";
import { SAMPLE_BOOKING_DETAILS } from "./sample";

// covers: spec 0013 AC-12 to AC-15, AC-17, AC-23 (the render snapshots)
const KOLKATA: BookingEmailDetails = {
  ...SAMPLE_BOOKING_DETAILS,
  learnerName: "Arjun",
  timezone: "Asia/Kolkata",
};
const cancelled = (d: BookingEmailDetails): BookingEmailDetails => ({
  ...d,
  links: null,
});

const BOOKING_ID = "22222222-2222-4222-8222-222222222222";
const CREATED = new Date("2026-10-12T10:00:00.000Z");

const cases = [
  ["booked", "New York", SAMPLE_BOOKING_DETAILS],
  ["rescheduled", "New York", SAMPLE_BOOKING_DETAILS],
  ["cancelled", "New York", cancelled(SAMPLE_BOOKING_DETAILS)],
  ["booked", "Kolkata", KOLKATA],
  ["rescheduled", "Kolkata", KOLKATA],
  ["cancelled", "Kolkata", cancelled(KOLKATA)],
] as const;

describe("booking email render (spec 0013 AC-23)", () => {
  it.each(cases)("renders %s for %s", async (kind, _zone, details) => {
    const { html, text } = await renderBookingEmail(kind, details);
    expect(html).toMatchSnapshot("html");
    expect(text).toMatchSnapshot("text");
    const ics = renderInvite(
      inviteFields({
        kind,
        details,
        bookingId: BOOKING_ID,
        bookingVersion: kind === "booked" ? 1 : kind === "rescheduled" ? 2 : 3,
        createdAt: CREATED,
        senderEmail: "labs@nile.example",
        recipient: "priya@acme.com",
      }),
    );
    expect(ics).toMatchSnapshot("ics");
  });
});

// covers: spec 0013 AC-15, AC-17
describe("composeBookingEmail (spec 0013 AC-15)", () => {
  const compose = (
    over: { bcc?: string | null; subjectPrefix?: string } = {},
  ) =>
    composeBookingEmail({
      emailId: "11111111-1111-4111-8111-111111111111",
      bookingId: BOOKING_ID,
      bookingVersion: 2,
      createdAt: CREATED,
      kind: "rescheduled",
      details: SAMPLE_BOOKING_DETAILS,
      subject: "Updated: Your Nile Hands-On Lab access - x",
      senderEmail: "labs@nile.example",
      to: "priya@acme.com",
      bcc: over.bcc === undefined ? "ops@nile.example" : over.bcc,
      subjectPrefix: over.subjectPrefix ?? "",
    }).then(({ subject, raw }) => ({
      subject,
      mime: Buffer.from(raw, "base64url").toString("utf8"),
    }));

  it("builds one message with HTML, text, the inline logo, and the invite twice", async () => {
    const { subject, mime } = await compose();
    expect(subject).toBe("Updated: Your Nile Hands-On Lab access - x");
    expect(mime).toContain('From: "Nile Hands-On Labs" <labs@nile.example>');
    expect(mime).toContain("To: priya@acme.com");
    expect(mime).toContain("Bcc: ops@nile.example");
    expect(mime).toContain(
      "Message-ID: <11111111-1111-4111-8111-111111111111@nile-hol-reservations>",
    );
    expect(mime).toMatch(/Content-Type: multipart\/alternative/);
    expect(mime).toMatch(/Content-Type: text\/plain/);
    expect(mime).toMatch(/Content-Type: text\/html/);
    expect(mime).toContain("Content-ID: <nile-logo>");
    expect(mime).toMatch(
      /Content-Type: text\/calendar; charset=utf-8; method=REQUEST/,
    );
    expect(mime).toMatch(/Content-Type: application\/ics; name=invite\.ics/);
    expect(mime).toContain("SEQUENCE:2");
    expect(mime).toContain(`UID:${BOOKING_ID}@nile-hol-reservations`);
    expect(mime).toContain("DTSTAMP:20261012T100000Z");
    expect(mime).not.toMatch(/^Reply-To:/m);
  });

  it("adds the [dev] prefix and leaves out an empty Bcc", async () => {
    const { subject, mime } = await compose({
      bcc: null,
      subjectPrefix: "[dev] ",
    });
    expect(subject).toBe("[dev] Updated: Your Nile Hands-On Lab access - x");
    expect(mime).not.toMatch(/^Bcc:/m);
  });

  it("cancels with METHOD:CANCEL and STATUS:CANCELLED", () => {
    const ics = renderInvite(
      inviteFields({
        kind: "cancelled",
        details: cancelled(SAMPLE_BOOKING_DETAILS),
        bookingId: BOOKING_ID,
        bookingVersion: 3,
        createdAt: CREATED,
        senderEmail: "labs@nile.example",
        recipient: "priya@acme.com",
      }),
    );
    expect(ics).toMatch(/^METHOD:CANCEL$/m);
    expect(ics).toMatch(/^STATUS:CANCELLED$/m);
    expect(ics).toMatch(/^SEQUENCE:3$/m);
    expect(ics).toMatch(/PARTSTAT=NEEDS-ACTION/);
    expect(ics).toMatch(/RSVP=FALSE/);
  });
});
