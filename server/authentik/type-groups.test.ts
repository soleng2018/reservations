import { describe, expect, it, vi } from "vitest";
import {
  deleteTypeGroup,
  ensureTypeGroup,
  renameTypeGroup,
} from "./type-groups";
import {
  ADMINS,
  fakeAuthentik,
  fakeGroup,
  groupWrites,
  markedGroup,
  TESTBED_GROUP,
} from "./testing";

const TYPE = "type-1";
const NAME = "Nile Certified Associate";
const ours = (pk: string, name: string, id = TYPE) =>
  fakeGroup(pk, name, { hol_type_group: true, hol_type_id: id });

// covers: spec 0026 AC-1, AC-2, AC-3
describe("ensureTypeGroup (spec 0026)", () => {
  it("creates a group with the exact name and both markers", async () => {
    const ak = fakeAuthentik([]);
    const r = await ensureTypeGroup(ak.api, { typeId: TYPE, name: NAME });
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toMatchObject({ origin: "created", outcome: "created" });
    expect(ak.writes).toEqual(["POST /core/groups/"]);
    expect(ak.writeBodies[0]?.body).toMatchObject({
      name: NAME,
      is_superuser: false,
      attributes: { hol_type_group: true, hol_type_id: TYPE },
    });
    expect(
      ak.groups.find((g) => g.pk === r.value.pk)?.attributes,
    ).not.toHaveProperty("hol_testbed_group");
  });

  it("links a plain same name group with no Authentik write", async () => {
    const plain = fakeGroup("owner-uuid", NAME);
    const ak = fakeAuthentik([], { groups: [plain] });
    expect(await ensureTypeGroup(ak.api, { typeId: TYPE, name: NAME })).toEqual(
      {
        ok: true,
        value: { pk: "owner-uuid", origin: "reused", outcome: "linked" },
      },
    );
    expect(ak.writes).toEqual([]);
  });

  it("links a group the app made before its save failed, as reused", async () => {
    const orphan = ours("orphan-uuid", NAME, "dead-type");
    const ak = fakeAuthentik([], { groups: [orphan] });
    const r = await ensureTypeGroup(ak.api, { typeId: TYPE, name: NAME });
    expect(r).toMatchObject({ ok: true, value: { origin: "reused" } });
    expect(ak.writes).toEqual([]);
  });

  it.each([
    ["the admin group", ADMINS.name],
    ["a testbed group", TESTBED_GROUP.name],
    ["a marked but false testbed group", "Falsy"],
    ["a superuser group", "Super"],
    ["a group with a parent", "Child"],
    ["a group with a role", "Roled"],
  ])("refuses %s and writes nothing", async (_label, name) => {
    const ak = fakeAuthentik([], {
      groups: [
        fakeGroup("falsy", "Falsy", { hol_testbed_group: false }),
        fakeGroup("super", "Super", {}, { is_superuser: true }),
        fakeGroup("child", "Child", {}, { parents: ["admins-uuid"] }),
        fakeGroup("roled", "Roled", {}, { roles: ["r"] }),
      ],
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await ensureTypeGroup(ak.api, { typeId: TYPE, name })).toEqual({
      ok: false,
      error: "unsafe",
    });
    expect(ak.writes).toEqual([]);
  });

  // covers: AC-4 (a 400 on create is a clash or a bad name, not an outage)
  it("links a group the owner made between the look and the create", async () => {
    const owner = fakeGroup("late-uuid", NAME);
    const ak = fakeAuthentik([]);
    // The first list sees nothing; the create is refused; the second list
    // sees the owner's group.
    let lists = 0;
    const real = ak.groups;
    const spy = vi.spyOn(real, "filter").mockImplementation(function (
      this: typeof real,
      ...args: Parameters<typeof real.filter>
    ) {
      const out = Array.prototype.filter.apply(
        this,
        args as never,
      ) as typeof real;
      lists += 1;
      if (lists === 2) real.push(owner);
      return out;
    } as never);
    const r = await ensureTypeGroup(ak.api, { typeId: TYPE, name: NAME });
    spy.mockRestore();
    expect(r).toMatchObject({ ok: true });
  });

  it("calls a refused name bad, and an outage unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bad = fakeAuthentik([], { rejectName: () => true });
    expect(
      await ensureTypeGroup(bad.api, { typeId: TYPE, name: NAME }),
    ).toEqual({
      ok: false,
      error: "name_invalid",
    });
    const down = fakeAuthentik([], { down: true });
    expect(
      await ensureTypeGroup(down.api, { typeId: TYPE, name: NAME }),
    ).toEqual({ ok: false, error: "unavailable" });
    const forbidden = fakeAuthentik([], {
      reply: (m, p) =>
        m === "POST" && p === "/core/groups/"
          ? new Response("{}", { status: 403 })
          : undefined,
    });
    expect(
      await ensureTypeGroup(forbidden.api, { typeId: TYPE, name: NAME }),
    ).toEqual({ ok: false, error: "unavailable" });
  });
});

