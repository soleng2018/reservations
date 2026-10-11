import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  asConn,
  hasDb,
  inRollback,
  makeAuthUser,
  makeTestbed,
  makeType,
  makeUser,
  slot,
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
      ).toEqual({ ok: true, value: { cancelled: 0 } });
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

  // covers: spec 0008 key invariant (a row with no pk is never changed)
  it("treats a row with no Authentik pk as not found, changing nothing", () =>
    inRollback(async (trx) => {
      const { actor } = await setup(trx);
      const adding = await makeUser(trx);
      const old = await makeUser(trx, {
        status: "deactivated",
        deactivated_at: new Date(),
      });
      const ak = fakeAuthentik([LEARNER]);
      expect(
        await deactivateLearner(ak.api, asConn(trx), adding.id, actor.id),
      ).toEqual({ ok: false, error: "not_found" });
      expect(
        await reactivateLearner(ak.api, asConn(trx), old.id, actor.id),
      ).toEqual({ ok: false, error: "not_found" });
      expect(ak.writes).toEqual([]);
      const rows = await trx
        .selectFrom("users")
        .select(["id", "status"])
        .where("id", "in", [adding.id, old.id])
        .execute();
      expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
        [adding.id]: "active",
        [old.id]: "deactivated",
      });
      expect(
        await trx
          .selectFrom("audit_events")
          .select("action")
          .where("target_id", "in", [adding.id, old.id])
          .execute(),
      ).toEqual([]);
    }));
});

// A booking of `userId`, `from` to `to` hours from now.
async function booking(
  trx: Kysely<DB>,
  userId: string,
  from: number,
  to: number,
  status = "confirmed",
) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  return trx
    .insertInto("bookings")
    .values({
      user_id: userId,
      testbed_id: testbed.id,
      testbed_type_id: type.id,
      starts_at: slot(from),
      ends_at: slot(to),
      status,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

const bookingOf = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("bookings")
    .select(["status", "cancel_source", "cancelled_by_user_id"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

// covers: spec 0008 AC-8, AC-9, AC-13
describe.skipIf(!hasDb)("deactivation side effects (spec 0008)", () => {
  // One live booking per learner (spec 0002), so one case per phase.
  it.each([
    { phase: "Upcoming", from: 48, to: 50 },
    { phase: "Current", from: -1, to: 2 },
  ])(
    "cancels an $phase booking, leaves a Past one, and audits it",
    ({ phase, from, to }) =>
      inRollback(async (trx) => {
        const { actor, learner } = await setup(trx);
        const live = await booking(trx, learner.id, from, to);
        const past = await booking(trx, learner.id, -10, -8, "completed");
        const ak = fakeAuthentik([LEARNER]);

        expect(
          await deactivateLearner(ak.api, asConn(trx), learner.id, actor.id),
        ).toEqual({ ok: true, value: { cancelled: 1 } });
        expect(await bookingOf(trx, live.id)).toEqual({
          status: "cancelled",
          cancel_source: "deactivation",
          cancelled_by_user_id: actor.id,
        });
        expect((await bookingOf(trx, past.id)).status).toBe("completed");

        const [cancel] = await trx
          .selectFrom("audit_events")
          .select("metadata")
          .where("action", "=", "booking.cancelled")
          .where("target_id", "=", live.id)
          .execute();
        expect(cancel?.metadata).toEqual({
          source: "deactivation",
          userId: learner.id,
          testbedId: live.testbed_id,
          phase,
        });
        const [deactivated] = await trx
          .selectFrom("audit_events")
          .select("metadata")
          .where("action", "=", "user.deactivated")
          .where("target_id", "=", learner.id)
          .execute();
        expect(deactivated?.metadata).toEqual({ cancelledBookings: 1 });
      }),
  );

  it("refuses while a booking is being set up, with no Authentik write", () =>
    inRollback(async (trx) => {
      const { actor, learner, state } = await setup(trx);
      await booking(trx, learner.id, 48, 50, "provisioning");
      const ak = fakeAuthentik([LEARNER]);
      expect(
        await deactivateLearner(ak.api, asConn(trx), learner.id, actor.id),
      ).toEqual({ ok: false, error: "booking_pending" });
      expect(ak.writes).toEqual([]);
      expect((await state()).status).toBe("active");
    }));

  it("still deactivates when the Authentik account is gone", () =>
    inRollback(async (trx) => {
      const { actor, learner, state } = await setup(trx);
      const ak = fakeAuthentik([]);
      expect(
        await deactivateLearner(ak.api, asConn(trx), learner.id, actor.id),
      ).toEqual({ ok: true, value: { cancelled: 0 } });
      expect(await state()).toMatchObject({
        status: "deactivated",
        appSessions: 0,
      });
    }));

  it("keeps bookings and the row when Authentik is down", () =>
    inRollback(async (trx) => {
      const { actor, learner } = await setup(trx);
      const upcoming = await booking(trx, learner.id, 48, 50);
      const ak = fakeAuthentik([LEARNER], { down: true });
      expect(
        await deactivateLearner(ak.api, asConn(trx), learner.id, actor.id),
      ).toEqual({ ok: false, error: "unavailable" });
      expect((await bookingOf(trx, upcoming.id)).status).toBe("confirmed");
    }));

  it("is a no op with no audit row when repeated", () =>
    inRollback(async (trx) => {
      const { actor, learner, state } = await setup(trx);
      const ak = fakeAuthentik([LEARNER]);
      await deactivateLearner(ak.api, asConn(trx), learner.id, actor.id);
      const writes = ak.writes.length;
      expect(
        await deactivateLearner(ak.api, asConn(trx), learner.id, actor.id),
      ).toEqual({ ok: true, value: { cancelled: 0 } });
      expect(ak.writes).toHaveLength(writes);
      expect((await state()).audits).toEqual(["user.deactivated"]);

      await reactivateLearner(ak.api, asConn(trx), learner.id, actor.id);
      await reactivateLearner(ak.api, asConn(trx), learner.id, actor.id);
      expect(
        (await state()).audits.filter((a) => a === "user.reactivated"),
      ).toHaveLength(1);
    }));

  it("reactivate keeps the row deactivated when the Authentik account is gone", () =>
    inRollback(async (trx) => {
      const { actor, learner, state } = await setup(trx);
      await deactivateLearner(
        fakeAuthentik([LEARNER]).api,
        asConn(trx),
        learner.id,
        actor.id,
      );
      expect(
        await reactivateLearner(
          fakeAuthentik([]).api,
          asConn(trx),
          learner.id,
          actor.id,
        ),
      ).toEqual({ ok: false, error: "not_found" });
      expect((await state()).status).toBe("deactivated");
    }));
});
