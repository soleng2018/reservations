import { sql, type Insertable, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { Bookings, DB } from "@/server/db/types";
import {
  cancelOwnBooking,
  hasLiveBooking,
  learnerBookings,
  ownReschedulable,
} from "./manage";

const insertBooking = (trx: Kysely<DB>, values: Insertable<Bookings>) =>
  trx
    .insertInto("bookings")
    .values(values)
    .returningAll()
    .executeTakeFirstOrThrow();

// A learner, a type, and a bookable testbed, plus a booking builder for them.
async function world(trx: Kysely<DB>) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const user = await makeUser(trx);
  const book = (
    from: number,
    to: number,
    extra: Partial<Insertable<Bookings>> = {},
  ) =>
    insertBooking(trx, {
      user_id: user.id,
      testbed_id: testbed.id,
      testbed_type_id: type.id,
      starts_at: slot(from),
      ends_at: slot(to),
      status: "confirmed",
      ...extra,
    });
  return { type, testbed, user, book };
}

// A row an admin cancelled, as the cancel checks require.
const CANCELLED = {
  status: "cancelled",
  cancelled_at: new Date(),
  cancel_source: "admin",
} as const;

const bookingRow = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("bookings")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const auditsOf = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("audit_events")
    .select(["action", "metadata", "actor_user_id", "summary"])
    .where("target_id", "=", id)
    .execute();

// covers: AC-1, AC-15
describe.skipIf(!hasDb)("learnerBookings", () => {
  it("lists only the learner's confirmed and completed rows", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const current = await w.book(-1, 1);
      const past = await w.book(-50, -48, { status: "completed" });
      await w.book(-30, -28, CANCELLED);
      const other = await makeUser(trx);
      await w.book(10, 12, { user_id: other.id });

      const rows = await learnerBookings(trx, w.user.id);
      expect(rows.map((r) => r.id).toSorted()).toEqual(
        [current.id, past.id].toSorted(),
      );
      expect(rows.find((r) => r.id === current.id)).toMatchObject({
        version: current.version,
        status: "confirmed",
        testbedName: w.testbed.name,
        typeName: w.type.name,
        reschedulable: true,
      });
      // Past rows are never reschedulable.
      expect(rows.find((r) => r.id === past.id)?.reschedulable).toBe(false);
    }));

  it("leaves a provisioning row out", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      await w.book(10, 12, { status: "provisioning" });
      expect(await learnerBookings(trx, w.user.id)).toEqual([]);
    }));

  it("shows soft deleted testbed and type names", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(-50, -48, { status: "completed" });
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", w.testbed.id)
        .execute();
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: new Date() })
        .where("id", "=", w.type.id)
        .execute();
      const [row] = await learnerBookings(trx, w.user.id);
      expect(row).toMatchObject({
        id: b.id,
        testbedName: w.testbed.name,
        typeName: w.type.name,
      });
    }));

  it("is not reschedulable once the type is deleted", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      await w.book(10, 12);
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: new Date() })
        .where("id", "=", w.type.id)
        .execute();
      const [row] = await learnerBookings(trx, w.user.id);
      expect(row?.reschedulable).toBe(false);
    }));

  it("is not reschedulable when the type has no bookable testbed", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      await w.book(10, 12);
      await trx
        .updateTable("testbeds")
        .set({ authentik_group_pk: null })
        .where("id", "=", w.testbed.id)
        .execute();
      const [row] = await learnerBookings(trx, w.user.id);
      expect(row?.reschedulable).toBe(false);
    }));
});

// covers: AC-2
describe.skipIf(!hasDb)("hasLiveBooking", () => {
  it("is true for a confirmed booking that has not ended", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      expect(await hasLiveBooking(trx, w.user.id)).toBe(false);
      await w.book(10, 12);
      expect(await hasLiveBooking(trx, w.user.id)).toBe(true);
    }));

  it("is false for an ended confirmed booking and for completed rows", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      await w.book(-10, -8);
      await w.book(-50, -48, { status: "completed" });
      expect(await hasLiveBooking(trx, w.user.id)).toBe(false);
    }));

  it("counts a provisioning row under a minute old, not an older one", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(10, 12, { status: "provisioning" });
      expect(await hasLiveBooking(trx, w.user.id)).toBe(true);
      await trx
        .updateTable("bookings")
        .set({ created_at: sql<Date>`now() - interval '2 minutes'` })
        .where("id", "=", b.id)
        .execute();
      expect(await hasLiveBooking(trx, w.user.id)).toBe(false);
    }));
});

