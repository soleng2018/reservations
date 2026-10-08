import { describe, expect, it } from "vitest";
import { removeFromPodGroup } from "./groups";
import { ADMINS, fakeAuthentik, fakeUser, POD } from "./testing";

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
