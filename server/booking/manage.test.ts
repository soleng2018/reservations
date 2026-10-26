import { sql, type Insertable, type Kysely, type Transaction } from "kysely";
import { describe, expect, it } from "vitest";
import {
  fakeAuthentik,
  fakeLearner,
  fakeUser,
} from "@/server/authentik/testing";
import { rescheduleBooking } from "@/server/db/bookings";
import { mapConstraintError } from "@/server/db/constraint-errors";
import {
  applyBookingGapMigration,
  asConn,
  attempt,
  hasDb,
  inRollback,
  inRollbackDdl,
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
  rescheduleOwnBooking,
  toRescheduleError,
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
        .set({ deleted_at: new Date() })
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

  // covers: spec 0020 AC-5. An early cancel frees the testbed and its gap.
  it("frees the testbed and its gap at once for a Current booking (spec 0020 AC-5)", () =>
    inRollbackDdl(async (trx) => {
      await applyBookingGapMigration(trx);
      const w = await world(trx);
      const current = await w.book(-1, 2);
      const next = (hours: number) =>
        attempt(trx, async () =>
          insertBooking(trx, {
            user_id: (await makeUser(trx)).id,
            testbed_id: w.testbed.id,
            testbed_type_id: w.type.id,
            starts_at: slot(hours),
            ends_at: slot(hours + 2),
            status: "confirmed",
          }),
        );
      expect(mapConstraintError(await next(2))).toEqual({
        ok: false,
        error: "overlap",
      });
      expect(
        await cancelOwnBooking(
          asConn(trx),
          w.user.id,
          current.id,
          current.version,
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(await next(2)).toBeUndefined();
    }));

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

// A type with two bookable testbeds named so that `first` sorts before
// `second`, a learner booked on `second`, and other learners to fill slots.
async function twoBeds(trx: Transaction<DB>, from = 48, to = 50) {
  const u = crypto.randomUUID().slice(0, 8);
  const type = await makeType(trx);
  const first = await makeTestbed(trx, type.id, { name: `A bed ${u}` });
  const second = await makeTestbed(trx, type.id, { name: `B bed ${u}` });
  const pk = 900_600 + Math.floor(Math.random() * 1000);
  const user = await makeUser(trx, { authentik_user_pk: pk });
  const ak = fakeAuthentik([fakeLearner(pk, { email: user.email })]);
  const booking = await insertBooking(trx, {
    user_id: user.id,
    testbed_id: second.id,
    testbed_type_id: type.id,
    starts_at: slot(from),
    ends_at: slot(to),
    status: "confirmed",
  });
  // Another learner's live booking on `testbedId` at [from, to) hours.
  const occupy = async (testbedId: string, start: number, end: number) => {
    const other = await makeUser(trx);
    return insertBooking(trx, {
      user_id: other.id,
      testbed_id: testbedId,
      testbed_type_id: type.id,
      starts_at: slot(start),
      ends_at: slot(end),
      status: "confirmed",
    });
  };
  const move = (startsAt: Date, version = booking.version) =>
    rescheduleOwnBooking(ak.api, asConn(trx), user.id, {
      bookingId: booking.id,
      version,
      startsAt,
    });
  return { type, first, second, user, booking, occupy, move, ak };
}

const refused = (error: string) => ({ ok: false, error });

// covers: AC-9, AC-17
describe.skipIf(!hasDb)("rescheduleOwnBooking", () => {
  it("keeps its own testbed when it is free, bumps the version, and audits", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      const r = await w.move(slot(72));
      expect(r).toEqual({
        ok: true,
        value: {
          testbedName: w.second.name,
          typeName: w.type.name,
          startsAt: slot(72),
          endsAt: slot(74),
        },
      });
      const after = await bookingRow(trx, w.booking.id);
      expect(after).toMatchObject({
        status: "confirmed",
        testbed_id: w.second.id,
        starts_at: slot(72),
        ends_at: slot(74),
        version: w.booking.version + 1,
      });
      expect(await auditsOf(trx, w.booking.id)).toEqual([
        {
          action: "booking.rescheduled",
          actor_user_id: w.user.id,
          summary: "Reservation rescheduled",
          metadata: {
            fromStartsAt: slot(48).toISOString(),
            toStartsAt: slot(72).toISOString(),
            fromTestbedId: w.second.id,
            toTestbedId: w.second.id,
            phase: "Upcoming",
          },
        },
      ]);
    }));

  it("moves to the next free testbed in name order when its own is busy", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      await w.occupy(w.second.id, 72, 74);
      const r = await w.move(slot(72));
      expect(r.ok && r.value.testbedName).toBe(w.first.name);
      expect((await bookingRow(trx, w.booking.id)).testbed_id).toBe(w.first.id);
    }));

  it("can overlap its own old range on the same testbed", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      const r = await w.move(slot(49));
      expect(r.ok && r.value.testbedName).toBe(w.second.name);
    }));

  // covers: spec 0020 AC-4. The clash query counts a live booking within the
  // gap on either side, so this holds before the constraint changes too.
  it("gives slot_taken for a start inside another learner's gap, on either side", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      await w.occupy(w.first.id, 72, 74);
      await w.occupy(w.second.id, 72, 74);
      expect(await w.move(slot(74))).toEqual(refused("slot_taken")); // after
      expect(await w.move(slot(70))).toEqual(refused("slot_taken")); // 70 to 72
      expect(await bookingRow(trx, w.booking.id)).toMatchObject({
        starts_at: w.booking.starts_at,
        version: w.booking.version,
      });
      const r = await w.move(slot(74.5));
      expect(r.ok && r.value.startsAt).toEqual(slot(74.5));
    }));

  it("moves next to its own old slot, which the gap never counts (spec 0020 AC-4)", () =>
    inRollbackDdl(async (trx) => {
      await applyBookingGapMigration(trx);
      const w = await twoBeds(trx); // 48 to 50 on the second bed
      const r = await w.move(slot(50));
      expect(r.ok && r.value.testbedName).toBe(w.second.name);
      expect(await bookingRow(trx, w.booking.id)).toMatchObject({
        starts_at: slot(50),
        testbed_id: w.second.id,
      });
    }));

  it("gives slot_taken and changes nothing when every testbed is busy", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      await w.occupy(w.first.id, 72, 74);
      await w.occupy(w.second.id, 73, 75);
      expect(await w.move(slot(72))).toEqual(refused("slot_taken"));
      expect(await bookingRow(trx, w.booking.id)).toMatchObject({
        starts_at: w.booking.starts_at,
        version: w.booking.version,
      });
      expect(await auditsOf(trx, w.booking.id)).toEqual([]);
    }));

  it("gives slot_taken for a start inside the lead time or off the grid", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      expect(await w.move(slot(0.5))).toEqual(refused("slot_taken"));
      expect(await w.move(new Date(slot(72).getTime() + 60_000))).toEqual(
        refused("slot_taken"),
      );
    }));

  it("gives same_time for its current start", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      expect(await w.move(slot(48))).toEqual(refused("same_time"));
    }));

  it("gives same_time, not slot_taken, for a Current booking's past start", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx, -1, 1);
      expect(await w.move(slot(-1))).toEqual(refused("same_time"));
    }));

  it("gives unavailable once the type is deleted", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: new Date() })
        .where("id", "=", w.type.id)
        .execute();
      expect(await w.move(slot(72))).toEqual(refused("unavailable"));
    }));

  it("gives unavailable when every testbed is soft deleted", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("testbed_type_id", "=", w.type.id)
        .execute();
      expect(await w.move(slot(72))).toEqual(refused("unavailable"));
    }));

  it("gives stale for a version the learner did not see", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      expect(await w.move(slot(72), w.booking.version + 1)).toEqual(
        refused("stale"),
      );
    }));

  it("answers rescheduled again for a retry after a lost reply", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      const first = await w.move(slot(72));
      expect(await w.move(slot(72))).toEqual(first);
      // Still one change: the retry wrote nothing.
      expect(await auditsOf(trx, w.booking.id)).toHaveLength(1);
      // A different start at the old version is stale.
      expect(await w.move(slot(96))).toEqual(refused("stale"));
    }));

  it("moves a Current booking whose own start is inside the lead time", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx, -1, 1);
      const r = await w.move(slot(24));
      expect(r.ok).toBe(true);
      const [row] = await auditsOf(trx, w.booking.id);
      expect(row?.metadata).toMatchObject({ phase: "Current" });
    }));

  it("refuses a learner who was deactivated", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      await trx
        .updateTable("users")
        .set({ status: "deactivated", deactivated_at: new Date() })
        .where("id", "=", w.user.id)
        .execute();
      expect(await w.move(slot(72))).toEqual(refused("stale"));
    }));

  it("refuses another learner's booking as stale", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      const other = await makeUser(trx);
      expect(
        await rescheduleOwnBooking(w.ak.api, asConn(trx), other.id, {
          bookingId: w.booking.id,
          version: w.booking.version,
          startsAt: slot(72),
        }),
      ).toEqual(refused("stale"));
    }));

  it("takes the end from the type's current duration", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      await trx
        .updateTable("testbed_types")
        .set({ duration_value: 3 })
        .where("id", "=", w.type.id)
        .execute();
      const r = await w.move(slot(72));
      expect(r.ok && r.value.endsAt).toEqual(slot(75));
      expect((await bookingRow(trx, w.booking.id)).ends_at).toEqual(slot(75));
    }));
});

