import { describe, expect, it } from "vitest";
import { authErrorView } from "./auth-errors";

describe("authErrorView", () => {
  it("shows the reserve link only for an unknown account", () => {
    expect(authErrorView({ reason: "unknown" })).toMatchObject({
      message: "We couldn't find reservations for this account.",
      reserveLink: true,
    });
    expect(authErrorView({ reason: "deactivated" }).reserveLink).toBe(false);
  });

  it("reads Better Auth's error param when it holds one of our reasons", () => {
    expect(authErrorView({ error: "deactivated" }).message).toBe(
      "This account is deactivated.",
    );
  });

  it("treats unknown or missing codes as unavailable", () => {
    const unavailable =
      "Sign in is temporarily unavailable, try again shortly.";
    expect(authErrorView({ error: "state_invalid" }).message).toBe(unavailable);
    expect(authErrorView({ error: "toString" }).message).toBe(unavailable);
    expect(authErrorView({ reason: "unavailable" }).message).toBe(unavailable);
    expect(authErrorView({}).message).toBe(unavailable);
  });

  // covers: spec 0014 AC-19 (Better Auth's 5 minute state cookie ran out)
  it("shows a state mismatch as timed out, with a Sign in button", () => {
    expect(authErrorView({ error: "state_mismatch" })).toEqual({
      title: "Sign in timed out",
      message:
        "Your sign in expired before it finished. Sign in again to continue.",
      reserveLink: false,
      signIn: true,
    });
  });

  // covers: spec 0014 AC-19
  it("keeps our reason ahead of a state mismatch", () => {
    expect(
      authErrorView({ reason: "unavailable", error: "state_mismatch" }),
    ).toMatchObject({ title: "Sign in unavailable", signIn: false });
  });

  // covers: spec 0014 AC-19
  it("offers Sign in only on the timed out view", () => {
    const reasons = [
      "unknown",
      "deactivated",
      "unavailable",
      "not_authorized",
      "signout_partial",
    ];
    for (const reason of reasons)
      expect(authErrorView({ reason }).signIn).toBe(false);
  });

  // covers: AC-12 (Authentik unreachable at sign out)
  it("tells you the app session ended but Authentik's did not", () => {
    expect(authErrorView({ reason: "signout_partial" })).toMatchObject({
      title: "Signed out of HOL",
      message:
        "You're signed out of HOL, but we couldn't end your Authentik session. Close the browser to finish.",
      reserveLink: false,
    });
  });

  it("prefers our reason over Better Auth's error", () => {
    expect(
      authErrorView({ reason: "not_authorized", error: "unknown" }).title,
    ).toBe("Not authorized");
  });
});
