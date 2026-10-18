import { describe, expect, it } from "vitest";
import { linkView, type LinkFacts, type UserFacts } from "./set-password-link";

// covers: spec 0014 AC-9, AC-12, AC-14 (which view a link gets)
const link = (over: Partial<LinkFacts> = {}): LinkFacts => ({
  endedReason: null,
  unexpired: true,
  email: "priya@acme.com",
  ...over,
});
const user = (over: Partial<UserFacts> = {}): UserFacts => ({
  role: "learner",
  status: "active",
  authentikUserPk: 42,
  setPasswordPending: true,
  email: "Priya@Acme.com",
  ...over,
});

describe("linkView (spec 0014 AC-9)", () => {
  it("is live for an unended, unexpired link of a pending learner at the same address", () => {
    expect(linkView(link(), user())).toBe("live");
  });

  it.each([
    ["used", link({ endedReason: "used" }), user()],
    ["used by a sibling", link({ endedReason: "other_used" }), user()],
    ["expired", link({ unexpired: false }), user()],
    [
      "ended by an email change",
      link({ endedReason: "email_changed" }),
      user(),
    ],
    [
      "for a learner with no Authentik pk",
      link(),
      user({ authentikUserPk: null }),
    ],
    ["for a deactivated learner", link(), user({ status: "deactivated" })],
    ["for an admin", link(), user({ role: "admin" })],
    ["for an old address", link({ email: "old@acme.com" }), user()],
  ])("is dead while pending when %s", (_why, l, u) => {
    expect(linkView(l, u)).toBe("dead");
  });

  it.each([
    ["live", link()],
    ["used", link({ endedReason: "used" })],
    ["used by a sibling", link({ endedReason: "other_used" })],
    ["used and expired", link({ endedReason: "used", unexpired: false })],
    ["expired", link({ unexpired: false })],
  ])("is already set after the first sign in when %s (AC-12)", (_why, l) => {
    expect(linkView(l, user({ setPasswordPending: false }))).toBe(
      "already_set",
    );
  });

  it.each([
    [
      "an email change ended it",
      link({ endedReason: "email_changed" }),
      user(),
    ],
    ["the address changed", link({ email: "old@acme.com" }), user()],
    ["the learner is deactivated", link(), user({ status: "deactivated" })],
  ])("is dead after the first sign in when %s", (_why, l, u) => {
    expect(linkView(l, { ...u, setPasswordPending: false })).toBe("dead");
  });
});
