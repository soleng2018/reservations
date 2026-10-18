import type { Kysely, Transaction } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/server/db/types";

const ctx = vi.hoisted(() => ({
  conn: undefined as Kysely<DB> | undefined,
  // The signed in learner's users.id; undefined is anyone else, whom
  // requireLearner() redirects.
  learnerId: undefined as string | undefined,
  revalidated: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => ctx.revalidated.push(path),
}));
vi.mock("@/server/auth/require", () => ({
  requireLearner: async () => {
    if (!ctx.learnerId) throw new Error("NEXT_REDIRECT");
    return { user: { id: ctx.learnerId } };
  },
}));
vi.mock("@/server/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db")>();
  return { ...real, db: () => ctx.conn ?? real.db() };
});

const {
  loadRescheduleStartsAction,
  previewRescheduleAction,
  rescheduleAction,
} = await import("./actions");
const { asConn, hasDb, inRollback, makeTestbed, makeType, makeUser, slot } =
  await import("@/server/db/testing");

// Runs a test body with db() pointed at the rollback transaction.
const withConn = (fn: (trx: Transaction<DB>) => Promise<void>) =>
  inRollback(async (trx) => {
    ctx.conn = asConn(trx);
    try {
      await fn(trx);
    } finally {
      ctx.conn = undefined;
    }
  });

