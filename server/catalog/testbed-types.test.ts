import type { Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
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
import {
  deleteTestbedType,
  listTestbedTypes,
  updateTestbedType,
} from "./testbed-types";

// Feature 7: edit, delete, and the usage count. Rules from spec 0002 AC-4,
// AC-5, AC-14.

const unique = () => crypto.randomUUID().slice(0, 8);

const auditsFor = (trx: Kysely<DB>, targetId: string) =>
  trx
    .selectFrom("audit_events")
    .select(["action", "actor_user_id", "metadata"])
    .where("target_id", "=", targetId)
    .orderBy("created_at")
    .execute();

const typeRow = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("testbed_types")
    .select(["name", "duration_value", "duration_unit", "deleted_at"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

afterAll(() => (hasDb ? db().destroy() : undefined));

describe.skipIf(!hasDb)("listTestbedTypes usage count", () => {
  it("counts only the live testbeds of each type", () =>
    inRollback(async (trx) => {
      const tag = unique();
      const used = await makeType(trx, { name: `used ${tag}` });
      const unused = await makeType(trx, { name: `unused ${tag}` });
      await makeTestbed(trx, used.id);
      await makeTestbed(trx, used.id);
      await makeTestbed(trx, used.id, { deleted_at: new Date() });
      await makeTestbed(trx, unused.id, { deleted_at: new Date() });

      const mine = (await listTestbedTypes(trx)).filter((t) =>
        t.name.endsWith(tag),
      );

      expect(mine.map((t) => [t.name, t.testbedCount])).toEqual([
        [`unused ${tag}`, 0],
        [`used ${tag}`, 2],
      ]);
    }));
});

describe.skipIf(!hasDb)("updateTestbedType", () => {
  it("saves the new values and audits only the changed fields", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const type = await makeType(trx, { name: `Basic ${unique()}` });
      const input = {
        name: type.name,
        durationValue: 4,
        durationUnit: "days",
      } as const;

      const result = await updateTestbedType(
        asConn(trx),
        type.id,
        input,
        admin.id,
      );

      expect(result).toEqual({ ok: true, value: undefined });
      expect(await typeRow(trx, type.id)).toMatchObject({
        duration_value: 4,
        duration_unit: "days",
      });
      expect(await auditsFor(trx, type.id)).toEqual([
        {
          action: "testbed_type.updated",
          actor_user_id: admin.id,
          metadata: {
            durationValue: { from: 2, to: 4 },
            durationUnit: { from: "hours", to: "days" },
          },
        },
      ]);
    }));

  it("writes no audit entry when nothing changed", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const type = await makeType(trx);

      const result = await updateTestbedType(
        asConn(trx),
        type.id,
        { name: type.name, durationValue: 2, durationUnit: "hours" },
        admin.id,
      );

      expect(result.ok).toBe(true);
      expect(await auditsFor(trx, type.id)).toEqual([]);
    }));

  it("refuses another live type's name ignoring case, leaving the row as it was", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const taken = await makeType(trx, { name: `Taken ${unique()}` });
      const type = await makeType(trx);

      const result = await updateTestbedType(
        asConn(trx),
        type.id,
        {
          name: taken.name.toUpperCase(),
          durationValue: 9,
          durationUnit: "days",
        },
        admin.id,
      );

      expect(result).toEqual({ ok: false, error: "duplicate_name" });
      expect(await typeRow(trx, type.id)).toMatchObject({
        name: type.name,
        duration_value: 2,
      });
      expect(await auditsFor(trx, type.id)).toEqual([]);
    }));

  it("allows a change of case to its own name, and a deleted type's name", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const type = await makeType(trx, { name: `Own ${unique()}` });
      const gone = await makeType(trx, {
        name: `Gone ${unique()}`,
        deleted_at: new Date(),
      });
      const edit = (name: string) =>
        updateTestbedType(
          asConn(trx),
          type.id,
          { name, durationValue: 2, durationUnit: "hours" },
          admin.id,
        );

      expect((await edit(type.name.toUpperCase())).ok).toBe(true);
      expect((await edit(gone.name)).ok).toBe(true);
      expect((await typeRow(trx, type.id)).name).toBe(gone.name);
    }));

  it("refuses a missing or deleted type as not found", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const deleted = await makeType(trx, { deleted_at: new Date() });
      const input = {
        name: `x ${unique()}`,
        durationValue: 1,
        durationUnit: "hours",
      } as const;

      for (const id of [crypto.randomUUID(), deleted.id])
        expect(
          await updateTestbedType(asConn(trx), id, input, admin.id),
        ).toEqual({ ok: false, error: "not_found" });
    }));

  it("keeps an existing booking's end when the duration changes", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const learner = await makeUser(trx);
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const startsAt = slot(48);
      const endsAt = new Date(startsAt.getTime() + 2 * 3_600_000);
      const booking = await trx
        .insertInto("bookings")
        .values({
          user_id: learner.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: startsAt,
          ends_at: endsAt,
          status: "confirmed",
        })
        .returning("id")
        .executeTakeFirstOrThrow();

      await updateTestbedType(
        asConn(trx),
        type.id,
        { name: type.name, durationValue: 5, durationUnit: "days" },
        admin.id,
      );

      const after = await trx
        .selectFrom("bookings")
        .select("ends_at")
        .where("id", "=", booking.id)
        .executeTakeFirstOrThrow();
      expect(after.ends_at).toEqual(endsAt);
    }));
});

