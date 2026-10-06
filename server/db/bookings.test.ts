import { sql, type Insertable, type Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import {
  cancelBooking,
  completeEndedForUser,
  lockBookableTestbed,
  rescheduleBooking,
} from "./bookings";
import { mapConstraintError } from "./constraint-errors";
import {
  attempt,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "./testing";
import type { Bookings, DB } from "./types";

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

const mapped = (e: unknown) => {
  const r = mapConstraintError(e);
  return r.ok ? undefined : r.error;
};

describe.skipIf(!hasDb)("booking data rules", () => {
  afterAll(() => db().destroy());

  it("rejects overlapping live bookings on a testbed, allows back to back (AC-1)", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const other = await makeUser(trx);
      await w.book(24, 26);
      const clash = await attempt(trx, () =>
        insertBooking(trx, {
          user_id: other.id,
          testbed_id: w.testbed.id,
          testbed_type_id: w.type.id,
          starts_at: slot(25),
          ends_at: slot(27),
          status: "provisioning",
        }),
      );
      expect(mapped(clash)).toBe("overlap");
      const backToBack = await attempt(trx, () =>
        insertBooking(trx, {
          user_id: other.id,
          testbed_id: w.testbed.id,
          testbed_type_id: w.type.id,
          starts_at: slot(26),
          ends_at: slot(28),
          status: "confirmed",
        }),
      );
      expect(backToBack).toBeUndefined();
    }));

  // Never commits (spec 0002): a second connection cannot see the first one's
  // uncommitted fixtures, so this proves the race by blocking. The exclusion
  // check runs before foreign keys, so an overlapping insert on connection B
  // waits on A's uncommitted live row (hits lock_timeout) instead of slipping
  // past it; a non overlapping one does not wait.
  it("makes a concurrent overlapping insert wait on the first (AC-1)", () =>
    inRollback(async (a) => {
      const w = await world(a);
      await w.book(24, 26);
      const fromB = (from: number, to: number) =>
        inRollback(async (b) => {
          await sql`set local lock_timeout = '300ms'`.execute(b);
          await insertBooking(b, {
            user_id: crypto.randomUUID(),
            testbed_id: w.testbed.id,
            testbed_type_id: w.type.id,
            starts_at: slot(from),
            ends_at: slot(to),
            status: "confirmed",
          });
        }).catch((e: unknown) => (e as { code?: string }).code);
      expect(await fromB(25, 27)).toBe("55P03"); // lock_not_available: waited on A
      expect(await fromB(26, 28)).toBe("23503"); // no wait; only B's FK fails
    }));

  it("allows one live booking per user, completing ended ones first (AC-2)", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const testbed2 = await makeTestbed(trx, w.type.id);
      const ended = await w.book(-4, -2);
      const second = () =>
        insertBooking(trx, {
          user_id: w.user.id,
          testbed_id: testbed2.id,
          testbed_type_id: w.type.id,
          starts_at: slot(24),
          ends_at: slot(26),
          status: "confirmed",
        });
      expect(mapped(await attempt(trx, second))).toBe("user_has_live_booking");

      await completeEndedForUser(trx, w.user.id);
      const after = await trx
        .selectFrom("bookings")
        .select(["status", "version"])
        .where("id", "=", ended.id)
        .executeTakeFirstOrThrow();
      expect(after).toEqual({ status: "completed", version: 1 });
      expect(await attempt(trx, second)).toBeUndefined();
    }));

  it("never completes a provisioning booking or one still running (AC-2)", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const running = await w.book(-1, 1);
      await completeEndedForUser(trx, w.user.id);
      const { status } = await trx
        .selectFrom("bookings")
        .select("status")
        .where("id", "=", running.id)
        .executeTakeFirstOrThrow();
      expect(status).toBe("confirmed");
    }));

  it("lets cancelled and completed bookings block nothing (AC-3)", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      await w.book(24, 26, {
        status: "cancelled",
        cancelled_at: new Date(),
        cancel_source: "learner",
        cancelled_by_user_id: w.user.id,
      });
      await w.book(28, 30, { status: "completed" });
      expect(await attempt(trx, () => w.book(24, 26))).toBeUndefined();
      const other = await makeUser(trx);
      const overCompleted = await attempt(trx, () =>
        insertBooking(trx, {
          user_id: other.id,
          testbed_id: w.testbed.id,
          testbed_type_id: w.type.id,
          starts_at: slot(28),
          ends_at: slot(30),
          status: "confirmed",
        }),
      );
      expect(overCompleted).toBeUndefined();
    }));

  it("enforces name, slug, and email uniqueness (AC-5, AC-6)", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx, { name: "Lab A" });
      expect(
        mapped(await attempt(trx, () => makeType(trx, { name: "lab a" }))),
      ).toBe("duplicate_name");
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: new Date() })
        .where("id", "=", type.id)
        .execute();
      expect(
        await attempt(trx, () => makeType(trx, { name: "lab a" })),
      ).toBeUndefined();

      const tb = await makeTestbed(trx, type.id, { name: "Pod", slug: "pod" });
      expect(
        mapped(
          await attempt(trx, () => makeTestbed(trx, type.id, { name: "POD" })),
        ),
      ).toBe("duplicate_name");
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", tb.id)
        .execute();
      expect(
        mapped(
          await attempt(trx, () => makeTestbed(trx, type.id, { slug: "pod" })),
        ),
      ).toBe("duplicate_slug");
      const slugChange = await attempt(trx, () =>
        trx
          .updateTable("testbeds")
          .set({ slug: "pod-2" })
          .where("id", "=", tb.id)
          .execute(),
      );
      expect(slugChange).toMatchObject({
        constraint: "testbeds_slug_immutable",
      });

      await makeUser(trx, { email: "Priya@x.test" });
      expect(
        mapped(
          await attempt(trx, () => makeUser(trx, { email: "priya@x.test" })),
        ),
      ).toBe("duplicate_email");
    }));

  it("rejects invalid values (AC-9)", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const now = new Date();
      const rejected = async (fn: () => Promise<unknown>) =>
        (await attempt(trx, fn)) as { code?: string } | undefined;
      const cases: (() => Promise<unknown>)[] = [
        () => makeType(trx, { duration_value: 0 }),
        () => makeType(trx, { duration_unit: "weeks" }),
        () => makeUser(trx, { role: "owner" }),
        () => makeUser(trx, { status: "paused" }),
        () => makeUser(trx, { status: "deactivated" }),
        () => makeUser(trx, { name: " padded " }),
        () => makeUser(trx, { email: "" }),
        () =>
          trx
            .insertInto("testbed_clients")
            .values({
              testbed_id: w.testbed.id,
              kind: "fiber",
              name: "c",
              url: "u",
              position: 0,
            })
            .execute(),
        () => makeTestbed(trx, w.type.id, { slug: "Bad Slug" }),
        () => w.book(24, 24),
        () => w.book(30, 28),
        () =>
          w.book(24, 26, {
            starts_at: new Date(slot(24).getTime() + 15 * 60_000),
          }),
        () => w.book(24, 26, { status: "pending" }),
        () => w.book(24, 26, { status: "cancelled" }),
        () => w.book(24, 26, { cancelled_at: now, cancel_source: "learner" }),
        () =>
          w.book(24, 26, {
            status: "cancelled",
            cancelled_at: now,
            cancel_source: null,
          }),
        () =>
          w.book(24, 26, {
            status: "cancelled",
            cancelled_at: now,
            cancel_source: "robot",
          }),
        () =>
          trx
            .insertInto("jobs")
            .values({ kind: "fax", payload: "{}", idempotency_key: "k" })
            .execute(),
        () =>
          trx
            .insertInto("jobs")
            .values({
              kind: "send_email",
              payload: "{}",
              idempotency_key: "k",
              attempts: 9,
            })
            .execute(),
      ];
      // Sequential: each attempt uses the same transaction's savepoint.
      const codes: (string | undefined)[] = [];
      for (const fn of cases) codes.push((await rejected(fn))?.code);
      expect(codes).toEqual(cases.map(() => "23514")); // check_violation
    }));

  it("guards reschedule and cancel, bumping version by one (AC-12)", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(24, 26);
      const move = (expectedVersion: number, id = b.id) =>
        rescheduleBooking(trx, {
          id,
          expectedVersion,
          testbedId: w.testbed.id,
          testbedTypeId: w.type.id,
          startsAt: slot(30),
          endsAt: slot(32),
        });

      expect(await move(2)).toEqual({ ok: false, error: "stale" });
      expect(await move(1)).toEqual({ ok: true, value: { version: 2 } });

      // The trigger owns version: a direct write cannot set it.
      await trx
        .updateTable("bookings")
        .set({ version: 99 })
        .where("id", "=", b.id)
        .execute();
      const cancel = (expectedVersion: number) =>
        cancelBooking(trx, {
          id: b.id,
          expectedVersion,
          source: "learner",
          byUserId: w.user.id,
        });
      expect(await cancel(99)).toEqual({ ok: false, error: "stale" });
      expect(await cancel(2)).toEqual({ ok: true, value: { version: 3 } });
      expect(await cancel(3)).toEqual({ ok: false, error: "stale" });

      const ended = await insertBooking(trx, {
        user_id: (await makeUser(trx)).id,
        testbed_id: w.testbed.id,
        testbed_type_id: w.type.id,
        starts_at: slot(-4),
        ends_at: slot(-2),
        status: "confirmed",
      });
      expect(await move(1, ended.id)).toEqual({ ok: false, error: "stale" });
      await trx
        .updateTable("bookings")
        .set({ status: "completed" })
        .where("id", "=", ended.id)
        .execute();
      expect(await move(1, ended.id)).toEqual({ ok: false, error: "stale" });
    }));

  it("keeps version on confirm and complete", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(24, 26, { status: "provisioning" });
      const { version } = await trx
        .updateTable("bookings")
        .set({ status: "confirmed" })
        .where("id", "=", b.id)
        .returning("version")
        .executeTakeFirstOrThrow();
      expect(version).toBe(1);
    }));

  it("books only a live testbed with a group (AC-14)", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const good = await makeTestbed(trx, type.id);
      const noGroup = await makeTestbed(trx, type.id, {
        authentik_group_pk: null,
      });
      const deleted = await makeTestbed(trx, type.id, {
        deleted_at: new Date(),
      });
      expect((await lockBookableTestbed(trx, good.id)).ok).toBe(true);
      for (const id of [noGroup.id, deleted.id, crypto.randomUUID()]) {
        expect(await lockBookableTestbed(trx, id)).toEqual({
          ok: false,
          error: "not_bookable",
        });
      }
    }));

  it("lets a reschedule overlap its own old range but not another booking (AC-1, AC-12)", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(24, 26);
      const other = await makeUser(trx);
      await insertBooking(trx, {
        user_id: other.id,
        testbed_id: w.testbed.id,
        testbed_type_id: w.type.id,
        starts_at: slot(30),
        ends_at: slot(32),
        status: "confirmed",
      });
      const move = (from: number, to: number, expectedVersion: number) =>
        rescheduleBooking(trx, {
          id: b.id,
          expectedVersion,
          testbedId: w.testbed.id,
          testbedTypeId: w.type.id,
          startsAt: slot(from),
          endsAt: slot(to),
        });

      expect(await move(25, 27, 1)).toEqual({
        ok: true,
        value: { version: 2 },
      });
      const clash = await attempt(trx, () => move(29, 31, 2));
      expect(mapped(clash)).toBe("overlap");
    }));

  it("records a system cancel with no actor and keeps ends_at (AC-12)", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(-1, 1);
      const result = await cancelBooking(trx, {
        id: b.id,
        expectedVersion: 1,
        source: "deactivation",
        byUserId: null,
      });
      expect(result).toEqual({ ok: true, value: { version: 2 } });
      const row = await trx
        .selectFrom("bookings")
        .select(["status", "cancel_source", "cancelled_by_user_id", "ends_at"])
        .where("id", "=", b.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        status: "cancelled",
        cancel_source: "deactivation",
        cancelled_by_user_id: null,
        ends_at: b.ends_at,
      });
    }));

  it("refuses a testbed whose type is soft deleted (AC-14)", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const tb = await makeTestbed(trx, type.id);
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: new Date() })
        .where("id", "=", type.id)
        .execute();
      expect(await lockBookableTestbed(trx, tb.id)).toEqual({
        ok: false,
        error: "not_bookable",
      });
    }));

  it("moves updated_at forward on update", () =>
    inRollback(async (trx) => {
      const old = new Date("2020-01-01T00:00:00Z");
      const user = await makeUser(trx, { updated_at: old });
      const { updated_at } = await trx
        .updateTable("users")
        .set({ name: "Renamed" })
        .where("id", "=", user.id)
        .returning("updated_at")
        .executeTakeFirstOrThrow();
      expect(updated_at.getTime()).toBeGreaterThan(old.getTime());
    }));

  it("keeps client positions unique per testbed and removes clients with a hard deleted testbed", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const tb = await makeTestbed(trx, type.id);
      const client = (position: number) =>
        trx
          .insertInto("testbed_clients")
          .values({
            testbed_id: tb.id,
            kind: "wired",
            name: "PC",
            url: "u",
            position,
          })
          .execute();
      await client(0);
      const dup = (await attempt(trx, () => client(0))) as {
        constraint?: string;
      };
      expect(dup.constraint).toBe("testbed_clients_position_uq");

      await trx.deleteFrom("testbeds").where("id", "=", tb.id).execute();
      const left = await trx
        .selectFrom("testbed_clients")
        .select("id")
        .where("testbed_id", "=", tb.id)
        .execute();
      expect(left).toEqual([]);
    }));
});

