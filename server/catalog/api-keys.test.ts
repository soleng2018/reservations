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
import type { ApiKeyCreateInput } from "@/lib/catalog-input";
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
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
  listApiKeysQuery,
  updateApiKey,
} from "./api-keys";

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
      expect(Object.keys(mine[0]).sort()).toEqual([
        "baseUrl",
        "id",
        "name",
        "secretUpdatedAt",
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
  ) => ({
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
