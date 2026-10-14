import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { DB } from "@/server/db/types";

// Spec 0011 AC-13 and AC-15: who /book treats as the signed in learner.

const ctx = vi.hoisted(() => ({
  // What currentSession() returns; undefined is signed out.
  session: undefined as
    | {
        readonly user: {
          readonly id: string;
          readonly role: string;
          readonly status: string;
        };
      }
    | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/auth/require", () => ({
  currentSession: async () => ctx.session,
}));

const { sessionAccount } = await import("./account");
const { hasDb, inRollback, makeUser } = await import("@/server/db/testing");

const signInAs = (user: { id: string; role: string; status: string }) => {
  ctx.session = {
    user: { id: user.id, role: user.role, status: user.status },
  };
};

const deactivate = (trx: Kysely<DB>, id: string) =>
  trx
    .updateTable("users")
    .set({ status: "deactivated", deactivated_at: new Date() })
    .where("id", "=", id)
    .execute();

describe.skipIf(!hasDb)("sessionAccount", () => {
  // covers: AC-13
  it("returns the active learner's row as stored", () =>
    inRollback(async (trx) => {
      const user = await makeUser(trx, {
        name: "Ada Lovelace",
        company: "Analytical Co",
        timezone: "America/New_York",
      });
      signInAs(user);

      const account = await sessionAccount(trx);

      expect(account).toEqual({
        id: user.id,
        name: "Ada Lovelace",
        company: "Analytical Co",
        email: user.email,
        timezone: "America/New_York",
      });
    }));

  // covers: AC-13 (Company hidden when the account has none)
  it("keeps a missing company as null", () =>
    inRollback(async (trx) => {
      const user = await makeUser(trx, { company: null });
      signInAs(user);

      const account = await sessionAccount(trx);

      expect(account?.company).toBeNull();
    }));

  // covers: AC-13, AC-15
  it("returns only the fields /book shows, never other users columns", () =>
    inRollback(async (trx) => {
      const user = await makeUser(trx);
      signInAs(user);

      const account = await sessionAccount(trx);

      expect(Object.keys(account ?? {}).sort()).toEqual([
        "company",
        "email",
        "id",
        "name",
        "timezone",
      ]);
    }));

  // covers: AC-13 (/book stays public)
  it("returns undefined for a guest who is not signed in", () =>
    inRollback(async (trx) => {
      await makeUser(trx);
      ctx.session = undefined;

      await expect(sessionAccount(trx)).resolves.toBeUndefined();
    }));

  // covers: AC-15
  it("returns undefined for a signed in admin", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      signInAs(admin);

      await expect(sessionAccount(trx)).resolves.toBeUndefined();
    }));

  // covers: AC-15
  it("returns undefined when the session already says deactivated", () =>
    inRollback(async (trx) => {
      const user = await makeUser(trx);
      signInAs({ ...user, status: "deactivated" });

      await expect(sessionAccount(trx)).resolves.toBeUndefined();
    }));

  // covers: AC-15 (the row is checked again, not just the session)
  it("returns undefined when the row was deactivated after the session was read", () =>
    inRollback(async (trx) => {
      const user = await makeUser(trx);
      signInAs(user);
      await deactivate(trx, user.id);

      await expect(sessionAccount(trx)).resolves.toBeUndefined();
    }));

  // covers: AC-15
  it("returns undefined when the session claims learner but the row is an admin", () =>
    inRollback(async (trx) => {
      const admin = await makeUser(trx, { role: "admin" });
      signInAs({ ...admin, role: "learner" });

      await expect(sessionAccount(trx)).resolves.toBeUndefined();
    }));

  it("returns undefined when the session's user row no longer exists", () =>
    inRollback(async (trx) => {
      signInAs({
        id: crypto.randomUUID(),
        role: "learner",
        status: "active",
      });

      await expect(sessionAccount(trx)).resolves.toBeUndefined();
    }));
});
