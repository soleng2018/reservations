import "server-only";
import type { BookingEmailDetails } from "@/lib/booking-email";

// Spec 0013 AC-22, AC-23: fixed details, matching the standalone files'
// sample (Priya, Testbed 1), for the worker's start up render and the
// template snapshots.
export const SAMPLE_BOOKING_DETAILS: BookingEmailDetails = {
  learnerName: "Priya",
  timezone: "America/New_York",
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
