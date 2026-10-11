import { sql, type Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
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
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { reconcileAccess } from "./reconcile";
import { teardownDeletedTestbeds } from "./teardown";

// pk numbers high enough never to meet a real Authentik pk in the shared DB.
const PK = 900_000 + Math.floor(Math.random() * 90_000);

async function deletedTestbed(trx: Kysely<DB>) {
  const type = await makeType(trx);
  const pk = crypto.randomUUID();
  const tb = await makeTestbed(trx, type.id, {
    authentik_group_pk: pk,
    deleted_at: new Date(),
  });
  return {
    tb,
    pk,
    own: fakeGroup(pk, `pod-${tb.slug}`, { hol_testbed_id: tb.id }),
  };
}

const stampOf = async (trx: Kysely<DB>, id: string) =>
  (
    await trx
      .selectFrom("testbeds")
      .select("authentik_group_deleted_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).authentik_group_deleted_at;

const teardownAudits = (trx: Kysely<DB>, groupPk: string) =>
  trx
    .selectFrom("audit_events")
    .select(["actor_user_id", "target_type", "summary", "metadata"])
    .where("action", "=", "authentik_group.deleted")
    .where("target_id", "=", groupPk)
    // Only this test's rows: they carry the rollback transaction's now().
    .where("created_at", ">=", sql<Date>`now()`)
    .execute();

afterEach(() => {
  vi.restoreAllMocks();
});

// covers: spec 0007 AC-7
describe.skipIf(!hasDb)("teardownDeletedTestbeds (AC-7)", () => {
  it("waits for the reconciler to remove tagged learners, then deletes and stamps once", () =>
    inRollback(async (trx) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { tb, pk, own } = await deletedTestbed(trx);
      const ak = fakeAuthentik(
        [
          fakeLearner(PK + 1, { groups: [pk] }),
          fakeLearner(PK + 2, { groups: [pk] }),
        ],
        { groups: [own] },
      );

      await teardownDeletedTestbeds(ak.api, asConn(trx));
      expect(ak.groups.some((g) => g.pk === pk)).toBe(true);
      expect(await stampOf(trx, tb.id)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`${tb.id}.*2 tagged learner`)),
      );

      await reconcileAccess(ak.api, asConn(trx));
      await teardownDeletedTestbeds(ak.api, asConn(trx));
      expect(ak.groups.some((g) => g.pk === pk)).toBe(false);
      expect(await stampOf(trx, tb.id)).not.toBeNull();
      expect(await teardownAudits(trx, pk)).toEqual([
        {
          actor_user_id: null,
          target_type: "authentik_group",
          summary: "Access group of a deleted testbed removed",
          metadata: { testbedId: tb.id },
        },
      ]);

      // A stamped row is never looked at again, by teardown or reconciler.
      const writes = ak.writes.length;
      await teardownDeletedTestbeds(ak.api, asConn(trx));
      await reconcileAccess(ak.api, asConn(trx));
      expect(ak.writes).toHaveLength(writes);
      expect(await teardownAudits(trx, pk)).toHaveLength(1);
    }));

  it("is not stopped by an untagged member", () =>
    inRollback(async (trx) => {
      const { tb, pk, own } = await deletedTestbed(trx);
      const ak = fakeAuthentik([fakeUser({ pk: PK + 3, groups: [pk] })], {
        groups: [own],
      });
      await teardownDeletedTestbeds(ak.api, asConn(trx));
      expect(ak.writes).toEqual([`DELETE /core/groups/${pk}/`]);
      expect(await stampOf(trx, tb.id)).not.toBeNull();
    }));

  it("stamps a group that is already gone as such", () =>
    inRollback(async (trx) => {
      const { tb, pk } = await deletedTestbed(trx);
      const ak = fakeAuthentik([]);
      await teardownDeletedTestbeds(ak.api, asConn(trx));
      expect(ak.writes).toEqual([]);
      expect(await stampOf(trx, tb.id)).not.toBeNull();
      expect((await teardownAudits(trx, pk)).map((a) => a.summary)).toEqual([
        "Access group of a deleted testbed was already gone",
      ]);
    }));

  it("leaves a group carrying another testbed's id, or not a pod group, and logs it", () =>
    inRollback(async (trx) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const foreign = await deletedTestbed(trx);
      const staff = await deletedTestbed(trx);
      const ak = fakeAuthentik([], {
        groups: [
          fakeGroup(foreign.pk, `pod-${foreign.tb.slug}`, {
            hol_testbed_id: crypto.randomUUID(),
          }),
          fakeGroup(staff.pk, "staff-lab", { hol_testbed_id: staff.tb.id }),
        ],
      });
      await teardownDeletedTestbeds(ak.api, asConn(trx));
      expect(ak.writes).toEqual([]);
      expect(await stampOf(trx, foreign.tb.id)).toBeNull();
      expect(await stampOf(trx, staff.tb.id)).toBeNull();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `${foreign.tb.id} group ${foreign.pk}: not_owned`,
        ),
      );
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(
          `${staff.tb.id} group ${staff.pk}: not_pod_group`,
        ),
      );
    }));

  it("keeps going after one testbed fails", () =>
    inRollback(async (trx) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const broken = await deletedTestbed(trx);
      const good = await deletedTestbed(trx);
      const ak = fakeAuthentik([], {
        groups: [broken.own, good.own],
        fail: (_, p) => p.startsWith(`/core/groups/${broken.pk}/`),
      });
      await teardownDeletedTestbeds(ak.api, asConn(trx));
      expect(await stampOf(trx, broken.tb.id)).toBeNull();
      expect(await stampOf(trx, good.tb.id)).not.toBeNull();
      expect(ak.groups.some((g) => g.pk === broken.pk)).toBe(true);
    }));

  it("never touches a live testbed's group", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const pk = crypto.randomUUID();
      const tb = await makeTestbed(trx, type.id, { authentik_group_pk: pk });
      const ak = fakeAuthentik([], {
        groups: [fakeGroup(pk, `pod-${tb.slug}`, { hol_testbed_id: tb.id })],
      });
      await teardownDeletedTestbeds(ak.api, asConn(trx));
      expect(ak.writes).toEqual([]);
      expect(await stampOf(trx, tb.id)).toBeNull();
    }));
});

