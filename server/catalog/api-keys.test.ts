import { randomBytes } from "node:crypto";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import type { ApiKeyCreateInput } from "@/lib/catalog-input";
import {
  decryptSecret,
  secretAad,
  type Keyring,
} from "@/server/crypto/secrets";
import { db } from "@/server/db";
import { asConn, hasDb, inRollback, makeUser } from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { createApiKey, listApiKeys, listApiKeysQuery } from "./api-keys";

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