// covers: AC-6, AC-15
describe.skipIf(!hasDb)("ownReschedulable", () => {
  it("loads the learner's own live booking", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(10, 12);
      expect(await ownReschedulable(trx, w.user.id, b.id)).toEqual({
        kind: "ok",
        booking: {
          id: b.id,
          version: b.version,
          testbedId: w.testbed.id,
          testbedName: w.testbed.name,
          typeId: w.type.id,
          typeName: w.type.name,
          durationValue: 2,
          durationUnit: "hours",
          startsAt: b.starts_at,
          endsAt: b.ends_at,
          current: false,
        },
      });
    }));

  it("flags a booking that has started as current", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(-1, 1);
      const r = await ownReschedulable(trx, w.user.id, b.id);
      expect(r.kind === "ok" && r.booking.current).toBe(true);
    }));

  it("is missing for another learner's id, an unknown id, or a malformed one", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(10, 12);
      const other = await makeUser(trx);
      for (const [user, id] of [
        [other.id, b.id],
        [w.user.id, crypto.randomUUID()],
        [w.user.id, "not-a-uuid"],
      ] as const)
        expect(await ownReschedulable(trx, user, id)).toEqual({
          kind: "missing",
        });
    }));

  it("is unavailable for their own ended, cancelled, or unmovable booking", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const ended = await w.book(-10, -8);
      expect(await ownReschedulable(trx, w.user.id, ended.id)).toEqual({
        kind: "unavailable",
      });
      await trx
        .updateTable("bookings")
        .set({ status: "completed" })
        .where("id", "=", ended.id)
        .execute();
      const cancelled = await w.book(-30, -28, CANCELLED);
      expect(await ownReschedulable(trx, w.user.id, cancelled.id)).toEqual({
        kind: "unavailable",
      });
      const live = await w.book(10, 12);
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: new Date() })
        .where("id", "=", w.type.id)
        .execute();
      expect(await ownReschedulable(trx, w.user.id, live.id)).toEqual({
        kind: "unavailable",
      });
    }));
});

// covers: AC-4, AC-5, AC-17
describe.skipIf(!hasDb)("cancelOwnBooking", () => {
  it.each([
    { phase: "Upcoming", from: 48, to: 50 },
    { phase: "Current", from: -1, to: 2 },
    // Inside the 1 hour lead time, still cancellable up to the start.
    { phase: "Upcoming", from: 0.5, to: 2.5 },
  ])(
    "cancels an $phase booking ($from h) as the learner and audits it",
    ({ phase, from, to }) =>
      inRollback(async (trx) => {
        const w = await world(trx);
        const b = await w.book(from, to);
        expect(
          await cancelOwnBooking(asConn(trx), w.user.id, b.id, b.version),
        ).toEqual({ ok: true, value: undefined });
        const after = await bookingRow(trx, b.id);
        expect(after).toMatchObject({
          status: "cancelled",
          cancel_source: "learner",
          cancelled_by_user_id: w.user.id,
        });
        expect(after.cancelled_at).not.toBeNull();
        // A Current booking keeps its end (spec 0002).
        expect(after.ends_at).toEqual(b.ends_at);
        expect(await auditsOf(trx, b.id)).toEqual([
          {
            action: "booking.cancelled",
            actor_user_id: w.user.id,
            summary: "Reservation cancelled",
            metadata: {
              source: "learner",
              userId: w.user.id,
              testbedId: w.testbed.id,
              phase,
            },
          },
        ]);
      }),
  );

  it("returns stale and writes nothing for a stale version, a Past booking, or another learner's id", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const live = await w.book(48, 50);
      const other = await makeUser(trx);
      const stale = { ok: false, error: "stale" };
      expect(
        await cancelOwnBooking(
          asConn(trx),
          w.user.id,
          live.id,
          live.version + 1,
        ),
      ).toEqual(stale);
      expect(
        await cancelOwnBooking(asConn(trx), other.id, live.id, live.version),
      ).toEqual(stale);
      expect(await bookingRow(trx, live.id)).toMatchObject({
        status: "confirmed",
        version: live.version,
      });

      const w2 = await world(trx);
      const past = await w2.book(-10, -8);
      expect(
        await cancelOwnBooking(asConn(trx), w2.user.id, past.id, past.version),
      ).toEqual(stale);
      expect(await auditsOf(trx, live.id)).toEqual([]);
      expect(await auditsOf(trx, past.id)).toEqual([]);
    }));

  it("refuses a second cancel of the same booking", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(48, 50);
      await cancelOwnBooking(asConn(trx), w.user.id, b.id, b.version);
      expect(
        await cancelOwnBooking(asConn(trx), w.user.id, b.id, b.version),
      ).toEqual({ ok: false, error: "stale" });
      expect(await auditsOf(trx, b.id)).toHaveLength(1);
    }));

  it("refuses a learner who was deactivated", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(48, 50);
      await trx
        .updateTable("users")
        .set({ status: "deactivated", deactivated_at: new Date() })
        .where("id", "=", w.user.id)
        .execute();
      expect(
        await cancelOwnBooking(asConn(trx), w.user.id, b.id, b.version),
      ).toEqual({ ok: false, error: "stale" });
      expect(await bookingRow(trx, b.id)).toMatchObject({
        status: "confirmed",
      });
    }));
});
