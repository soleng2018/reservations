import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  ADMINS,
  fakeAuthentik,
  fakeUser,
  type FakeUser,
} from "@/server/authentik/testing";
import type { GuestBookingInput } from "@/server/db/guest-saga";
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
import { bookAsGuest } from "./guest-booking";

async function setup(trx: Kysely<DB>) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const email = `priya-${crypto.randomUUID().slice(0, 8)}@x.test`;
  const input: GuestBookingInput = {
    name: "Priya",
    company: "Acme",
    email,
    timezone: "UTC",
    testbedTypeId: type.id,
    startsAt: slot(24),
  };
  const state = async () => {
    const user = await trx
      .selectFrom("users")
      .select(["id", "authentik_user_pk"])
      .where("email", "ilike", email)
      .executeTakeFirst();
    const bookings = user
      ? await trx
          .selectFrom("bookings")
          .select("status")
          .where("user_id", "=", user.id)
          .execute()
      : [];
    const jobs = user
      ? await trx
          .selectFrom("jobs")
          .select("idempotency_key")
          .where("payload", "@>", JSON.stringify({ userId: user.id }))
          .execute()
      : [];
    return {
      user,
      bookings: bookings.map((b) => b.status),
      jobs: jobs.map((j) => j.idempotency_key),
    };
  };
  const audits = async (action: string) =>
    (
      await trx
        .selectFrom("audit_events")
        .select("target_id")
        .where("action", "=", action)
        .where("created_at", ">=", new Date(Date.now() - 60_000))
        .execute()
    ).length;
  return { input, email, state, audits, type, testbed };
}

const existing = (email: string, over: Partial<FakeUser> = {}) =>
  fakeUser({ pk: 7, username: email, email, ...over });

