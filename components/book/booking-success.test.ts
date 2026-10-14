import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Booked } from "@/lib/booking-flow";
import { BookingSuccess } from "./booking-success";

const BOOKED: Booked = {
  kind: "booked",
  typeName: "Basic",
  testbedName: "aa bench",
  startsAt: "2026-10-13T13:00:00.000Z",
  endsAt: "2026-10-13T17:00:00.000Z",
  timezone: "America/New_York",
  newUser: true,
  access: null,
};

const render = (booking: Booked, signedIn?: boolean) =>
  renderToStaticMarkup(
    createElement(BookingSuccess, {
      booking,
      firstName: "Priya",
      email: "priya@example.test",
      signedIn,
    }),
  );

// covers: spec 0010 AC-10
describe("BookingSuccess (AC-10)", () => {
  it("greets by first name and shows the booking in the chosen zone", () => {
    const html = render(BOOKED);
    expect(html).toContain("You&#x27;re all set, Priya!");
    expect(html).toContain("Your reservation is confirmed for");
    expect(html).toContain("priya@example.test");
    expect(html).toContain("aa bench");
    expect(html).toContain("Basic");
    expect(html).toContain("Tue, Oct 13, 2026, 9:00 AM EDT");
    expect(html).toContain("Tue, Oct 13, 2026, 1:00 PM EDT");
  });

  it("asks a new user to set a password", () => {
    const html = render(BOOKED);
    expect(html).toContain("Set your password");
    expect(html).toContain("Check your inbox for a link to set your password.");
    expect(html).not.toContain("existing credentials");
  });

  it("points a reused user to sign in", () => {
    const html = render({ ...BOOKED, newUser: false });
    expect(html).toContain(
      "Sign in with your existing credentials anytime to manage this reservation.",
    );
    expect(html).toContain('href="/reservations"');
    expect(html).not.toContain("Set your password");
  });

  it("has Done to the home page and no lab links without access", () => {
    const html = render(BOOKED);
    expect(html).toContain('href="/"');
    expect(html).toContain("Done");
    expect(html).not.toContain("Add to calendar");
    expect(html).not.toContain("View email");
    expect(html).not.toContain("portal.example");
  });
});

// covers: spec 0011 AC-13
describe("BookingSuccess for a signed in learner (spec 0011 AC-13)", () => {
  it("links to the reservations instead of the sign in line, and Done goes there", () => {
    const html = render({ ...BOOKED, newUser: false }, true);
    expect(html).toContain("View my reservations");
    expect(html).not.toContain("existing credentials");
    expect(html).not.toContain('href="/"');
    expect(html.match(/href="\/reservations"/g)).toHaveLength(2);
  });
});

const ACCESS = {
  portalUrl: "https://portal.example.test",
  lmsUrl: "https://lms.example.test",
  clients: [{ name: "Client A", kind: "wired", url: "https://a.example.test" }],
} as const;

// covers: spec 0012 AC-2, AC-3, AC-4
describe("BookingSuccess lab access (spec 0012)", () => {
  it("shows the card under View my reservations when the reply has links", () => {
    const html = render({ ...BOOKED, newUser: false, access: ACCESS }, true);
    expect(html).toContain("View my reservations");
    expect(html.indexOf("View my reservations")).toBeLessThan(
      html.indexOf("Your lab access"),
    );
    expect(html).toContain(
      "These links start working at your start time (allow up to a minute).",
    );
    expect(html.match(/target="_blank"/g)).toHaveLength(3);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(3);
    expect(html).toContain('href="https://portal.example.test"');
  });

  it("leaves the card out when the reply has no links", () => {
    const html = render({ ...BOOKED, newUser: false }, true);
    expect(html).toContain("View my reservations");
    expect(html).not.toContain("Your lab access</h2>");
  });

  it("tells a reused account where the links will be, with no card", () => {
    const html = render({ ...BOOKED, newUser: false });
    expect(html).toContain(
      "Sign in with your existing credentials anytime to manage this reservation. Your lab access shows there once your lab starts.",
    );
    expect(html).toContain("Manage my reservations");
    expect(html).not.toContain("Your lab access</h2>");
    expect(html).not.toContain("https://");
  });

  it("tells a new learner to set a password first, with no card", () => {
    const html = render({ ...BOOKED, access: ACCESS });
    expect(html).toContain("Set your password");
    expect(html).toContain("After you set your password, sign in to");
    expect(html).toContain("Manage my reservation</a>");
    expect(html).toContain(
      ". Your lab access shows there once your lab starts.",
    );
    expect(html).not.toContain("Your lab access</h2>");
    expect(html).not.toContain("https://");
  });
});