// covers: spec 0026 AC-5, AC-6, AC-8, AC-11
describe("renameTypeGroup (spec 0026)", () => {
  it("renames with a body of the name and nothing else", async () => {
    const ak = fakeAuthentik([], { groups: [ours("g1", "Old")] });
    expect(
      await renameTypeGroup(ak.api, { typeId: TYPE, pk: "g1", name: "New" }),
    ).toEqual({ ok: true, value: { kind: "renamed" } });
    expect(ak.writes).toEqual(["PATCH /core/groups/g1/"]);
    expect(Object.keys(ak.writeBodies[0]?.body ?? {})).toEqual(["name"]);
    expect(ak.groups.find((g) => g.pk === "g1")?.name).toBe("New");
  });

  it("makes a case only change a real PATCH", async () => {
    const ak = fakeAuthentik([], { groups: [ours("g1", "lab")] });
    await renameTypeGroup(ak.api, { typeId: TYPE, pk: "g1", name: "Lab" });
    expect(ak.writes).toEqual(["PATCH /core/groups/g1/"]);
  });

  it("makes no call when the name already matches", async () => {
    const ak = fakeAuthentik([], { groups: [ours("g1", "Same")] });
    expect(
      await renameTypeGroup(ak.api, { typeId: TYPE, pk: "g1", name: "Same" }),
    ).toEqual({ ok: true, value: { kind: "unchanged" } });
    expect(ak.writes).toEqual([]);
  });

  it("refuses a name another group holds, and writes nothing", async () => {
    const ak = fakeAuthentik([], {
      groups: [ours("g1", "Old"), fakeGroup("g2", "Taken")],
    });
    expect(
      await renameTypeGroup(ak.api, { typeId: TYPE, pk: "g1", name: "Taken" }),
    ).toEqual({ ok: false, error: "name_taken" });
    expect(ak.writes).toEqual([]);
  });

  it("refuses a group that is no longer marked for this type", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const g of [
      fakeGroup("g1", "Old"),
      ours("g1", "Old", "other-type"),
      fakeGroup("g1", "Old", {
        hol_type_group: true,
        hol_type_id: TYPE,
        hol_testbed_group: true,
      }),
    ]) {
      const ak = fakeAuthentik([], { groups: [g] });
      expect(
        await renameTypeGroup(ak.api, { typeId: TYPE, pk: "g1", name: "New" }),
      ).toEqual({ ok: false, error: "changed" });
      expect(ak.writes).toEqual([]);
    }
  });

  it("makes a fresh group when the old one is gone", async () => {
    const ak = fakeAuthentik([]);
    const r = await renameTypeGroup(ak.api, {
      typeId: TYPE,
      pk: "missing-uuid",
      name: "New",
    });
    expect(r).toMatchObject({ ok: true, value: { kind: "recreated" } });
    expect(ak.writes).toEqual(["POST /core/groups/"]);
  });

  it("reports a bad name and an outage", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bad = fakeAuthentik([], {
      groups: [ours("g1", "Old")],
      rejectName: (n) => n === "Bad",
    });
    expect(
      await renameTypeGroup(bad.api, { typeId: TYPE, pk: "g1", name: "Bad" }),
    ).toEqual({ ok: false, error: "name_invalid" });
    const down = fakeAuthentik([], { down: true });
    expect(
      await renameTypeGroup(down.api, { typeId: TYPE, pk: "g1", name: "New" }),
    ).toEqual({ ok: false, error: "unavailable" });
  });
});

// covers: spec 0026 AC-9, AC-10, AC-11
describe("deleteTypeGroup (spec 0026)", () => {
  it("deletes the group it made and counts the members", async () => {
    const ak = fakeAuthentik(
      [
        {
          pk: 7,
          username: "a",
          name: "A",
          email: "a@x.test",
          is_active: true,
          is_superuser: false,
          groups: ["g1"],
          attributes: {},
        },
      ],
      { groups: [ours("g1", "Old")] },
    );
    expect(await deleteTypeGroup(ak.api, { typeId: TYPE, pk: "g1" })).toEqual({
      ok: true,
      value: { kind: "deleted", memberCount: 1 },
    });
    expect(ak.writes).toEqual(["DELETE /core/groups/g1/"]);
    // The member survives; only the group is gone.
    expect(ak.users).toHaveLength(1);
  });

  it("leaves a group that is bound, has children, or is not ours", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cases = [
      [
        fakeAuthentik([], { groups: [ours("g1", "A")], usedBy: ["g1"] }),
        "bound",
      ],
      [
        fakeAuthentik([], {
          groups: [
            ours("g1", "A"),
            fakeGroup("kid", "Kid", {}, { parents: ["g1"] }),
          ],
        }),
        "has_children",
      ],
      [fakeAuthentik([], { groups: [fakeGroup("g1", "A")] }), "not_ours"],
    ] as const;
    for (const [ak, reason] of cases) {
      expect(await deleteTypeGroup(ak.api, { typeId: TYPE, pk: "g1" })).toEqual(
        {
          ok: true,
          value: { kind: "left", reason },
        },
      );
      expect(groupWrites(ak.writes)).toEqual([]);
    }
  });

  it("goes on when the group is gone, and fails on an outage", async () => {
    const ak = fakeAuthentik([]);
    expect(await deleteTypeGroup(ak.api, { typeId: TYPE, pk: "gone" })).toEqual(
      {
        ok: true,
        value: { kind: "gone" },
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const down = fakeAuthentik([], { down: true });
    expect(await deleteTypeGroup(down.api, { typeId: TYPE, pk: "g1" })).toEqual(
      {
        ok: false,
        error: "unavailable",
      },
    );
  });

  it("never writes a testbed group or the admin group", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const pk of [TESTBED_GROUP.pk, ADMINS.pk]) {
      const ak = fakeAuthentik([]);
      const r = await deleteTypeGroup(ak.api, { typeId: TYPE, pk });
      expect(r).toEqual({
        ok: true,
        value: { kind: "left", reason: "not_ours" },
      });
      expect(groupWrites(ak.writes)).toEqual([]);
    }
    expect(markedGroup).toBeDefined();
  });
});