describe.skipIf(!hasDb)("deleteTestbedType", () => {
  it("soft deletes an unused type, audits it, and frees its name", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const type = await makeType(trx);
      await makeTestbed(trx, type.id, { deleted_at: new Date() });

      const result = await deleteTestbedType(asConn(trx), type.id, admin.id);

      expect(result).toEqual({ ok: true, value: undefined });
      expect((await typeRow(trx, type.id)).deleted_at).not.toBeNull();
      expect(await auditsFor(trx, type.id)).toEqual([
        {
          action: "testbed_type.deleted",
          actor_user_id: admin.id,
          metadata: {},
        },
      ]);
      expect((await listTestbedTypes(trx)).some((t) => t.id === type.id)).toBe(
        false,
      );
      await expect(makeType(trx, { name: type.name })).resolves.toBeDefined();
    }));

  it("refuses while live testbeds use the type, listing them by name", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const type = await makeType(trx);
      const b = await makeTestbed(trx, type.id, { name: `b ${unique()}` });
      const a = await makeTestbed(trx, type.id, { name: `a ${unique()}` });

      const result = await deleteTestbedType(asConn(trx), type.id, admin.id);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: "blocked",
          blockers: [
            { id: a.id, label: a.name },
            { id: b.id, label: b.name },
          ],
        },
      });
      expect((await typeRow(trx, type.id)).deleted_at).toBeNull();
      expect(await auditsFor(trx, type.id)).toEqual([]);
    }));

  it("refuses a missing or already deleted type as not found", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const deleted = await makeType(trx, { deleted_at: new Date() });

      for (const id of [crypto.randomUUID(), deleted.id])
        expect(await deleteTestbedType(asConn(trx), id, admin.id)).toEqual({
          ok: false,
          error: { kind: "not_found" },
        });
    }));

  it("keeps past bookings joined to the deleted type", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin", company: null });
      const learner = await makeUser(trx);
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const startsAt = slot(-48);
      const booking = await trx
        .insertInto("bookings")
        .values({
          user_id: learner.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: startsAt,
          ends_at: new Date(startsAt.getTime() + 2 * 3_600_000),
          status: "confirmed",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", testbed.id)
        .execute();

      expect((await deleteTestbedType(asConn(trx), type.id, admin.id)).ok).toBe(
        true,
      );
      const joined = await trx
        .selectFrom("bookings")
        .innerJoin(
          "testbed_types",
          "testbed_types.id",
          "bookings.testbed_type_id",
        )
        .select("testbed_types.name")
        .where("bookings.id", "=", booking.id)
        .executeTakeFirstOrThrow();
      expect(joined.name).toBe(type.name);
    }));
});
