import { describe, expect, it } from "vitest";
import type { BookingEmailDetails } from "@/lib/booking-email";
import {
  composeBookingEmail,
  composeWelcomeEmail,
  renderBookingEmail,
  renderInvite,
  renderWelcomeEmail,
} from "./compose";
import { inviteFields } from "@/lib/booking-email";
import {
  SAMPLE_BOOKING_DETAILS,
  SAMPLE_CLIENT_LOGINS,
  SAMPLE_REMINDER_DETAILS,
  SAMPLE_WELCOME,
} from "./sample";
import { allParts, mimeShape, parseMime } from "./testing";

// covers: spec 0013 AC-12 to AC-15, AC-17, AC-23 (the render snapshots);
// spec 0015 AC-7, AC-14 (the reminder's)
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
  ["reminder", "New York", SAMPLE_REMINDER_DETAILS],
  ["reminder", "Kolkata", { ...KOLKATA, newAccount: false }],
] as const;

// The version each kind's sample invite carries (a reminder repeats the
// booked version's invite, spec 0015 AC-7).
const VERSION = { booked: 1, rescheduled: 2, cancelled: 3, reminder: 1 };

describe("booking email render (spec 0013 AC-23)", () => {
  it("greets a reminder by first name and says when it starts (spec 0015 AC-7)", async () => {
    const { html, text } = await renderBookingEmail("reminder", {
      ...SAMPLE_REMINDER_DETAILS,
      learnerName: "Priya Raman",
    });
    const intro =
      "Hi Priya, this is a reminder that your reservation starts Tue, Oct 13, 2026, 9:00 AM ET.";
    expect(text).toContain(intro);
    expect(html).toContain("Your lab starts soon");
    expect(html).toContain(
      "Your lab starts soon. Access links and session details inside.",
    );
    expect(html).not.toContain("Set your password");
  });

  it.each(cases)("renders %s for %s", async (kind, _zone, details) => {
    const { html, text } = await renderBookingEmail(
      kind,
      details,
      SAMPLE_CLIENT_LOGINS,
    );
    expect(html).toMatchSnapshot("html");
    expect(text).toMatchSnapshot("text");
    const ics = renderInvite(
      inviteFields({
        kind,
        details,
        bookingId: BOOKING_ID,
        bookingVersion: VERSION[kind],
        createdAt: CREATED,
        senderEmail: "labs@nile.example",
        recipient: "priya@acme.com",
      }),
    );
    expect(ics).toMatchSnapshot("ics");
  });

  // covers: spec 0007 (client OS logins in the booking email)
  it("shows each client's OS login under its link, and only its own", async () => {
    const { html, text } = await renderBookingEmail(
      "booked",
      SAMPLE_BOOKING_DETAILS,
      [
        ...SAMPLE_CLIENT_LOGINS,
        // A client edited after the email was queued matches nothing.
        {
          name: "Wired client",
          url: "https://example.nile/client/moved",
          username: "stale-user",
          password: "stale-pass",
        },
      ],
    );
    expect(text).toContain("Username: labuser");
    expect(text).toContain("Password: Sample-Pass-1");
    expect(text).toContain("Username: wired-user");
    expect(html).toContain("Sample-Pass-1");
    for (const body of [html, text]) {
      expect(body).not.toContain("stale-user");
      expect(body).not.toContain("stale-pass");
    }
    // The wired client has no password line.
    expect(text.match(/Password:/g)).toHaveLength(1);
  });

  it("shows no logins on a cancellation", async () => {
    const { html, text } = await renderBookingEmail(
      "cancelled",
      cancelled(SAMPLE_BOOKING_DETAILS),
      SAMPLE_CLIENT_LOGINS,
    );
    for (const body of [html, text]) {
      expect(body).not.toContain("labuser");
      expect(body).not.toContain("Sample-Pass-1");
    }
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
      logins: SAMPLE_CLIENT_LOGINS,
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

// covers: spec 0014 AC-5, AC-7, AC-17 (the set password email)
describe("welcome email (spec 0014 AC-7)", () => {
  const UTC_WELCOME = {
    ...SAMPLE_WELCOME,
    details: { ...SAMPLE_WELCOME.details, name: "Sam", timeZone: "UTC" },
  };

  it.each([
    ["New York", SAMPLE_WELCOME],
    ["UTC", UTC_WELCOME],
  ] as const)("renders for %s", async (_zone, sample) => {
    const { html, text } = await renderWelcomeEmail(
      sample.details,
      sample.email,
      sample.url,
    );
    expect(html).toMatchSnapshot("html");
    expect(text).toMatchSnapshot("text");
  });

  it("carries the copy, the button, the fallback link, and the expiry in the learner's zone", async () => {
    const { html, text } = await renderWelcomeEmail(
      SAMPLE_WELCOME.details,
      SAMPLE_WELCOME.email,
      SAMPLE_WELCOME.url,
    );
    // Plain text uppercases the heading.
    expect(html).toContain(">Set your password</h1>");
    expect(text).toContain("SET YOUR PASSWORD");
    for (const body of [html, text]) {
      expect(body).toContain(
        "Hi Priya, your Nile Hands-On Labs account for priya@example.com is ready. Set a password to view your lab access and reschedule or cancel reservations.",
      );
      expect(body).toContain("Set my password");
      expect(body).toContain(
        "This link works once and expires Fri, Oct 16, 2026, 9:00 AM EDT.",
      );
      expect(body).toContain(
        "Button not working? Paste this link into your browser:",
      );
      expect(body).toContain(SAMPLE_WELCOME.url);
      expect(body).toContain("You can ignore this email.");
    }
    expect(html).toContain(
      "Set a password to manage your Nile Hands-On Lab reservations.",
    );
    expect(html).toContain(`href="${SAMPLE_WELCOME.url}"`);
  });

  it("names the UTC zone UTC", async () => {
    const { text } = await renderWelcomeEmail(
      UTC_WELCOME.details,
      UTC_WELCOME.email,
      UTC_WELCOME.url,
    );
    expect(text).toContain("expires Fri, Oct 16, 2026, 1:00 PM UTC.");
  });

  const composeWelcome = (subjectPrefix = "") =>
    composeWelcomeEmail({
      emailId: "33333333-3333-4333-8333-333333333333",
      details: SAMPLE_WELCOME.details,
      email: SAMPLE_WELCOME.email,
      url: SAMPLE_WELCOME.url,
      senderEmail: "labs@nile.example",
      to: "priya@example.com",
      subjectPrefix,
    }).then(({ subject, raw }) => ({
      subject,
      mime: Buffer.from(raw, "base64url").toString("utf8"),
    }));

  it("builds HTML and text alternatives with the inline logo, no attachment, and no Bcc (AC-5)", async () => {
    const { subject, mime } = await composeWelcome();
    expect(subject).toBe("Set your password for Nile Hands-On Labs");
    expect(mime).toContain('From: "Nile Hands-On Labs" <labs@nile.example>');
    expect(mime).toContain("To: priya@example.com");
    expect(mime).toContain(
      "Message-ID: <33333333-3333-4333-8333-333333333333@nile-hol-reservations>",
    );
    expect(mime).not.toMatch(/^Bcc:/m);
    const root = parseMime(mime);
    expect(mimeShape(root)).toEqual([
      "multipart/alternative",
      ["text/plain", ["multipart/related", ["text/html", "image/png"]]],
    ]);
    expect(
      allParts(root).filter((p) => p.disposition?.startsWith("attachment")),
    ).toEqual([]);
  });

  it("adds the [dev] prefix to the subject", async () => {
    expect((await composeWelcome("[dev] ")).subject).toBe(
      "[dev] Set your password for Nile Hands-On Labs",
    );
  });
});

// covers: spec 0019 AC-6 (the Nile login row)
describe("Nile login in the booking emails", () => {
  it.each(["booked", "rescheduled", "reminder"] as const)(
    "shows a Nile login row in the %s email, html and text",
    async (kind) => {
      const { html, text } = await renderBookingEmail(
        kind,
        SAMPLE_BOOKING_DETAILS,
        [],
        "ana.souza@nileworkshop-1.com",
      );
      expect(html).toContain("Nile login");
      expect(html).toContain("ana.souza@nileworkshop-1.com");
      expect(text).toMatch(/Nile login\s+ana\.souza@nileworkshop-1\.com/);
    },
  );

  it("omits the row with no login, and for a cancellation", async () => {
    const plain = await renderBookingEmail("booked", SAMPLE_BOOKING_DETAILS);
    expect(plain.html).not.toContain("Nile login");
    const gone = await renderBookingEmail(
      "cancelled",
      cancelled(SAMPLE_BOOKING_DETAILS),
      [],
      "ana.souza@nileworkshop-1.com",
    );
    expect(gone.html).not.toContain("ana.souza");
  });
});
