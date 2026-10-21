import "server-only";
import type { BookingEmailDetails, ClientLogin } from "@/lib/booking-email";
import { setPasswordUrl, type WelcomeEmailDetails } from "@/lib/welcome-email";

// Spec 0014 AC-17, AC-7: the same learner's set password email. The token is
// a fixed sample of the real shape, never a working link.
export const SAMPLE_WELCOME = {
  details: {
    name: "Priya Raman",
    expiresAt: "2026-10-16T13:00:00.000Z",
    timeZone: "America/New_York",
  } satisfies WelcomeEmailDetails,
  email: "priya@example.com",
  url: setPasswordUrl(
    "https://labs.nile.example",
    "SAMPLE_token_0123456789_abcdefghijklmnopqrs",
  ),
} as const;

// Spec 0013 AC-22, AC-23: fixed details, matching the standalone files'
// sample (Priya, Testbed 1), for the worker's start up render and the
// template snapshots.
export const SAMPLE_BOOKING_DETAILS: BookingEmailDetails = {
  learnerName: "Priya",
  timezone: "America/New_York",
  newAccount: true,
  labTypeName: "Basic",
  testbedName: "Testbed 1",
  startsAt: "2026-10-13T13:00:00.000Z",
  endsAt: "2026-10-13T17:00:00.000Z",
  appUrl: "https://labs.nile.example",
  links: {
    portalUrl: "https://example.nile/portal",
    lmsUrl: "https://example.nile/lms",
    clients: [
      {
        name: "Wireless client",
        kind: "wireless",
        url: "https://example.nile/client/wireless",
      },
      {
        name: "Wired client",
        kind: "wired",
        url: "https://example.nile/client/wired",
      },
    ],
  },
};

// Spec 0015 AC-5, AC-7: the same booking's reminder. A reminder is never a
// new account's first email.
export const SAMPLE_REMINDER_DETAILS: BookingEmailDetails = {
  ...SAMPLE_BOOKING_DETAILS,
  newAccount: false,
};

// Spec 0007: the sample clients' OS logins. The wired client has no password,
// so the render shows both shapes.
export const SAMPLE_CLIENT_LOGINS: readonly ClientLogin[] = [
  {
    name: "Wireless client",
    url: "https://example.nile/client/wireless",
    username: "labuser",
    password: "Sample-Pass-1",
  },
  {
    name: "Wired client",
    url: "https://example.nile/client/wired",
    username: "wired-user",
    password: null,
  },
];
