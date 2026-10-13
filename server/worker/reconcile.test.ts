import { sql, type Kysely, type Transaction } from "kysely";
import { describe, expect, it } from "vitest";
import {
  fakeAuthentik,
  fakeGroup,
  fakeLearner,
  fakeUser,
} from "@/server/authentik/testing";
import {
  cancelOwnBooking,
  rescheduleOwnBooking,
} from "@/server/booking/manage";
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
import { reconcileAccess } from "./reconcile";

const groupPk = () => crypto.randomUUID();

async function bookingOn(
  trx: Kysely<DB>,
  testbedId: string,
  typeId: string,
  authentikPk: number,
  from: number,
  to: number,
) {
  const user = await makeUser(trx, { authentik_user_pk: authentikPk });
  const booking = await trx
    .insertInto("bookings")
    .values({
      user_id: user.id,
      testbed_id: testbedId,
      testbed_type_id: typeId,
      starts_at: slot(from),
      ends_at: slot(to),
      status: "confirmed",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { user, booking };
}

const audited = (trx: Kysely<DB>, action: string) =>
  trx
    .selectFrom("audit_events")
    .select(["target_type", "target_id", "metadata"])
    .where("action", "=", action)
    // Only this test's rows: they carry the rollback transaction's now(),
    // while rows committed earlier (an e2e run) are older.
    .where("created_at", ">=", sql<Date>`now()`)
    .execute();

// pk numbers high enough never to meet a real Authentik pk in the shared DB.
const PK = 900_000 + Math.floor(Math.random() * 90_000);

// covers: AC-12
describe.skipIf(!hasDb)("reconcileAccess (AC-12)", () => {
  it("adds the Current learner, removes the ended one, keeps untagged members", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      const now = await bookingOn(trx, testbed.id, type.id, PK + 1, -1, 2);
      const ended = await makeUser(trx, { authentik_user_pk: PK + 2 });
      const ak = fakeAuthentik(
        [
          fakeLearner(PK + 1),
          fakeLearner(PK + 2, { groups: [pk] }),
          fakeUser({ pk: PK + 3, groups: [pk] }),
        ],
        {
          groups: [fakeGroup(pk, `pod-${testbed.slug}`)],
          sessions: [
            {
              uuid: "s1",
              user: PK + 2,
              username: `learner-${PK + 2}@x.test`,
            },
          ],
        },
      );
      await reconcileAccess(ak.api, asConn(trx));

      const members = ak.users.filter((u) => u.groups.includes(pk));
      expect(members.map((u) => u.pk).sort()).toEqual([PK + 1, PK + 3]);
      expect(ak.sessions).toEqual([]);
      expect(await audited(trx, "access.granted")).toEqual([
        expect.objectContaining({
          target_type: "booking",
          target_id: now.booking.id,
        }),
      ]);
      expect(await audited(trx, "access.revoked")).toEqual([
        expect.objectContaining({ target_type: "user", target_id: ended.id }),
      ]);
    }));

  it("empties a soft deleted testbed's group of tagged learners", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      await bookingOn(trx, testbed.id, type.id, PK + 1, -1, 2);
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", testbed.id)
        .execute();
      const ak = fakeAuthentik([fakeLearner(PK + 1, { groups: [pk] })], {
        groups: [fakeGroup(pk, `pod-${testbed.slug}`)],
      });
      await reconcileAccess(ak.api, asConn(trx));
      expect(ak.users[0]?.groups).toEqual([]);
    }));

  it("skips a missing or failing group and still runs the next", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const [gone, broken, good] = [groupPk(), groupPk(), groupPk()];
      const tb = (pk: string) =>
        makeTestbed(trx, type.id, { authentik_group_pk: pk });
      const [a, b, c] = [await tb(gone), await tb(broken), await tb(good)];
      await bookingOn(trx, a.id, type.id, PK + 1, -1, 2);
      await bookingOn(trx, b.id, type.id, PK + 2, -1, 2);
      await bookingOn(trx, c.id, type.id, PK + 3, -1, 2);
      const ak = fakeAuthentik(
        [fakeLearner(PK + 1), fakeLearner(PK + 2), fakeLearner(PK + 3)],
        {
          groups: [
            fakeGroup(broken, `pod-${b.slug}`),
            fakeGroup(good, `pod-${c.slug}`),
          ],
          fail: (m, p) => p.startsWith(`/core/groups/${broken}/`),
        },
      );
      await reconcileAccess(ak.api, asConn(trx));
      expect(ak.users.find((u) => u.pk === PK + 3)?.groups).toEqual([good]);
      expect(ak.users.find((u) => u.pk === PK + 2)?.groups).toEqual([]);
    }));

  it("writes no audit row when the add fails", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      const { booking } = await bookingOn(
        trx,
        testbed.id,
        type.id,
        PK + 1,
        -1,
        2,
      );
      const ak = fakeAuthentik([fakeLearner(PK + 1)], {
        groups: [fakeGroup(pk, `pod-${testbed.slug}`)],
        fail: (m, p) => p.endsWith("/add_user/"),
      });
      await reconcileAccess(ak.api, asConn(trx));
      const rows = await audited(trx, "access.granted");
      expect(rows.filter((r) => r.target_id === booking.id)).toEqual([]);
    }));

  it("reads members over 100 across pages", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      const stale = Array.from({ length: 130 }, (_, i) =>
        fakeLearner(PK + 10 + i, { groups: [pk] }),
      );
      const ak = fakeAuthentik(stale, {
        groups: [fakeGroup(pk, `pod-${testbed.slug}`)],
      });
      await reconcileAccess(ak.api, asConn(trx));
      expect(ak.users.filter((u) => u.groups.includes(pk))).toEqual([]);
    }));
});

