import { sql, type Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { checkGuestDetails } from "./details-check";

const HOUR = 3_600_000;

async function setup(trx: Kysely<DB>) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const user = await makeUser(trx);
  const check = (email = user.email, testbedTypeId = type.id) =>
    checkGuestDetails(trx, { email, testbedTypeId });
  const book = (values: {
    status: "confirmed" | "provisioning" | "cancelled" | "completed";
    starts: Date;
    ends: Date;
    createdAt?: Date;
  }) =>
    trx
      .insertInto("bookings")
      .values({
        user_id: user.id,
        testbed_id: testbed.id,
        testbed_type_id: type.id,
        starts_at: values.starts,
        ends_at: values.ends,
        status: values.status,
        ...(values.createdAt ? { created_at: values.createdAt } : {}),
      })
      .execute();
  return { type, testbed, user, check, book };
}

const counts = async (trx: Kysely<DB>) => {
  const { rows } = await sql<{
    users: string;
    bookings: string;
    audit: string;
  }>`
    select (select count(*) from hol_app.users) as users,
           (select count(*) from hol_app.bookings) as bookings,
           (select count(*) from hol_app.audit_events) as audit
  `.execute(trx);
  return rows[0];
};

// covers: spec 0010 AC-2
describe.skipIf(!hasDb)("checkGuestDetails (AC-2)", () => {
  it("passes a new email and a bookable type", () =>
    inRollback(async (trx) => {
      const { check, type } = await setup(trx);
      expect(await check("brand-new@example.test", type.id)).toEqual({
        ok: true,
        value: undefined,
      });
    }));

  it("refuses an admin's email, in any case", () =>
    inRollback(async (trx) => {
      const { check } = await setup(trx);
      const admin = await makeUser(trx, { role: "admin" });
      expect(await check(admin.email.toUpperCase())).toEqual({
        ok: false,
        error: "admin_email",
      });
    }));

  it("refuses a deactivated learner", () =>
    inRollback(async (trx) => {
      const { check, user } = await setup(trx);
      await trx
        .updateTable("users")
        .set({ status: "deactivated", deactivated_at: sql<Date>`now()` })
        .where("id", "=", user.id)
        .execute();
      expect(await check()).toEqual({ ok: false, error: "refused" });
    }));

  it("refuses a learner with a confirmed booking that has not ended", () =>
    inRollback(async (trx) => {
      const { check, book } = await setup(trx);
      await book({ status: "confirmed", starts: slot(24), ends: slot(26) });
      expect(await check()).toEqual({ ok: false, error: "has_live_booking" });
    }));

  it("passes a learner whose confirmed booking has ended", () =>
    inRollback(async (trx) => {
      const { check, book } = await setup(trx);
      await book({ status: "confirmed", starts: slot(-4), ends: slot(-2) });
      expect((await check()).ok).toBe(true);
    }));

  it("refuses a learner whose booking is running right now", () =>
    inRollback(async (trx) => {
      const { check, book } = await setup(trx);
      await book({ status: "confirmed", starts: slot(-1), ends: slot(1) });
      expect(await check()).toEqual({ ok: false, error: "has_live_booking" });
    }));

  it("passes a learner whose future booking was cancelled", () =>
    inRollback(async (trx) => {
      const { check, user, testbed, type } = await setup(trx);
      await trx
        .insertInto("bookings")
        .values({
          user_id: user.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: slot(24),
          ends_at: slot(26),
          status: "cancelled",
          cancelled_at: sql<Date>`now()`,
          cancel_source: "learner",
        })
        .execute();
      expect((await check()).ok).toBe(true);
    }));

  it("refuses a provisioning attempt under a minute old", () =>
    inRollback(async (trx) => {
      const { check, book } = await setup(trx);
      await book({ status: "provisioning", starts: slot(24), ends: slot(26) });
      expect(await check()).toEqual({ ok: false, error: "booking_pending" });
    }));

  it("ignores a provisioning attempt over a minute old", () =>
    inRollback(async (trx) => {
      const { check, book } = await setup(trx);
      const { rows } = await sql<{
        at: Date;
      }>`select now() - interval '2 minutes' as at`.execute(trx);
      await book({
        status: "provisioning",
        starts: slot(24),
        ends: slot(26),
        createdAt: rows[0]?.at,
      });
      expect((await check()).ok).toBe(true);
    }));

  it("refuses a deleted type", () =>
    inRollback(async (trx) => {
      const { check, type } = await setup(trx);
      await trx
        .updateTable("testbed_types")
        .set({ deleted_at: new Date(Date.now() - HOUR) })
        .where("id", "=", type.id)
        .execute();
      expect(await check("new@example.test")).toEqual({
        ok: false,
        error: "type_unavailable",
      });
    }));

  it("refuses a type with no bookable testbed, or an unknown one", () =>
    inRollback(async (trx) => {
      const { check } = await setup(trx);
      const empty = await makeType(trx);
      await makeTestbed(trx, empty.id, { deleted_at: new Date() });
      expect(await check("new@example.test", empty.id)).toEqual({
        ok: false,
        error: "type_unavailable",
      });
      expect(await check("new@example.test", crypto.randomUUID())).toEqual({
        ok: false,
        error: "type_unavailable",
      });
    }));

  it("checks the account before the type", () =>
    inRollback(async (trx) => {
      const { check } = await setup(trx);
      const admin = await makeUser(trx, { role: "admin" });
      expect(await check(admin.email, crypto.randomUUID())).toEqual({
        ok: false,
        error: "admin_email",
      });
    }));

  // AC-2 step (4): first match wins, in the order admin, deactivated, live.
  it("names an admin before a deactivated account", () =>
    inRollback(async (trx) => {
      const { check } = await setup(trx);
      const admin = await makeUser(trx, {
        role: "admin",
        status: "deactivated",
        deactivated_at: new Date(Date.now() - HOUR),
      });
      expect(await check(admin.email)).toEqual({
        ok: false,
        error: "admin_email",
      });
    }));

  it("names a deactivated account before its live booking", () =>
    inRollback(async (trx) => {
      const { check, book, user } = await setup(trx);
      await book({ status: "confirmed", starts: slot(24), ends: slot(26) });
      await trx
        .updateTable("users")
        .set({ status: "deactivated", deactivated_at: sql<Date>`now()` })
        .where("id", "=", user.id)
        .execute();
      expect(await check()).toEqual({ ok: false, error: "refused" });
    }));

  it("names a live booking before a gone type", () =>
    inRollback(async (trx) => {
      const { check, book, user } = await setup(trx);
      await book({ status: "confirmed", starts: slot(24), ends: slot(26) });
      expect(await check(user.email, crypto.randomUUID())).toEqual({
        ok: false,
        error: "has_live_booking",
      });
    }));

  it("writes nothing", () =>
    inRollback(async (trx) => {
      const { check, book } = await setup(trx);
      await book({ status: "provisioning", starts: slot(24), ends: slot(26) });
      const before = await counts(trx);
      await check();
      await check("new@example.test");
      expect(await counts(trx)).toEqual(before);
    }));
});
