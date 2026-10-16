import { randomBytes } from "node:crypto";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type Transaction,
} from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import type {
  StandardKeyCreate as ApiKeyCreateInput,
  StandardKeyUpdate,
} from "@/lib/catalog-input";
import {
  decryptSecret,
  secretAad,
  type Keyring,
} from "@/server/crypto/secrets";
import { db } from "@/server/db";
import { apiKeyBlockers } from "@/server/db/delete-blockers";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import type { CloudflareConfig } from "@/server/cloudflare/access";
import {
  cloudflareRevokeConfig,
  createApiKey,
  deleteApiKey,
  listApiKeys,
  listApiKeysQuery,
  googleConfigured,
  googleMailConfig,
  listIdpKeyOptions,
  updateApiKey,
  type ApiKeyDeps,
  type GoogleKeyCreate,
  type GoogleKeyUpdate,
} from "./api-keys";
import { fakeServiceAccountKey } from "@/server/google/testing";
import type {
  GoogleSignIn,
  VerifyGoogleError,
  VerifyGoogleInput,
} from "@/server/google/verify";

// Feature 8 (spec 0006): API keys with write only, row bound secrets. DB
// tests run inside inRollback with an in memory keyring (no keyring file).

const unique = () => crypto.randomUUID().slice(0, 8);

const KEYRING: Keyring = {
  activeKeyId: "ktest",
  keys: new Map([["ktest", randomBytes(32)]]),
};

const input = (
  overrides: Partial<ApiKeyCreateInput> = {},
): ApiKeyCreateInput => ({
  name: `Okta ${unique()}`,
  type: "IDP",
  baseUrl: "https://acme.okta.example",
  secret: "canary-secret-value",
  ...overrides,
});

const stored = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("api_keys")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const auditsFor = (trx: Kysely<DB>, targetId: string) =>
  trx
    .selectFrom("audit_events")
    .select(["action", "actor_user_id", "metadata", "summary"])
    .where("target_id", "=", targetId)
    .orderBy("created_at")
    .execute();

const thrown = async (fn: () => Promise<unknown>): Promise<Error> => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof Error) return e;
  }
  throw new Error("expected a throw");
};

afterAll(() => (hasDb ? db().destroy() : undefined));

describe("listApiKeysQuery (AC-8)", () => {
  // Compiles only: no database needed.
  const offline = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  it("never selects the secret", () => {
    const { sql } = listApiKeysQuery(offline).compile();
    expect(sql).not.toContain("secret_ciphertext");
    expect(sql).not.toContain("*");
    expect(sql).toContain('"secret_updated_at"');
  });
});

describe.skipIf(!hasDb)("createApiKey and listApiKeys", () => {
  it("stores the secret encrypted and bound to its row (AC-2, AC-7)", () =>
    inRollback(async (trx) => {
      const actor = await makeUser(trx, { role: "admin" });
      const created = await createApiKey(
        asConn(trx),
        KEYRING,
        input(),
        actor.id,
      );
      if (!created.ok) throw new Error("expected a create");

      const row = await stored(trx, created.value.id);
      expect(row.secret_ciphertext).toMatch(/^v1:ktest:/);
      expect(row.secret_ciphertext).not.toContain("canary");
      const aad = secretAad("api_keys", "secret_ciphertext", row.id);
      expect(decryptSecret(KEYRING, row.secret_ciphertext, aad)).toBe(
        "canary-secret-value",
      );
      const [{ now }] = await trx
        .selectNoFrom((eb) => eb.fn<Date>("now").as("now"))
        .execute();
      expect(row.secret_updated_at).toEqual(now);
    }));

  it("audits the create with type and base URL, never the secret (AC-2)", () =>
    inRollback(async (trx) => {
      const actor = await makeUser(trx, { role: "admin" });
      const created = await createApiKey(
        asConn(trx),
        KEYRING,
        input({ type: "AI", baseUrl: "https://api.ai.example" }),
        actor.id,
      );
      if (!created.ok) throw new Error("expected a create");
      const audits = await auditsFor(trx, created.value.id);
      expect(audits).toEqual([
        {
          action: "api_key.created",
          actor_user_id: actor.id,
          summary: "API key created",
          metadata: { type: "AI", baseUrl: "https://api.ai.example" },
        },
      ]);
      expect(JSON.stringify(audits)).not.toMatch(/canary|v1:/);
    }));

  it("refuses a live duplicate name ignoring case, then allows it once deleted (AC-3, AC-6)", () =>
    inRollback(async (trx) => {
      const actor = await makeUser(trx, { role: "admin" });
      const name = `Okta ${unique()}`;
      const first = await createApiKey(
        asConn(trx),
        KEYRING,
        input({ name }),
        actor.id,
      );
      if (!first.ok) throw new Error("expected a create");
      expect(
        await createApiKey(
          asConn(trx),
          KEYRING,
          input({ name: name.toUpperCase() }),
          actor.id,
        ),
      ).toEqual({ ok: false, error: "duplicate_name" });

      await trx
        .updateTable("api_keys")
        .set({ deleted_at: new Date() })
        .where("id", "=", first.value.id)
        .execute();
      const again = await createApiKey(
        asConn(trx),
        KEYRING,
        input({ name }),
        actor.id,
      );
      expect(again.ok).toBe(true);
    }));

  it("turns an unmapped DB error into a fixed message, no row data (AC-8)", () =>
    inRollback(async (trx) => {
      const actor = await makeUser(trx, { role: "admin" });
      // Skips Zod on purpose: api_keys_name_trimmed fails, and Postgres puts
      // the whole failing row, ciphertext included, in the error detail.
      const e = await thrown(() =>
        createApiKey(
          asConn(trx),
          KEYRING,
          input({ name: " untrimmed " }),
          actor.id,
        ),
      );
      expect(e.message).toBe("api key write failed");
      expect(e.cause).toBeUndefined();
      expect(JSON.stringify(e)).not.toMatch(/canary|v1:/);
    }));

  it("lists live keys by lower(name) with their secret date, and no secret (AC-1)", () =>
    inRollback(async (trx) => {
      const actor = await makeUser(trx, { role: "admin" });
      const tag = unique();
      for (const name of [`b ${tag}`, `A ${tag}`, `c ${tag}`])
        await createApiKey(asConn(trx), KEYRING, input({ name }), actor.id);
      const gone = await createApiKey(
        asConn(trx),
        KEYRING,
        input({ name: `gone ${tag}` }),
        actor.id,
      );
      if (!gone.ok) throw new Error("expected a create");
      await trx
        .updateTable("api_keys")
        .set({ deleted_at: new Date() })
        .where("id", "=", gone.value.id)
        .execute();

      const mine = (await listApiKeys(trx)).filter((k) => k.name.endsWith(tag));
      expect(mine.map((k) => k.name)).toEqual([
        `A ${tag}`,
        `b ${tag}`,
        `c ${tag}`,
      ]);
      // The Google settings (spec 0013) are not secret; null for this type.
      expect(Object.keys(mine[0]).sort()).toEqual([
        "baseUrl",
        "calendarId",
        "devInbox",
        "googleAuth",
        "googleRejectedAt",
        "id",
        "name",
        "opsBcc",
        "secretUpdatedAt",
        "senderEmail",
        "type",
      ]);
      expect(mine[0].secretUpdatedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(mine)).not.toMatch(/canary|v1:/);
    }));
});

