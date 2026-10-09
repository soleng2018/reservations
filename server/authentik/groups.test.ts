import { describe, expect, it } from "vitest";
import {
  addToPodGroup,
  createPodGroup,
  deletePodGroup,
  findPodGroupByName,
  podGroupMembers,
  removeFromPodGroup,
} from "./groups";
import {
  ADMINS,
  fakeAuthentik,
  fakeGroup,
  fakeLearner,
  fakeUser,
  POD,
} from "./testing";

const TESTBED = "6f1c2f9e-0000-4000-8000-000000000001";

// covers: spec 0004 AC-2
describe("createPodGroup (AC-2)", () => {
  it("creates the group stamped with the testbed id", async () => {
    const ak = fakeAuthentik([]);
    const r = await createPodGroup(ak.api, "pod-lab-2", TESTBED);
    expect(r).toMatchObject({
      ok: true,
      value: { name: "pod-lab-2", testbedId: TESTBED },
    });
    expect(ak.writes).toEqual(["POST /core/groups/"]);
    expect(ak.groups.at(-1)?.attributes).toEqual({ hol_testbed_id: TESTBED });
  });

  it("never adopts an existing group of that name", async () => {
    const ak = fakeAuthentik([]);
    expect(await createPodGroup(ak.api, POD.name, TESTBED)).toEqual({
      ok: false,
      error: "exists",
    });
    expect(ak.writes).toEqual([]);
  });

  it("refuses a name outside pod-, without writing", async () => {
    const ak = fakeAuthentik([]);
    expect(await createPodGroup(ak.api, "hol-admins", TESTBED)).toEqual({
      ok: false,
      error: "not_pod_group",
    });
    expect(ak.writes).toEqual([]);
  });

  it("returns unavailable when Authentik is down", async () => {
    const ak = fakeAuthentik([], { down: true });
    expect(await createPodGroup(ak.api, "pod-lab-2", TESTBED)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("findPodGroupByName", () => {
  it("finds the exact name, or nothing", async () => {
    const ak = fakeAuthentik([], {
      groups: [fakeGroup("g2", "pod-lab-2", { hol_testbed_id: TESTBED })],
    });
    expect(await findPodGroupByName(ak.api, "pod-lab-2")).toEqual({
      ok: true,
      value: { pk: "g2", name: "pod-lab-2", testbedId: TESTBED },
    });
    expect(await findPodGroupByName(ak.api, "pod-lab-9")).toEqual({
      ok: true,
      value: undefined,
    });
  });
});

describe("deletePodGroup (AC-11 invariant)", () => {
  const owned = fakeGroup("g2", "pod-lab-2", { hol_testbed_id: TESTBED });

  it("deletes a group that carries this testbed's id", async () => {
    const ak = fakeAuthentik([], { groups: [owned] });
    expect((await deletePodGroup(ak.api, "g2", TESTBED)).ok).toBe(true);
    expect(ak.writes).toEqual(["DELETE /core/groups/g2/"]);
  });

  it("leaves a group stamped with another id, or none, alone", async () => {
    const ak = fakeAuthentik([], { groups: [owned] });
    expect(
      await deletePodGroup(ak.api, "g2", crypto.randomUUID()),
    ).toMatchObject({ ok: false, error: "not_owned" });
    expect(await deletePodGroup(ak.api, POD.pk, TESTBED)).toMatchObject({
      ok: false,
      error: "not_owned",
    });
    expect(ak.writes).toEqual([]);
  });

  it("never deletes a group outside pod-", async () => {
    const ak = fakeAuthentik([]);
    expect(await deletePodGroup(ak.api, ADMINS.pk, TESTBED)).toEqual({
      ok: false,
      error: "not_pod_group",
    });
    expect(ak.writes).toEqual([]);
  });
});

// covers: spec 0004 AC-12
describe("podGroupMembers (AC-12)", () => {
  it("reads every member across pages, with the learner tag", async () => {
    const members = Array.from({ length: 205 }, (_, i) =>
      fakeLearner(1000 + i, { groups: [POD.pk] }),
    );
    const staff = fakeUser({ pk: 5, groups: [POD.pk] });
    const outside = fakeLearner(6);
    const ak = fakeAuthentik([...members, staff, outside]);
    const r = await podGroupMembers(ak.api, POD.pk);
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toHaveLength(206);
    expect(r.value).toContainEqual({ pk: 1204, holLearner: true });
    expect(r.value).toContainEqual({ pk: 5, holLearner: false });
    expect(r.value.some((m) => m.pk === 6)).toBe(false);
  });

  it("returns unavailable when a page fails", async () => {
    const ak = fakeAuthentik([], { fail: (m, p) => p === "/core/users/" });
    expect(await podGroupMembers(ak.api, POD.pk)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("addToPodGroup", () => {
  it("adds a tagged learner, which the member list then shows", async () => {
    const ak = fakeAuthentik([fakeLearner(3)]);
    expect((await addToPodGroup(ak.api, POD.pk, 3)).ok).toBe(true);
    expect(await podGroupMembers(ak.api, POD.pk)).toEqual({
      ok: true,
      value: [{ pk: 3, holLearner: true }],
    });
  });
});

// covers: AC-4
describe("removeFromPodGroup (AC-4)", () => {
  const learner = fakeUser({ pk: 3, attributes: { hol_learner: true } });
  const admin = fakeUser({
    pk: 1,
    groups: [ADMINS.pk],
    attributes: { hol_learner: true },
  });
  const untagged = fakeUser({ pk: 2 });

  it("refuses any group that is not a pod- group, without writing", async () => {
    const ak = fakeAuthentik([learner]);
    expect(await removeFromPodGroup(ak.api, ADMINS.pk, 3)).toEqual({
      ok: false,
      error: "not_pod_group",
    });
    expect(await removeFromPodGroup(ak.api, "other-uuid", 3)).toEqual({
      ok: false,
      error: "not_pod_group",
    });
    expect(ak.writes).toEqual([]);
  });

  it("refuses an admin or an untagged user, without writing", async () => {
    const ak = fakeAuthentik([admin, untagged]);
    expect(await removeFromPodGroup(ak.api, POD.pk, 1)).toEqual({
      ok: false,
      error: "is_admin",
    });
    expect(await removeFromPodGroup(ak.api, POD.pk, 2)).toEqual({
      ok: false,
      error: "not_learner",
    });
    expect(ak.writes).toEqual([]);
  });

  it("removes a learner from a pod- group", async () => {
    const ak = fakeAuthentik([learner]);
    expect((await removeFromPodGroup(ak.api, POD.pk, 3)).ok).toBe(true);
    expect(ak.writes).toEqual([`POST /core/groups/${POD.pk}/remove_user/`]);
  });

  it("returns unavailable when Authentik cannot be reached (AC-15)", async () => {
    const ak = fakeAuthentik([learner], { down: true });
    expect(await removeFromPodGroup(ak.api, POD.pk, 3)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});
