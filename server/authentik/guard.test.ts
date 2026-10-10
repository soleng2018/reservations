import { describe, expect, it } from "vitest";
import { checkGroupWrite, checkUserWrite, type UserTarget } from "./guard";

const ADMINS = "admins-uuid";
const target = (over: Partial<UserTarget> = {}): UserTarget => ({
  isSuperuser: false,
  groups: [],
  attributes: { hol_learner: true },
  ...over,
});

describe("checkUserWrite (AC-4)", () => {
  it("allows a tagged learner for any purpose", () => {
    expect(checkUserWrite(target(), ADMINS, "learner").ok).toBe(true);
    expect(checkUserWrite(target(), ADMINS, "tag").ok).toBe(true);
  });

  it("refuses a member of the admin group, even when tagged", () => {
    const admin = target({ groups: ["pod-x", ADMINS] });
    expect(checkUserWrite(admin, ADMINS, "learner")).toEqual({
      ok: false,
      error: "is_admin",
    });
    expect(checkUserWrite(admin, ADMINS, "tag")).toEqual({
      ok: false,
      error: "is_admin",
    });
  });

  it("refuses an Authentik superuser", () => {
    expect(
      checkUserWrite(target({ isSuperuser: true }), ADMINS, "learner"),
    ).toEqual({ ok: false, error: "is_admin" });
  });

  it("refuses an untagged user outside the saga's tag step", () => {
    const plain = target({ attributes: {} });
    expect(checkUserWrite(plain, ADMINS, "learner")).toEqual({
      ok: false,
      error: "not_learner",
    });
    expect(checkUserWrite(plain, ADMINS, "tag").ok).toBe(true);
  });

  it("does not take a truthy string as the learner tag", () => {
    const fake = target({ attributes: { hol_learner: "true" } });
    expect(checkUserWrite(fake, ADMINS, "learner").ok).toBe(false);
  });
});

describe("checkGroupWrite (AC-4)", () => {
  it("allows pod- groups only", () => {
    expect(checkGroupWrite("pod-lab-1").ok).toBe(true);
    for (const name of [
      "hol-admins",
      "authentik Admins",
      "pod-",
      "Pod-x",
      "xpod-1",
    ])
      expect(checkGroupWrite(name)).toEqual({
        ok: false,
        error: "not_pod_group",
      });
  });
});