describe.skipIf(!hasDb)("updateApiKey (AC-4, AC-5)", () => {
  // A key created by an admin, with its secret dated a day ago.
  const setup = async (
    trx: Transaction<DB>,
    overrides: Partial<ApiKeyCreateInput> = {},
  ) => {
    const actor = await makeUser(trx, { role: "admin" });
    const fields = input(overrides);
    const created = await createApiKey(asConn(trx), KEYRING, fields, actor.id);
    if (!created.ok) throw new Error("expected a create");
    const id = created.value.id;
    await trx
      .updateTable("api_keys")
      .set({ secret_updated_at: new Date(Date.now() - 86_400_000) })
      .where("id", "=", id)
      .execute();
    return { actor, id, fields, before: await stored(trx, id) };
  };
  const edit = (
    fields: ApiKeyCreateInput,
    changes: Partial<ApiKeyCreateInput> = {},
  ): StandardKeyUpdate => ({
    name: fields.name,
    type: fields.type,
    baseUrl: fields.baseUrl,
    secret: "",
    ...changes,
  });
  const updates = async (trx: Kysely<DB>, id: string) =>
    (await auditsFor(trx, id)).filter((a) => a.action !== "api_key.created");

  it("keeps the secret and its date when the key is left blank", () =>
    inRollback(async (trx) => {
      const { actor, id, fields, before } = await setup(trx);
      const result = await updateApiKey(
        asConn(trx),
        KEYRING,
        id,
        edit(fields, { baseUrl: "https://new.okta.example" }),
        actor.id,
      );
      expect(result).toEqual({ ok: true, value: undefined });
      const after = await stored(trx, id);
      expect(after.base_url).toBe("https://new.okta.example");
      expect(after.secret_ciphertext).toBe(before.secret_ciphertext);
      expect(after.secret_updated_at).toEqual(before.secret_updated_at);
      expect(await updates(trx, id)).toEqual([
        {
          action: "api_key.updated",
          actor_user_id: actor.id,
          summary: "API key updated",
          metadata: {
            baseUrl: { from: fields.baseUrl, to: "https://new.okta.example" },
          },
        },
      ]);
    }));

  it("replaces the secret with a fresh ciphertext and today's date", () =>
    inRollback(async (trx) => {
      const { actor, id, fields, before } = await setup(trx);
      const result = await updateApiKey(
        asConn(trx),
        KEYRING,
        id,
        edit(fields, { secret: "new-canary" }),
        actor.id,
      );
      expect(result.ok).toBe(true);
      const after = await stored(trx, id);
      expect(after.secret_ciphertext).not.toBe(before.secret_ciphertext);
      const aad = secretAad("api_keys", "secret_ciphertext", id);
      expect(decryptSecret(KEYRING, after.secret_ciphertext, aad)).toBe(
        "new-canary",
      );
      const [{ now }] = await trx
        .selectNoFrom((eb) => eb.fn<Date>("now").as("now"))
        .execute();
      expect(after.secret_updated_at).toEqual(now);
      const audits = await updates(trx, id);
      expect(audits).toEqual([
        {
          action: "api_key.secret_replaced",
          actor_user_id: actor.id,
          summary: "API key secret replaced",
          metadata: {},
        },
      ]);
      expect(JSON.stringify(audits)).not.toMatch(/canary|v1:/);
    }));

  it("writes both audit rows when fields and the key change together", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      const name = `${fields.name} renamed`;
      await updateApiKey(
        asConn(trx),
        KEYRING,
        id,
        edit(fields, { name, type: "AI", secret: "x" }),
        actor.id,
      );
      expect(
        (await updates(trx, id)).map((a) => [a.action, a.metadata]),
      ).toEqual([
        [
          "api_key.updated",
          {
            name: { from: fields.name, to: name },
            type: { from: "IDP", to: "AI" },
          },
        ],
        ["api_key.secret_replaced", {}],
      ]);
    }));

  it("writes nothing when nothing changed", () =>
    inRollback(async (trx) => {
      const { actor, id, fields, before } = await setup(trx);
      expect(
        await updateApiKey(asConn(trx), KEYRING, id, edit(fields), actor.id),
      ).toEqual({ ok: true, value: undefined });
      expect(await stored(trx, id)).toEqual(before);
      expect(await updates(trx, id)).toEqual([]);
    }));

  // covers: AC-3, AC-4
  it("lets a key change the case of its own name, auditing it as a rename", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      const upper = fields.name.toUpperCase();
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          edit(fields, { name: upper }),
          actor.id,
        ),
      ).toEqual({ ok: true, value: undefined });
      expect((await stored(trx, id)).name).toBe(upper);
      expect(await updates(trx, id)).toMatchObject([
        {
          action: "api_key.updated",
          metadata: { name: { from: fields.name, to: upper } },
        },
      ]);
    }));

  // covers: AC-8
  it("turns an unmapped DB error into a fixed message, no row data", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      // Skips Zod on purpose: api_keys_name_trimmed fails on the UPDATE, and
      // Postgres puts the failing row, the new ciphertext included, in the
      // error detail.
      const e = await thrown(() =>
        updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          edit(fields, { name: " untrimmed ", secret: "canary-replacement" }),
          actor.id,
        ),
      );
      expect(e.message).toBe("api key write failed");
      expect(e.cause).toBeUndefined();
      expect(JSON.stringify(e)).not.toMatch(/canary|v1:/);
    }));

  it("refuses a name another live key has, ignoring case", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      const other = await setup(trx);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          edit(fields, { name: other.fields.name.toUpperCase() }),
          actor.id,
        ),
      ).toEqual({ ok: false, error: "duplicate_name" });
    }));

  it("reports a deleted or missing key as not found and writes nothing", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      await trx
        .updateTable("api_keys")
        .set({ deleted_at: new Date() })
        .where("id", "=", id)
        .execute();
      const changes = edit(fields, { name: "Renamed", secret: "s" });
      expect(
        await updateApiKey(asConn(trx), KEYRING, id, changes, actor.id),
      ).toEqual({
        ok: false,
        error: "not_found",
      });
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          crypto.randomUUID(),
          changes,
          actor.id,
        ),
      ).toEqual({ ok: false, error: "not_found" });
      expect(await updates(trx, id)).toEqual([]);
    }));

  it("refuses IDP to AI while a live testbed uses the key, naming them in order", () =>
    inRollback(async (trx) => {
      const { actor, id, fields, before } = await setup(trx);
      const type = await makeType(trx);
      const tag = unique();
      await makeTestbed(trx, type.id, {
        name: `zeta ${tag}`,
        idp_api_key_id: id,
      });
      await makeTestbed(trx, type.id, {
        name: `Alpha ${tag}`,
        idp_api_key_id: id,
      });
      await makeTestbed(trx, type.id, {
        name: `gone ${tag}`,
        idp_api_key_id: id,
        deleted_at: new Date(),
      });

      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          edit(fields, { type: "AI", secret: "s" }),
          actor.id,
        ),
      ).toEqual({
        ok: false,
        error: { kind: "type_in_use", names: [`Alpha ${tag}`, `zeta ${tag}`] },
      });
      expect(await stored(trx, id)).toEqual(before);
      expect(await updates(trx, id)).toEqual([]);

      // Other edits to a key in use still save.
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          edit(fields, { baseUrl: "https://moved.okta.example" }),
          actor.id,
        ),
      ).toEqual({ ok: true, value: undefined });
    }));

  it("allows AI to IDP, and IDP to AI once no live testbed uses the key", () =>
    inRollback(async (trx) => {
      const ai = await setup(trx, { type: "AI" });
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          ai.id,
          edit(ai.fields, { type: "IDP" }),
          ai.actor.id,
        ),
      ).toEqual({ ok: true, value: undefined });
      const idp = await setup(trx);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          idp.id,
          edit(idp.fields, { type: "AI" }),
          idp.actor.id,
        ),
      ).toEqual({ ok: true, value: undefined });
    }));
});

