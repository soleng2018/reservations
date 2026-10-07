import { sql, type Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import {
  compensateGuestBooking,
  confirmGuestBooking,
  recordAuthentikUser,
  staleProvisioning,
  startGuestBooking,
  type GuestBookingInput,
} from "./guest-saga";
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
import type { DB } from "./types";

// The Authentik boundary is a recording stub here; feature 6 tests the real call.
const recorder = () => {
  const deleted: number[] = [];
  return {
    deleted,
    deleteAuthentikUser: async (pk: number) => {
      deleted.push(pk);
    },
  };
};

async function setup(trx: Kysely<DB>) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const input: GuestBookingInput = {
    name: "Priya",
    company: "Acme",
    email: `Priya-${crypto.randomUUID().slice(0, 8)}@x.test`,
    timezone: "America/New_York",
    testbedId: testbed.id,
    testbedTypeId: type.id,
    startsAt: slot(24),
    endsAt: slot(26),
  };
  const state = async (userId: string) => ({
    user: await trx
      .selectFrom("users")
      .select(["authentik_user_pk", "authentik_pending_saga"])
      .where("id", "=", userId)
      .executeTakeFirst(),
    bookings: await trx
      .selectFrom("bookings")
      .select("status")
      .where("user_id", "=", userId)
      .execute(),
  });
  return { input, state, testbed };
}

const started = async (trx: Kysely<DB>, input: GuestBookingInput) => {
  const r = await startGuestBooking(trx, input);
  if (!r.ok) throw new Error(`start failed: ${r.error}`);
  return r.value;
};

