import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { HORIZON_MS, LEAD_MS, SLOT_MS } from "@/lib/slots";
import { dbNow } from "@/server/db/bookings";
import {
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { bookableTypes, firstFreeTestbed, startsFor } from "./availability";

const HOUR = 3_600_000;

// The first offerable start from DB now().
const firstStart = async (trx: Kysely<DB>) => {
  const now = await dbNow(trx);
  return Math.ceil((now.getTime() + LEAD_MS) / SLOT_MS) * SLOT_MS;
};

const book = async (
  trx: Kysely<DB>,
  testbed: { id: string; testbed_type_id: string },
  from: number,
  to: number,
) => {
  const user = await makeUser(trx);
  await trx
    .insertInto("bookings")
    .values({
      user_id: user.id,
      testbed_id: testbed.id,
      testbed_type_id: testbed.testbed_type_id,
      starts_at: new Date(from),
      ends_at: new Date(to),
      status: "confirmed",
    })
    .execute();
};

// covers: spec 0004 AC-3, spec 0010 AC-1, AC-4, AC-7
describe.skipIf(!hasDb)("availability (AC-3)", () => {
  it("lists only types with a bookable testbed, with their duration", () =>
    inRollback(async (trx) => {
      const ready = await makeType(trx, {
        duration_value: 4,
        duration_unit: "hours",
      });
      await makeTestbed(trx, ready.id);
      const allDeleted = await makeType(trx);
      await makeTestbed(trx, allDeleted.id, { deleted_at: new Date() });
      const empty = await makeType(trx);
      const types = await bookableTypes(trx);
      const ids = types.map((t) => t.id);
      expect(ids).toContain(ready.id);
      expect(ids).not.toContain(allDeleted.id);
      expect(ids).not.toContain(empty.id);
      expect(types.find((t) => t.id === ready.id)).toMatchObject({
        durationValue: 4,
        durationUnit: "hours",
      });
    }));

  it("skips starts where every testbed of the type is busy", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx, { duration_value: 2 });
      const testbed = await makeTestbed(trx, type.id);
      const first = await firstStart(trx);
      await book(trx, testbed, first + 2 * HOUR, first + 4 * HOUR);

      const starts = (await startsFor(trx, type.id)).starts.map((d) =>
        d.getTime(),
      );
      expect(starts[0]).toBe(first);
      expect(starts).not.toContain(first + HOUR);
      expect(starts).not.toContain(first + 3 * HOUR);
      expect(starts).toContain(first + 4 * HOUR);

      // A second testbed frees the busy window again.
      await makeTestbed(trx, type.id);
      const again = (await startsFor(trx, type.id)).starts;
      expect(again.map((d) => d.getTime())).toContain(first + HOUR);
    }));

  // spec 0010 AC-4
  it("returns the type's duration and the DB clock with the starts", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx, {
        duration_value: 1,
        duration_unit: "days",
      });
      await makeTestbed(trx, type.id);
      const result = await startsFor(trx, type.id);
      expect(result.durationMs).toBe(24 * HOUR);
      // Inside a transaction now() is the transaction's start time.
      expect(result.now).toEqual(await dbNow(trx));
      expect(result.starts.length).toBeGreaterThan(0);
    }));

  it("has nothing for an unknown type", () =>
    inRollback(async (trx) => {
      const result = await startsFor(trx, crypto.randomUUID());
      expect(result.starts).toEqual([]);
      expect(result.durationMs).toBe(0);
      expect(result.now).toBeInstanceOf(Date);
    }));

  // spec 0010 AC-4: "unknown or unbookable type gives starts: [], durationMs: 0"
  it("has nothing for a deleted type or one with no bookable testbed", () =>
    inRollback(async (trx) => {
      const deleted = await makeType(trx);
      await makeTestbed(trx, deleted.id);
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: await dbNow(trx) })
        .where("id", "=", deleted.id)
        .execute();
      const allDeleted = await makeType(trx);
      await makeTestbed(trx, allDeleted.id, { deleted_at: new Date() });

      for (const id of [deleted.id, allDeleted.id])
        expect(await startsFor(trx, id)).toMatchObject({
          starts: [],
          durationMs: 0,
        });
    }));
});