describe.skipIf(!hasDb)("deleteApiKey (AC-6)", () => {
  const create = async (trx: Transaction<DB>, name?: string) => {
    const actor = await makeUser(trx, { role: "admin" });
    const created = await createApiKey(
      asConn(trx),
      KEYRING,
      input(name ? { name } : {}),
      actor.id,
    );
    if (!created.ok) throw new Error("expected a create");
    return { actor, id: created.value.id };
  };

  it("soft deletes an unused key once, audits it, and frees its name", () =>
    inRollback(async (trx) => {
      const name = `Okta ${unique()}`;
      const { actor, id } = await create(trx, name);
      expect(await deleteApiKey(asConn(trx), id, actor.id)).toEqual({
        ok: true,
        value: undefined,
      });
      expect((await stored(trx, id)).deleted_at).toBeInstanceOf(Date);
      expect((await auditsFor(trx, id)).map((a) => a.action)).toEqual([
        "api_key.created",
        "api_key.deleted",
      ]);
      expect(await deleteApiKey(asConn(trx), id, actor.id)).toEqual({
        ok: false,
        error: { kind: "not_found" },
      });
      expect((await create(trx, name)).id).not.toBe(id);
    }));

  it("is blocked by live testbeds using the key, listed by lower(name)", () =>
    inRollback(async (trx) => {
      const { actor, id } = await create(trx);
      const type = await makeType(trx);
      const tag = unique();
      const zeta = await makeTestbed(trx, type.id, {
        name: `zeta ${tag}`,
        idp_api_key_id: id,
      });
      const alpha = await makeTestbed(trx, type.id, {
        name: `Alpha ${tag}`,
        idp_api_key_id: id,
      });
      await makeTestbed(trx, type.id, {
        name: `gone ${tag}`,
        idp_api_key_id: id,
        deleted_at: new Date(),
      });
      expect(await deleteApiKey(asConn(trx), id, actor.id)).toEqual({
        ok: false,
        error: {
          kind: "blocked",
          blockers: [
            { id: alpha.id, label: alpha.name },
            { id: zeta.id, label: zeta.name },
          ],
        },
      });
      expect((await stored(trx, id)).deleted_at).toBeNull();
    }));

  it("catches a testbed assigned between the check and the remove", () =>
    inRollback(async (trx) => {
      const { actor, id } = await create(trx);
      expect(await apiKeyBlockers(trx, id)).toEqual([]);
      const type = await makeType(trx);
      const late = await makeTestbed(trx, type.id, { idp_api_key_id: id });
      expect(await deleteApiKey(asConn(trx), id, actor.id)).toEqual({
        ok: false,
        error: {
          kind: "blocked",
          blockers: [{ id: late.id, label: late.name }],
        },
      });
    }));
});

