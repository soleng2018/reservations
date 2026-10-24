import { describe, expect, it, vi } from "vitest";
import {
  checkGroupWrite,
  checkUserWrite,
  guardGroupWrite,
  type GroupTarget,
  type UserTarget,
} from "./guard";
import {
  ADMINS as ADMINS_GROUP,
  fakeAuthentik,
  markedGroup,
  TESTBED_GROUP,
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

const group = (over: Partial<GroupTarget> = {}): GroupTarget => ({
  pk: "g1",
  name: "NileWorkshop1Admin",
  isSuperuser: false,
  parents: [],
  roles: [],
  attributes: { hol_testbed_group: true },
  ...over,
});

const refused = { ok: false, error: "not_testbed_group" } as const;

// covers: spec 0017 AC-3, AC-10 (the marker is the allow list)
describe("checkGroupWrite (spec 0017 AC-3, AC-10)", () => {
  it("allows a flat group marked with the boolean true, for both purposes", () => {
    expect(checkGroupWrite(group(), "add", ADMINS).ok).toBe(true);
    expect(checkGroupWrite(group(), "remove", ADMINS).ok).toBe(true);
  });

  it("refuses an add when the marker is missing, false, or the string true", () => {
    for (const attributes of [
      {},
      { hol_testbed_group: false },
      { hol_testbed_group: "true" },
      { hol_testbed_group: 1 },
    ])
      expect(checkGroupWrite(group({ attributes }), "add", ADMINS)).toEqual(
        refused,
      );
  });

  it("refuses an add to a superuser group, or one with a parent or a role", () => {
    expect(
      checkGroupWrite(group({ isSuperuser: true }), "add", ADMINS),
    ).toEqual(refused);
    expect(
      checkGroupWrite(group({ parents: ["parent-uuid"] }), "add", ADMINS),
    ).toEqual(refused);
    expect(
      checkGroupWrite(group({ roles: ["role-id"] }), "add", ADMINS),
    ).toEqual(refused);
  });

  it("refuses an add when Authentik did not say what the group is", () => {
    for (const over of [
      { isSuperuser: undefined },
      { parents: undefined },
      { roles: undefined },
    ])
      expect(checkGroupWrite(group(over), "add", ADMINS)).toEqual(refused);
  });

  it("refuses hol-admins for both purposes, by pk and by name in any case", () => {
    const attributes = { hol_testbed_group: true };
    for (const purpose of ["add", "remove"] as const) {
      expect(
        checkGroupWrite(group({ pk: ADMINS, attributes }), purpose, ADMINS),
      ).toEqual(refused);
      for (const name of ["hol-admins", "HOL-Admins"])
        expect(
          checkGroupWrite(group({ name, attributes }), purpose, ADMINS),
        ).toEqual(refused);
    }
  });

  it("lets a removal through on a group that lost its marker", () => {
    const unmarked = group({ attributes: {}, parents: ["p"], roles: ["r"] });
    expect(checkGroupWrite(unmarked, "remove", ADMINS).ok).toBe(true);
  });
});

// covers: spec 0017 AC-3, AC-10 (the fresh read, without the members)
describe("guardGroupWrite (spec 0017 AC-3)", () => {
  it("returns the freshly read marked group, reading no members", async () => {
    const marked = markedGroup("g2-uuid", "NileWorkshop2Admin");
    const ak = fakeAuthentik([], { groups: [marked] });
    const r = await guardGroupWrite(ak.api, marked.pk, "add");
    expect(r).toMatchObject({
      ok: true,
      value: { pk: marked.pk, name: "NileWorkshop2Admin" },
    });
    expect(ak.writes).toEqual([]);
    expect(ak.groupReads.length).toBeGreaterThan(0);
    expect(ak.groupReads.every((g) => g.includeUsers === "false")).toBe(true);
  });

  it("refuses an add to an unmarked group, writing nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ak = fakeAuthentik([]);
    expect(await guardGroupWrite(ak.api, "other-uuid", "add")).toEqual(refused);
    expect(ak.writes).toEqual([]);
    warn.mockRestore();
  });

  it("refuses hol-admins even when someone marks it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ak = fakeAuthentik([]);
    const admins = ak.groups.find((g) => g.pk === ADMINS_GROUP.pk);
    if (admins) admins.attributes = { hol_testbed_group: true };
    expect(await guardGroupWrite(ak.api, ADMINS_GROUP.pk, "add")).toEqual(
      refused,
    );
    expect(await guardGroupWrite(ak.api, ADMINS_GROUP.pk, "remove")).toEqual(
      refused,
    );
    warn.mockRestore();
  });

  it("allows a removal on an unmarked group", async () => {
    const ak = fakeAuthentik([]);
    const r = await guardGroupWrite(ak.api, "other-uuid", "remove");
    expect(r.ok).toBe(true);
  });

  it("refuses a marked group that has a role or a parent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const withRole = markedGroup("r-uuid", "WithRole", { roles: ["role-1"] });
    const withParent = markedGroup("p-uuid", "WithParent", {
      parents: ["admins-uuid"],
    });
    const ak = fakeAuthentik([], { groups: [withRole, withParent] });
    expect(await guardGroupWrite(ak.api, "r-uuid", "add")).toEqual(refused);
    expect(await guardGroupWrite(ak.api, "p-uuid", "add")).toEqual(refused);
    warn.mockRestore();
  });

  it("passes not_found through for a group that is gone", async () => {
    const ak = fakeAuthentik([]);
    expect(await guardGroupWrite(ak.api, "missing-uuid", "add")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("returns unavailable when Authentik cannot be reached", async () => {
    const ak = fakeAuthentik([], { down: true });
    expect(await guardGroupWrite(ak.api, TESTBED_GROUP.pk, "add")).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("returns unavailable on a 403 or a 500 from the group read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const forbidden = fakeAuthentik([], {
      reply: (m, p) =>
        p.startsWith("/core/groups/") && p !== "/core/groups/"
          ? new Response("{}", { status: 403 })
          : undefined,
    });
    expect(
      await guardGroupWrite(forbidden.api, TESTBED_GROUP.pk, "add"),
    ).toEqual({ ok: false, error: "unavailable" });
    const broken = fakeAuthentik([], {
      fail: (m, p) => p === `/core/groups/${TESTBED_GROUP.pk}/`,
    });
    expect(await guardGroupWrite(broken.api, TESTBED_GROUP.pk, "add")).toEqual({
      ok: false,
      error: "unavailable",
    });
    error.mockRestore();
  });
});
