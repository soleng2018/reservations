import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/server/db/types";

const ctx = vi.hoisted(() => ({
  conn: undefined as Kysely<DB> | undefined,
  ip: "203.0.113.7",
  human: true,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "cf-connecting-ip": ctx.ip }),
}));
vi.mock("@/server/turnstile", () => ({
  verifyTurnstile: async () =>
    ctx.human ? { ok: true, value: undefined } : { ok: false, error: "bot" },
}));
vi.mock("@/server/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db")>();
  return { ...real, db: () => ctx.conn ?? real.db() };
});

const { resendSetPassword } = await import("./actions");
const { asConn, hasDb, inRollback, makeUser } =
  await import("@/server/db/testing");

const GENERIC =
  "If that email has a reservation waiting for a password, we've sent a new link. Check your inbox.";

const form = (email: string, token = "tok") => {
  const f = new FormData();
  f.set("email", email);
  f.set("cf-turnstile-response", token);
  return f;
};

// Unique per test so hourly buckets from other runs never collide.
const uniqueIp = () =>
  `198.51.100.${Math.floor(Math.random() * 250)}-${crypto.randomUUID()}`;

const resendJobs = (trx: Kysely<DB>, userId: string) =>
  trx
    .selectFrom("jobs")
    .select("idempotency_key")
    .where("kind", "=", "send_welcome")
    .where("payload", "@>", JSON.stringify({ userId }))
    .execute();

const audited = async (trx: Kysely<DB>, userId: string) =>
  (
    await trx
      .selectFrom("audit_events")
      .select("id")
      .where("action", "=", "set_password.resent")
      .where("target_id", "=", userId)
      .execute()
  ).length;

// Runs a test body with db() pointed at the rollback transaction.
const withConn = (fn: (trx: Kysely<DB>) => Promise<void>) =>
  inRollback(async (trx) => {
    ctx.conn = asConn(trx);
    try {
      await fn(trx);
    } finally {
      ctx.conn = undefined;
    }
  });

// covers: AC-8, AC-16
describe.skipIf(!hasDb)("resendSetPassword (AC-8)", () => {
  beforeEach(() => {
    ctx.ip = uniqueIp();
    ctx.human = true;
  });

  it("queues one job and audits it for a pending learner", () =>
    withConn(async (trx) => {
      const u = await makeUser(trx, { set_password_pending: true });
      expect(
        await resendSetPassword(undefined, form(u.email.toUpperCase())),
      ).toEqual({
        message: GENERIC,
      });
      expect(await resendJobs(trx, u.id)).toHaveLength(1);
      expect(await audited(trx, u.id)).toBe(1);
    }));

  it("gives the same reply and queues nothing for anyone else", () =>
    withConn(async (trx) => {
      const verified = await makeUser(trx, { set_password_pending: false });
      const admin = await makeUser(trx, {
        role: "admin",
        set_password_pending: true,
      });
      const gone = await makeUser(trx, {
        set_password_pending: true,
        status: "deactivated",
        deactivated_at: new Date(),
      });
      for (const email of [
        verified.email,
        admin.email,
        gone.email,
        `nobody-${crypto.randomUUID()}@x.test`,
        "not an email",
      ])
        expect(await resendSetPassword(undefined, form(email))).toEqual({
          message: GENERIC,
        });
      for (const u of [verified, admin, gone])
        expect(await resendJobs(trx, u.id)).toEqual([]);
    }));

  it("queues nothing when Turnstile fails", () =>
    withConn(async (trx) => {
      const u = await makeUser(trx, { set_password_pending: true });
      ctx.human = false;
      expect(await resendSetPassword(undefined, form(u.email))).toEqual({
        message: GENERIC,
      });
      expect(await resendJobs(trx, u.id)).toEqual([]);
    }));

  it("stops after 3 attempts per email in an hour", () =>
    withConn(async (trx) => {
      const u = await makeUser(trx, { set_password_pending: true });
      for (let i = 0; i < 4; i++) {
        ctx.ip = uniqueIp();
        await resendSetPassword(undefined, form(u.email));
      }
      // Three allowed sends share one hourly job key; the 4th never audits.
      expect(await audited(trx, u.id)).toBe(3);
    }));

  it("stops after 10 attempts per IP in an hour, counting every attempt", () =>
    withConn(async (trx) => {
      for (let i = 0; i < 10; i++)
        await resendSetPassword(undefined, form("not an email"));
      const u = await makeUser(trx, { set_password_pending: true });
      await resendSetPassword(undefined, form(u.email));
      expect(await resendJobs(trx, u.id)).toEqual([]);
      expect(await audited(trx, u.id)).toBe(0);
    }));
});