// covers: spec 0007 AC-2 (the testbed form's IDP choices)
describe.skipIf(!hasDb)("listIdpKeyOptions (spec 0007 AC-2)", () => {
  it("lists live IDP keys only, by name ignoring case, with no secret", () =>
    inRollback(async (trx) => {
      const tag = unique();
      const key = (name: string, type: "IDP" | "AI", deleted_at?: Date) =>
        trx
          .insertInto("api_keys")
          .values({
            name,
            type,
            base_url: "https://idp.example.test",
            secret_ciphertext: "v1:test:placeholder",
            deleted_at,
          })
          .returning(["id", "name"])
          .executeTakeFirstOrThrow();
      const b = await key(`b ${tag}`, "IDP");
      const a = await key(`A ${tag}`, "IDP");
      await key(`c ${tag}`, "AI");
      await key(`d ${tag}`, "IDP", new Date());

      const mine = (await listIdpKeyOptions(trx)).filter((k) =>
        k.name.endsWith(tag),
      );
      expect(mine).toEqual([a, b]);
      expect(JSON.stringify(mine)).not.toContain("v1:");
    }));
});

// Spec 0012 AC-11 and spec 0006 AC-12. Dev and prod share one database, so
// the owner's real Cloudflare key may be live: each test soft deletes it
// first, inside the rollback. A stub verifier stands in for Cloudflare.
const CF_URL = `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}`;
const CF_URL_2 = `https://api.cloudflare.com/client/v4/accounts/${"b".repeat(32)}`;

const clearCloudflare = (trx: Kysely<DB>) =>
  trx
    .updateTable("api_keys")
    .set({ deleted_at: new Date() })
    .where("type", "=", "CLOUDFLARE")
    .where("deleted_at", "is", null)
    .execute();

const stubVerifier = (answer: "ok" | "invalid" | "unavailable" = "ok") => {
  const calls: CloudflareConfig[] = [];
  const deps: ApiKeyDeps = {
    verifyCloudflare: async (config) => {
      calls.push(config);
      return answer === "ok"
        ? { ok: true, value: undefined }
        : { ok: false, error: answer };
    },
    verifyGoogle: async () => {
      throw new Error("no Google check expected");
    },
  };
  return { calls, deps };
};

const cfInput = (overrides: Partial<ApiKeyCreateInput> = {}) =>
  input({
    type: "CLOUDFLARE",
    baseUrl: CF_URL,
    secret: "cf-token",
    ...overrides,
  });

// covers: spec 0006 AC-5, AC-12
describe.skipIf(!hasDb)("a CLOUDFLARE key (spec 0006 AC-12)", () => {
  const edit = (
    fields: ApiKeyCreateInput,
    changes: Partial<ApiKeyCreateInput> = {},
  ): StandardKeyUpdate => ({
    name: fields.name,
    type: fields.type,
    baseUrl: fields.baseUrl,
    secret: "",
    ...changes,
  });

  it("checks the typed token with Cloudflare, then saves it", () =>
    inRollback(async (trx) => {
      await clearCloudflare(trx);
      const actor = await makeUser(trx, { role: "admin" });
      const { calls, deps } = stubVerifier();
      const created = await createApiKey(
        asConn(trx),
        KEYRING,
        cfInput(),
        actor.id,
        deps,
      );
      if (!created.ok) throw new Error("expected a create");
      expect(calls).toEqual([{ baseUrl: CF_URL, apiToken: "cf-token" }]);
      const row = await stored(trx, created.value.id);
      expect(row.type).toBe("CLOUDFLARE");
      expect(row.secret_ciphertext).not.toContain("cf-token");
    }));

  it.each([
    ["invalid", "cloudflare_invalid"],
    ["unavailable", "cloudflare_unavailable"],
  ] as const)("writes nothing when Cloudflare answers %s", (answer, error) =>
    inRollback(async (trx) => {
      await clearCloudflare(trx);
      const actor = await makeUser(trx, { role: "admin" });
      const fields = cfInput();
      expect(
        await createApiKey(
          asConn(trx),
          KEYRING,
          fields,
          actor.id,
          stubVerifier(answer).deps,
        ),
      ).toEqual({ ok: false, error });
      const rows = await trx
        .selectFrom("api_keys")
        .select("id")
        .where("name", "=", fields.name)
        .execute();
      expect(rows).toEqual([]);
    }),
  );

  it("refuses a second live key on create and on a type change, not as a duplicate name", () =>
    inRollback(async (trx) => {
      await clearCloudflare(trx);
      const actor = await makeUser(trx, { role: "admin" });
      const { deps } = stubVerifier();
      const first = await createApiKey(
        asConn(trx),
        KEYRING,
        cfInput(),
        actor.id,
        deps,
      );
      expect(first.ok).toBe(true);
      expect(
        await createApiKey(asConn(trx), KEYRING, cfInput(), actor.id, deps),
      ).toEqual({ ok: false, error: "cloudflare_exists" });

      const idpFields = input();
      const idp = await createApiKey(asConn(trx), KEYRING, idpFields, actor.id);
      if (!idp.ok) throw new Error("expected a create");
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          idp.value.id,
          edit(idpFields, { type: "CLOUDFLARE", baseUrl: CF_URL, secret: "t" }),
          actor.id,
          deps,
        ),
      ).toEqual({ ok: false, error: "cloudflare_exists" });
      expect((await stored(trx, idp.value.id)).type).toBe("IDP");
    }));

  it("asks for the key again to change type to or from CLOUDFLARE, or its account", () =>
    inRollback(async (trx) => {
      await clearCloudflare(trx);
      const actor = await makeUser(trx, { role: "admin" });
      const { calls, deps } = stubVerifier();
      const cfFields = cfInput();
      const cf = await createApiKey(
        asConn(trx),
        KEYRING,
        cfFields,
        actor.id,
        deps,
      );
      const idpFields = input();
      const idp = await createApiKey(asConn(trx), KEYRING, idpFields, actor.id);
      if (!cf.ok || !idp.ok) throw new Error("expected creates");
      const before = await stored(trx, cf.value.id);
      calls.length = 0;

      for (const [id, changes] of [
        [cf.value.id, { baseUrl: CF_URL_2 }],
        [cf.value.id, { type: "AI", baseUrl: "https://ai.example" }],
      ] as const)
        expect(
          await updateApiKey(
            asConn(trx),
            KEYRING,
            id,
            edit(cfFields, changes),
            actor.id,
            deps,
          ),
        ).toEqual({ ok: false, error: "cloudflare_retype" });
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          idp.value.id,
          edit(idpFields, { type: "CLOUDFLARE", baseUrl: CF_URL_2 }),
          actor.id,
          deps,
        ),
      ).toEqual({ ok: false, error: "cloudflare_retype" });
      expect(await stored(trx, cf.value.id)).toEqual(before);
      expect(calls).toEqual([]);

      // With the token typed, the account change is checked and saved.
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          cf.value.id,
          edit(cfFields, { baseUrl: CF_URL_2, secret: "cf-token-2" }),
          actor.id,
          deps,
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(calls).toEqual([{ baseUrl: CF_URL_2, apiToken: "cf-token-2" }]);
    }));

  it("renames with the key blank and makes no Cloudflare call", () =>
    inRollback(async (trx) => {
      await clearCloudflare(trx);
      const actor = await makeUser(trx, { role: "admin" });
      const { calls, deps } = stubVerifier();
      const fields = cfInput();
      const cf = await createApiKey(
        asConn(trx),
        KEYRING,
        fields,
        actor.id,
        deps,
      );
      if (!cf.ok) throw new Error("expected a create");
      calls.length = 0;
      const name = `Cloudflare ${unique()}`;
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          cf.value.id,
          edit(fields, { name }),
          actor.id,
          deps,
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(calls).toEqual([]);
      expect((await stored(trx, cf.value.id)).name).toBe(name);
    }));

  it("refuses IDP to CLOUDFLARE while a live testbed uses the key (AC-5)", () =>
    inRollback(async (trx) => {
      await clearCloudflare(trx);
      const actor = await makeUser(trx, { role: "admin" });
      const fields = input();
      const idp = await createApiKey(asConn(trx), KEYRING, fields, actor.id);
      if (!idp.ok) throw new Error("expected a create");
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id, {
        idp_api_key_id: idp.value.id,
      });
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          idp.value.id,
          edit(fields, { type: "CLOUDFLARE", baseUrl: CF_URL, secret: "t" }),
          actor.id,
          stubVerifier().deps,
        ),
      ).toEqual({
        ok: false,
        error: { kind: "type_in_use", names: [testbed.name] },
      });
    }));
});

