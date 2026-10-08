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
    expect(authErrorView({ error: "state_mismatch" }).message).toBe(
      unavailable,
    );
    expect(authErrorView({ error: "toString" }).message).toBe(unavailable);
    expect(authErrorView({}).message).toBe(unavailable);
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
