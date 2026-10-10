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

const {
  checkTestbedTypeDelete,
  createTestbedAction,
  createTestbedTypeAction,
  deleteTestbedTypeAction,
  updateTestbedTypeAction,
} = await import("./actions");
const {
  asConn,
  hasDb,
  inRollback,
  makeAuthUser,
  makeTestbed,
  makeType,
  makeUser,
} = await import("@/server/db/testing");

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

// Feature 7: edit and delete testbed types.
describe.skipIf(!hasDb)("testbed type edit and delete actions", () => {
  const GONE = "This testbed type no longer exists.";

  // Runs `body` as a fresh admin, learner, or anonymous caller.
  const as = (
    who: "admin" | "learner" | "anonymous",
    body: (trx: Kysely<DB>) => Promise<void>,
  ) =>
    inRollback(async (trx) => {
      ctx.conn = asConn(trx);
      try {
        if (who !== "anonymous") {
          const authId = await makeAuthUser(
            trx,
            9100 + (who === "admin" ? 1 : 2),
          );
          await makeUser(trx, {
            auth_user_id: authId,
            ...(who === "admin" ? { role: "admin", company: null } : {}),
          });
          ctx.authUserId = authId;
        }
        await body(trx);
      } finally {
        ctx.conn = undefined;
        ctx.authUserId = undefined;
      }
    });

  const row = (trx: Kysely<DB>, id: string) =>
    trx
      .selectFrom("testbed_types")
      .select(["name", "duration_value", "duration_unit", "deleted_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  // covers: requireAdmin on every new action (AGENTS.md auth rule)
  it.each([
    ["anonymous", "/l0gin"],
    ["learner", "/auth/error?reason=not_authorized"],
  ] as const)("sends a %s caller to %s and changes nothing", (who, to) =>
    as(who, async (trx) => {
      const type = await makeType(trx);

      expect(
        await redirectOf(() =>
          updateTestbedTypeAction(type.id, IDLE, typeForm("Changed")),
        ),
      ).toBe(to);
      expect(await redirectOf(() => checkTestbedTypeDelete(type.id))).toBe(to);
      expect(await redirectOf(() => deleteTestbedTypeAction(type.id))).toBe(to);
      expect(await row(trx, type.id)).toMatchObject({
        name: type.name,
        deleted_at: null,
      });
    }),
  );

  it("saves an edit and says so", () =>
    as("admin", async (trx) => {
      const type = await makeType(trx);
      const name = `Edited ${crypto.randomUUID().slice(0, 8)}`;
      const form = typeForm(name);
      form.set("durationUnit", "days");

      expect(await updateTestbedTypeAction(type.id, IDLE, form)).toEqual({
        kind: "saved",
        message: `Updated ${name}.`,
      });
      expect(await row(trx, type.id)).toMatchObject({
        name,
        duration_value: 2,
        duration_unit: "days",
      });
    }));

  it("returns field errors for bad input and a taken name", () =>
    as("admin", async (trx) => {
      const taken = await makeType(trx);
      const type = await makeType(trx);
      const bad = typeForm(" ");
      bad.set("durationValue", "0");
      bad.set("durationUnit", "weeks");

      expect(await updateTestbedTypeAction(type.id, IDLE, bad)).toMatchObject({
        kind: "error",
        fields: {
          name: "Enter a name.",
          durationValue: "Use at least 1.",
          durationUnit: expect.any(String),
        },
      });
      expect(
        await updateTestbedTypeAction(
          type.id,
          IDLE,
          typeForm(taken.name.toLowerCase()),
        ),
      ).toEqual({
        kind: "error",
        fields: { name: "A testbed type with this name already exists." },
      });
      expect((await row(trx, type.id)).name).toBe(type.name);
    }));

  it("says the type is gone for a deleted type or a malformed id", () =>
    as("admin", async (trx) => {
      const deleted = await makeType(trx, { deleted_at: new Date() });
      const gone = { kind: "error", message: GONE, fields: {} };

      expect(
        await updateTestbedTypeAction(deleted.id, IDLE, typeForm("x")),
      ).toEqual(gone);
      expect(
        await updateTestbedTypeAction("not-a-uuid", IDLE, typeForm("x")),
      ).toEqual(gone);
    }));

  it("checks a delete: the live testbeds using the type, or none", () =>
    as("admin", async (trx) => {
      const used = await makeType(trx);
      const testbed = await makeTestbed(trx, used.id);
      const unused = await makeType(trx);

      expect(await checkTestbedTypeDelete(used.id)).toEqual({
        ok: true,
        value: [{ id: testbed.id, label: testbed.name }],
      });
      expect(await checkTestbedTypeDelete(unused.id)).toEqual({
        ok: true,
        value: [],
      });
      expect(await checkTestbedTypeDelete("not-a-uuid")).toEqual({
        ok: true,
        value: [],
      });
    }));

  it("deletes an unused type once, then reports it gone", () =>
    as("admin", async (trx) => {
      const type = await makeType(trx);

      expect(await deleteTestbedTypeAction(type.id)).toEqual({
        ok: true,
        value: undefined,
      });
      expect((await row(trx, type.id)).deleted_at).not.toBeNull();
      expect(await deleteTestbedTypeAction(type.id)).toEqual({
        ok: false,
        error: { kind: "failed", message: GONE },
      });
      expect(await deleteTestbedTypeAction("not-a-uuid")).toEqual({
        ok: false,
        error: { kind: "failed", message: GONE },
      });
    }));

  it("refuses to delete a type a testbed uses, returning the blockers", () =>
    as("admin", async (trx) => {
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);

      expect(await deleteTestbedTypeAction(type.id)).toEqual({
        ok: false,
        error: {
          kind: "blocked",
          blockers: [{ id: testbed.id, label: testbed.name }],
        },
      });
      expect((await row(trx, type.id)).deleted_at).toBeNull();
    }));
});