// covers: spec 0012 AC-11
describe.skipIf(!hasDb)("cloudflareRevokeConfig (spec 0012 AC-11)", () => {
  const getter = (keyring: Keyring = KEYRING) => {
    let reads = 0;
    return {
      get reads() {
        return reads;
      },
      keyring: () => {
        reads += 1;
        return keyring;
      },
    };
  };

  it("is off with no live key and never reads the keyring", () =>
    inRollback(async (trx) => {
      await clearCloudflare(trx);
      const g = getter();
      expect(await cloudflareRevokeConfig(asConn(trx), g.keyring)).toEqual({
        kind: "off",
      });
      expect(g.reads).toBe(0);
    }));

  it("round trips a live key to its base URL and token", () =>
    inRollback(async (trx) => {
      await clearCloudflare(trx);
      const actor = await makeUser(trx, { role: "admin" });
      await createApiKey(
        asConn(trx),
        KEYRING,
        cfInput({ secret: "cf-live-token" }),
        actor.id,
        stubVerifier().deps,
      );
      expect(
        await cloudflareRevokeConfig(asConn(trx), getter().keyring),
      ).toEqual({
        kind: "on",
        config: { baseUrl: CF_URL, apiToken: "cf-live-token" },
      });
    }));

  it("is off once the key is soft deleted", () =>
    inRollback(async (trx) => {
      await clearCloudflare(trx);
      const actor = await makeUser(trx, { role: "admin" });
      const cf = await createApiKey(
        asConn(trx),
        KEYRING,
        cfInput(),
        actor.id,
        stubVerifier().deps,
      );
      if (!cf.ok) throw new Error("expected a create");
      await deleteApiKey(asConn(trx), cf.value.id, actor.id);
      expect(
        await cloudflareRevokeConfig(asConn(trx), getter().keyring),
      ).toEqual({
        kind: "off",
      });
    }));

  it("is broken, never a throw, when the keyring can't be read or lacks the key id", () =>
    inRollback(async (trx) => {
      await clearCloudflare(trx);
      const actor = await makeUser(trx, { role: "admin" });
      await createApiKey(
        asConn(trx),
        KEYRING,
        cfInput(),
        actor.id,
        stubVerifier().deps,
      );
      const missing = () => {
        throw new Error("Encryption env: APP_ENCRYPTION_KEYS is missing");
      };
      expect(await cloudflareRevokeConfig(asConn(trx), missing)).toEqual({
        kind: "broken",
      });
      const other: Keyring = {
        activeKeyId: "kother",
        keys: new Map([["kother", randomBytes(32)]]),
      };
      expect(await cloudflareRevokeConfig(asConn(trx), () => other)).toEqual({
        kind: "broken",
      });
    }));

  it("is broken when the read itself fails", async () => {
    const failing = new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => ({
          init: async () => undefined,
          acquireConnection: async () => {
            throw new Error("connection refused");
          },
          beginTransaction: async () => undefined,
          commitTransaction: async () => undefined,
          rollbackTransaction: async () => undefined,
          releaseConnection: async () => undefined,
          destroy: async () => undefined,
        }),
        createIntrospector: (k) => new PostgresIntrospector(k),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    expect(await cloudflareRevokeConfig(failing, getter().keyring)).toEqual({
      kind: "broken",
    });
  });
});