describe.skipIf(!hasDb)("guest saga data (AC-13)", () => {
  afterAll(() => db().destroy());

  it("runs the happy path to a confirmed booking", () =>
    inRollback(async (trx) => {
      const { input, state } = await setup(trx);
      const ref = await started(trx, input);
      await recordAuthentikUser(trx, ref.userId, { pk: 41, created: true });
      expect(await confirmGuestBooking(trx, ref)).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await state(ref.userId)).toEqual({
        user: { authentik_user_pk: 41, authentik_pending_saga: false },
        bookings: [{ status: "confirmed" }],
      });
    }));

  it("cleans up a crash after step 1 and lets the same email retry", () =>
    inRollback(async (trx) => {
      const { input, state } = await setup(trx);
      const auth = recorder();
      const ref = await started(trx, input);
      await compensateGuestBooking(trx, ref, auth.deleteAuthentikUser);
      expect(await state(ref.userId)).toEqual({
        user: undefined,
        bookings: [],
      });
      expect(auth.deleted).toEqual([]);
      expect((await startGuestBooking(trx, input)).ok).toBe(true);
    }));

  it("deletes the Authentik user this saga created after a step 2 crash", () =>
    inRollback(async (trx) => {
      const { input, state } = await setup(trx);
      const auth = recorder();
      const ref = await started(trx, input);
      await recordAuthentikUser(trx, ref.userId, { pk: 42, created: true });
      await compensateGuestBooking(trx, ref, auth.deleteAuthentikUser);
      expect(auth.deleted).toEqual([42]);
      expect(await state(ref.userId)).toEqual({
        user: undefined,
        bookings: [],
      });
    }));

  it("keeps a reused Authentik user and its row after a step 2 crash", () =>
    inRollback(async (trx) => {
      const { input, state } = await setup(trx);
      const auth = recorder();
      const ref = await started(trx, input);
      await recordAuthentikUser(trx, ref.userId, { pk: 43, created: false });
      await compensateGuestBooking(trx, ref, auth.deleteAuthentikUser);
      expect(auth.deleted).toEqual([]);
      expect(await state(ref.userId)).toEqual({
        user: { authentik_user_pk: 43, authentik_pending_saga: false },
        bookings: [],
      });
    }));

  it("keeps a returning learner with past bookings", () =>
    inRollback(async (trx) => {
      const { input, state, testbed } = await setup(trx);
      const auth = recorder();
      const user = await makeUser(trx, {
        email: input.email.toLowerCase(),
        authentik_user_pk: 44,
      });
      await trx
        .insertInto("bookings")
        .values({
          user_id: user.id,
          testbed_id: testbed.id,
          testbed_type_id: input.testbedTypeId,
          starts_at: slot(-6),
          ends_at: slot(-4),
          status: "completed",
        })
        .execute();
      const ref = await started(trx, input);
      expect(ref.userId).toBe(user.id);
      await compensateGuestBooking(trx, ref, auth.deleteAuthentikUser);
      expect(auth.deleted).toEqual([]);
      expect(await state(user.id)).toEqual({
        user: { authentik_user_pk: 44, authentik_pending_saga: false },
        bookings: [{ status: "completed" }],
      });
    }));

  it("replaces the user's own stale attempt instead of blocking the retry", () =>
    inRollback(async (trx) => {
      const { input, state } = await setup(trx);
      const first = await started(trx, input);
      // Within one minute the earlier attempt still counts as live.
      const tooSoon = await attempt(trx, () =>
        startGuestBooking(trx, {
          ...input,
          startsAt: slot(30),
          endsAt: slot(32),
        }),
      );
      expect(mapConstraintError(tooSoon)).toEqual({
        ok: false,
        error: "user_has_live_booking",
      });

      await trx
        .updateTable("bookings")
        .set({ created_at: sql<Date>`now() - interval '2 minutes'` })
        .where("id", "=", first.bookingId)
        .execute();
      const retry = await started(trx, input);
      expect(retry.userId).toBe(first.userId);
      expect(retry.bookingId).not.toBe(first.bookingId);
      expect(await state(first.userId)).toMatchObject({
        bookings: [{ status: "provisioning" }],
      });
    }));

  it("lets the sweeper find old provisioning rows, and confirm then fails", () =>
    inRollback(async (trx) => {
      const { input, state } = await setup(trx);
      const auth = recorder();
      const ref = await started(trx, input);
      expect(await staleProvisioning(trx)).not.toContainEqual(ref);
      await trx
        .updateTable("bookings")
        .set({ created_at: sql<Date>`now() - interval '11 minutes'` })
        .where("id", "=", ref.bookingId)
        .execute();
      expect(await staleProvisioning(trx)).toContainEqual(ref);
      await compensateGuestBooking(trx, ref, auth.deleteAuthentikUser);
      expect(await confirmGuestBooking(trx, ref)).toEqual({
        ok: false,
        error: "gone",
      });
      expect(await state(ref.userId)).toEqual({
        user: undefined,
        bookings: [],
      });
    }));

  it("refuses admin and deactivated accounts", () =>
    inRollback(async (trx) => {
      const { input } = await setup(trx);
      await makeUser(trx, { role: "admin", company: null, email: input.email });
      expect(await startGuestBooking(trx, input)).toEqual({
        ok: false,
        error: "admin_email",
      });
      const off = { ...input, email: `off-${input.email}` };
      await makeUser(trx, {
        email: off.email,
        status: "deactivated",
        deactivated_at: new Date(),
      });
      expect(await startGuestBooking(trx, off)).toEqual({
        ok: false,
        error: "refused",
      });
    }));

  it("refuses a testbed that cannot take bookings and writes no booking", () =>
    inRollback(async (trx) => {
      const { input, testbed } = await setup(trx);
      await trx
        .updateTable("testbeds")
        .set({ authentik_group_pk: null })
        .where("id", "=", testbed.id)
        .execute();
      expect(await startGuestBooking(trx, input)).toEqual({
        ok: false,
        error: "not_bookable",
      });
      const rows = await trx
        .selectFrom("bookings")
        .select("id")
        .where("testbed_id", "=", testbed.id)
        .execute();
      expect(rows).toEqual([]);
    }));

  it("never deletes an admin row during compensation", () =>
    inRollback(async (trx) => {
      const auth = recorder();
      const admin = await makeUser(trx, { role: "admin", company: null });
      await compensateGuestBooking(
        trx,
        { userId: admin.id, bookingId: crypto.randomUUID() },
        auth.deleteAuthentikUser,
      );
      const still = await trx
        .selectFrom("users")
        .select("id")
        .where("id", "=", admin.id)
        .executeTakeFirst();
      expect(still).toEqual({ id: admin.id });
      expect(auth.deleted).toEqual([]);
    }));
});