describe("mapConstraintError", () => {
  it.each([
    ["23P01", "bookings_no_overlap", "overlap"],
    ["23505", "bookings_one_live_per_user", "user_has_live_booking"],
    ["23505", "users_email_lower_uq", "duplicate_email"],
    ["23505", "testbeds_slug_uq", "duplicate_slug"],
    ["23505", "testbed_types_name_lower_uq", "duplicate_name"],
    ["23505", "testbeds_name_lower_uq", "duplicate_name"],
    ["23505", "api_keys_name_lower_uq", "duplicate_name"],
  ])("maps %s on %s to %s", (code, constraint, error) => {
    expect(mapConstraintError({ code, constraint })).toEqual({
      ok: false,
      error,
    });
  });

  it("rethrows a known constraint name under the wrong error code", () => {
    const e = { code: "23514", constraint: "bookings_no_overlap" };
    expect(() => mapConstraintError(e)).toThrow();
  });

  it("rethrows errors that are not expected constraint violations", () => {
    const bug = new Error("boom");
    expect(() => mapConstraintError(bug)).toThrow(bug);
    const unknownUnique = { code: "23505", constraint: "something_else" };
    expect(() => mapConstraintError(unknownUnique)).toThrow();
    const missingParent = {
      code: "23503",
      detail: "Key is not present in table",
    };
    expect(() => mapConstraintError(missingParent)).toThrow();
  });

  it("maps a RESTRICT delete to in_use", () => {
    const e = {
      code: "23503",
      detail: 'Key (id)=(x) is still referenced from table "bookings".',
    };
    expect(mapConstraintError(e)).toEqual({ ok: false, error: "in_use" });
  });
});