// covers: spec 0013 AC-1 to AC-5, AC-28 to AC-30, AC-34 (the GOOGLE key)
describe.skipIf(!hasDb)("a GOOGLE key (spec 0013)", () => {
  const keyFile = fakeServiceAccountKey();

  type ServiceAccountCreate = Extract<
    GoogleKeyCreate,
    { googleAuth: "service_account" }
  >;
  type ServiceAccountUpdate = Extract<
    GoogleKeyUpdate,
    { googleAuth: "service_account" }
  >;
  type SignInCreate = Extract<GoogleKeyCreate, { googleAuth: "oauth" }>;
  type SignInUpdate = Extract<GoogleKeyUpdate, { googleAuth: "oauth" }>;

  const signIn = (over: Partial<GoogleSignIn> = {}): GoogleSignIn => ({
    clientId: "1234-abc.apps.googleusercontent.com",
    clientSecret: "GOCSPX-canary-client-secret",
    refreshToken: "1//canary-refresh-token",
    senderEmail: "hol.sender@gmail.com",
    ...over,
  });

  const clearGoogle = (trx: Kysely<DB>) =>
    trx
      .updateTable("api_keys")
      .set({ deleted_at: new Date() })
      .where("type", "=", "GOOGLE")
      .where("deleted_at", "is", null)
      .execute();

  const googleInput = (
    overrides: Partial<ServiceAccountCreate> = {},
  ): ServiceAccountCreate => ({
    name: `Google ${unique()}`,
    type: "GOOGLE",
    googleAuth: "service_account",
    senderEmail: "labs@nile.example",
    calendarId: "c_abc@group.calendar.google.com",
    devInbox: "dev-inbox@nile.example",
    opsBcc: null,
    keyFile,
    ...overrides,
  });

  const signInInput = (
    overrides: Partial<SignInCreate> = {},
  ): SignInCreate => ({
    name: `Gmail ${unique()}`,
    type: "GOOGLE",
    googleAuth: "oauth",
    calendarId: "c_gmail@group.calendar.google.com",
    devInbox: "dev-inbox@nile.example",
    opsBcc: null,
    signIn: signIn(),
    ...overrides,
  });

  const googleStub = (answer: "ok" | VerifyGoogleError = "ok") => {
    const calls: VerifyGoogleInput[] = [];
    const deps: ApiKeyDeps = {
      verifyCloudflare: async () => {
        throw new Error("no Cloudflare check expected");
      },
      verifyGoogle: async (input) => {
        calls.push(input);
        return answer === "ok"
          ? { ok: true, value: undefined }
          : { ok: false, error: answer };
      },
    };
    return { calls, deps };
  };

  const setup = async (trx: Transaction<DB>) => {
    await clearGoogle(trx);
    const actor = await makeUser(trx, { role: "admin" });
    const fields = googleInput();
    const created = await createApiKey(
      asConn(trx),
      KEYRING,
      fields,
      actor.id,
      googleStub().deps,
    );
    if (!created.ok) throw new Error("expected a create");
    return { actor, id: created.value.id, fields };
  };

  const setupSignIn = async (trx: Transaction<DB>) => {
    await clearGoogle(trx);
    const actor = await makeUser(trx, { role: "admin" });
    const fields = signInInput();
    const created = await createApiKey(
      asConn(trx),
      KEYRING,
      fields,
      actor.id,
      googleStub().deps,
    );
    if (!created.ok) throw new Error("expected a create");
    return { actor, id: created.value.id, fields };
  };

  const edit = (
    fields: ServiceAccountCreate,
    changes: Partial<ServiceAccountUpdate> = {},
  ): ServiceAccountUpdate => ({ ...fields, keyFile: null, ...changes });

  const editSignIn = (
    fields: SignInCreate,
    changes: Partial<SignInUpdate> = {},
  ): SignInUpdate => ({ ...fields, signIn: null, ...changes });

  const secretOf = async (trx: Kysely<DB>, id: string): Promise<unknown> =>
    JSON.parse(
      decryptSecret(
        KEYRING,
        (await stored(trx, id)).secret_ciphertext,
        secretAad("api_keys", "secret_ciphertext", id),
      ),
    );

  it("checks the key as the sender, then stores only three fields, encrypted", () =>
    inRollback(async (trx) => {
      const { calls, deps } = googleStub();
      await clearGoogle(trx);
      const actor = await makeUser(trx, { role: "admin" });
      const created = await createApiKey(
        asConn(trx),
        KEYRING,
        googleInput({ opsBcc: "ops@nile.example" }),
        actor.id,
        deps,
      );
      if (!created.ok) throw new Error("expected a create");
      expect(calls).toEqual([
        {
          credentials: {
            method: "service_account",
            clientEmail: keyFile.client_email,
            privateKey: keyFile.private_key,
            privateKeyId: keyFile.private_key_id,
          },
          senderEmail: "labs@nile.example",
          calendarId: "c_abc@group.calendar.google.com",
        },
      ]);
      const row = await stored(trx, created.value.id);
      expect(row).toMatchObject({
        type: "GOOGLE",
        base_url: "https://www.googleapis.com",
        google_auth: "service_account",
        google_rejected_at: null,
        sender_email: "labs@nile.example",
        calendar_id: "c_abc@group.calendar.google.com",
        dev_inbox: "dev-inbox@nile.example",
        ops_bcc: "ops@nile.example",
      });
      expect(row.secret_ciphertext).not.toContain("PRIVATE KEY");
      expect(await secretOf(trx, created.value.id)).toEqual({
        clientEmail: keyFile.client_email,
        privateKey: keyFile.private_key,
        privateKeyId: keyFile.private_key_id,
      });
      const [createdAudit] = await auditsFor(trx, created.value.id);
      expect(createdAudit.metadata).toEqual({
        type: "GOOGLE",
        baseUrl: "https://www.googleapis.com",
        googleAuth: "service_account",
        senderEmail: "labs@nile.example",
        calendarId: "c_abc@group.calendar.google.com",
        devInbox: "dev-inbox@nile.example",
        opsBcc: "ops@nile.example",
      });
      expect(JSON.stringify(createdAudit)).not.toContain("PRIVATE KEY");
    }));

  it.each<[VerifyGoogleError, string]>([
    ["invalid", "google_invalid"],
    ["delegation", "google_delegation"],
    ["calendar", "google_calendar"],
    ["unavailable", "google_unavailable"],
  ])("writes nothing when the check answers %s", (answer, error) =>
    inRollback(async (trx) => {
      await clearGoogle(trx);
      const actor = await makeUser(trx, { role: "admin" });
      const fields = googleInput();
      expect(
        await createApiKey(
          asConn(trx),
          KEYRING,
          fields,
          actor.id,
          googleStub(answer).deps,
        ),
      ).toEqual({ ok: false, error });
      const rows = await trx
        .selectFrom("api_keys")
        .select("id")
        .where("name", "=", fields.name)
        .execute();
      expect(rows).toEqual([]);
    }),
  );

  it("refuses a second live GOOGLE key", () =>
    inRollback(async (trx) => {
      const { actor } = await setup(trx);
      expect(
        await createApiKey(
          asConn(trx),
          KEYRING,
          googleInput(),
          actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: false, error: "google_exists" });
    }));

  it("saves a name, dev inbox, or Ops BCC change with no file and no Google call (AC-4)", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      const { calls, deps } = googleStub();
      const before = await stored(trx, id);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          edit(fields, { devInbox: null, opsBcc: "ops@nile.example" }),
          actor.id,
          deps,
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(calls).toEqual([]);
      const after = await stored(trx, id);
      expect(after).toMatchObject({
        dev_inbox: null,
        ops_bcc: "ops@nile.example",
      });
      expect(after.secret_ciphertext).toBe(before.secret_ciphertext);
      const audits = (await auditsFor(trx, id)).map((a) => a.action);
      expect(audits).toEqual(["api_key.created", "api_key.updated"]);
    }));

  it.each([
    ["the sender", { senderEmail: "other@nile.example" }],
    ["the calendar", { calendarId: "c_other@group.calendar.google.com" }],
  ])("needs the key file again to change %s (AC-4)", (_label, change) =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          edit(fields, change),
          actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: false, error: "google_file_required" });
    }),
  );

  it("needs the key file to become GOOGLE, and a typed key to leave it (AC-4)", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          {
            name: fields.name,
            type: "AI",
            baseUrl: "https://ai.example",
            secret: "",
          },
          actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: false, error: "key_required" });
      const ai = await createApiKey(
        asConn(trx),
        KEYRING,
        input({ type: "AI" }),
        actor.id,
      );
      if (!ai.ok) throw new Error("expected a create");
      await clearGoogle(trx);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          ai.value.id,
          { ...googleInput(), keyFile: null },
          actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: false, error: "google_file_required" });
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          ai.value.id,
          { ...signInInput(), signIn: null },
          actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: false, error: "google_sign_in_switch" });
    }));

  it("replaces the key with a new file, checking it first (AC-4)", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      const { calls, deps } = googleStub();
      const before = await stored(trx, id);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          edit(fields, {
            senderEmail: "other@nile.example",
            keyFile: fakeServiceAccountKey({ private_key_id: "new-key-id" }),
          }),
          actor.id,
          deps,
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(calls).toHaveLength(1);
      const after = await stored(trx, id);
      expect(after.sender_email).toBe("other@nile.example");
      expect(after.secret_ciphertext).not.toBe(before.secret_ciphertext);
      const audits = await auditsFor(trx, id);
      expect(audits.map((a) => a.action)).toEqual([
        "api_key.created",
        "api_key.updated",
        "api_key.secret_replaced",
      ]);
      expect(audits[1].metadata).toEqual({
        senderEmail: { from: "labs@nile.example", to: "other@nile.example" },
      });
    }));

  it("moves a GOOGLE key to another type with a typed key, clearing its settings", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      await trx
        .updateTable("api_keys")
        .set({ google_rejected_at: new Date() })
        .where("id", "=", id)
        .execute();
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          {
            name: fields.name,
            type: "AI",
            baseUrl: "https://ai.example",
            secret: "ai-secret",
          },
          actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(await stored(trx, id)).toMatchObject({
        type: "AI",
        base_url: "https://ai.example",
        google_auth: null,
        google_rejected_at: null,
        sender_email: null,
        calendar_id: null,
        dev_inbox: null,
        ops_bcc: null,
      });
    }));

  it("creates a Google sign in key with no Google check, storing only the client and refresh token (AC-28)", () =>
    inRollback(async (trx) => {
      const { calls, deps } = googleStub();
      await clearGoogle(trx);
      const actor = await makeUser(trx, { role: "admin" });
      const created = await createApiKey(
        asConn(trx),
        KEYRING,
        signInInput({ opsBcc: "ops@nile.example" }),
        actor.id,
        deps,
      );
      if (!created.ok) throw new Error("expected a create");
      expect(calls).toEqual([]);
      const row = await stored(trx, created.value.id);
      expect(row).toMatchObject({
        type: "GOOGLE",
        base_url: "https://www.googleapis.com",
        google_auth: "oauth",
        sender_email: "hol.sender@gmail.com",
        calendar_id: "c_gmail@group.calendar.google.com",
        ops_bcc: "ops@nile.example",
      });
      expect(row.secret_ciphertext).not.toContain("canary");
      expect(await secretOf(trx, created.value.id)).toEqual({
        clientId: "1234-abc.apps.googleusercontent.com",
        clientSecret: "GOCSPX-canary-client-secret",
        refreshToken: "1//canary-refresh-token",
      });
      const audits = await auditsFor(trx, created.value.id);
      expect(audits[0].metadata).toEqual({
        type: "GOOGLE",
        baseUrl: "https://www.googleapis.com",
        googleAuth: "oauth",
        senderEmail: "hol.sender@gmail.com",
        calendarId: "c_gmail@group.calendar.google.com",
        devInbox: "dev-inbox@nile.example",
        opsBcc: "ops@nile.example",
      });
      expect(JSON.stringify(audits)).not.toContain("canary");
    }));

  it("edits a Google sign in key's dev inbox with no sign in, keeping its sender and secret (AC-29)", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setupSignIn(trx);
      const before = await stored(trx, id);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          editSignIn(fields, { devInbox: null }),
          actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: true, value: undefined });
      const after = await stored(trx, id);
      expect(after).toMatchObject({
        dev_inbox: null,
        sender_email: "hol.sender@gmail.com",
        google_auth: "oauth",
      });
      expect(after.secret_ciphertext).toBe(before.secret_ciphertext);
      const audits = await auditsFor(trx, id);
      expect(audits.map((a) => a.action)).toEqual([
        "api_key.created",
        "api_key.updated",
      ]);
      expect(audits[1].metadata).toEqual({
        devInbox: { from: "dev-inbox@nile.example", to: null },
      });
    }));

  it("needs a new sign in to change a Google sign in key's calendar (AC-29)", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setupSignIn(trx);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          editSignIn(fields, {
            calendarId: "c_other@group.calendar.google.com",
          }),
          actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: false, error: "google_sign_in_required" });
    }));

  it("refuses a switch of method without the new method's credential (AC-29)", () =>
    inRollback(async (trx) => {
      const sa = await setup(trx);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          sa.id,
          { ...signInInput({ name: sa.fields.name }), signIn: null },
          sa.actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: false, error: "google_sign_in_switch" });
      const oauth = await setupSignIn(trx);
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          oauth.id,
          {
            ...googleInput({ name: oauth.fields.name }),
            keyFile: null,
          },
          oauth.actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: false, error: "google_file_switch" });
    }));

  it("switches a service account key to Google sign in in one update, clearing the marker (AC-29, AC-31)", () =>
    inRollback(async (trx) => {
      const { actor, id, fields } = await setup(trx);
      await trx
        .updateTable("api_keys")
        .set({ google_rejected_at: new Date() })
        .where("id", "=", id)
        .execute();
      expect(
        await updateApiKey(
          asConn(trx),
          KEYRING,
          id,
          {
            ...signInInput({
              name: fields.name,
              calendarId: fields.calendarId,
              devInbox: fields.devInbox,
            }),
          },
          actor.id,
          googleStub().deps,
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(await stored(trx, id)).toMatchObject({
        google_auth: "oauth",
        sender_email: "hol.sender@gmail.com",
        google_rejected_at: null,
      });
      expect(await secretOf(trx, id)).toEqual({
        clientId: "1234-abc.apps.googleusercontent.com",
        clientSecret: "GOCSPX-canary-client-secret",
        refreshToken: "1//canary-refresh-token",
      });
      const audits = await auditsFor(trx, id);
      expect(audits.map((a) => a.action)).toEqual([
        "api_key.created",
        "api_key.updated",
        "api_key.secret_replaced",
      ]);
      expect(audits[1].metadata).toEqual({
        googleAuth: { from: "service_account", to: "oauth" },
        senderEmail: { from: "labs@nile.example", to: "hol.sender@gmail.com" },
      });
      expect(JSON.stringify(audits)).not.toContain("canary");
    }));

  it("lists a GOOGLE key's method and Needs attention date, never its secret (AC-32)", () =>
    inRollback(async (trx) => {
      const { id } = await setupSignIn(trx);
      const at = new Date("2026-10-16T09:00:00.000Z");
      await trx
        .updateTable("api_keys")
        .set({ google_rejected_at: at })
        .where("id", "=", id)
        .execute();
      const row = (await listApiKeys(asConn(trx))).find((k) => k.id === id);
      expect(row).toMatchObject({
        googleAuth: "oauth",
        googleRejectedAt: at,
        senderEmail: "hol.sender@gmail.com",
      });
      expect(JSON.stringify(row)).not.toMatch(/canary|GOCSPX|v1:/);
      expect(listApiKeysQuery(asConn(trx)).compile().sql).not.toContain(
        "secret_ciphertext",
      );
    }));

  it("googleMailConfig is null with no live key and never reads the keyring (AC-5)", () =>
    inRollback(async (trx) => {
      await clearGoogle(trx);
      let reads = 0;
      expect(
        await googleMailConfig(asConn(trx), () => {
          reads += 1;
          return KEYRING;
        }),
      ).toBeNull();
      expect(reads).toBe(0);
      expect(await googleConfigured(asConn(trx))).toBe(false);
    }));

  it("googleMailConfig round trips the live key and its settings (AC-5, AC-30)", () =>
    inRollback(async (trx) => {
      const { id } = await setup(trx);
      const row = await stored(trx, id);
      expect(await googleMailConfig(asConn(trx), () => KEYRING)).toEqual({
        id,
        credentials: {
          method: "service_account",
          clientEmail: keyFile.client_email,
          privateKey: keyFile.private_key,
          privateKeyId: keyFile.private_key_id,
        },
        senderEmail: "labs@nile.example",
        calendarId: "c_abc@group.calendar.google.com",
        devInbox: "dev-inbox@nile.example",
        opsBcc: null,
        secretUpdatedAt: row.secret_updated_at,
        stamp: row.secret_updated_at.toISOString(),
      });
      expect(await googleConfigured(asConn(trx))).toBe(true);
    }));

  it("googleMailConfig reads a Google sign in key by its column (AC-30)", () =>
    inRollback(async (trx) => {
      const { id } = await setupSignIn(trx);
      const cfg = await googleMailConfig(asConn(trx), () => KEYRING);
      expect(cfg).toMatchObject({
        id,
        credentials: {
          method: "oauth",
          clientId: "1234-abc.apps.googleusercontent.com",
          clientSecret: "GOCSPX-canary-client-secret",
          refreshToken: "1//canary-refresh-token",
        },
        senderEmail: "hol.sender@gmail.com",
      });
      // The column names the schema: a sign in secret under the other label
      // can't be read.
      await trx
        .updateTable("api_keys")
        .set({ google_auth: "service_account" })
        .where("id", "=", id)
        .execute();
      const e = await thrown(() =>
        googleMailConfig(asConn(trx), () => KEYRING),
      );
      expect(e.message).toBe("the GOOGLE API key can't be read");
    }));

  it("googleMailConfig throws one fixed message when the key can't be read", () =>
    inRollback(async (trx) => {
      await setup(trx);
      const other: Keyring = {
        activeKeyId: "kother",
        keys: new Map([["kother", randomBytes(32)]]),
      };
      const e = await thrown(() => googleMailConfig(asConn(trx), () => other));
      expect(e.message).toBe("the GOOGLE API key can't be read");
    }));

  it.each([
    ["a GOOGLE key with no method", { type: "GOOGLE", google_auth: null }],
    ["an AI key with a method", { type: "AI", google_auth: "oauth" }],
    [
      "an AI key with the marker",
      { type: "AI", google_auth: null, google_rejected_at: new Date() },
    ],
  ] as const)("api_keys_google_fields_check refuses %s (AC-34)", (_, row) =>
    inRollback(async (trx) => {
      await clearGoogle(trx);
      const google = row.type === "GOOGLE";
      const e = await thrown(() =>
        trx
          .insertInto("api_keys")
          .values({
            name: `Check ${unique()}`,
            base_url: "https://www.googleapis.com",
            secret_ciphertext: "v1:x:y:z:w",
            sender_email: google ? "labs@nile.example" : null,
            calendar_id: google ? "c@group.calendar.google.com" : null,
            ...row,
          })
          .execute(),
      );
      expect(e.message).toContain("api_keys_google_fields_check");
    }),
  );
});
