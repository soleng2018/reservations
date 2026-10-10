import "server-only";
import { sql, type Kysely } from "kysely";
import type { ApiKeyCreateInput } from "@/lib/catalog-input";
import { ApiKeyType } from "@/lib/db-enums";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import {
  encryptSecret,
  secretAad,
  type Keyring,
} from "@/server/crypto/secrets";
import { mapConstraintError } from "@/server/db/constraint-errors";
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
