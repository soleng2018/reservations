import { describe, expect, it, vi } from "vitest";
import {
  checkGroupWrite,
  checkUserWrite,
  guardGroupWrite,
  type UserTarget,
} from "./guard";
import {
  ADMINS as ADMINS_GROUP,
  fakeAuthentik,
  fakeGroup,
  POD,
} from "./testing";

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

// covers: spec 0004 AC-2, AC-11 (the undo checks the fresh group's attributes)
describe("guardGroupWrite (AC-4)", () => {
  it("returns the freshly read pod group, attributes included", async () => {
    const pod = fakeGroup("pod-2-uuid", "pod-lab-2", { hol_testbed_id: "t1" });
    const ak = fakeAuthentik([], { groups: [pod] });
    const r = await guardGroupWrite(ak.api, pod.pk);
    expect(r).toMatchObject({
      ok: true,
      value: { pk: pod.pk, name: "pod-lab-2", attributes: pod.attributes },
    });
    expect(ak.writes).toEqual([]);
  });

  it("refuses a group not named pod-, writing nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ak = fakeAuthentik([]);
    expect(await guardGroupWrite(ak.api, ADMINS_GROUP.pk)).toEqual({
      ok: false,
      error: "not_pod_group",
    });
    expect(ak.writes).toEqual([]);
    warn.mockRestore();
  });

  it("passes not_found through for a group that is gone", async () => {
    const ak = fakeAuthentik([]);
    expect(await guardGroupWrite(ak.api, "missing-uuid")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("returns unavailable when Authentik cannot be reached", async () => {
    const ak = fakeAuthentik([], { down: true });
    expect(await guardGroupWrite(ak.api, POD.pk)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});
