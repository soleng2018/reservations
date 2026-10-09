import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  fakeAuthentik,
  fakeGroup,
  fakeLearner,
  fakeUser,
} from "@/server/authentik/testing";
import {
  asConn,
  hasDb,
  inRollback,
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
    .where("created_at", ">=", new Date(Date.now() - 60_000))
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
