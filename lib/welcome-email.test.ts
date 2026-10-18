import { describe, expect, it } from "vitest";
import {
  SetPasswordToken,
  setPasswordUrl,
  WelcomeEmailDetails,
  welcomeExpiry,
} from "./welcome-email";

// covers: spec 0014 AC-4, AC-7, AC-8 (the pure parts)
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";

describe("welcome email parts (spec 0014)", () => {
  it("accepts only the 43 character base64url token shape (AC-4)", () => {
    expect(TOKEN).toHaveLength(43);
    expect(SetPasswordToken.safeParse(TOKEN).success).toBe(true);
    expect(SetPasswordToken.safeParse(`${TOKEN}A`).success).toBe(false);
    expect(SetPasswordToken.safeParse(TOKEN.slice(1)).success).toBe(false);
    expect(SetPasswordToken.safeParse(`${TOKEN.slice(1)}=`).success).toBe(
      false,
    );
    expect(SetPasswordToken.safeParse(`${TOKEN.slice(1)}/`).success).toBe(
      false,
    );
  });

  it("builds the link on the queuing app's origin (AC-4)", () => {
    expect(setPasswordUrl("http://10.1.255.18:3000", TOKEN)).toBe(
      `http://10.1.255.18:3000/set-password/${TOKEN}`,
    );
  });

  it.each([
    ["America/New_York", "Thu, Oct 15, 2026, 6:00 PM EDT"],
    ["Asia/Kolkata", "Fri, Oct 16, 2026, 3:30 AM GMT+5:30"],
    ["UTC", "Thu, Oct 15, 2026, 10:00 PM UTC"],
  ])("prints the expiry in the learner's zone, %s (AC-7)", (zone, text) => {
    expect(
      welcomeExpiry({
        name: "Priya",
        expiresAt: "2026-10-15T22:00:00.000Z",
        timeZone: zone,
      }),
    ).toBe(text);
  });

  it("holds the name, expiry, and zone, and nothing else (AC-8)", () => {
    const parsed = WelcomeEmailDetails.parse({
      name: "Priya",
      expiresAt: "2026-10-15T22:00:00.000Z",
      timeZone: "UTC",
      url: "https://x.test/set-password/secret",
    });
    expect(Object.keys(parsed).toSorted()).toEqual([
      "expiresAt",
      "name",
      "timeZone",
    ]);
  });
});
