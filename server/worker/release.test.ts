import { sql, type Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeAuthentik,
  fakeLearner,
  fakeUser,
  groupWrites,
  markedGroup,
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
import { releaseDeletedTestbeds } from "./release";

// No CLOUDFLARE key: the revoke is off (spec 0012 AC-11).
const OFF = async () => ({ kind: "off" }) as const;

// pk numbers high enough never to meet a real Authentik pk in the shared DB.
const PK = 900_000 + Math.floor(Math.random() * 90_000);

async function deletedTestbed(trx: Kysely<DB>) {
  const type = await makeType(trx);
  const pk = crypto.randomUUID();
  const tb = await makeTestbed(trx, type.id, {
    authentik_group_pk: pk,
    deleted_at: new Date(),
  });
  return { type, tb, pk, own: markedGroup(pk, tb.name) };
}

const stampOf = async (trx: Kysely<DB>, id: string) =>
  (
    await trx
      .selectFrom("testbeds")
      .select("authentik_group_deleted_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).authentik_group_deleted_at;

const releaseAudits = (trx: Kysely<DB>, groupPk: string) =>
  trx
    .selectFrom("audit_events")
    .select(["actor_user_id", "target_type", "summary", "metadata"])
    .where("action", "=", "authentik_group.released")
    .where("target_id", "=", groupPk)
    // Only this test's rows: they carry the rollback transaction's now().
    .where("created_at", ">=", sql<Date>`now()`)
    .execute();

afterEach(() => {
  vi.restoreAllMocks();
});

// covers: spec 0017 AC-9
describe.skipIf(!hasDb)("releaseDeletedTestbeds (spec 0017 AC-9)", () => {
  it("waits for the reconciler to remove tagged learners, then stamps once and deletes no group", () =>
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

      await releaseDeletedTestbeds(ak.api, asConn(trx));
      expect(await stampOf(trx, tb.id)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("2 tagged learner(s)"),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(tb.id));
      expect(await releaseAudits(trx, pk)).toEqual([]);

      // The reconciler empties the group, then the release stamps it.
      vi.spyOn(console, "error").mockImplementation(() => {});
      await reconcileAccess(ak.api, asConn(trx), OFF);
      expect(await releaseDeletedTestbeds(ak.api, asConn(trx))).toBe(1);
      expect(await stampOf(trx, tb.id)).not.toBeNull();
      expect(await releaseAudits(trx, pk)).toEqual([
        {
          actor_user_id: null,
          target_type: "authentik_group",
          summary: "Testbed group released",
          metadata: { testbedId: tb.id, reason: "drained" },
        },
      ]);
      // The group stays: the app never deletes one.
      expect(ak.groups.some((g) => g.pk === pk)).toBe(true);
      expect(groupWrites(ak.writes)).toEqual([]);

      // Stamped rows are skipped from then on.
      expect(await releaseDeletedTestbeds(ak.api, asConn(trx))).toBe(0);
      expect(await releaseAudits(trx, pk)).toHaveLength(1);
    }));

  it("never lets an untagged member stop a release, and removes none", () =>
    inRollback(async (trx) => {
      const { tb, pk, own } = await deletedTestbed(trx);
      const ak = fakeAuthentik([fakeUser({ pk: PK + 3, groups: [pk] })], {
        groups: [own],
      });
      await releaseDeletedTestbeds(ak.api, asConn(trx));
      expect(await stampOf(trx, tb.id)).not.toBeNull();
      expect(ak.users[0]?.groups).toEqual([pk]);
      expect(ak.writes).toEqual([]);
    }));

  it("stamps a missing group as gone, with no group write", () =>
    inRollback(async (trx) => {
      const { tb, pk } = await deletedTestbed(trx);
      const ak = fakeAuthentik([]);
      expect(await releaseDeletedTestbeds(ak.api, asConn(trx))).toBe(1);
      expect(await stampOf(trx, tb.id)).not.toBeNull();
      expect(await releaseAudits(trx, pk)).toEqual([
        expect.objectContaining({
          metadata: { testbedId: tb.id, reason: "gone" },
        }),
      ]);
      expect(ak.writes).toEqual([]);
    }));

  it("stamps at once, as shared, when a live testbed holds the same group, with no Authentik call", () =>
    inRollback(async (trx) => {
      const { type, tb, pk } = await deletedTestbed(trx);
      await makeTestbed(trx, type.id, { authentik_group_pk: pk });
      const ak = fakeAuthentik([fakeLearner(PK + 4, { groups: [pk] })], {
        down: true,
      });
      expect(await releaseDeletedTestbeds(ak.api, asConn(trx))).toBe(1);
      expect(await stampOf(trx, tb.id)).not.toBeNull();
      expect(await releaseAudits(trx, pk)).toEqual([
        expect.objectContaining({
          metadata: { testbedId: tb.id, reason: "shared" },
        }),
      ]);
    }));

  it("leaves the row for the next tick when Authentik cannot be reached", () =>
    inRollback(async (trx) => {
      const { tb } = await deletedTestbed(trx);
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const ak = fakeAuthentik([], { down: true });
      expect(await releaseDeletedTestbeds(ak.api, asConn(trx))).toBe(0);
      expect(await stampOf(trx, tb.id)).toBeNull();
      expect(error).toHaveBeenCalled();
    }));

  it("lets one failing row not stop the next", () =>
    inRollback(async (trx) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const broken = await deletedTestbed(trx);
      const fine = await deletedTestbed(trx);
      const ak = fakeAuthentik([], {
        groups: [broken.own, fine.own],
        fail: (_m, p) => p.startsWith(`/core/groups/${broken.pk}/`),
      });
      await releaseDeletedTestbeds(ak.api, asConn(trx));
      expect(await stampOf(trx, broken.tb.id)).toBeNull();
      expect(await stampOf(trx, fine.tb.id)).not.toBeNull();
    }));

  it("leaves a live testbed alone", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const live = await makeTestbed(trx, type.id);
      const ak = fakeAuthentik([]);
      await releaseDeletedTestbeds(ak.api, asConn(trx));
      expect(await stampOf(trx, live.id)).toBeNull();
    }));
});
