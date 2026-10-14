import type { Insertable, Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import {
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { Bookings, DB } from "@/server/db/types";
import { ownLabAccess, ownLabLinks, sessionLabLinks } from "./lab-access";

vi.mock("server-only", () => ({}));

const VERIFIED = { email_verified_at: new Date() } as const;

// A verified learner, a testbed with two clients (inserted out of order, with
// OS logins), and a booking builder for them.
async function world(trx: Kysely<DB>) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const user = await makeUser(trx, VERIFIED);
  await trx
    .insertInto("testbed_clients")
    .values([
      {
        testbed_id: testbed.id,
        name: "Client B",
        kind: "wireless",
        url: "https://b.example.test",
        position: 1,
        os_username: "student",
        os_password: "s3cret-pass",
      },
      {
        testbed_id: testbed.id,
        name: "Client A",
        kind: "wired",
        url: "https://a.example.test",
        position: 0,
        os_username: "student",
        os_password: "s3cret-pass",
      },
    ])
    .execute();
  const book = (
    from: number,
    to: number,
    extra: Partial<Insertable<Bookings>> = {},
  ) =>
    trx
      .insertInto("bookings")
      .values({
        user_id: user.id,
        testbed_id: testbed.id,
        testbed_type_id: type.id,
        starts_at: slot(from),
        ends_at: slot(to),
        status: "confirmed",
        ...extra,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  return { type, testbed, user, book };
}

// covers: AC-1
describe.skipIf(!hasDb)("ownLabAccess (AC-1)", () => {
  it("returns the learner's own links, clients in position order, no OS logins", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(-1, 1);
      const found = await ownLabAccess(trx, w.user.id, b.id);
      expect(found).toEqual({
        kind: "ok",
        access: {
          testbedName: w.testbed.name,
          typeName: w.type.name,
          status: "confirmed",
          startsAt: b.starts_at,
          endsAt: b.ends_at,
          links: {
            portalUrl: "https://portal.example.test",
            lmsUrl: "https://lms.example.test",
            clients: [
              {
                name: "Client A",
                kind: "wired",
                url: "https://a.example.test",
              },
              {
                name: "Client B",
                kind: "wireless",
                url: "https://b.example.test",
              },
            ],
          },
        },
      });
      const json = JSON.stringify(found);
      expect(json).not.toContain("os_");
      expect(json).not.toContain("s3cret-pass");
      expect(json).not.toContain("student");
    }));

  it("returns missing for every miss", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const other = await makeUser(trx, VERIFIED);
      const theirs = await w.book(10, 12, { user_id: other.id });
      const cancelled = await w.book(20, 22, {
        status: "cancelled",
        cancelled_at: new Date(),
        cancel_source: "admin",
      });
      const provisioning = await w.book(30, 32, { status: "provisioning" });
      const misses = [
        ownLabAccess(trx, w.user.id, theirs.id),
        ownLabAccess(trx, w.user.id, cancelled.id),
        ownLabAccess(trx, w.user.id, provisioning.id),
        ownLabAccess(trx, w.user.id, crypto.randomUUID()),
        ownLabAccess(trx, w.user.id, "not-a-uuid"),
      ];
      for (const miss of await Promise.all(misses))
        expect(miss).toEqual({ kind: "missing" });
    }));

  it("returns missing for an unverified, deactivated, or admin user", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(10, 12);
      const setUser = (values: Partial<Insertable<DB["users"]>>) =>
        trx
          .updateTable("users")
          .set(values)
          .where("id", "=", w.user.id)
          .execute();

      await setUser({ email_verified_at: null });
      expect(await ownLabAccess(trx, w.user.id, b.id)).toEqual({
        kind: "missing",
      });
      await setUser({
        ...VERIFIED,
        status: "deactivated",
        deactivated_at: new Date(),
      });
      expect(await ownLabAccess(trx, w.user.id, b.id)).toEqual({
        kind: "missing",
      });
      await setUser({ status: "active", deactivated_at: null, role: "admin" });
      expect(await ownLabAccess(trx, w.user.id, b.id)).toEqual({
        kind: "missing",
      });
    }));

  it("still returns a Past booking on a soft deleted testbed", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(-50, -48, { status: "completed" });
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", w.testbed.id)
        .execute();
      const found = await ownLabAccess(trx, w.user.id, b.id);
      expect(found).toMatchObject({
        kind: "ok",
        access: { testbedName: w.testbed.name, status: "completed" },
      });
    }));
});

// covers: AC-2, AC-3, AC-5
describe.skipIf(!hasDb)("sessionLabLinks and ownLabLinks", () => {
  it("gives links only to the session's own learner", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const b = await w.book(10, 12);
      const booked = { userId: w.user.id, bookingId: b.id };
      expect(await sessionLabLinks(trx, undefined, booked)).toBeNull();
      expect(
        await sessionLabLinks(trx, crypto.randomUUID(), booked),
      ).toBeNull();
      expect(await sessionLabLinks(trx, w.user.id, booked)).toMatchObject({
        portalUrl: "https://portal.example.test",
      });
    }));

  it("answers null when the read throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      selectFrom: () => {
        throw new Error("db down");
      },
    } as unknown as Kysely<DB>;
    expect(
      await ownLabLinks(broken, crypto.randomUUID(), crypto.randomUUID()),
    ).toBeNull();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
