import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { DB } from "@/server/db/types";

class Redirect extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}

const ctx = vi.hoisted(() => ({
  conn: undefined as Kysely<DB> | undefined,
  authUserId: undefined as string | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/auth", () => ({
  auth: () => ({
    api: {
      getSession: async () =>
        ctx.authUserId
          ? {
              user: { id: ctx.authUserId },
              session: { id: "s", expiresAt: new Date(Date.now() + 60_000) },
            }
          : null,
    },
  }),
}));
vi.mock("@/server/env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adminEntryPath: () => "/l0gin",
}));
vi.mock("@/server/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db")>();
  return { ...real, db: () => ctx.conn ?? real.db() };
});

const { createTestbedAction, createTestbedTypeAction } =
  await import("./actions");
const { asConn, hasDb, inRollback, makeAuthUser, makeType, makeUser } =
  await import("@/server/db/testing");

const IDLE = { kind: "idle" } as const;

const typeForm = (name: string) => {
  const f = new FormData();
  f.set("name", name);
  f.set("durationValue", "2");
  f.set("durationUnit", "hours");
  return f;
};

const testbedForm = (name: string, typeId: string) => {
  const f = new FormData();
  f.set("name", name);
  f.set("testbedTypeId", typeId);
  f.set("portalUrl", "https://portal.example.test");
  f.set("lmsUrl", "https://lms.example.test");
  return f;
};

const redirectOf = async (run: () => Promise<unknown>) => {
  const thrown = await run().catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(Redirect);
  return (thrown as Redirect).to;
};

// covers: AC-13
describe.skipIf(!hasDb)("admin create actions require an admin (AC-13)", () => {
  const run = (body: (trx: Kysely<DB>) => Promise<void>) =>
    inRollback(async (trx) => {
      ctx.conn = asConn(trx);
      try {
        await body(trx);
      } finally {
        ctx.conn = undefined;
        ctx.authUserId = undefined;
      }
    });

  it("sends a learner to not authorized and writes nothing", () =>
    run(async (trx) => {
      const authId = await makeAuthUser(trx, 9001);
      await makeUser(trx, { auth_user_id: authId });
      ctx.authUserId = authId;
      const type = await makeType(trx);
      const name = `Blocked ${crypto.randomUUID().slice(0, 8)}`;

      expect(
        await redirectOf(() => createTestbedTypeAction(IDLE, typeForm(name))),
      ).toBe("/auth/error?reason=not_authorized");
      expect(
        await redirectOf(() =>
          createTestbedAction(IDLE, testbedForm(name, type.id)),
        ),
      ).toBe("/auth/error?reason=not_authorized");

      const written = await trx
        .selectFrom("testbed_types")
        .select("id")
        .where("name", "=", name)
        .unionAll(
          trx.selectFrom("testbeds").select("id").where("name", "=", name),
        )
        .execute();
      expect(written).toEqual([]);
    }));

  it("sends an anonymous caller to the admin sign in", () =>
    run(async () => {
      expect(
        await redirectOf(() => createTestbedTypeAction(IDLE, typeForm("x"))),
      ).toBe("/l0gin");
    }));

  it("lets an admin create a type, with field errors for bad input", () =>
    run(async (trx) => {
      const authId = await makeAuthUser(trx, 9002);
      await makeUser(trx, {
        role: "admin",
        company: null,
        auth_user_id: authId,
      });
      ctx.authUserId = authId;
      const bad = typeForm("  ");
      bad.set("durationValue", "0");
      expect(await createTestbedTypeAction(IDLE, bad)).toEqual({
        kind: "error",
        fields: { name: "Enter a name.", durationValue: "Use at least 1." },
      });
      const name = `Type ${crypto.randomUUID().slice(0, 8)}`;
      expect(await createTestbedTypeAction(IDLE, typeForm(name))).toEqual({
        kind: "saved",
        message: `Created ${name}.`,
      });
      expect(
        await createTestbedTypeAction(IDLE, typeForm(name.toLowerCase())),
      ).toEqual({
        kind: "error",
        fields: { name: "A testbed type with this name already exists." },
      });
    }));

  it("refuses non https testbed URLs with field errors", () =>
    run(async (trx) => {
      const authId = await makeAuthUser(trx, 9003);
      await makeUser(trx, {
        role: "admin",
        company: null,
        auth_user_id: authId,
      });
      ctx.authUserId = authId;
      const type = await makeType(trx);
      const f = testbedForm("Lab", type.id);
      f.set("portalUrl", "http://portal.example.test");
      f.append("clientKind", "wired");
      f.append("clientName", "");
      f.append("clientUrl", "https://c.example.test");
      expect(await createTestbedAction(IDLE, f)).toEqual({
        kind: "error",
        fields: {
          portalUrl: "Enter an https:// URL.",
          "clients.0.name": "Enter a name.",
        },
      });
    }));
});
