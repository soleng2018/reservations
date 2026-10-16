import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import {
  encryptSecret,
  secretAad,
  type Keyring,
} from "@/server/crypto/secrets";
import {
  FAKE_CLIENT_ID,
  fakeKeyFileText,
  fakeOAuthClientText,
  fakeServiceAccountKey,
} from "@/server/google/testing";
import type { DB } from "@/server/db/types";
import type {
  VerifySignInError,
  VerifySignInInput,
} from "@/server/google/verify";

class Redirect extends Error {
  constructor(readonly to: string) {
    super(to);
  }
}

const ctx = vi.hoisted(() => ({
  conn: undefined as Kysely<DB> | undefined,
  authUserId: undefined as string | undefined,
  // The keyring the API key actions see; undefined means not configured.
  keyring: undefined as Keyring | undefined,
  // What the stub Cloudflare token check answers, and how often it ran.
  cloudflare: "ok" as "ok" | "invalid" | "unavailable",
  cloudflareChecks: 0,
  // The same for the Google key check (spec 0013 AC-2).
  google: "ok" as "ok" | "invalid" | "delegation" | "calendar" | "unavailable",
  googleChecks: 0,
  // The stub Google sign in check (spec 0013 AC-28 steps 5 to 8): what it
  // answers, and what each call was given.
  signIn: { ok: true } as
    | { readonly ok: true }
    | { readonly ok: false; readonly error: VerifySignInError },
  signInCalls: [] as VerifySignInInput[],
  // The response cookies a Server Action set, by name.
  cookies: new Map<string, { value: string; options: unknown }>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => {
      const c = ctx.cookies.get(name);
      return c ? { name, value: c.value } : undefined;
    },
    set: (name: string, value: string, options: unknown) => {
      ctx.cookies.set(name, { value, options });
    },
    delete: (opts: { readonly name: string; readonly path: string }) => {
      ctx.cookies.delete(opts.name);
    },
  }),
}));
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
  assertEncryptionEnv: () =>
    ctx.keyring
      ? { ok: true, value: { keyring: ctx.keyring } }
      : { ok: false, error: "Encryption env: APP_ENCRYPTION_KEYS is missing" },
}));
// Never the real Cloudflare (spec 0006 AC-12).
vi.mock("@/server/cloudflare/access", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyCloudflareToken: async () => {
    ctx.cloudflareChecks += 1;
    return ctx.cloudflare === "ok"
      ? { ok: true, value: undefined }
      : { ok: false, error: ctx.cloudflare };
  },
}));
// Never the real Google (spec 0013 AC-2).
vi.mock("@/server/google/verify", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyGoogleKey: async () => {
    ctx.googleChecks += 1;
    return ctx.google === "ok"
      ? { ok: true, value: undefined }
      : { ok: false, error: ctx.google };
  },
  verifyGoogleSignIn: async (input: VerifySignInInput) => {
    ctx.signInCalls.push(input);
    return ctx.signIn.ok
      ? {
          ok: true,
          value: {
            clientId: input.clientId,
            clientSecret: input.clientSecret,
            refreshToken: "1//canary-refresh-token",
            senderEmail: "hol.sender@gmail.com",
          },
        }
      : ctx.signIn;
  },
}));
vi.mock("@/server/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/db")>();
  return { ...real, db: () => ctx.conn ?? real.db() };
});

const {
  checkApiKeyDelete,
  checkTestbedDelete,
  checkTestbedTypeDelete,
  createApiKeyAction,
  deleteApiKeyAction,
  startGoogleSignInAction,
  deleteTestbedAction,
  updateApiKeyAction,
  createTestbedAction,
  createTestbedTypeAction,
  deleteTestbedTypeAction,
  loadTestbedForEdit,
  updateTestbedAction,
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
  slot,
} = await import("@/server/db/testing");
const { dbNow } = await import("@/server/db/bookings");

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