// covers: AC-5, AC-6, AC-15, AC-16
describe.skipIf(!hasDb)("bookAsGuest (AC-5, AC-6)", () => {
  it("creates one learner, confirms the booking, and queues one welcome", () =>
    inRollback(async (trx) => {
      const { input, state, audits } = await setup(trx);
      const ak = fakeAuthentik([]);
      const r = await bookAsGuest(ak.api, asConn(trx), input);
      expect(r).toMatchObject({
        ok: true,
        value: { newUser: true, typeName: expect.any(String) },
      });

      const s = await state();
      expect(ak.users).toHaveLength(1);
      expect(s.user?.authentik_user_pk).toBe(ak.users[0]?.pk);
      expect(s.bookings).toEqual(["confirmed"]);
      expect(s.jobs).toEqual([`welcome:${s.user?.id}`]);
      expect(await audits("user.created_in_authentik")).toBe(1);
      expect(await audits("booking.created")).toBe(1);
    }));

  it("reuses a known Authentik user and sends no welcome", () =>
    inRollback(async (trx) => {
      const { input, email, state, audits } = await setup(trx);
      const ak = fakeAuthentik([existing(email)]);
      expect(await bookAsGuest(ak.api, asConn(trx), input)).toMatchObject({
        ok: true,
        value: { newUser: false },
      });

      const s = await state();
      expect(ak.users).toHaveLength(1);
      expect(s.user?.authentik_user_pk).toBe(7);
      expect(s.bookings).toEqual(["confirmed"]);
      expect(s.jobs).toEqual([]);
      expect(await audits("user.tagged_in_authentik")).toBe(1);
    }));

  it("refuses an admin row's email before calling Authentik", () =>
    inRollback(async (trx) => {
      const { input, email, audits } = await setup(trx);
      await makeUser(trx, { role: "admin", email });
      const ak = fakeAuthentik([]);
      expect(await bookAsGuest(ak.api, asConn(trx), input)).toEqual({
        ok: false,
        error: "admin_email",
      });
      expect(ak.writes).toEqual([]);
      expect(await audits("booking.refused_admin_email")).toBe(1);
    }));

  it("refuses an Authentik admin's email and leaves nothing behind", () =>
    inRollback(async (trx) => {
      const { input, email, state, audits } = await setup(trx);
      const ak = fakeAuthentik([existing(email, { groups: [ADMINS.pk] })]);
      expect(await bookAsGuest(ak.api, asConn(trx), input)).toEqual({
        ok: false,
        error: "admin_email",
      });
      expect(await state()).toEqual({
        user: undefined,
        bookings: [],
        jobs: [],
      });
      expect(ak.writes).toEqual([]);
      expect(await audits("booking.refused_admin_email")).toBe(1);
    }));

  it("refuses a username taken by another email, and audits it", () =>
    inRollback(async (trx) => {
      const { input, email, state, audits } = await setup(trx);
      const ak = fakeAuthentik([existing("other@x.test", { username: email })]);
      expect(await bookAsGuest(ak.api, asConn(trx), input)).toEqual({
        ok: false,
        error: "unavailable",
      });
      expect((await state()).user).toBeUndefined();
      expect(await audits("booking.refused_username_taken")).toBe(1);
    }));

  it("leaves nothing behind when Authentik is down (AC-15)", () =>
    inRollback(async (trx) => {
      const { input, state } = await setup(trx);
      const ak = fakeAuthentik([], { down: true });
      expect(await bookAsGuest(ak.api, asConn(trx), input)).toEqual({
        ok: false,
        error: "unavailable",
      });
      expect(await state()).toEqual({
        user: undefined,
        bookings: [],
        jobs: [],
      });
    }));

  // covers: spec 0004 AC-9
  it("never writes pod group membership, even when step 2 times out", () =>
    inRollback(async (trx) => {
      const { input, state } = await setup(trx);
      const ak = fakeAuthentik([], {
        fail: (m, p) => m === "POST" && p === "/core/users/",
      });
      expect(await bookAsGuest(ak.api, asConn(trx), input)).toEqual({
        ok: false,
        error: "unavailable",
      });
      expect(await state()).toEqual({
        user: undefined,
        bookings: [],
        jobs: [],
      });
      expect(ak.writes.filter((w) => w.includes("_user/"))).toEqual([]);

      const ok = fakeAuthentik([]);
      expect((await bookAsGuest(ok.api, asConn(trx), input)).ok).toBe(true);
      expect(ok.writes.filter((w) => w.includes("/core/groups/"))).toEqual([]);
    }));

  // covers: spec 0004 AC-9 (a step 1 refusal commits nothing)
  it("leaves no users row when step 1 refuses a new email", () =>
    inRollback(async (trx) => {
      const { input, state, testbed } = await setup(trx);
      const ak = fakeAuthentik([]);
      const other = await makeUser(trx);
      await trx
        .insertInto("bookings")
        .values({
          user_id: other.id,
          testbed_id: testbed.id,
          testbed_type_id: input.testbedTypeId,
          starts_at: input.startsAt,
          ends_at: new Date(input.startsAt.getTime() + 2 * 3_600_000),
          status: "confirmed",
        })
        .execute();
      expect(await bookAsGuest(ak.api, asConn(trx), input)).toEqual({
        ok: false,
        error: "slot_taken",
      });
      expect((await state()).user).toBeUndefined();

      await trx
        .updateTable("testbeds")
        .set({ authentik_group_pk: null })
        .where("id", "=", testbed.id)
        .execute();
      expect(await bookAsGuest(ak.api, asConn(trx), input)).toEqual({
        ok: false,
        error: "not_bookable",
      });
      expect((await state()).user).toBeUndefined();
      expect(ak.writes).toEqual([]);
    }));

  // covers: spec 0004 AC-8
  it("tells a live booking apart from one still being set up", () =>
    inRollback(async (trx) => {
      const { input, email } = await setup(trx);
      const ak = fakeAuthentik([existing(email)]);
      expect((await bookAsGuest(ak.api, asConn(trx), input)).ok).toBe(true);
      const again = { ...input, startsAt: slot(48) };
      expect(await bookAsGuest(ak.api, asConn(trx), again)).toEqual({
        ok: false,
        error: "has_live_booking",
      });

      await trx
        .updateTable("bookings")
        .set({ status: "provisioning" })
        .where("starts_at", "=", input.startsAt)
        .where("testbed_type_id", "=", input.testbedTypeId)
        .execute();
      expect(await bookAsGuest(ak.api, asConn(trx), again)).toEqual({
        ok: false,
        error: "booking_pending",
      });
    }));
});
