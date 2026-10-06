import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { lockBookableTestbed } from "./bookings";
import {
  lockForDelete,
  testbedBlockers,
  testbedTypeBlockers,
} from "./delete-blockers";
import {
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "./testing";

describe.skipIf(!hasDb)("delete blockers", () => {
  afterAll(() => db().destroy());

  it("lists live testbeds using a type, not deleted ones (AC-4)", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const a = await makeTestbed(trx, type.id, { name: "Alpha" });
      await makeTestbed(trx, type.id, { deleted_at: new Date() });
      expect(await testbedTypeBlockers(trx, type.id)).toEqual([
        { id: a.id, label: "Alpha" },
      ]);
      expect(await testbedTypeBlockers(trx, (await makeType(trx)).id)).toEqual(
        [],
      );
    }));

  it("blocks a testbed only on live bookings that have not ended (AC-4)", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const tb = await makeTestbed(trx, type.id);
      const learner = await makeUser(trx, { name: "Priya" });
      const pastUser = await makeUser(trx);
      const book = (userId: string, from: number, to: number) =>
        trx
          .insertInto("bookings")
          .values({
            user_id: userId,
            testbed_id: tb.id,
            testbed_type_id: type.id,
            starts_at: slot(from),
            ends_at: slot(to),
            status: "confirmed",
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      const past = await book(pastUser.id, -6, -4);
      expect(await testbedBlockers(trx, tb.id)).toEqual([]);

      const upcoming = await book(learner.id, 24, 26);
      expect(await testbedBlockers(trx, tb.id)).toEqual([
        { id: upcoming.id, label: "Priya" },
      ]);

      // With only Past bookings left, the delete goes through and history
      // still joins to the soft deleted testbed and type.
      await trx.deleteFrom("bookings").where("id", "=", upcoming.id).execute();
      expect(await lockForDelete(trx, "testbeds", tb.id)).toBe(true);
      expect(await testbedBlockers(trx, tb.id)).toEqual([]);
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", tb.id)
        .execute();
      const joined = await trx
        .selectFrom("bookings")
        .innerJoin("testbeds", "testbeds.id", "bookings.testbed_id")
        .innerJoin(
          "testbed_types",
          "testbed_types.id",
          "bookings.testbed_type_id",
        )
        .select(["testbeds.name as testbed", "testbed_types.name as type"])
        .where("bookings.id", "=", past.id)
        .executeTakeFirst();
      expect(joined).toEqual({ testbed: tb.name, type: type.name });
      expect(await lockForDelete(trx, "testbeds", tb.id)).toBe(false);
    }));

  // The cross connection wait (delete FOR UPDATE vs booking FOR SHARE) needs a
  // committed testbed both connections can see, and these tests never commit,
  // so it rests on Postgres's documented row lock conflict. What is checked
  // here: a booking that gets the lock after the delete sees it and refuses.
  it("refuses a booking once the delete went through (AC-14)", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const tb = await makeTestbed(trx, type.id);
      expect(await lockForDelete(trx, "testbeds", tb.id)).toBe(true);
      expect(await testbedBlockers(trx, tb.id)).toEqual([]);
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", tb.id)
        .execute();
      expect(await lockBookableTestbed(trx, tb.id)).toEqual({
        ok: false,
        error: "not_bookable",
      });
    }));
});