// A learner signed in with one Upcoming booking.
async function signedIn(trx: Kysely<DB>) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const user = await makeUser(trx);
  const booking = await trx
    .insertInto("bookings")
    .values({
      user_id: user.id,
      testbed_id: testbed.id,
      testbed_type_id: type.id,
      starts_at: slot(48),
      ends_at: slot(50),
      status: "confirmed",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  ctx.learnerId = user.id;
  return { type, testbed, user, booking };
}

const startsOf = async (trx: Kysely<DB>, id: string) =>
  (
    await trx
      .selectFrom("bookings")
      .select("starts_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).starts_at;

// covers: AC-7, AC-14, AC-15
describe.skipIf(!hasDb)("loadRescheduleStartsAction", () => {
  beforeEach(() => {
    ctx.learnerId = undefined;
  });

  it("offers the type's starts, including the booking's own range", () =>
    withConn(async (trx) => {
      const { booking } = await signedIn(trx);
      const r = await loadRescheduleStartsAction(booking.id);
      if (!("starts" in r)) throw new Error("expected starts");
      expect(r.durationMs).toBe(2 * 3_600_000);
      expect(r.starts).toContain(slot(48).toISOString());
      expect(r.starts).toContain(slot(49).toISOString());
    }));

  it("answers gone for another learner's booking or a malformed id", () =>
    withConn(async (trx) => {
      const { booking } = await signedIn(trx);
      expect(await loadRescheduleStartsAction("nope")).toEqual({
        gone: true,
      });
      ctx.learnerId = (await makeUser(trx)).id;
      expect(await loadRescheduleStartsAction(booking.id)).toEqual({
        gone: true,
      });
    }));

  it("is limited after 60 loads in 10 minutes", () =>
    withConn(async (trx) => {
      const { booking } = await signedIn(trx);
      for (let i = 0; i < 60; i++) await loadRescheduleStartsAction("nope");
      expect(await loadRescheduleStartsAction(booking.id)).toEqual({
        limited: true,
      });
    }));
});

// covers: AC-8, AC-14
describe.skipIf(!hasDb)("previewRescheduleAction", () => {
  beforeEach(() => {
    ctx.learnerId = undefined;
  });

  it("keeps the booking's own testbed when it is free", () =>
    withConn(async (trx) => {
      const { booking, testbed } = await signedIn(trx);
      expect(
        await previewRescheduleAction(booking.id, slot(49).toISOString()),
      ).toEqual({
        kind: "ok",
        testbedName: testbed.name,
        endsAt: slot(51).toISOString(),
      });
    }));

  it("reads a bad start as taken and another learner's id as gone", () =>
    withConn(async (trx) => {
      const { booking } = await signedIn(trx);
      expect(await previewRescheduleAction(booking.id, "soon")).toEqual({
        kind: "taken",
      });
      ctx.learnerId = (await makeUser(trx)).id;
      expect(
        await previewRescheduleAction(booking.id, slot(72).toISOString()),
      ).toEqual({ kind: "gone" });
    }));

  it("is limited after 60 previews in 10 minutes", () =>
    withConn(async (trx) => {
      const { booking } = await signedIn(trx);
      for (let i = 0; i < 60; i++) await previewRescheduleAction("nope", "x");
      expect(
        await previewRescheduleAction(booking.id, slot(72).toISOString()),
      ).toEqual({ kind: "limited" });
    }));
});

// covers: AC-9, AC-14, AC-15
describe.skipIf(!hasDb)("rescheduleAction", () => {
  beforeEach(() => {
    ctx.learnerId = undefined;
    ctx.revalidated = [];
  });

  it("moves the booking and refreshes the list", () =>
    withConn(async (trx) => {
      const { booking, testbed, type } = await signedIn(trx);
      expect(
        await rescheduleAction(
          booking.id,
          booking.version,
          slot(72).toISOString(),
        ),
      ).toEqual({
        kind: "rescheduled",
        testbedName: testbed.name,
        typeName: type.name,
        startsAt: slot(72).toISOString(),
        endsAt: slot(74).toISOString(),
        // An unverified learner gets no links (spec 0012 AC-1).
        access: null,
      });
      expect(await startsOf(trx, booking.id)).toEqual(slot(72));
      expect(ctx.revalidated).toEqual(["/reservations"]);
    }));

  // covers: spec 0012 AC-5
  it("returns the new testbed's links when the move changes the testbed", () =>
    withConn(async (trx) => {
      const { booking, testbed, type, user } = await signedIn(trx);
      await trx
        .updateTable("users")
        .set({ email_verified_at: new Date() })
        .where("id", "=", user.id)
        .execute();
      // The kept testbed is busy at the new time, so the move goes elsewhere.
      const other = await makeUser(trx);
      await trx
        .insertInto("bookings")
        .values({
          user_id: other.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: slot(72),
          ends_at: slot(74),
          status: "confirmed",
        })
        .execute();
      const moved = await makeTestbed(trx, type.id, {
        portal_url: "https://moved-portal.example.test",
        lms_url: "https://moved-lms.example.test",
      });
      expect(
        await rescheduleAction(
          booking.id,
          booking.version,
          slot(72).toISOString(),
        ),
      ).toMatchObject({
        kind: "rescheduled",
        testbedName: moved.name,
        access: {
          portalUrl: "https://moved-portal.example.test",
          lmsUrl: "https://moved-lms.example.test",
          clients: [],
        },
      });
    }));

  it("answers invalid for bad input", () =>
    withConn(async (trx) => {
      const { booking } = await signedIn(trx);
      for (const [id, version, at] of [
        ["nope", booking.version, slot(72).toISOString()],
        [booking.id, 0, slot(72).toISOString()],
        [booking.id, booking.version, "tomorrow"],
      ] as const)
        expect(await rescheduleAction(id, version, at)).toEqual({
          kind: "error",
          code: "invalid",
        });
      expect(await startsOf(trx, booking.id)).toEqual(booking.starts_at);
    }));

  it("answers stale for another learner's booking", () =>
    withConn(async (trx) => {
      const { booking } = await signedIn(trx);
      ctx.learnerId = (await makeUser(trx)).id;
      expect(
        await rescheduleAction(
          booking.id,
          booking.version,
          slot(72).toISOString(),
        ),
      ).toEqual({ kind: "error", code: "stale" });
      expect(await startsOf(trx, booking.id)).toEqual(booking.starts_at);
    }));

  it("is limited on the 21st attempt in an hour", () =>
    withConn(async (trx) => {
      const { booking } = await signedIn(trx);
      for (let i = 0; i < 20; i++) await rescheduleAction("nope", 1, "x");
      expect(
        await rescheduleAction(
          booking.id,
          booking.version,
          slot(72).toISOString(),
        ),
      ).toEqual({ kind: "error", code: "limited" });
      expect(await startsOf(trx, booking.id)).toEqual(booking.starts_at);
    }));

  it("writes nothing when nobody is signed in as a learner", () =>
    withConn(async (trx) => {
      const { booking } = await signedIn(trx);
      ctx.learnerId = undefined;
      for (const call of [
        () => loadRescheduleStartsAction(booking.id),
        () => previewRescheduleAction(booking.id, slot(72).toISOString()),
        () =>
          rescheduleAction(booking.id, booking.version, slot(72).toISOString()),
      ])
        await expect(call()).rejects.toThrow("NEXT_REDIRECT");
      expect(await startsOf(trx, booking.id)).toEqual(booking.starts_at);
      expect(ctx.revalidated).toEqual([]);
    }));
});