// A connection whose transactions fail on the audit insert with `error`, as
// a concurrent commit or a deadlock would mid transaction.
function failingAudit(trx: Transaction<DB>, error: unknown): Kysely<DB> {
  const conn = asConn(trx);
  const failing = (inner: Kysely<DB>) =>
    new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "insertInto")
          return (table: string) => {
            if (table === "audit_events") throw error;
            return target.insertInto(table as "audit_events");
          };
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(conn, {
    get(target, prop, receiver) {
      if (prop === "transaction")
        return () => ({
          execute: <T>(fn: (t: Kysely<DB>) => Promise<T>) =>
            target.transaction().execute((t) => fn(failing(t))),
        });
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// covers: spec 0019 AC-4, AC-5
describe.skipIf(!hasDb)("rescheduleOwnBooking Nile login", () => {
  it("renames the learner to the new testbed's domain when the move lands there", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      // Someone else holds `second` at the new time, so the move lands on
      // `first`, which has its own domain.
      await w.occupy(w.second.id, 72, 74);
      const r = await w.move(slot(72));
      expect(r.ok).toBe(true);
      expect(w.ak.users[0]?.username).toMatch(
        new RegExp(`@${w.first.domain}$`),
      );
      expect(w.ak.users[0]?.email).toBe(w.user.email);
    }));

  it("refuses and moves nothing when Authentik is down", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      const down = fakeAuthentik([], { down: true });
      const r = await rescheduleOwnBooking(down.api, asConn(trx), w.user.id, {
        bookingId: w.booking.id,
        version: w.booking.version,
        startsAt: slot(72),
      });
      expect(r).toEqual({ ok: false, error: "unavailable" });
      expect(await bookingRow(trx, w.booking.id)).toMatchObject({
        starts_at: w.booking.starts_at,
        version: w.booking.version,
      });
    }));
});

