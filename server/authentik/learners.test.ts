import { describe, expect, it } from "vitest";
import { addToPodGroup } from "./groups";
import {
  deleteSagaLearner,
  findOrCreateLearner,
  issueSetPasswordLink,
} from "./learners";
import { ADMINS, fakeAuthentik, fakeUser, POD } from "./testing";

const user = fakeUser;

const input = { email: "Priya@X.test", name: "Priya", holUserId: "row-1" };

describe("findOrCreateLearner (AC-5)", () => {
  it("creates one passwordless learner for a new email", async () => {
    const ak = fakeAuthentik([]);
    const r = await findOrCreateLearner(ak.api, input);
    expect(r).toEqual({
      ok: true,
      value: { pk: 100, created: true, tagged: false },
    });
    expect(ak.writes).toEqual(["POST /core/users/"]);
    expect(ak.users[0]).toMatchObject({
      username: "priya@x.test",
      email: "Priya@X.test",
      path: "hol/learners",
      type: "external",
      is_active: true,
      attributes: { hol_learner: true, hol_user_id: "row-1" },
    });
    expect(ak.users[0]).not.toHaveProperty("password");
  });

  it("reuses a known non admin user, adding only the missing attributes", async () => {
    const ak = fakeAuthentik([
      user({ email: "priya@x.test", attributes: { team: "a" } }),
    ]);
    const r = await findOrCreateLearner(ak.api, input);
    expect(r).toEqual({
      ok: true,
      value: { pk: 7, created: false, tagged: true },
    });
    expect(ak.writes).toEqual(["PATCH /core/users/7/"]);
    expect(ak.users[0]?.attributes).toEqual({
      team: "a",
      hol_learner: true,
      hol_user_id: "row-1",
    });
  });

  it("writes nothing for an already tagged user", async () => {
    const ak = fakeAuthentik([
      user({
        email: "priya@x.test",
        attributes: { hol_learner: true, hol_user_id: "row-1" },
      }),
    ]);
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: true,
      value: { pk: 7, created: false, tagged: false },
    });
    expect(ak.writes).toEqual([]);
  });

  it("refuses an admin email without writing", async () => {
    const ak = fakeAuthentik([
      user({ email: "priya@x.test", groups: [ADMINS.pk] }),
    ]);
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: false,
      error: "is_admin",
    });
    expect(ak.writes).toEqual([]);
  });

  it("refuses a username taken by a different email", async () => {
    const ak = fakeAuthentik([
      user({ username: "priya@x.test", email: "other@x.test" }),
    ]);
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: false,
      error: "username_taken",
    });
    expect(ak.writes).toEqual([]);
  });

  it("finds a user ignoring case, by email or by username", async () => {
    const byEmail = fakeAuthentik([
      user({
        email: "priya@x.test",
        attributes: { hol_learner: true, hol_user_id: "row-1" },
      }),
    ]);
    expect(await findOrCreateLearner(byEmail.api, input)).toMatchObject({
      ok: true,
      value: { pk: 7, created: false },
    });
    // Stored mixed case: the email filter misses it, the username finds it,
    // and the same email ignoring case makes it the same person.
    const byUsername = fakeAuthentik([
      user({
        username: "priya@x.test",
        email: "PRIYA@x.TEST",
        attributes: { hol_learner: true, hol_user_id: "row-1" },
      }),
    ]);
    expect(await findOrCreateLearner(byUsername.api, input)).toMatchObject({
      ok: true,
      value: { pk: 7, created: false },
    });
    expect(byEmail.writes).toEqual([]);
    expect(byUsername.writes).toEqual([]);
  });

  it("never changes the type or path of a reused user", async () => {
    const ak = fakeAuthentik([user({ email: "priya@x.test" })]);
    await findOrCreateLearner(ak.api, input);
    expect(ak.users[0]).not.toHaveProperty("type");
    expect(ak.users[0]).not.toHaveProperty("path");
  });

  it("refuses two users whose emails differ only by case", async () => {
    const ak = fakeAuthentik([
      user({ pk: 7, email: "priya@x.test" }),
      user({ pk: 8, username: "priya@x.test", email: "Priya@X.test" }),
    ]);
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: false,
      error: "duplicate_email",
    });
    expect(ak.writes).toEqual([]);
  });

  it("refuses an inactive Authentik account", async () => {
    const ak = fakeAuthentik([
      user({ email: "priya@x.test", is_active: false }),
    ]);
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: false,
      error: "refused",
    });
  });

  it("returns unavailable when Authentik cannot be reached (AC-15)", async () => {
    const ak = fakeAuthentik([], { down: true });
    expect(await findOrCreateLearner(ak.api, input)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("guarded writes (AC-4, AC-6)", () => {
  const admin = user({
    pk: 1,
    groups: [ADMINS.pk],
    attributes: { hol_learner: true },
  });
  const plain = user({ pk: 2 });
  const learner = user({ pk: 3, attributes: { hol_learner: true } });

  it("never issues a recovery link for an admin or an untagged user", async () => {
    const ak = fakeAuthentik([admin, plain, learner]);
    expect(await issueSetPasswordLink(ak.api, 1)).toEqual({
      ok: false,
      error: "is_admin",
    });
    expect(await issueSetPasswordLink(ak.api, 2)).toEqual({
      ok: false,
      error: "not_learner",
    });
    expect(await issueSetPasswordLink(ak.api, 3)).toEqual({
      ok: true,
      // AC-6: 72 hours, not Authentik's default token duration.
      value: "https://auth.test/recover/3?for=hours=72",
    });
    expect(ak.writes).toEqual(["POST /core/users/3/recovery/"]);
  });

  it("never deletes an admin", async () => {
    const ak = fakeAuthentik([admin]);
    expect((await deleteSagaLearner(ak.api, 1)).ok).toBe(false);
    expect(ak.writes).toEqual([]);
  });

  it("adds learners to pod- groups only", async () => {
    const ak = fakeAuthentik([learner, admin]);
    expect(await addToPodGroup(ak.api, ADMINS.pk, 3)).toEqual({
      ok: false,
      error: "not_pod_group",
    });
    expect(await addToPodGroup(ak.api, "other-uuid", 3)).toEqual({
      ok: false,
      error: "not_pod_group",
    });
    expect(await addToPodGroup(ak.api, POD.pk, 1)).toEqual({
      ok: false,
      error: "is_admin",
    });
    expect(ak.writes).toEqual([]);
    expect((await addToPodGroup(ak.api, POD.pk, 3)).ok).toBe(true);
    expect(ak.writes).toEqual([`POST /core/groups/${POD.pk}/add_user/`]);
  });
});
