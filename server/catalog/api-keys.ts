import "server-only";
import { sql, type Kysely } from "kysely";
import type { ApiKeyCreateInput, ApiKeyUpdateInput } from "@/lib/catalog-input";
import { changedFields } from "@/lib/changed-fields";
import { ApiKeyType } from "@/lib/db-enums";
import type { Blocker } from "@/lib/delete-flow";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import {
  encryptSecret,
  secretAad,
  type Keyring,
} from "@/server/crypto/secrets";
import { mapConstraintError } from "@/server/db/constraint-errors";
import { apiKeyBlockers, lockForDelete } from "@/server/db/delete-blockers";
import type { DB } from "@/server/db/types";

// Feature 8 (spec 0006). A secret is written here and nowhere else: it is
// encrypted before the insert, never selected, and never returned, logged,
// or audited. This is the only app file that names its column.

export type ApiKeyRow = {
  readonly id: string;
  readonly name: string;
  readonly type: ApiKeyType;
  readonly baseUrl: string;
  readonly secretUpdatedAt: Date;
};

const aad = (id: string) => secretAad("api_keys", "secret_ciphertext", id);

// A Postgres error's detail can hold the failing row, ciphertext included,
// so a write error that is not an expected constraint leaves only this.
const WRITE_FAILED = "api key write failed";

const isDuplicateName = (e: unknown): boolean => {
  try {
    const mapped = mapConstraintError(e);
    return !mapped.ok && mapped.error === "duplicate_name";
  } catch {
    return false;
  }
};

// The list query, exported so a test can check its SQL never reads the
// secret (AC-8).
export const listApiKeysQuery = (conn: Kysely<DB>) =>
  conn
    .selectFrom("api_keys")
    .select(["id", "name", "type", "base_url", "secret_updated_at"])
    .where("deleted_at", "is", null)
    .orderBy(sql`lower(name)`);

// AC-1. Live keys by name, without their secrets.
export async function listApiKeys(
  conn: Kysely<DB>,
): Promise<readonly ApiKeyRow[]> {
  const rows = await listApiKeysQuery(conn).execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: ApiKeyType.parse(r.type),
    baseUrl: r.base_url,
    secretUpdatedAt: r.secret_updated_at,
  }));
}

// AC-2, AC-7. The id is made here so the ciphertext can be bound to its row
// before the insert. A live key with the same name ignoring case is refused
// through api_keys_name_lower_uq (ON CONFLICT DO NOTHING); secret_updated_at
// takes its default, the DB clock.
export async function createApiKey(
  conn: Kysely<DB>,
  keyring: Keyring,
  input: ApiKeyCreateInput,
  actorId: string,
): Promise<Result<{ readonly id: string }, "duplicate_name">> {
  const id = crypto.randomUUID();
  const ciphertext = encryptSecret(keyring, input.secret, aad(id));
  try {
    return await conn.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("api_keys")
        .values({
          id,
          name: input.name,
          type: input.type,
          base_url: input.baseUrl,
          secret_ciphertext: ciphertext,
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!row) return err("duplicate_name");
      await audit(trx, {
        actorUserId: actorId,
        action: "api_key.created",
        targetType: "api_key",
        targetId: id,
        summary: "API key created",
        metadata: { type: input.type, baseUrl: input.baseUrl },
      });
      return ok({ id });
    });
  } catch (e) {
    if (isDuplicateName(e)) return err("duplicate_name");
    throw new Error(WRITE_FAILED);
  }
}

export type ApiKeyUpdateError =
  | "duplicate_name"
  | "not_found"
  | { readonly kind: "type_in_use"; readonly names: readonly string[] };

const AUDITED_FIELDS = ["name", "type", "baseUrl"] as const;

// AC-4, AC-5. The row lock serializes concurrent saves (the last one wins)
// and holds the key while the type change check runs. A blank secret keeps
// the stored one; a typed one is stored fresh (new IV) and bumps
// secret_updated_at. A save that changes nothing writes nothing. A duplicate
// name aborts the transaction, so it is mapped outside it.
export async function updateApiKey(
  conn: Kysely<DB>,
  keyring: Keyring,
  id: string,
  input: ApiKeyUpdateInput,
  actorId: string,
): Promise<Result<void, ApiKeyUpdateError>> {
  const ciphertext =
    input.secret === ""
      ? undefined
      : encryptSecret(keyring, input.secret, aad(id));
  try {
    return await conn.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("api_keys")
        .select(["name", "type", "base_url"])
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return err("not_found");
      const before = {
        name: row.name,
        type: ApiKeyType.parse(row.type),
        baseUrl: row.base_url,
      };
      const changed = changedFields(AUDITED_FIELDS, before, input);
      const fieldsChanged = Object.keys(changed).length > 0;
      if (!fieldsChanged && ciphertext === undefined) return ok(undefined);

      if (before.type === "IDP" && input.type === "AI") {
        const blockers = await apiKeyBlockers(trx, id);
        if (blockers.length > 0)
          return err({
            kind: "type_in_use",
            names: blockers.map((b) => b.label),
          });
      }

      await trx
        .updateTable("api_keys")
        .set({
          ...("name" in changed ? { name: input.name } : {}),
          ...("type" in changed ? { type: input.type } : {}),
          ...("baseUrl" in changed ? { base_url: input.baseUrl } : {}),
          ...(ciphertext === undefined
            ? {}
            : {
                secret_ciphertext: ciphertext,
                secret_updated_at: sql<Date>`now()`,
              }),
        })
        .where("id", "=", id)
        .execute();
      if (fieldsChanged)
        await audit(trx, {
          actorUserId: actorId,
          action: "api_key.updated",
          targetType: "api_key",
          targetId: id,
          summary: "API key updated",
          metadata: changed,
        });
      if (ciphertext !== undefined)
        await audit(trx, {
          actorUserId: actorId,
          action: "api_key.secret_replaced",
          targetType: "api_key",
          targetId: id,
          summary: "API key secret replaced",
        });
      return ok(undefined);
    });
  } catch (e) {
    if (isDuplicateName(e)) return err("duplicate_name");
    throw new Error(WRITE_FAILED);
  }
}

export type DeleteApiKeyError =
  | { readonly kind: "blocked"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "not_found" };

// AC-6 (spec 0002 AC-14). Lock, check the blockers again, then soft delete,
// so a testbed assigned meanwhile cannot slip in. The name is free for
// reuse afterwards (unique among live rows only).
export async function deleteApiKey(
  conn: Kysely<DB>,
  id: string,
  actorId: string,
): Promise<Result<void, DeleteApiKeyError>> {
  try {
    return await conn.transaction().execute(async (trx) => {
      if (!(await lockForDelete(trx, "api_keys", id)))
        return err({ kind: "not_found" });
      const blockers = await apiKeyBlockers(trx, id);
      if (blockers.length > 0) return err({ kind: "blocked", blockers });

      await trx
        .updateTable("api_keys")
        .set({ deleted_at: sql<Date>`now()` })
        .where("id", "=", id)
        .execute();
      await audit(trx, {
        actorUserId: actorId,
        action: "api_key.deleted",
        targetType: "api_key",
        targetId: id,
        summary: "API key deleted",
      });
      return ok(undefined);
    });
  } catch {
    throw new Error(WRITE_FAILED);
  }
}
