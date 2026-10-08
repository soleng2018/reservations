import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  asConn,
  hasDb,
  inRollback,
  makeAuthUser,
  makeUser,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { deactivateLearner, reactivateLearner } from "./learners";
import { ADMINS, fakeAuthentik, fakeUser, type FakeSession } from "./testing";

const LEARNER = fakeUser({
  pk: 3,
  username: "pat@x.test",
  attributes: { hol_learner: true },
});
const session = (uuid: string, user = 3, username = "pat@x.test") =>
  ({ uuid, user, username }) satisfies FakeSession;

async function setup(trx: Kysely<DB>) {
  const actor = await makeUser(trx, { role: "admin" });
  const authUserId = await makeAuthUser(trx, 3, 2);
  const learner = await makeUser(trx, {
    authentik_user_pk: 3,
    auth_user_id: authUserId,
  });
  const state = async () => ({
    status: (
      await trx
        .selectFrom("users")
        .select("status")
        .where("id", "=", learner.id)
        .executeTakeFirstOrThrow()
    ).status,
    appSessions: (
      await trx
        .selectFrom("hol_auth.session")
        .select("id")
        .where("userId", "=", authUserId)
        .execute()
    ).length,
    audits: (
      await trx
        .selectFrom("audit_events")
        .select("action")
        .where("target_id", "=", learner.id)
        .execute()
    ).map((a) => a.action),
  });
  return { actor, learner, state };
}

// covers: AC-9, AC-4
describe.skipIf(!hasDb)("deactivate and reactivate a learner (AC-9)", () => {
  it("deactivates in Authentik, ends every session, and records it", () =>
    inRollback(async (trx) => {
      const { actor, learner, state } = await setup(trx);
      const ak = fakeAuthentik([LEARNER], {
        sessions: [
          session("s1"),
          session("s2"),
          session("other", 9, "pat@x.test"),
        ],
      });

      expect(
        await deactivateLearner(ak.api, asConn(trx), learner.id, actor.id),
      ).toEqual({ ok: true, value: undefined });
      expect(ak.users[0]?.is_active).toBe(false);
      // Both of this user's Authentik sessions end; a stray row whose user
      // pk differs is left alone.
      expect(ak.sessions.map((s) => s.uuid)).toEqual(["other"]);
      expect(await state()).toEqual({
        status: "deactivated",
        appSessions: 0,
        audits: ["user.deactivated"],
      });
    }));

  it("reactivates in Authentik and in the app", () =>
    inRollback(async (trx) => {
      const { actor, learner, state } = await setup(trx);
      const ak = fakeAuthentik([LEARNER]);
      await deactivateLearner(ak.api, asConn(trx), learner.id, actor.id);

      expect(
        await reactivateLearner(ak.api, asConn(trx), learner.id, actor.id),
      ).toEqual({ ok: true, value: undefined });
      expect(ak.users[0]?.is_active).toBe(true);
      expect(await state()).toMatchObject({
        status: "active",
        audits: expect.arrayContaining([
          "user.deactivated",
          "user.reactivated",
        ]),
      });
    }));

  it("refuses an admin row without any Authentik call (AC-4)", () =>
    inRollback(async (trx) => {
      const { actor } = await setup(trx);
      const ak = fakeAuthentik([LEARNER]);
      for (const change of [deactivateLearner, reactivateLearner])
        expect(await change(ak.api, asConn(trx), actor.id, actor.id)).toEqual({
          ok: false,
          error: "is_admin",
        });
      expect(ak.writes).toEqual([]);
    }));

  it("refuses when Authentik says the user is an admin, changing nothing", () =>
    inRollback(async (trx) => {
      const { actor, learner, state } = await setup(trx);
      const ak = fakeAuthentik([{ ...LEARNER, groups: [ADMINS.pk] }], {
        sessions: [session("s1")],
      });
      expect(
        await deactivateLearner(ak.api, asConn(trx), learner.id, actor.id),
      ).toEqual({ ok: false, error: "is_admin" });
      expect(ak.writes).toEqual([]);
      expect(await state()).toEqual({
        status: "active",
        appSessions: 2,
        audits: [],
      });
    }));

  it("changes nothing in the app when Authentik is down (AC-15)", () =>
    inRollback(async (trx) => {
      const { actor, learner, state } = await setup(trx);
      const ak = fakeAuthentik([LEARNER], { down: true });
      expect(
        await deactivateLearner(ak.api, asConn(trx), learner.id, actor.id),
      ).toEqual({ ok: false, error: "unavailable" });
      expect(await state()).toEqual({
        status: "active",
        appSessions: 2,
        audits: [],
      });
    }));

  it("returns not_found for an unknown row", () =>
    inRollback(async (trx) => {
      const { actor } = await setup(trx);
      const ak = fakeAuthentik([]);
      expect(
        await deactivateLearner(
          ak.api,
          asConn(trx),
          crypto.randomUUID(),
          actor.id,
        ),
      ).toEqual({ ok: false, error: "not_found" });
    }));
});
