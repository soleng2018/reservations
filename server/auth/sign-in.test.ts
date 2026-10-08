import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import {
  asConn,
  hasDb,
  inRollback,
  makeAuthUser,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { onSessionCreate, validateSignIn } from "./sign-in";

// Authentik pks well above the real ones, unique per test run.
const pk = () => 900_000 + Math.floor(Math.random() * 99_999);
const HOURS = { admin: 2, learner: 8 };

const row = (trx: Kysely<DB>, authentikPk: number) =>
  trx
    .selectFrom("users")
    .selectAll()
    .where("authentik_user_pk", "=", authentikPk)
    .executeTakeFirst();

const audits = async (trx: Kysely<DB>, action: string) =>
  (
    await trx
      .selectFrom("audit_events")
      .select("target_id")
      .where("action", "=", action)
      .where("created_at", ">=", new Date(Date.now() - 60_000))
      .execute()
  ).map((a) => a.target_id);

// covers: AC-2, AC-10, AC-16
describe.skipIf(!hasDb)("validateSignIn (AC-2, AC-10)", () => {
  it("refuses claims it cannot parse", () =>
    inRollback(async (trx) => {
      expect(await validateSignIn(asConn(trx), { sub: "abc" })).toBe(
        "not_authorized",
      );
      expect(await validateSignIn(asConn(trx), undefined)).toBe(
        "not_authorized",
      );
    }));

  it("refuses an unknown learner and writes no row", () =>
    inRollback(async (trx) => {
      const p = pk();
      expect(
        await validateSignIn(asConn(trx), {
          sub: String(p),
          email: `nobody-${p}@x.test`,
          groups: [],
        }),
      ).toBe("unknown");
      expect(await row(trx, p)).toBeUndefined();
    }));

  it("lets a known learner in, matched by sub", () =>
    inRollback(async (trx) => {
      const p = pk();
      await makeUser(trx, { authentik_user_pk: p });
      expect(
        await validateSignIn(asConn(trx), {
          sub: String(p),
          email: "changed@x.test",
          groups: [],
        }),
      ).toBeUndefined();
    }));

  it("refuses a deactivated learner", () =>
    inRollback(async (trx) => {
      const p = pk();
      await makeUser(trx, {
        authentik_user_pk: p,
        status: "deactivated",
        deactivated_at: new Date(),
      });
      expect(
        await validateSignIn(asConn(trx), { sub: String(p), groups: [] }),
      ).toBe("deactivated");
    }));

  it("creates an admin row on first sign in", () =>
    inRollback(async (trx) => {
      const p = pk();
      expect(
        await validateSignIn(asConn(trx), {
          sub: String(p),
          email: `admin-${p}@x.test`,
          name: "Ada",
          groups: ["hol-admins"],
        }),
      ).toBeUndefined();
      expect(await row(trx, p)).toMatchObject({
        role: "admin",
        name: "Ada",
        company: "Nile",
        timezone: "UTC",
        email: `admin-${p}@x.test`,
      });
    }));

  it("links an existing admin row by email the first time", () =>
    inRollback(async (trx) => {
      const p = pk();
      const admin = await makeUser(trx, {
        role: "admin",
        email: `Admin-${p}@X.test`,
      });
      await validateSignIn(asConn(trx), {
        sub: String(p),
        email: `admin-${p}@x.test`,
        groups: ["hol-admins"],
      });
      expect((await row(trx, p))?.id).toBe(admin.id);
    }));

  it("refuses an admin with no email claim, and audits it (AC-16)", () =>
    inRollback(async (trx) => {
      const p = pk();
      expect(
        await validateSignIn(asConn(trx), {
          sub: String(p),
          groups: ["hol-admins"],
        }),
      ).toBe("not_authorized");
      expect(await row(trx, p)).toBeUndefined();
      expect(await audits(trx, "admin.sign_in_refused")).toContain(
        `authentik:${p}`,
      );
    }));

  it("refuses a learner row that appears in hol-admins, and audits it", () =>
    inRollback(async (trx) => {
      const p = pk();
      const learner = await makeUser(trx, { authentik_user_pk: p });
      expect(
        await validateSignIn(asConn(trx), {
          sub: String(p),
          email: learner.email,
          groups: ["hol-admins"],
        }),
      ).toBe("not_authorized");
      expect((await row(trx, p))?.role).toBe("learner");
      expect(await audits(trx, "admin.sign_in_refused")).toContain(learner.id);
    }));

  it("turns an admin removed from hol-admins into a learner", () =>
    inRollback(async (trx) => {
      const p = pk();
      await makeUser(trx, { role: "admin", authentik_user_pk: p });
      expect(
        await validateSignIn(asConn(trx), { sub: String(p), groups: [] }),
      ).toBeUndefined();
      expect((await row(trx, p))?.role).toBe("learner");
    }));
});

// covers: AC-7, AC-11, AC-16
describe.skipIf(!hasDb)("onSessionCreate (AC-7, AC-11)", () => {
  const hoursFromNow = (d: Date | undefined) =>
    d && Math.round((d.getTime() - Date.now()) / 3_600_000);

  it("verifies a learner on first sign in and gives 8 hours", () =>
    inRollback(async (trx) => {
      const p = pk();
      const authId = await makeAuthUser(trx, p);
      await makeUser(trx, { authentik_user_pk: p, set_password_pending: true });

      expect(
        hoursFromNow(await onSessionCreate(asConn(trx), authId, HOURS)),
      ).toBe(8);
      const first = await row(trx, p);
      expect(first).toMatchObject({
        auth_user_id: authId,
        set_password_pending: false,
      });
      expect(first?.email_verified_at).toBeInstanceOf(Date);
    }));

  it("never moves email_verified_at once set", () =>
    inRollback(async (trx) => {
      const p = pk();
      const authId = await makeAuthUser(trx, p);
      const verified = new Date("2026-01-02T03:04:05Z");
      await makeUser(trx, {
        authentik_user_pk: p,
        email_verified_at: verified,
      });
      await onSessionCreate(asConn(trx), authId, HOURS);
      expect((await row(trx, p))?.email_verified_at).toEqual(verified);
    }));

  it("gives an admin 2 hours, audits it, and never marks them verified", () =>
    inRollback(async (trx) => {
      const p = pk();
      const authId = await makeAuthUser(trx, p);
      const admin = await makeUser(trx, {
        role: "admin",
        authentik_user_pk: p,
      });
      expect(
        hoursFromNow(await onSessionCreate(asConn(trx), authId, HOURS)),
      ).toBe(2);
      expect((await row(trx, p))?.email_verified_at).toBeNull();
      expect(await audits(trx, "admin.signed_in")).toContain(admin.id);
    }));

  it("refuses a session with no account, no row, or a deactivated row", () =>
    inRollback(async (trx) => {
      expect(
        await onSessionCreate(asConn(trx), crypto.randomUUID(), HOURS),
      ).toBeUndefined();

      const noRow = await makeAuthUser(trx, pk());
      expect(await onSessionCreate(asConn(trx), noRow, HOURS)).toBeUndefined();

      const p = pk();
      const gone = await makeAuthUser(trx, p);
      await makeUser(trx, {
        authentik_user_pk: p,
        status: "deactivated",
        deactivated_at: new Date(),
      });
      expect(await onSessionCreate(asConn(trx), gone, HOURS)).toBeUndefined();
    }));
});

// Keeps `has_bookings` honest: an admin claim on a row with bookings is a
// learner account and must be refused.
describe.skipIf(!hasDb)("validateSignIn with bookings", () => {
  it("refuses an admin claim on a row that has bookings", () =>
    inRollback(async (trx) => {
      const p = pk();
      const u = await makeUser(trx, { role: "admin", authentik_user_pk: p });
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      await trx
        .insertInto("bookings")
        .values({
          user_id: u.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: slot(24),
          ends_at: slot(26),
          status: "confirmed",
        })
        .execute();
      expect(
        await validateSignIn(asConn(trx), {
          sub: String(p),
          email: u.email,
          groups: ["hol-admins"],
        }),
      ).toBe("not_authorized");
    }));
});