// covers: spec 0010 AC-7
describe.skipIf(!hasDb)("firstFreeTestbed (AC-7)", () => {
  it("names the first free testbed in lower(name) order", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx, { duration_value: 2 });
      const a = await makeTestbed(trx, type.id, { name: "alpha bench" });
      await makeTestbed(trx, type.id, { name: "Bravo bench" });
      const start = (await firstStart(trx)) + 2 * HOUR;

      expect(await firstFreeTestbed(trx, type.id, new Date(start))).toEqual({
        testbedName: "alpha bench",
        endsAt: new Date(start + 2 * HOUR),
      });

      // The first one busy for part of the window: the second is named.
      await book(trx, a, start + HOUR, start + 3 * HOUR);
      expect(
        (await firstFreeTestbed(trx, type.id, new Date(start)))?.testbedName,
      ).toBe("Bravo bench");
    }));

  it("is null when every testbed is busy", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx, { duration_value: 2 });
      const testbed = await makeTestbed(trx, type.id);
      const start = (await firstStart(trx)) + 2 * HOUR;
      await book(trx, testbed, start, start + 2 * HOUR);
      expect(await firstFreeTestbed(trx, type.id, new Date(start))).toBeNull();
    }));

  it("is null for a start inside the lead time or off the grid", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      await makeTestbed(trx, type.id);
      const first = await firstStart(trx);
      expect(
        await firstFreeTestbed(trx, type.id, new Date(first - SLOT_MS)),
      ).toBeNull();
      expect(
        await firstFreeTestbed(trx, type.id, new Date(first + 60_000)),
      ).toBeNull();
    }));

  it("is null for a start past the 90 day horizon", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      await makeTestbed(trx, type.id);
      const now = (await dbNow(trx)).getTime();
      const pastHorizon =
        Math.ceil((now + HORIZON_MS) / SLOT_MS) * SLOT_MS + SLOT_MS;
      expect(
        await firstFreeTestbed(trx, type.id, new Date(pastHorizon)),
      ).toBeNull();
    }));

  // Bookings are [start, end): one ending at the start, or starting at the
  // end, leaves the testbed free, and so does a cancelled one.
  it("is not blocked by back to back or cancelled bookings", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx, { duration_value: 2 });
      const testbed = await makeTestbed(trx, type.id, { name: "only bench" });
      const start = (await firstStart(trx)) + 4 * HOUR;
      await book(trx, testbed, start - 2 * HOUR, start);
      await book(trx, testbed, start + 2 * HOUR, start + 4 * HOUR);
      const canceller = await makeUser(trx);
      await trx
        .insertInto("bookings")
        .values({
          user_id: canceller.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: new Date(start),
          ends_at: new Date(start + 2 * HOUR),
          status: "cancelled",
          cancelled_at: await dbNow(trx),
          cancel_source: "learner",
        })
        .execute();

      expect(
        (await firstFreeTestbed(trx, type.id, new Date(start)))?.testbedName,
      ).toBe("only bench");
    }));

  // The preview must never name a testbed the saga would not assign.
  it("skips a deleted testbed", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      await makeTestbed(trx, type.id, {
        name: "aa gone",
        deleted_at: await dbNow(trx),
      });
      await makeTestbed(trx, type.id, { name: "cc bench" });
      const start = (await firstStart(trx)) + HOUR;
      expect(
        (await firstFreeTestbed(trx, type.id, new Date(start)))?.testbedName,
      ).toBe("cc bench");
    }));

  it("is null for a deleted type", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      await makeTestbed(trx, type.id);
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: await dbNow(trx) })
        .where("id", "=", type.id)
        .execute();
      const start = (await firstStart(trx)) + HOUR;
      expect(await firstFreeTestbed(trx, type.id, new Date(start))).toBeNull();
    }));

  it("is null for an unknown type", () =>
    inRollback(async (trx) => {
      const start = (await firstStart(trx)) + HOUR;
      expect(
        await firstFreeTestbed(trx, crypto.randomUUID(), new Date(start)),
      ).toBeNull();
    }));

  it("follows the type duration for the end", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx, {
        duration_value: 1,
        duration_unit: "days",
      });
      await makeTestbed(trx, type.id);
      const start = (await firstStart(trx)) + HOUR;
      expect(
        (await firstFreeTestbed(trx, type.id, new Date(start)))?.endsAt,
      ).toEqual(new Date(start + 24 * HOUR));
    }));
});

// A booking of a fresh learner on `testbed` at [from, to), returning its id.
const bookId = async (
  trx: Kysely<DB>,
  testbed: { id: string; testbed_type_id: string },
  from: number,
  to: number,
) => {
  const user = await makeUser(trx);
  const row = await trx
    .insertInto("bookings")
    .values({
      user_id: user.id,
      testbed_id: testbed.id,
      testbed_type_id: testbed.testbed_type_id,
      starts_at: new Date(from),
      ends_at: new Date(to),
      status: "confirmed",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
};

// covers: spec 0011 AC-7, AC-8
describe.skipIf(!hasDb)("a reschedule's view (spec 0011)", () => {
  it("offers the booking's own range only when it is excluded", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx, { duration_value: 2 });
      const testbed = await makeTestbed(trx, type.id);
      const first = await firstStart(trx);
      const own = await bookId(trx, testbed, first, first + 2 * HOUR);

      const plain = await startsFor(trx, type.id);
      expect(plain.starts.map((d) => d.getTime())).not.toContain(first);
      const excluded = await startsFor(trx, type.id, {
        excludeBookingId: own,
      });
      expect(excluded.starts.map((d) => d.getTime())).toContain(first);
      expect(excluded.starts.map((d) => d.getTime())).toContain(first + HOUR);
    }));

  it("prefers the kept testbed when free, else the name order one", () =>
    inRollback(async (trx) => {
      const u = crypto.randomUUID().slice(0, 8);
      const type = await makeType(trx, { duration_value: 2 });
      const a = await makeTestbed(trx, type.id, { name: `a ${u}` });
      const b = await makeTestbed(trx, type.id, { name: `b ${u}` });
      const first = await firstStart(trx);
      const own = await bookId(trx, b, first, first + 2 * HOUR);
      const at = new Date(first + HOUR);

      // Its own range on b does not block b once excluded.
      expect(
        await firstFreeTestbed(trx, type.id, at, {
          excludeBookingId: own,
          preferTestbedId: b.id,
        }),
      ).toMatchObject({ testbedName: b.name });
      // Without the exclusion, b is busy, so a is offered.
      expect(
        await firstFreeTestbed(trx, type.id, at, { preferTestbedId: b.id }),
      ).toMatchObject({ testbedName: a.name });

      // Someone else on b: fall back to a.
      const later = new Date(first + 24 * HOUR);
      await bookId(trx, b, later.getTime(), later.getTime() + 2 * HOUR);
      expect(
        await firstFreeTestbed(trx, type.id, later, {
          excludeBookingId: own,
          preferTestbedId: b.id,
        }),
      ).toMatchObject({ testbedName: a.name });
    }));
});
