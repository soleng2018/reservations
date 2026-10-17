import { describe, expect, it } from "vitest";
import {
  BookingEmailDetails,
  emailSubject,
  parseGoogleKeyFile,
} from "./booking-email";

// covers: spec 0013 AC-3
const PEM =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n";

const keyFile = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "service_account",
    project_id: "hol-project",
    private_key_id: "abc123",
    private_key: PEM,
    client_email: "hol-mailer@hol-project.iam.gserviceaccount.com",
    client_id: "104857600123456789012",
    token_uri: "https://oauth2.googleapis.com/token",
    ...overrides,
  });

describe("parseGoogleKeyFile (spec 0013 AC-3)", () => {
  it("keeps only the five fields it reads", () => {
    expect(parseGoogleKeyFile(keyFile())).toEqual({
      ok: true,
      value: {
        type: "service_account",
        client_id: "104857600123456789012",
        client_email: "hol-mailer@hol-project.iam.gserviceaccount.com",
        private_key: PEM,
        private_key_id: "abc123",
      },
    });
  });

  it.each([
    ["not JSON", "this is not json"],
    ["a JSON array", "[]"],
    [
      "an OAuth client file",
      JSON.stringify({
        web: { client_id: "x.apps.googleusercontent.com", client_secret: "s" },
      }),
    ],
    ["another key type", keyFile({ type: "authorized_user" })],
    ["a client id that isn't digits", keyFile({ client_id: "abc" })],
    ["an email outside service accounts", keyFile({ client_email: "a@b.com" })],
    ["a key that isn't PKCS #8 PEM", keyFile({ private_key: "MIIEvQ" })],
    ["an empty key id", keyFile({ private_key_id: "" })],
  ])("refuses %s with one answer", (_label, text) => {
    expect(parseGoogleKeyFile(text)).toEqual({ ok: false, error: "invalid" });
  });

  it("never echoes the file's contents", () => {
    const result = parseGoogleKeyFile(
      keyFile({ private_key: "canary-private-key", type: "x" }),
    );
    expect(JSON.stringify(result)).not.toContain("canary");
  });
});

// covers: spec 0013 AC-11, AC-12, AC-13
describe("emailSubject (spec 0013 AC-12, AC-13)", () => {
  const details = BookingEmailDetails.parse({
    learnerName: "Priya",
    timezone: "America/New_York",
    labTypeName: "Basic",
    testbedName: "Testbed 1",
    startsAt: "2026-10-13T13:00:00.000Z",
    endsAt: "2026-10-13T17:00:00.000Z",
    appUrl: "https://labs.nile.example",
    links: null,
  });
  it.each([
    ["booked", "Your Nile Hands-On Lab access - Tue, Oct 13, 2026, 9:00 AM ET"],
    [
      "rescheduled",
      "Updated: Your Nile Hands-On Lab access - Tue, Oct 13, 2026, 9:00 AM ET",
    ],
    [
      "cancelled",
      "Cancelled: Your Nile Hands-On Lab reservation - Tue, Oct 13, 2026, 9:00 AM ET",
    ],
  ] as const)("titles %s", (kind, subject) => {
    expect(emailSubject(kind, details)).toBe(subject);
  });

  it("refuses a snapshot link that isn't https", () => {
    expect(
      BookingEmailDetails.safeParse({
        ...details,
        links: {
          portalUrl: "http://x.example",
          lmsUrl: "https://x.example",
          clients: [],
        },
      }).success,
    ).toBe(false);
  });

  // AC-11 (amended 2026-10-16): rows queued before newAccount existed.
  it("reads a snapshot without newAccount as an existing account", () => {
    const older: Record<string, unknown> = { ...details };
    delete older.newAccount;
    expect(BookingEmailDetails.parse(older).newAccount).toBe(false);
  });
});