// covers: spec 0019 AC-3, AC-5, AC-12 (the refusals leave the booking as it was)
describe.skipIf(!hasDb)("rescheduleOwnBooking Nile login refusals", () => {
  const emailCount = async (trx: Transaction<DB>, userId: string) =>
    (
      await trx
        .selectFrom("email_messages")
        .select("id")
        .where("user_id", "=", userId)
        .execute()
    ).length;

  it("refuses when the stored login is another user's now, and queues nothing", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      const taken = `ana@${w.first.domain}`;
      await trx
        .insertInto("learner_domain_logins")
        .values({
          user_id: w.user.id,
          domain: w.first.domain ?? "",
          username: taken,
          used_at: sql<Date>`now() - interval '1 day'`,
        })
        .execute();
      // A newer login elsewhere, so this domain is not the one in use.
      await trx
        .insertInto("learner_domain_logins")
        .values({
          user_id: w.user.id,
          domain: "elsewhere.example.test",
          username: "ana@elsewhere.example.test",
          used_at: sql<Date>`now()`,
        })
        .execute();
      w.ak.users.push(fakeUser({ pk: 9, username: taken }));
      const kept = w.ak.users[0]?.username;
      await w.occupy(w.second.id, 72, 74);
      const before = await bookingRow(trx, w.booking.id);
      const emails = await emailCount(trx, w.user.id);
      const r = await w.move(slot(72));
      expect(r).toEqual({ ok: false, error: "unavailable" });
      expect(await bookingRow(trx, w.booking.id)).toMatchObject({
        testbed_id: before?.testbed_id,
        starts_at: before?.starts_at,
        version: before?.version,
      });
      expect(await emailCount(trx, w.user.id)).toBe(emails);
      // The learner's own Authentik user kept its name.
      expect(w.ak.users[0]?.username).toBe(kept);
      const audit = await trx
        .selectFrom("audit_events")
        .select("metadata")
        .where("action", "=", "user.nile_login_conflict")
        .where("created_at", ">=", sql<Date>`now()`)
        .execute();
      expect(audit.map((a) => a.metadata)).toContainEqual({
        domain: w.first.domain,
        username: taken,
      });
    }));

  it("refuses an untagged Authentik user and moves nothing", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      const pk = w.ak.users[0]?.pk ?? 0;
      const untagged = fakeAuthentik([fakeUser({ pk, email: w.user.email })]);
      await w.occupy(w.second.id, 72, 74);
      const before = await bookingRow(trx, w.booking.id);
      const r = await rescheduleOwnBooking(
        untagged.api,
        asConn(trx),
        w.user.id,
        {
          bookingId: w.booking.id,
          version: w.booking.version,
          startsAt: slot(72),
        },
      );
      expect(r).toEqual({ ok: false, error: "unavailable" });
      expect(untagged.writes).toEqual([]);
      expect(await bookingRow(trx, w.booking.id)).toMatchObject({
        testbed_id: before?.testbed_id,
        version: before?.version,
      });
    }));
});

