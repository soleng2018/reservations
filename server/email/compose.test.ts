import { describe, expect, it } from "vitest";
import type { BookingEmailDetails } from "@/lib/booking-email";
import {
  composeBookingEmail,
  renderBookingEmail,
  renderInvite,
} from "./compose";
import { inviteFields } from "@/lib/booking-email";
import { SAMPLE_BOOKING_DETAILS } from "./sample";
import { allParts, mimeShape, parseMime } from "./testing";

// covers: spec 0013 AC-12 to AC-15, AC-17, AC-23 (the render snapshots)
const KOLKATA: BookingEmailDetails = {
  ...SAMPLE_BOOKING_DETAILS,
  learnerName: "Arjun",
  timezone: "Asia/Kolkata",
};
// AC-14 (amended 2026-10-17): Intl would print GMT+0 here.
const UTC_LEARNER: BookingEmailDetails = {
  ...SAMPLE_BOOKING_DETAILS,
  learnerName: "Sam",
  timezone: "UTC",
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
  // AC-12: no password box for an account the booking didn't create.
  [
    "booked",
    "New York, existing account",
    { ...SAMPLE_BOOKING_DETAILS, newAccount: false },
  ],
  ["booked", "UTC", UTC_LEARNER],
  ["cancelled", "UTC", cancelled(UTC_LEARNER)],
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

  it.each(["booked", "cancelled"] as const)(
    "names the UTC zone UTC in the %s card and plain text (AC-14)",
    async (kind) => {
      const details =
        kind === "cancelled" ? cancelled(UTC_LEARNER) : UTC_LEARNER;
      const { html, text } = await renderBookingEmail(kind, details);
      for (const body of [html, text]) {
        expect(body).toContain("1:00 PM UTC");
        expect(body).not.toContain("GMT+0");
      }
    },
  );
});

// covers: spec 0013 AC-15, AC-17
describe("composeBookingEmail (spec 0013 AC-15)", () => {
  const compose = (
    over: {
      bcc?: string | null;
      subjectPrefix?: string;
      kind?: "booked" | "rescheduled" | "cancelled";
    } = {},
  ) =>
    composeBookingEmail({
      emailId: "11111111-1111-4111-8111-111111111111",
      bookingId: BOOKING_ID,
      bookingVersion: 2,
      createdAt: CREATED,
      kind: over.kind ?? "rescheduled",
      details:
        over.kind === "cancelled"
          ? cancelled(SAMPLE_BOOKING_DETAILS)
          : SAMPLE_BOOKING_DETAILS,
      subject: "Updated: Your Nile Hands-On Lab access - x",
      senderEmail: "labs@nile.example",
      to: "priya@acme.com",
      bcc: over.bcc === undefined ? "ops@nile.example" : over.bcc,
      subjectPrefix: over.subjectPrefix ?? "",
    }).then(({ subject, raw }) => ({
      subject,
      mime: Buffer.from(raw, "base64url").toString("utf8"),
    }));

  it("builds one message with the sender, recipients, and Message-ID", async () => {
    const { subject, mime } = await compose();
    expect(subject).toBe("Updated: Your Nile Hands-On Lab access - x");
    expect(mime).toContain('From: "Nile Hands-On Labs" <labs@nile.example>');
    expect(mime).toContain("To: priya@acme.com");
    expect(mime).toContain("Bcc: ops@nile.example");
    expect(mime).toContain(
      "Message-ID: <11111111-1111-4111-8111-111111111111@nile-hol-reservations>",
    );
    expect(mime).not.toMatch(/^Reply-To:/m);
  });

  // AC-15 (amended 2026-10-16): with the calendar part last inside
  // multipart/alternative, iOS Mail showed no body. This pins the whole tree.
  it.each([
    ["booked", "REQUEST"],
    ["rescheduled", "REQUEST"],
    ["cancelled", "CANCEL"],
  ] as const)(
    "puts the %s invite once, beside the alternatives",
    async (kind, method) => {
      const root = parseMime((await compose({ kind })).mime);
      expect(mimeShape(root)).toEqual([
        "multipart/mixed",
        [
          [
            "multipart/alternative",
            ["text/plain", ["multipart/related", ["text/html", "image/png"]]],
          ],
          "text/calendar",
        ],
      ]);

      const [alternative, invite] = root.children;
      const logo = alternative?.children[1]?.children[1];
      expect(logo?.contentId).toBe("<nile-logo>");
      expect(logo?.disposition).toMatch(/^inline/);

      expect(invite?.params).toMatchObject({
        charset: "utf-8",
        method,
        name: "invite.ics",
      });
      expect(invite?.disposition).toBe("attachment; filename=invite.ics");
      expect(
        allParts(root).filter((p) => p.type === "text/calendar"),
      ).toHaveLength(1);
      expect(allParts(root).map((p) => p.type)).not.toContain(
        "application/ics",
      );

      expect(invite?.body).toMatch(new RegExp(`^METHOD:${method}\\r?$`, "m"));
      expect(invite?.body).toMatch(/^SEQUENCE:2\r?$/m);
      expect(invite?.body).toContain(`UID:${BOOKING_ID}@nile-hol-reservations`);
      expect(invite?.body).toContain("DTSTAMP:20261012T100000Z");
    },
  );

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
