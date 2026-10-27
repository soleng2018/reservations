import { describe, expect, it, vi } from "vitest";
import {
  addToTestbedGroup,
  findTestbedGroup,
  listTestbedGroupChoices,
  readTestbedGroup,
  removeFromTestbedGroup,
  testbedGroupMembers,
} from "./groups";
import {
  ADMINS,
  fakeAuthentik,
  fakeGroup,
  fakeLearner,
  fakeUser,
  groupWrites,
  markedGroup,
  TESTBED_GROUP,
} from "./testing";

const NAME = "NileWorkshop1Admin";

// covers: spec 0017 AC-3 (the exact name, the marker, the failures)
describe("findTestbedGroup (spec 0017 AC-3)", () => {
  it("finds the marked group with exactly that name", async () => {
    const ak = fakeAuthentik([]);
    expect(await findTestbedGroup(ak.api, NAME)).toEqual({
      ok: true,
      value: { pk: TESTBED_GROUP.pk, name: NAME },
    });
    expect(ak.writes).toEqual([]);
  });

  it("matches the name exactly, and case sensitively", async () => {
    const ak = fakeAuthentik([], {
      groups: [
        markedGroup("x-uuid", "NileWorkshop1AdminX"),
        markedGroup("lower-uuid", "nileworkshop1admin"),
      ],
    });
    expect(await findTestbedGroup(ak.api, NAME)).toMatchObject({
      ok: true,
      value: { pk: TESTBED_GROUP.pk },
    });
    expect(await findTestbedGroup(ak.api, "NileWorkshop1")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await findTestbedGroup(ak.api, "NILEWORKSHOP1ADMIN")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("says not_found when no group has the name", async () => {
    const ak = fakeAuthentik([]);
    expect(await findTestbedGroup(ak.api, "NoSuchGroup")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("refuses two groups with the same exact name, never the first", async () => {
    const ak = fakeAuthentik([], {
      groups: [markedGroup("dup-uuid", NAME)],
    });
    expect(await findTestbedGroup(ak.api, NAME)).toEqual({
      ok: false,
      error: "not_testbed_group",
    });
  });

  it("refuses a group without the marker, with the string true, or hol-admins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ak = fakeAuthentik([], {
      groups: [
        fakeGroup("plain-uuid", "Plain"),
        fakeGroup("str-uuid", "Stringly", { hol_testbed_group: "true" }),
        markedGroup("super-uuid", "Super", { is_superuser: true }),
        markedGroup("role-uuid", "Roled", { roles: ["r1"] }),
        markedGroup("parent-uuid", "Parented", { parents: ["p1"] }),
      ],
    });
    for (const name of ["Plain", "Stringly", "Super", "Roled", "Parented"])
      expect(await findTestbedGroup(ak.api, name)).toEqual({
        ok: false,
        error: "not_testbed_group",
      });
    const admins = ak.groups.find((g) => g.pk === ADMINS.pk);
    if (admins) admins.attributes = { hol_testbed_group: true };
    expect(await findTestbedGroup(ak.api, "hol-admins")).toEqual({
      ok: false,
      error: "not_testbed_group",
    });
    warn.mockRestore();
  });

  it("asks for the group without its members", async () => {
    const ak = fakeAuthentik([]);
    await findTestbedGroup(ak.api, NAME);
    expect(ak.groupReads.length).toBeGreaterThan(0);
    expect(ak.groupReads.every((g) => g.includeUsers === "false")).toBe(true);
  });

  it("is unavailable when Authentik is down, answers 403 or 500, or sends a body that does not parse", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onList = (m: string, p: string) =>
      m === "GET" && p === "/core/groups/" && true;
    const cases = [
      fakeAuthentik([], { down: true }),
      fakeAuthentik([], {
        reply: (m, p) =>
          onList(m, p) ? new Response("{}", { status: 403 }) : undefined,
      }),
      fakeAuthentik([], { fail: onList }),
      fakeAuthentik([], {
        reply: (m, p) =>
          onList(m, p)
            ? new Response("<html>", {
                status: 200,
                headers: { "Content-Type": "application/json" },
              })
            : undefined,
      }),
      fakeAuthentik([], {
        reply: (m, p) =>
          onList(m, p)
            ? new Response(JSON.stringify({ unexpected: true }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
              })
            : undefined,
      }),
    ];
    for (const ak of cases)
      expect(await findTestbedGroup(ak.api, NAME)).toEqual({
        ok: false,
        error: "unavailable",
      });
    error.mockRestore();
  });
});

describe("readTestbedGroup", () => {
  it("returns the group's current name, or not_found", async () => {
    const ak = fakeAuthentik([]);
    expect(await readTestbedGroup(ak.api, TESTBED_GROUP.pk)).toEqual({
      ok: true,
      value: { pk: TESTBED_GROUP.pk, name: NAME },
    });
    expect(await readTestbedGroup(ak.api, "gone-uuid")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(ak.groupReads.every((g) => g.includeUsers === "false")).toBe(true);
  });
});

// covers: spec 0004 AC-12
describe("testbedGroupMembers (AC-12)", () => {
  it("reads every member across pages, with the learner tag", async () => {
    const members = Array.from({ length: 205 }, (_, i) =>
      fakeLearner(1000 + i, { groups: [TESTBED_GROUP.pk] }),
    );
    const staff = fakeUser({ pk: 5, groups: [TESTBED_GROUP.pk] });
    const outside = fakeLearner(6);
    const ak = fakeAuthentik([...members, staff, outside]);
    const r = await testbedGroupMembers(ak.api, TESTBED_GROUP.pk);
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toHaveLength(206);
    expect(r.value).toContainEqual({ pk: 1204, holLearner: true });
    expect(r.value).toContainEqual({ pk: 5, holLearner: false });
    expect(r.value.some((m) => m.pk === 6)).toBe(false);
  });

  it("returns unavailable when a page fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ak = fakeAuthentik([], { fail: (m, p) => p === "/core/users/" });
    expect(await testbedGroupMembers(ak.api, TESTBED_GROUP.pk)).toEqual({
      ok: false,
      error: "unavailable",
    });
    error.mockRestore();
  });
});

describe("addToTestbedGroup", () => {
  it("adds a tagged learner, which the member list then shows", async () => {
    const ak = fakeAuthentik([fakeLearner(3)]);
    expect((await addToTestbedGroup(ak.api, TESTBED_GROUP.pk, 3)).ok).toBe(
      true,
    );
    expect(await testbedGroupMembers(ak.api, TESTBED_GROUP.pk)).toEqual({
      ok: true,
      value: [{ pk: 3, holLearner: true }],
    });
    expect(groupWrites(ak.writes)).toEqual([]);
  });

  it("refuses a group without the marker, writing nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ak = fakeAuthentik([fakeLearner(3)]);
    expect(await addToTestbedGroup(ak.api, "other-uuid", 3)).toEqual({
      ok: false,
      error: "not_testbed_group",
    });
    expect(ak.writes).toEqual([]);
    warn.mockRestore();
  });
});

// covers: spec 0003 AC-4, spec 0017 AC-10
describe("removeFromTestbedGroup (AC-4)", () => {
  const learner = fakeUser({ pk: 3, attributes: { hol_learner: true } });
  const admin = fakeUser({
    pk: 1,
    groups: [ADMINS.pk],
    attributes: { hol_learner: true },
  });
  const untagged = fakeUser({ pk: 2 });

  it("refuses hol-admins, without writing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ak = fakeAuthentik([learner]);
    expect(await removeFromTestbedGroup(ak.api, ADMINS.pk, 3)).toEqual({
      ok: false,
      error: "not_testbed_group",
    });
    expect(ak.writes).toEqual([]);
    warn.mockRestore();
  });

  it("still lets a learner out of a group that lost its marker", async () => {
    const ak = fakeAuthentik([{ ...learner, groups: ["other-uuid"] }]);
    expect((await removeFromTestbedGroup(ak.api, "other-uuid", 3)).ok).toBe(
      true,
    );
    expect(ak.writes).toEqual(["POST /core/groups/other-uuid/remove_user/"]);
  });

  it("refuses an admin or an untagged user, without writing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ak = fakeAuthentik([admin, untagged]);
    expect(await removeFromTestbedGroup(ak.api, TESTBED_GROUP.pk, 1)).toEqual({
      ok: false,
      error: "is_admin",
    });
    expect(await removeFromTestbedGroup(ak.api, TESTBED_GROUP.pk, 2)).toEqual({
      ok: false,
      error: "not_learner",
    });
    expect(ak.writes).toEqual([]);
    warn.mockRestore();
  });

  it("removes a learner from a testbed group", async () => {
    const ak = fakeAuthentik([learner]);
    expect((await removeFromTestbedGroup(ak.api, TESTBED_GROUP.pk, 3)).ok).toBe(
      true,
    );
    expect(ak.writes).toEqual([
      `POST /core/groups/${TESTBED_GROUP.pk}/remove_user/`,
    ]);
  });

  it("returns unavailable when Authentik cannot be reached (AC-15)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ak = fakeAuthentik([learner], { down: true });
    expect(await removeFromTestbedGroup(ak.api, TESTBED_GROUP.pk, 3)).toEqual({
      ok: false,
      error: "unavailable",
    });
    error.mockRestore();
  });
});