// covers: spec 0008 AC-11
describe.skipIf(!hasDb)("reconcileAccess skips deactivated learners", () => {
  it("removes a deactivated learner even with a confirmed Current booking", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = groupPk();
      const testbed = await makeTestbed(trx, type.id, {
        authentik_group_pk: pk,
      });
      const { user } = await bookingOn(trx, testbed.id, type.id, PK + 7, -1, 2);
      // Forced: a confirmed booking that slipped past the deactivation.
      await trx
        .updateTable("users")
        .set({ status: "deactivated", deactivated_at: sql<Date>`now()` })
        .where("id", "=", user.id)
        .execute();
      const ak = fakeAuthentik([fakeLearner(PK + 7, { groups: [pk] })], {
        groups: [fakeGroup(pk, `pod-${testbed.slug}`)],
      });

      await reconcileAccess(ak.api, asConn(trx));
      expect(ak.writes).toContain(`POST /core/groups/${pk}/remove_user/`);
      expect(ak.users[0]?.groups).toEqual([]);
    }));
});

// covers: spec 0011 AC-16
describe.skipIf(!hasDb)(
  "reconcileAccess after a learner's change (spec 0011)",
  () => {
    // A learner in a Current booking on `a`, already in its group, with one
    // Authentik session and one app (Better Auth) session.
    async function inLab(trx: Transaction<DB>) {
      const type = await makeType(trx);
      const [pkA, pkB] = [groupPk(), groupPk()];
      const u = crypto.randomUUID().slice(0, 8);
      const a = await makeTestbed(trx, type.id, {
        name: `a ${u}`,
        authentik_group_pk: pkA,
      });
      const b = await makeTestbed(trx, type.id, {
        name: `b ${u}`,
        authentik_group_pk: pkB,
      });
      const authUserId = await makeAuthUser(trx, PK + 20, 1);
      const { user, booking } = await bookingOn(
        trx,
        a.id,
        type.id,
        PK + 20,
        -1,
        2,
      );
      await trx
        .updateTable("users")
        .set({ auth_user_id: authUserId })
        .where("id", "=", user.id)
        .execute();
      const version = (
        await trx
          .selectFrom("bookings")
          .select("version")
          .where("id", "=", booking.id)
          .executeTakeFirstOrThrow()
      ).version;
      const ak = fakeAuthentik([fakeLearner(PK + 20, { groups: [pkA] })], {
        groups: [
          fakeGroup(pkA, `pod-${a.slug}`),
          fakeGroup(pkB, `pod-${b.slug}`),
        ],
        sessions: [
          { uuid: "s20", user: PK + 20, username: `learner-${PK + 20}@x.test` },
        ],
      });
      const appSessions = async () =>
        (
          await trx
            .selectFrom("hol_auth.session")
            .select("id")
            .where("userId", "=", authUserId)
            .execute()
        ).length;
      return { a, b, pkA, pkB, user, booking, version, ak, appSessions };
    }

    it("removes a learner who cancelled their Current booking and ends their Authentik sessions", () =>
      inRollback(async (trx) => {
        const w = await inLab(trx);
        expect(
          await cancelOwnBooking(
            asConn(trx),
            w.user.id,
            w.booking.id,
            w.version,
          ),
        ).toEqual({ ok: true, value: undefined });
        await reconcileAccess(w.ak.api, asConn(trx));
        expect(w.ak.users[0]?.groups).toEqual([]);
        expect(w.ak.sessions).toEqual([]);
        expect(await audited(trx, "access.revoked")).toEqual([
          expect.objectContaining({
            target_type: "user",
            target_id: w.user.id,
          }),
        ]);
        // The app session stays, so they stay on /reservations.
        expect(await w.appSessions()).toBe(1);
      }));

    it("removes a learner who moved their Current booking later", () =>
      inRollback(async (trx) => {
        const w = await inLab(trx);
        const moved = await rescheduleOwnBooking(asConn(trx), w.user.id, {
          bookingId: w.booking.id,
          version: w.version,
          startsAt: slot(24),
        });
        expect(moved.ok).toBe(true);
        await reconcileAccess(w.ak.api, asConn(trx));
        expect(w.ak.users[0]?.groups).toEqual([]);
        expect(w.ak.sessions).toEqual([]);
        expect(await w.appSessions()).toBe(1);
      }));

    it("adds the learner to the new testbed's group once a move there starts", () =>
      inRollback(async (trx) => {
        const w = await inLab(trx);
        // Someone else holds a at the new time, so the move lands on b.
        await bookingOn(trx, w.a.id, w.a.testbed_type_id, PK + 21, 23, 27);
        const moved = await rescheduleOwnBooking(asConn(trx), w.user.id, {
          bookingId: w.booking.id,
          version: w.version,
          startsAt: slot(24),
        });
        expect(moved.ok && moved.value.testbedName).toBe(w.b.name);
        // Forced: the moved booking's start arrives.
        await trx
          .updateTable("bookings")
          .set({ starts_at: slot(-1), ends_at: slot(1) })
          .where("id", "=", w.booking.id)
          .execute();
        await reconcileAccess(w.ak.api, asConn(trx));
        expect(w.ak.users.find((u) => u.pk === PK + 20)?.groups).toEqual([
          w.pkB,
        ]);
      }));
  },
);