// covers: spec 0007 AC-7 (what a tick reports, and what it never touches)
describe.skipIf(!hasDb)("teardownDeletedTestbeds edges (AC-7)", () => {
  it("returns how many testbeds it stamped this tick", () =>
    inRollback(async (trx) => {
      const one = await deletedTestbed(trx);
      const two = await deletedTestbed(trx);
      const ak = fakeAuthentik([], { groups: [one.own, two.own] });
      // Other tests' rows in the shared DB may also be stamped, never fewer.
      expect(
        await teardownDeletedTestbeds(ak.api, asConn(trx)),
      ).toBeGreaterThanOrEqual(2);
      expect(await stampOf(trx, one.tb.id)).not.toBeNull();
      expect(await stampOf(trx, two.tb.id)).not.toBeNull();
      expect(await teardownDeletedTestbeds(ak.api, asConn(trx))).toBe(0);
    }));

  it("leaves a deleted testbed that never got a group to the create sweeper", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const tb = await makeTestbed(trx, type.id, {
        authentik_group_pk: null,
        deleted_at: new Date(),
      });
      const ak = fakeAuthentik([]);
      await teardownDeletedTestbeds(ak.api, asConn(trx));
      expect(ak.writes).toEqual([]);
      expect(await stampOf(trx, tb.id)).toBeNull();
    }));

  it("stamps nothing and does not throw while Authentik is down", () =>
    inRollback(async (trx) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { tb } = await deletedTestbed(trx);
      const ak = fakeAuthentik([], { down: true });
      await expect(teardownDeletedTestbeds(ak.api, asConn(trx))).resolves.toBe(
        0,
      );
      expect(await stampOf(trx, tb.id)).toBeNull();
    }));
});