const names = async (ak: ReturnType<typeof fakeAuthentik>) => {
  const r = await listTestbedGroupChoices(ak.api);
  if (!r.ok) throw new Error(r.error);
  return r.value.map((c) => c.name);
};

// covers: spec 0017 AC-15, AC-19
describe("listTestbedGroupChoices (spec 0017 AC-15)", () => {
  it("offers only marked, flat groups whose name ends with Admin, sorted ignoring case", async () => {
    const ak = fakeAuthentik([], {
      groups: [
        markedGroup("b", "beta Admin"),
        markedGroup("c", "NileWorkshop1Contractor"),
        markedGroup("d", "NileWorkshop1Employee"),
        markedGroup("e", "SuperAdmin", { is_superuser: true }),
        markedGroup("f", "ChildAdmin", { parents: ["x"] }),
        markedGroup("g", "RoleAdmin", { roles: ["r"] }),
        fakeGroup("h", "UnmarkedAdmin"),
        fakeGroup("i", "StringAdmin", { hol_testbed_group: "true" }),
        markedGroup("j", "hol-admins"),
      ],
    });
    expect(await names(ak)).toEqual(["beta Admin", "NileWorkshop1Admin"]);
    expect(ak.writes).toEqual([]);
  });

  it("drops both groups that share one name", async () => {
    const ak = fakeAuthentik([], {
      groups: [markedGroup("a", "DupAdmin"), markedGroup("b", "DupAdmin")],
    });
    expect(await names(ak)).toEqual(["NileWorkshop1Admin"]);
  });

  it("reads a second page but stops after five", async () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        markedGroup(`p${i}`, `G${String(i).padStart(4, "0")}Admin`),
      );
    expect((await names(fakeAuthentik([], { groups: many(150) }))).length).toBe(
      151,
    );
    expect((await names(fakeAuthentik([], { groups: many(600) }))).length).toBe(
      500,
    );
  });

  it("is unavailable when Authentik is down or answers with a body it cannot read", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await listTestbedGroupChoices(fakeAuthentik([], { down: true }).api),
    ).toEqual({ ok: false, error: "unavailable" });
    const garbled = fakeAuthentik([], {
      reply: (m, p) =>
        m === "GET" && p === "/core/groups/"
          ? new Response("<html>", { status: 200 })
          : undefined,
    });
    expect(await listTestbedGroupChoices(garbled.api)).toEqual({
      ok: false,
      error: "unavailable",
    });
    error.mockRestore();
  });
});

// covers: spec 0017 AC-17
describe("a group's domain (spec 0017 AC-17)", () => {
  const domainOf = async (value: unknown) => {
    const ak = fakeAuthentik([], {
      groups: [
        fakeGroup("d", "DomAdmin", {
          hol_testbed_group: true,
          ...(value === undefined ? {} : { hol_testbed_domain: value }),
        }),
      ],
    });
    const r = await listTestbedGroupChoices(ak.api);
    if (!r.ok) throw new Error(r.error);
    return r.value.find((c) => c.name === "DomAdmin")?.domain;
  };

  it("parses the attribute like a typed domain", async () => {
    expect(await domainOf("NileWorkshop-1.COM")).toBe("nileworkshop-1.com");
  });

  it.each([undefined, 7, "", "nile"])(
    "gives null for %j and still offers the group",
    async (v) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await domainOf(v)).toBeNull();
      if (v !== undefined) {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("DomAdmin"));
        expect(JSON.stringify(warn.mock.calls)).not.toContain('"nile"');
      }
      warn.mockRestore();
    },
  );
});