// covers: AC-9 (a race cannot be staged on one connection, so each half)
describe.skipIf(!hasDb)("reschedule races", () => {
  it("lets the overlap constraint refuse a move into a held range", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      await w.occupy(w.second.id, 72, 74);
      const e = await attempt(trx, () =>
        rescheduleBooking(trx, {
          id: w.booking.id,
          expectedVersion: w.booking.version,
          testbedId: w.second.id,
          testbedTypeId: w.type.id,
          startsAt: slot(72),
          endsAt: slot(74),
        }),
      );
      expect(mapConstraintError(e)).toEqual({ ok: false, error: "overlap" });
    }));

  it.each([
    ["40P01", { code: "40P01" }],
    ["40001", { code: "40001" }],
    ["an overlap", { code: "23P01", constraint: "bookings_no_overlap" }],
  ])("rolls back and answers slot_taken for %s", (_label, error) =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      expect(
        await rescheduleOwnBooking(
          w.ak.api,
          failingAudit(trx, error),
          w.user.id,
          {
            bookingId: w.booking.id,
            version: w.booking.version,
            startsAt: slot(72),
          },
        ),
      ).toEqual(refused("slot_taken"));
      expect(await bookingRow(trx, w.booking.id)).toMatchObject({
        starts_at: w.booking.starts_at,
        version: w.booking.version,
      });
    }),
  );

  it("rethrows anything else", () =>
    inRollback(async (trx) => {
      const w = await twoBeds(trx);
      const boom = new Error("boom");
      await expect(
        rescheduleOwnBooking(w.ak.api, failingAudit(trx, boom), w.user.id, {
          bookingId: w.booking.id,
          version: w.booking.version,
          startsAt: slot(72),
        }),
      ).rejects.toBe(boom);
    }));
});

// covers: AC-9
describe("toRescheduleError", () => {
  it.each([
    { code: "40P01" },
    { code: "40001" },
    { code: "23P01", constraint: "bookings_no_overlap" },
  ])("maps %o to slot_taken", (e) => {
    expect(toRescheduleError(e)).toBe("slot_taken");
  });

  it.each([
    new Error("boom"),
    { code: "23505", constraint: "bookings_one_live_per_user" },
    { code: "23505", constraint: "unknown_uq" },
  ])("rethrows %o", (e) => {
    expect(() => toRescheduleError(e)).toThrow();
  });
});