// Feature 8 (spec 0006): API key actions.
describe.skipIf(!hasDb)("API key actions", () => {
  const KEYRING: Keyring = {
    activeKeyId: "ktest",
    keys: new Map([["ktest", randomBytes(32)]]),
  };
  const CANARY = `canary-${crypto.randomUUID()}`;

  const keyForm = (name: string, secret = CANARY) => {
    const f = new FormData();
    f.set("name", name);
    f.set("type", "IDP");
    f.set("baseUrl", "https://acme.okta.example");
    f.set("secret", secret);
    return f;
  };

  // Runs `body` as a fresh admin, learner, or anonymous caller, with the
  // test keyring unless `configured` is false.
  const as = (
    who: "admin" | "learner" | "anonymous",
    body: (trx: Kysely<DB>) => Promise<void>,
    configured = true,
  ) =>
    inRollback(async (trx) => {
      ctx.conn = asConn(trx);
      ctx.keyring = configured ? KEYRING : undefined;
      try {
        if (who !== "anonymous") {
          const authId = await makeAuthUser(
            trx,
            9200 + (who === "admin" ? 1 : 2),
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
        ctx.keyring = undefined;
      }
    });

  const keysNamed = (trx: Kysely<DB>, name: string) =>
    trx
      .selectFrom("api_keys")
      .select(["id", "name", "deleted_at"])
      .where("name", "=", name)
      .execute();

  const newName = () => `Key ${crypto.randomUUID().slice(0, 8)}`;

  // A key inserted directly (the encrypt path is covered by createApiKey).
  const makeKey = (trx: Kysely<DB>, name = newName()) =>
    trx
      .insertInto("api_keys")
      .values({
        name,
        type: "IDP",
        base_url: "https://acme.okta.example",
        secret_ciphertext: "v1:test:placeholder",
      })
      .returning(["id", "name"])
      .executeTakeFirstOrThrow();

  // covers: AC-10
  it.each([
    ["anonymous", "/l0gin"],
    ["learner", "/auth/error?reason=not_authorized"],
  ] as const)("sends a %s caller to %s and writes nothing (AC-10)", (who, to) =>
    as(who, async (trx) => {
      const name = newName();
      expect(
        await redirectOf(() => createApiKeyAction(IDLE, keyForm(name))),
      ).toBe(to);
      expect(await keysNamed(trx, name)).toEqual([]);

      const key = await makeKey(trx);
      expect(
        await redirectOf(() => updateApiKeyAction(key.id, IDLE, keyForm(name))),
      ).toBe(to);
      expect(await keysNamed(trx, name)).toEqual([]);
      expect(await redirectOf(() => checkApiKeyDelete(key.id))).toBe(to);
      expect(await redirectOf(() => deleteApiKeyAction(key.id))).toBe(to);
      expect(await keysNamed(trx, key.name)).toMatchObject([
        { deleted_at: null },
      ]);
    }),
  );

  // covers: AC-2, AC-3, AC-8
  it("creates a key, with field errors that never echo the key", () =>
    as("admin", async (trx) => {
      const bad = keyForm("  ", CANARY.repeat(100));
      bad.set("baseUrl", "https://u:p@acme.okta.example");
      const refused = await createApiKeyAction(IDLE, bad);
      expect(refused).toEqual({
        kind: "error",
        fields: {
          name: "Enter a name.",
          baseUrl: "Remove credentials from the URL.",
          secret: "Use at most 4096 characters.",
        },
      });

      const name = newName();
      const saved = await createApiKeyAction(IDLE, keyForm(name));
      expect(saved).toEqual({ kind: "saved", message: `Created ${name}.` });
      expect(await keysNamed(trx, name)).toHaveLength(1);

      const duplicate = await createApiKeyAction(
        IDLE,
        keyForm(name.toUpperCase()),
      );
      expect(duplicate).toEqual({
        kind: "error",
        fields: { name: "An API key with this name already exists." },
      });
      expect(JSON.stringify([refused, saved, duplicate])).not.toMatch(
        /canary|v1:/,
      );
    }));

  // covers: AC-9
  it("refuses to save without a keyring and writes nothing (AC-9)", () =>
    as(
      "admin",
      async (trx) => {
        const name = newName();
        expect(await createApiKeyAction(IDLE, keyForm(name))).toEqual({
          kind: "error",
          message: "Encryption isn't configured.",
          fields: {},
        });
        expect(await keysNamed(trx, name)).toEqual([]);
      },
      false,
    ));

  // covers: AC-4, AC-5
  it("saves an edit, keeping a blank key, and maps every refusal", () =>
    as("admin", async (trx) => {
      const key = await makeKey(trx);
      const name = newName();
      expect(await updateApiKeyAction(key.id, IDLE, keyForm(name, ""))).toEqual(
        { kind: "saved", message: `Updated ${name}.` },
      );
      const row = await trx
        .selectFrom("api_keys")
        .select(["name", "secret_ciphertext"])
        .where("id", "=", key.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ name, secret_ciphertext: "v1:test:placeholder" });

      const other = await makeKey(trx);
      expect(
        await updateApiKeyAction(key.id, IDLE, keyForm(other.name, "")),
      ).toEqual({
        kind: "error",
        fields: { name: "An API key with this name already exists." },
      });

      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id, {
        idp_api_key_id: key.id,
      });
      const toAi = keyForm(name, "");
      toAi.set("type", "AI");
      expect(await updateApiKeyAction(key.id, IDLE, toAi)).toEqual({
        kind: "error",
        fields: {
          type: `Used as the IDP by: ${testbed.name}. Remove it from them first.`,
        },
      });
    }));

  it("says the key is gone for a deleted key or a malformed id", () =>
    as("admin", async (trx) => {
      const key = await makeKey(trx);
      await trx
        .updateTable("api_keys")
        .set({ deleted_at: new Date() })
        .where("id", "=", key.id)
        .execute();
      const gone = {
        kind: "error",
        message: "This API key no longer exists.",
        fields: {},
      };
      expect(
        await updateApiKeyAction(key.id, IDLE, keyForm(newName())),
      ).toEqual(gone);
      expect(
        await updateApiKeyAction("not-a-uuid", IDLE, keyForm(newName())),
      ).toEqual(gone);
    }));

  it("refuses an edit without a keyring and writes nothing (AC-9)", () =>
    as(
      "admin",
      async (trx) => {
        const key = await makeKey(trx);
        expect(
          await updateApiKeyAction(key.id, IDLE, keyForm(newName(), "")),
        ).toEqual({
          kind: "error",
          message: "Encryption isn't configured.",
          fields: {},
        });
        expect(await keysNamed(trx, key.name)).toHaveLength(1);
      },
      false,
    ));

  // covers: AC-6
  it("checks and deletes a key, blocked while a testbed uses it", () =>
    as("admin", async (trx) => {
      const key = await makeKey(trx);
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id, {
        idp_api_key_id: key.id,
      });
      const blockers = [{ id: testbed.id, label: testbed.name }];
      expect(await checkApiKeyDelete(key.id)).toEqual({
        ok: true,
        value: blockers,
      });
      expect(await deleteApiKeyAction(key.id)).toEqual({
        ok: false,
        error: { kind: "blocked", blockers },
      });

      await trx
        .updateTable("testbeds")
        .set({ idp_api_key_id: null })
        .where("id", "=", testbed.id)
        .execute();
      expect(await checkApiKeyDelete(key.id)).toEqual({ ok: true, value: [] });
      expect(await deleteApiKeyAction(key.id)).toEqual({
        ok: true,
        value: undefined,
      });
      const gone = {
        ok: false,
        error: { kind: "failed", message: "This API key no longer exists." },
      };
      expect(await deleteApiKeyAction(key.id)).toEqual(gone);
      expect(await deleteApiKeyAction("not-a-uuid")).toEqual(gone);
      expect(await checkApiKeyDelete("not-a-uuid")).toEqual({
        ok: true,
        value: [],
      });
    }));

  // covers: spec 0006 AC-12, spec 0012 AC-11
  it("maps every Cloudflare key refusal to its field", () =>
    as("admin", async (trx) => {
      // The owner's real key may be live in the shared database.
      await trx
        .updateTable("api_keys")
        .set({ deleted_at: new Date() })
        .where("type", "=", "CLOUDFLARE")
        .where("deleted_at", "is", null)
        .execute();
      const account = `https://api.cloudflare.com/client/v4/accounts/${"c".repeat(32)}`;
      const cfForm = (name: string, secret = "cf-token-canary") => {
        const f = keyForm(name, secret);
        f.set("type", "CLOUDFLARE");
        f.set("baseUrl", account);
        return f;
      };
      ctx.cloudflareChecks = 0;
      try {
        const badUrl = cfForm(newName());
        badUrl.set("baseUrl", `${account}/`);
        expect(await createApiKeyAction(IDLE, badUrl)).toEqual({
          kind: "error",
          fields: {
            baseUrl:
              "Enter https://api.cloudflare.com/client/v4/accounts/<account id>.",
          },
        });
        expect(ctx.cloudflareChecks).toBe(0);

        ctx.cloudflare = "invalid";
        const invalid = await createApiKeyAction(IDLE, cfForm(newName()));
        expect(invalid).toEqual({
          kind: "error",
          fields: {
            secret: "Cloudflare didn't accept this token for this account.",
          },
        });
        ctx.cloudflare = "unavailable";
        expect(await createApiKeyAction(IDLE, cfForm(newName()))).toEqual({
          kind: "error",
          message: "Couldn't reach Cloudflare to check the token. Try again.",
          fields: {},
        });

        ctx.cloudflare = "ok";
        const name = newName();
        expect(await createApiKeyAction(IDLE, cfForm(name))).toEqual({
          kind: "saved",
          message: `Created ${name}.`,
        });
        expect(await createApiKeyAction(IDLE, cfForm(newName()))).toEqual({
          kind: "error",
          fields: {
            type: "Only one Cloudflare key can exist. Edit the existing one.",
          },
        });

        const [key] = await keysNamed(trx, name);
        if (!key) throw new Error("expected the key");
        const checks = ctx.cloudflareChecks;
        const moved = cfForm(name, "");
        moved.set(
          "baseUrl",
          `https://api.cloudflare.com/client/v4/accounts/${"d".repeat(32)}`,
        );
        expect(await updateApiKeyAction(key.id, IDLE, moved)).toEqual({
          kind: "error",
          fields: {
            secret: "Enter the key again to change its type or account.",
          },
        });
        const renamed = newName();
        expect(
          await updateApiKeyAction(key.id, IDLE, cfForm(renamed, "")),
        ).toEqual({ kind: "saved", message: `Updated ${renamed}.` });
        expect(ctx.cloudflareChecks).toBe(checks);
        expect(JSON.stringify(invalid)).not.toContain("canary");
      } finally {
        ctx.cloudflare = "ok";
      }
    }));

  // covers: spec 0013 AC-1 to AC-4
  it("reads, checks, and maps a GOOGLE key file, never echoing it", () =>
    as("admin", async (trx) => {
      await trx
        .updateTable("api_keys")
        .set({ deleted_at: new Date() })
        .where("type", "=", "GOOGLE")
        .where("deleted_at", "is", null)
        .execute();
      const file = (text: string, name = "key.json") =>
        new File([text], name, { type: "application/json" });
      const googleForm = (name: string, keyFile: File | undefined) => {
        const f = new FormData();
        f.set("name", name);
        f.set("type", "GOOGLE");
        f.set("googleAuth", "service_account");
        f.set("senderEmail", "labs@nile.example");
        f.set("calendarId", "c_abc@group.calendar.google.com");
        f.set("devInbox", "");
        f.set("opsBcc", "");
        // An empty file input posts a nameless, empty File.
        f.set("keyFile", keyFile ?? new File([], ""));
        return f;
      };
      const keyText = fakeKeyFileText(
        fakeServiceAccountKey({ private_key_id: "canary-key-id" }),
      );
      ctx.googleChecks = 0;
      try {
        expect(
          await createApiKeyAction(IDLE, googleForm(newName(), undefined)),
        ).toEqual({
          kind: "error",
          fields: { keyFile: "Choose the key file." },
        });
        const bad = googleForm("", file("{not json"));
        bad.set("senderEmail", "labs");
        expect(await createApiKeyAction(IDLE, bad)).toEqual({
          kind: "error",
          fields: {
            name: "Enter a name.",
            senderEmail: "Enter an email address.",
            keyFile: "This isn't a Google service account key file (.json).",
          },
        });
        expect(
          await createApiKeyAction(
            IDLE,
            googleForm(newName(), file("x".repeat(16 * 1024 + 1))),
          ),
        ).toEqual({
          kind: "error",
          fields: { keyFile: "The key file is too large." },
        });
        expect(ctx.googleChecks).toBe(0);

        ctx.google = "delegation";
        const refused = await createApiKeyAction(
          IDLE,
          googleForm(newName(), file(keyText)),
        );
        expect(refused).toEqual({
          kind: "error",
          fields: {
            keyFile:
              "Google refused this key for labs@nile.example. In the Google Admin console, add client ID 104857600123456789012 under domain wide delegation with the gmail.send and calendar.events scopes.",
          },
        });
        expect(JSON.stringify(refused)).not.toMatch(/canary|PRIVATE KEY/);
        ctx.google = "calendar";
        expect(
          await createApiKeyAction(IDLE, googleForm(newName(), file(keyText))),
        ).toEqual({
          kind: "error",
          fields: {
            calendarId:
              'labs@nile.example can\'t open this calendar. Create it in that mailbox or share it with "Make changes to events".',
          },
        });
        ctx.google = "unavailable";
        expect(
          await createApiKeyAction(IDLE, googleForm(newName(), file(keyText))),
        ).toEqual({
          kind: "error",
          message: "Couldn't reach Google to check the key. Try again.",
          fields: {},
        });

        ctx.google = "ok";
        const name = newName();
        expect(
          await createApiKeyAction(IDLE, googleForm(name, file(keyText))),
        ).toEqual({ kind: "saved", message: `Created ${name}.` });
        expect(
          await createApiKeyAction(IDLE, googleForm(newName(), file(keyText))),
        ).toEqual({
          kind: "error",
          fields: {
            type: "Only one Google key can exist. Edit the existing one.",
          },
        });

        const [key] = await keysNamed(trx, name);
        if (!key) throw new Error("expected the key");
        const checks = ctx.googleChecks;
        const moved = googleForm(name, undefined);
        moved.set("calendarId", "c_other@group.calendar.google.com");
        expect(await updateApiKeyAction(key.id, IDLE, moved)).toEqual({
          kind: "error",
          fields: {
            keyFile:
              "Upload the key file again to change the sender, calendar, or type.",
          },
        });
        const kept = googleForm(name, undefined);
        kept.set("opsBcc", "ops@nile.example");
        expect(await updateApiKeyAction(key.id, IDLE, kept)).toEqual({
          kind: "saved",
          message: `Updated ${name}.`,
        });
        expect(ctx.googleChecks).toBe(checks);
      } finally {
        ctx.google = "ok";
      }
    }));

  // covers: spec 0013 AC-25 to AC-29 (Google sign in), with the Google
  // checks stubbed and the response cookies held in memory.
  describe("Google sign in", () => {
    const COOKIE = "hol_google_sign_in";
    const file = (text: string) =>
      new File([text], "client.json", { type: "application/json" });
    const clientForm = (client: File | undefined) => {
      const f = new FormData();
      f.set("clientFile", client ?? new File([], ""));
      return f;
    };
    const signInForm = (
      name: string,
      fields: {
        readonly client?: File;
        readonly returnUrl?: string;
        readonly calendarId?: string;
        readonly devInbox?: string;
      } = {},
    ) => {
      const f = new FormData();
      f.set("name", name);
      f.set("type", "GOOGLE");
      f.set("googleAuth", "oauth");
      f.set(
        "calendarId",
        fields.calendarId ?? "c_gmail@group.calendar.google.com",
      );
      f.set("devInbox", fields.devInbox ?? "");
      f.set("opsBcc", "");
      f.set("clientFile", fields.client ?? new File([], ""));
      f.set("returnUrl", fields.returnUrl ?? "");
      // A key file chosen too is ignored under Google sign in (AC-29).
      f.set("keyFile", file("{not json"));
      return f;
    };
    const returned = (state: string, code = "4/0canary-auth-code") =>
      `http://127.0.0.1:47613/?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}&scope=email`;

    const clearGoogle = (trx: Kysely<DB>) =>
      trx
        .updateTable("api_keys")
        .set({ deleted_at: new Date() })
        .where("type", "=", "GOOGLE")
        .where("deleted_at", "is", null)
        .execute();

    // Starts a sign in through the action and answers its state.
    const start = async (): Promise<string> => {
      const started = await startGoogleSignInAction(
        clientForm(file(fakeOAuthClientText())),
      );
      if (started.kind !== "started") throw new Error("expected a start");
      const state = new URL(started.url).searchParams.get("state");
      if (!state) throw new Error("expected a state");
      return state;
    };

    // The admin's users.id, which the cookie is bound to.
    const adminId = async (trx: Kysely<DB>) =>
      (
        await trx
          .selectFrom("users")
          .select("id")
          .where("auth_user_id", "=", ctx.authUserId ?? "")
          .executeTakeFirstOrThrow()
      ).id;

    // Set by the "another client's file" case below.
    let otherClient = false;

    // A live service account GOOGLE key, inserted directly.
    const makeGoogleKey = (trx: Kysely<DB>) =>
      trx
        .insertInto("api_keys")
        .values({
          name: newName(),
          type: "GOOGLE",
          base_url: "https://www.googleapis.com",
          secret_ciphertext: "v1:test:placeholder",
          google_auth: "service_account",
          sender_email: "labs@nile.example",
          calendar_id: "c_abc@group.calendar.google.com",
        })
        .execute();

    const reset = () => {
      ctx.cookies.clear();
      ctx.signIn = { ok: true };
      ctx.signInCalls = [];
    };

    it("starts a sign in with PKCE and an encrypted cookie for this admin (AC-27)", () =>
      as("admin", async () => {
        reset();
        const started = await startGoogleSignInAction(
          clientForm(file(fakeOAuthClientText())),
        );
        if (started.kind !== "started") throw new Error("expected a start");
        const url = new URL(started.url);
        const params = Object.fromEntries(url.searchParams);
        expect(url.origin + url.pathname).toBe(
          "https://accounts.google.com/o/oauth2/v2/auth",
        );
        expect(params).toMatchObject({
          client_id: FAKE_CLIENT_ID,
          redirect_uri: "http://127.0.0.1:47613/",
          response_type: "code",
          access_type: "offline",
          prompt: "consent",
          code_challenge_method: "S256",
        });
        expect(params.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(params.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const cookie = ctx.cookies.get(COOKIE);
        expect(cookie?.options).toEqual({
          httpOnly: true,
          sameSite: "lax",
          // Dev runs on plain http.
          secure: false,
          path: "/admin",
          maxAge: 600,
        });
        // Only ciphertext: neither the state nor the client id shows.
        expect(cookie?.value).toMatch(/^v1:/);
        expect(cookie?.value).not.toContain(params.state);
        expect(cookie?.value).not.toContain("apps.googleusercontent.com");
        expect(JSON.stringify(started)).not.toContain("GOCSPX");
      }));

    it.each<[string, File | undefined, string]>([
      ["no file", undefined, "Choose the OAuth client file."],
      [
        "a Web application client",
        file(
          JSON.stringify({
            web: { client_id: FAKE_CLIENT_ID, client_secret: "GOCSPX-canary" },
          }),
        ),
        "This is a Web application client. Create a Desktop app OAuth client in Google Cloud and use its file.",
      ],
      [
        "a service account key",
        file(fakeKeyFileText()),
        "This is a service account key. Choose Service account as the sign in method, or use an OAuth client file.",
      ],
      [
        "junk",
        file("GOCSPX-canary not json"),
        "This isn't a Google OAuth client file (.json).",
      ],
      [
        "a file over 16 KB",
        file("x".repeat(16 * 1024 + 1)),
        "The OAuth client file is too large.",
      ],
    ])("refuses %s and sets no cookie (AC-26)", (_, client, message) =>
      as("admin", async () => {
        reset();
        const answer = await startGoogleSignInAction(clientForm(client));
        expect(answer).toEqual({
          kind: "error",
          fields: { clientFile: message },
        });
        expect(ctx.cookies.size).toBe(0);
        expect(JSON.stringify(answer)).not.toContain("canary");
      }),
    );

    it("refuses a learner (AC-27)", () =>
      as("learner", async () => {
        reset();
        await expect(
          startGoogleSignInAction(clientForm(file(fakeOAuthClientText()))),
        ).rejects.toThrow();
        expect(ctx.cookies.size).toBe(0);
      }));

    it("checks the fields, the file, and the address before Google, keeping the cookie (AC-28 steps 1 to 3)", () =>
      as("admin", async (trx) => {
        reset();
        await clearGoogle(trx);
        await start();
        expect(
          await createApiKeyAction(IDLE, signInForm("", { devInbox: "nope" })),
        ).toEqual({
          kind: "error",
          fields: {
            name: "Enter a name.",
            devInbox: "Enter an email address.",
            clientFile: "Choose the OAuth client file.",
            returnUrl: "Sign in with Google first, then paste the address.",
          },
        });
        const client = file(fakeOAuthClientText());
        expect(
          await createApiKeyAction(
            IDLE,
            signInForm(newName(), {
              client,
              returnUrl: "http://localhost:47613/?state=s&code=c",
            }),
          ),
        ).toEqual({
          kind: "error",
          fields: {
            returnUrl: "Paste the full address from the page Google opened.",
          },
        });
        expect(
          await createApiKeyAction(
            IDLE,
            signInForm(newName(), {
              client,
              returnUrl: "http://127.0.0.1:47613/?error=access_denied&state=s",
            }),
          ),
        ).toEqual({
          kind: "error",
          fields: {
            returnUrl: "The Google sign in was cancelled. Sign in again.",
          },
        });
        expect(ctx.signInCalls).toEqual([]);
        expect(ctx.cookies.has(COOKIE)).toBe(true);
      }));

    it.each<[string, (trx: Kysely<DB>, state: string) => Promise<string>]>([
      [
        "no cookie",
        async (_trx, state) => {
          ctx.cookies.clear();
          return state;
        },
      ],
      ["another state", async () => "another-state"],
      [
        "another admin's cookie",
        async (_trx, state) => {
          const cookie = ctx.cookies.get(COOKIE);
          if (!cookie) throw new Error("expected the cookie");
          ctx.cookies.set(COOKIE, {
            ...cookie,
            value: encryptSecret(
              KEYRING,
              JSON.stringify({
                state,
                codeVerifier: "v",
                clientId: FAKE_CLIENT_ID,
                issuedAt: new Date().toISOString(),
              }),
              secretAad("google_sign_in", "cookie", crypto.randomUUID()),
            ),
          });
          return state;
        },
      ],
      [
        "a cookie older than 10 minutes by the DB clock",
        async (trx, state) => {
          const old = new Date(
            (await dbNow(trx)).getTime() - 11 * 60_000,
          ).toISOString();
          ctx.cookies.set(COOKIE, {
            value: encryptSecret(
              KEYRING,
              JSON.stringify({
                state,
                codeVerifier: "v",
                clientId: FAKE_CLIENT_ID,
                issuedAt: old,
              }),
              secretAad("google_sign_in", "cookie", await adminId(trx)),
            ),
            options: {},
          });
          return state;
        },
      ],
      [
        "another client's file",
        async (_trx, state) => {
          otherClient = true;
          return state;
        },
      ],
    ])("refuses %s before the exchange (AC-28 step 4)", (_, tamper) =>
      as("admin", async (trx) => {
        reset();
        otherClient = false;
        await clearGoogle(trx);
        const state = await tamper(trx, await start());
        const client = file(
          fakeOAuthClientText(
            otherClient
              ? { clientId: "999-other.apps.googleusercontent.com" }
              : {},
          ),
        );
        expect(
          await createApiKeyAction(
            IDLE,
            signInForm(newName(), { client, returnUrl: returned(state) }),
          ),
        ).toEqual({
          kind: "error",
          fields: {
            returnUrl:
              "This sign in expired or belongs to another attempt. Sign in with Google again.",
          },
        });
        expect(ctx.signInCalls).toEqual([]);
      }),
    );

    it("saves a sign in with the cookie's verifier, then deletes the cookie (AC-28)", () =>
      as("admin", async (trx) => {
        reset();
        await clearGoogle(trx);
        const state = await start();
        const name = newName();
        const saved = await createApiKeyAction(
          IDLE,
          signInForm(name, {
            client: file(fakeOAuthClientText()),
            returnUrl: returned(state),
          }),
        );
        expect(saved).toEqual({ kind: "saved", message: `Created ${name}.` });
        expect(ctx.signInCalls).toEqual([
          {
            code: "4/0canary-auth-code",
            codeVerifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            clientId: FAKE_CLIENT_ID,
            clientSecret: "GOCSPX-test-client-secret",
            calendarId: "c_gmail@group.calendar.google.com",
          },
        ]);
        expect(ctx.cookies.has(COOKIE)).toBe(false);
        const [key] = await trx
          .selectFrom("api_keys")
          .select(["google_auth", "sender_email", "secret_ciphertext"])
          .where("name", "=", name)
          .execute();
        expect(key).toMatchObject({
          google_auth: "oauth",
          sender_email: "hol.sender@gmail.com",
        });
        expect(key?.secret_ciphertext).not.toMatch(/canary|GOCSPX/);
      }));

    it.each<[VerifySignInError, unknown]>([
      [
        { kind: "refused" },
        {
          kind: "error",
          fields: {
            returnUrl:
              "Google didn't accept this sign in (it may have been used already). Sign in with Google again.",
          },
          restart: true,
        },
      ],
      [
        { kind: "client" },
        {
          kind: "error",
          fields: {
            clientFile:
              "Google didn't accept this OAuth client. Check the file, or create a new Desktop app client.",
          },
          restart: true,
        },
      ],
      [
        { kind: "no_refresh" },
        {
          kind: "error",
          fields: {
            returnUrl:
              "Google didn't return a lasting sign in. Sign in with Google again.",
          },
          restart: true,
        },
      ],
      [
        { kind: "scopes" },
        {
          kind: "error",
          fields: {
            returnUrl:
              "Allow both sending email and Calendar events on the Google screen, then sign in with Google again.",
          },
          restart: true,
        },
      ],
      [
        { kind: "no_email" },
        {
          kind: "error",
          fields: {
            returnUrl:
              "Google didn't share a verified email for this account. Sign in with Google again.",
          },
          restart: true,
        },
      ],
      [
        { kind: "calendar", sender: "hol.sender@gmail.com" },
        {
          kind: "error",
          fields: {
            calendarId:
              'hol.sender@gmail.com can\'t open this calendar. Create it in that mailbox or share it with "Make changes to events". Then sign in with Google again.',
          },
          restart: true,
        },
      ],
      [
        { kind: "check_unavailable" },
        {
          kind: "error",
          message:
            "Couldn't reach Google to check the key. Try again. Then sign in with Google again.",
          fields: {},
          restart: true,
        },
      ],
      [
        { kind: "exchange_unavailable" },
        {
          kind: "error",
          message: "Couldn't reach Google to check the key. Try again.",
          fields: {},
        },
      ],
    ])(
      "maps %j after the exchange, writing nothing and deleting the cookie",
      (error, answer) =>
        as("admin", async (trx) => {
          reset();
          await clearGoogle(trx);
          ctx.signIn = { ok: false, error };
          const state = await start();
          const name = newName();
          expect(
            await createApiKeyAction(
              IDLE,
              signInForm(name, {
                client: file(fakeOAuthClientText()),
                returnUrl: returned(state),
              }),
            ),
          ).toEqual(answer);
          expect(ctx.cookies.has(COOKIE)).toBe(false);
          expect(await keysNamed(trx, name)).toEqual([]);
        }),
    );

    it("restarts a spent sign in that a second Google key refuses (AC-28)", () =>
      as("admin", async (trx) => {
        reset();
        await clearGoogle(trx);
        await makeGoogleKey(trx);
        const state = await start();
        expect(
          await createApiKeyAction(
            IDLE,
            signInForm(newName(), {
              client: file(fakeOAuthClientText()),
              returnUrl: returned(state),
            }),
          ),
        ).toEqual({
          kind: "error",
          fields: {
            type: "Only one Google key can exist. Edit the existing one.",
          },
          restart: true,
        });
      }));

    it("edits a Google sign in key without a sign in, and refuses a calendar change or a switch (AC-29)", () =>
      as("admin", async (trx) => {
        reset();
        await clearGoogle(trx);
        const state = await start();
        const name = newName();
        await createApiKeyAction(
          IDLE,
          signInForm(name, {
            client: file(fakeOAuthClientText()),
            returnUrl: returned(state),
          }),
        );
        const [key] = await keysNamed(trx, name);
        if (!key) throw new Error("expected the key");
        ctx.signInCalls = [];
        expect(
          await updateApiKeyAction(
            key.id,
            IDLE,
            signInForm(name, { devInbox: "dev-inbox@nile.example" }),
          ),
        ).toEqual({ kind: "saved", message: `Updated ${name}.` });
        expect(
          await updateApiKeyAction(
            key.id,
            IDLE,
            signInForm(name, {
              calendarId: "c_other@group.calendar.google.com",
            }),
          ),
        ).toEqual({
          kind: "error",
          fields: {
            returnUrl: "Sign in with Google again to change the calendar.",
          },
        });
        const toServiceAccount = signInForm(name);
        toServiceAccount.set("googleAuth", "service_account");
        toServiceAccount.set("senderEmail", "labs@nile.example");
        toServiceAccount.set("keyFile", new File([], ""));
        expect(
          await updateApiKeyAction(key.id, IDLE, toServiceAccount),
        ).toEqual({
          kind: "error",
          fields: {
            keyFile: "Upload the key file to switch to Service account.",
          },
        });
        expect(ctx.signInCalls).toEqual([]);
      }));

    it("tells an OAuth client file apart under Service account (AC-26)", () =>
      as("admin", async (trx) => {
        reset();
        await clearGoogle(trx);
        const f = signInForm(newName());
        f.set("googleAuth", "service_account");
        f.set("senderEmail", "labs@nile.example");
        f.set("keyFile", file(fakeOAuthClientText()));
        expect(await createApiKeyAction(IDLE, f)).toEqual({
          kind: "error",
          fields: {
            keyFile:
              "This is an OAuth client file. Choose Google sign in as the sign in method, or use a service account key.",
          },
        });
      }));
  });
});

// Feature 9 (spec 0007): testbed load, edit, and delete actions.
describe.skipIf(!hasDb)("testbed actions", () => {
  const GONE = "This testbed no longer exists.";

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
            9300 + (who === "admin" ? 1 : 2),
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

  // A testbed with one client carrying an OS login.
  const makeLab = async (trx: Kysely<DB>) => {
    const type = await makeType(trx);
    const testbed = await makeTestbed(trx, type.id);
    await trx
      .insertInto("testbed_clients")
      .values({
        testbed_id: testbed.id,
        kind: "wireless",
        name: "Air 1",
        url: "https://a1.example.test",
        os_username: "lab",
        os_password: "pw",
        position: 0,
      })
      .execute();
    return { type, testbed };
  };

  const editForm = (name: string, typeId: string) => {
    const f = testbedForm(name, typeId);
    f.set("idpApiKeyId", "");
    f.append("clientKind", "wireless");
    f.append("clientName", "Air 1");
    f.append("clientUrl", "https://a1.example.test");
    f.append("clientOsUsername", "lab");
    f.append("clientOsPassword", "pw");
    return f;
  };

  const row = (trx: Kysely<DB>, id: string) =>
    trx
      .selectFrom("testbeds")
      .select(["name", "deleted_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

  // covers: AC-9
  it.each([
    ["anonymous", "/l0gin"],
    ["learner", "/auth/error?reason=not_authorized"],
  ] as const)("sends a %s caller to %s and changes nothing (AC-9)", (who, to) =>
    as(who, async (trx) => {
      const { type, testbed } = await makeLab(trx);

      expect(await redirectOf(() => loadTestbedForEdit(testbed.id))).toBe(to);
      expect(
        await redirectOf(() =>
          updateTestbedAction(testbed.id, IDLE, editForm("Changed", type.id)),
        ),
      ).toBe(to);
      expect(await redirectOf(() => checkTestbedDelete(testbed.id))).toBe(to);
      expect(await redirectOf(() => deleteTestbedAction(testbed.id))).toBe(to);
      expect(await row(trx, testbed.id)).toEqual({
        name: testbed.name,
        deleted_at: null,
      });
    }),
  );

  // covers: AC-3
  it("loads a testbed for edit, OS logins included, or says it is gone", () =>
    as("admin", async (trx) => {
      const { type, testbed } = await makeLab(trx);
      expect(await loadTestbedForEdit(testbed.id)).toMatchObject({
        ok: true,
        value: {
          name: testbed.name,
          groupName: `pod-${testbed.slug}`,
          testbedTypeId: type.id,
          clients: [{ name: "Air 1", osUsername: "lab", osPassword: "pw" }],
        },
      });
      const gone = { ok: false, error: "not_found" };
      expect(await loadTestbedForEdit("not-a-uuid")).toEqual(gone);
      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", testbed.id)
        .execute();
      expect(await loadTestbedForEdit(testbed.id)).toEqual(gone);
    }));

  // covers: AC-3, AC-4
  it("saves an edit and maps every refusal", () =>
    as("admin", async (trx) => {
      const { type, testbed } = await makeLab(trx);
      const name = `Edited ${crypto.randomUUID().slice(0, 8)}`;
      expect(
        await updateTestbedAction(testbed.id, IDLE, editForm(name, type.id)),
      ).toEqual({ kind: "saved", message: `Updated ${name}.` });
      expect((await row(trx, testbed.id)).name).toBe(name);

      const taken = await makeTestbed(trx, type.id);
      expect(
        await updateTestbedAction(
          testbed.id,
          IDLE,
          editForm(taken.name.toLowerCase(), type.id),
        ),
      ).toEqual({
        kind: "error",
        fields: { name: "A testbed with this name already exists." },
      });

      const noUser = editForm(name, type.id);
      noUser.set("clientOsUsername", "");
      expect(await updateTestbedAction(testbed.id, IDLE, noUser)).toEqual({
        kind: "error",
        fields: {
          "clients.0.osUsername": "Enter the OS username for this password.",
        },
      });

      const notReady = await makeTestbed(trx, type.id, {
        authentik_group_pk: null,
      });
      expect(
        await updateTestbedAction(notReady.id, IDLE, editForm("X", type.id)),
      ).toEqual({
        kind: "error",
        message: "This testbed is still being set up. Try again in a minute.",
        fields: {},
      });
      const gone = { kind: "error", message: GONE, fields: {} };
      expect(
        await updateTestbedAction("not-a-uuid", IDLE, editForm("X", type.id)),
      ).toEqual(gone);
    }));

  // covers: AC-2 (the IDP must be a live IDP key)
  it("refuses an IDP key deleted meanwhile, on create and edit", () =>
    as("admin", async (trx) => {
      const { type, testbed } = await makeLab(trx);
      const key = await trx
        .insertInto("api_keys")
        .values({
          name: `Key ${crypto.randomUUID().slice(0, 8)}`,
          type: "IDP",
          base_url: "https://idp.example.test",
          secret_ciphertext: "v1:test:placeholder",
          deleted_at: new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const idpGone = {
        kind: "error",
        fields: { idpApiKeyId: "That IDP key no longer exists." },
      };
      const form = editForm(`New ${crypto.randomUUID().slice(0, 8)}`, type.id);
      form.set("idpApiKeyId", key.id);
      expect(await createTestbedAction(IDLE, form)).toEqual(idpGone);
      expect(await updateTestbedAction(testbed.id, IDLE, form)).toEqual(
        idpGone,
      );
    }));

  // covers: AC-6
  it("checks and deletes a testbed, blocked while a reservation is live", () =>
    as("admin", async (trx) => {
      const { type, testbed } = await makeLab(trx);
      const learner = await makeUser(trx, { name: "Priya" });
      const booking = await trx
        .insertInto("bookings")
        .values({
          user_id: learner.id,
          testbed_id: testbed.id,
          testbed_type_id: type.id,
          starts_at: slot(24),
          ends_at: slot(26),
          status: "confirmed",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      const blockers = [
        { id: booking.id, label: "Priya — Upcoming reservation" },
      ];
      expect(await checkTestbedDelete(testbed.id)).toEqual({
        ok: true,
        value: blockers,
      });
      expect(await deleteTestbedAction(testbed.id)).toEqual({
        ok: false,
        error: { kind: "blocked", blockers },
      });

      await trx.deleteFrom("bookings").where("id", "=", booking.id).execute();
      expect(await checkTestbedDelete(testbed.id)).toEqual({
        ok: true,
        value: [],
      });
      expect(await deleteTestbedAction(testbed.id)).toEqual({
        ok: true,
        value: undefined,
      });
      expect((await row(trx, testbed.id)).deleted_at).not.toBeNull();
      const gone = { ok: false, error: { kind: "failed", message: GONE } };
      expect(await deleteTestbedAction(testbed.id)).toEqual(gone);
      expect(await deleteTestbedAction("not-a-uuid")).toEqual(gone);
      expect(await checkTestbedDelete("not-a-uuid")).toEqual({
        ok: true,
        value: [],
      });
    }));

  const updatedAudits = (trx: Kysely<DB>, id: string) =>
    trx
      .selectFrom("audit_events")
      .select("metadata")
      .where("target_id", "=", id)
      .where("action", "=", "testbed.updated")
      .execute();

  // covers: AC-2, AC-3 (the form's parallel lists keep each login on its row)
  it("keeps each OS login with its own client when only a later row has one", () =>
    as("admin", async (trx) => {
      const { type, testbed } = await makeLab(trx);
      const f = testbedForm(testbed.name, type.id);
      f.set("idpApiKeyId", "");
      for (const [kind, name, user, pass] of [
        ["wired", "Wired 1", "", ""],
        ["wireless", "Air 2", "  ops ", " p w "],
      ]) {
        f.append("clientKind", kind);
        f.append("clientName", name);
        f.append("clientUrl", "https://c.example.test");
        f.append("clientOsUsername", user);
        f.append("clientOsPassword", pass);
      }
      expect(await updateTestbedAction(testbed.id, IDLE, f)).toMatchObject({
        kind: "saved",
      });
      expect(await loadTestbedForEdit(testbed.id)).toMatchObject({
        ok: true,
        value: {
          clients: [
            { name: "Wired 1", osUsername: null, osPassword: null },
            { name: "Air 2", osUsername: "ops", osPassword: " p w " },
          ],
        },
      });
    }));

  // covers: AC-3 (a save that changes nothing)
  it("says Updated for a save that changes nothing, and audits nothing more", () =>
    as("admin", async (trx) => {
      const { type, testbed } = await makeLab(trx);
      const name = `Same ${crypto.randomUUID().slice(0, 8)}`;
      await updateTestbedAction(testbed.id, IDLE, editForm(name, type.id));
      expect(await updatedAudits(trx, testbed.id)).toHaveLength(1);

      expect(
        await updateTestbedAction(testbed.id, IDLE, editForm(name, type.id)),
      ).toEqual({ kind: "saved", message: `Updated ${name}.` });
      expect(await updatedAudits(trx, testbed.id)).toHaveLength(1);
    }));

  // covers: AC-3 (gone testbed or type, by a well formed id)
  it("says the testbed is gone, or the type is, after a delete elsewhere", () =>
    as("admin", async (trx) => {
      const { type, testbed } = await makeLab(trx);
      const goneType = await makeType(trx, { deleted_at: new Date() });
      expect(
        await updateTestbedAction(
          testbed.id,
          IDLE,
          editForm(testbed.name, goneType.id),
        ),
      ).toEqual({
        kind: "error",
        fields: { testbedTypeId: "That type no longer exists." },
      });

      await trx
        .updateTable("testbeds")
        .set({ deleted_at: new Date() })
        .where("id", "=", testbed.id)
        .execute();
      expect(
        await updateTestbedAction(testbed.id, IDLE, editForm("X", type.id)),
      ).toEqual({ kind: "error", message: GONE, fields: {} });
    }));

  // covers: AC-2, AC-5 (an OS login never comes back in a refusal)
  it("never echoes an OS username or password in its errors", () =>
    as("admin", async (trx) => {
      const { type, testbed } = await makeLab(trx);
      const canary = `canary-${crypto.randomUUID()}`;
      const f = editForm(testbed.name, type.id);
      f.set("clientOsUsername", canary.repeat(10));
      f.set("clientOsPassword", canary.repeat(10));
      const refused = await updateTestbedAction(testbed.id, IDLE, f);
      expect(refused).toEqual({
        kind: "error",
        fields: {
          "clients.0.osUsername": "Use at most 200 characters.",
          "clients.0.osPassword": "Use at most 200 characters.",
        },
      });
      expect(JSON.stringify(refused)).not.toContain("canary");
    }));
});
