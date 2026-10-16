import "server-only";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { GoogleServiceAccountKey } from "@/lib/booking-email";
import {
  GOOGLE_BASE_URL,
  type GoogleKeyFields,
  type StandardKeyCreate,
  type StandardKeyUpdate,
} from "@/lib/catalog-input";
import { changedFields } from "@/lib/changed-fields";
import { ApiKeyType } from "@/lib/db-enums";
import type { Blocker } from "@/lib/delete-flow";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import {
  verifyCloudflareToken,
  type CloudflareConfig,
  type RevokeSource,
  type VerifyError,
} from "@/server/cloudflare/access";
import {
  decryptSecret,
  encryptSecret,
  secretAad,
  type Keyring,
} from "@/server/crypto/secrets";
import { mapConstraintError } from "@/server/db/constraint-errors";
import { apiKeyBlockers, lockForDelete } from "@/server/db/delete-blockers";
import type { DB } from "@/server/db/types";
import {
  verifyGoogleKey,
  type VerifyGoogleError,
  type VerifyGoogleInput,
} from "@/server/google/verify";

// Feature 8 (spec 0006). A secret is written here and nowhere else: it is
// encrypted before the insert, and never returned to a browser, logged, or
// audited. This is the only app file that names its column, and the only
// place one is decrypted, for the worker only: the CLOUDFLARE token (spec
// 0012 AC-11) and the GOOGLE service account key (spec 0013 AC-5).

export type ApiKeyRow = {
  readonly id: string;
  readonly name: string;
  readonly type: ApiKeyType;
  readonly baseUrl: string;
  readonly secretUpdatedAt: Date;
  // GOOGLE only (spec 0013 AC-1); null for every other type.
  readonly senderEmail: string | null;
  readonly calendarId: string | null;
  readonly devInbox: string | null;
  readonly opsBcc: string | null;
};

// Spec 0013 AC-1, AC-4: a GOOGLE save carries the parsed key file, or null
// on an edit that keeps the stored key.
export type GoogleKeyCreate = GoogleKeyFields & {
  readonly keyFile: GoogleServiceAccountKey;
};
export type GoogleKeyUpdate = GoogleKeyFields & {
  readonly keyFile: GoogleServiceAccountKey | null;
};
export type ApiKeyCreate = StandardKeyCreate | GoogleKeyCreate;
export type ApiKeyUpdate = StandardKeyUpdate | GoogleKeyUpdate;

const aad = (id: string) => secretAad("api_keys", "secret_ciphertext", id);

// A Postgres error's detail can hold the failing row, ciphertext included,
// so a write error that is not an expected constraint leaves only this.
const WRITE_FAILED = "api key write failed";

type UniqueError = "duplicate_name" | "cloudflare_exists" | "google_exists";

// The unique indexes a save can hit, or undefined for anything else.
const uniqueError = (e: unknown): UniqueError | undefined => {
  try {
    const mapped = mapConstraintError(e);
    if (mapped.ok) return undefined;
    switch (mapped.error) {
      case "duplicate_name":
      case "cloudflare_exists":
      case "google_exists":
        return mapped.error;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
};

// What a save stores, besides the secret. A GOOGLE key's base URL is the
// constant; every other type has no Google settings.
type Stored = {
  readonly name: string;
  readonly type: ApiKeyType;
  readonly baseUrl: string;
  readonly senderEmail: string | null;
  readonly calendarId: string | null;
  readonly devInbox: string | null;
  readonly opsBcc: string | null;
};

const storedFields = (input: ApiKeyCreate | ApiKeyUpdate): Stored =>
  input.type === "GOOGLE"
    ? {
        name: input.name,
        type: input.type,
        baseUrl: GOOGLE_BASE_URL,
        senderEmail: input.senderEmail,
        calendarId: input.calendarId,
        devInbox: input.devInbox,
        opsBcc: input.opsBcc,
      }
    : {
        name: input.name,
        type: input.type,
        baseUrl: input.baseUrl,
        senderEmail: null,
        calendarId: null,
        devInbox: null,
        opsBcc: null,
      };

// Spec 0013 AC-3: only these three fields of the key file are stored.
const GoogleSecret = z.object({
  clientEmail: z.string(),
  privateKey: z.string(),
  privateKeyId: z.string(),
});

// The plain text to encrypt, or undefined to keep the stored secret.
const newSecret = (input: ApiKeyCreate | ApiKeyUpdate): string | undefined => {
  if (input.type !== "GOOGLE")
    return input.secret === "" ? undefined : input.secret;
  if (!input.keyFile) return undefined;
  return JSON.stringify({
    clientEmail: input.keyFile.client_email,
    privateKey: input.keyFile.private_key,
    privateKeyId: input.keyFile.private_key_id,
  } satisfies z.infer<typeof GoogleSecret>);
};

// Spec 0006 AC-12: the save time check of a typed CLOUDFLARE token.
export type CloudflareCheckError =
  "cloudflare_invalid" | "cloudflare_unavailable";

// Spec 0013 AC-2: the save time check of an uploaded GOOGLE key.
export type GoogleCheckError =
  | "google_invalid"
  | "google_delegation"
  | "google_calendar"
  | "google_unavailable";

export type ApiKeyDeps = {
  readonly verifyCloudflare: (
    config: CloudflareConfig,
  ) => Promise<Result<void, VerifyError>>;
  readonly verifyGoogle: (
    input: VerifyGoogleInput,
  ) => Promise<Result<void, VerifyGoogleError>>;
};

const LIVE_DEPS: ApiKeyDeps = {
  verifyCloudflare: verifyCloudflareToken,
  verifyGoogle: (input) => verifyGoogleKey(input),
};

// Runs outside any transaction, before the write, and only when a new
// credential was given: a typed CLOUDFLARE token, or a GOOGLE key file. The
// result is not audited.
async function checkCredential(
  deps: ApiKeyDeps,
  input: ApiKeyCreate | ApiKeyUpdate,
): Promise<Result<void, CloudflareCheckError | GoogleCheckError>> {
  if (input.type === "GOOGLE") {
    if (!input.keyFile) return ok(undefined);
    const checked = await deps.verifyGoogle({
      clientEmail: input.keyFile.client_email,
      privateKey: input.keyFile.private_key,
      privateKeyId: input.keyFile.private_key_id,
      senderEmail: input.senderEmail,
      calendarId: input.calendarId,
    });
    if (checked.ok) return ok(undefined);
    switch (checked.error) {
      case "invalid":
        return err("google_invalid");
      case "delegation":
        return err("google_delegation");
      case "calendar":
        return err("google_calendar");
      case "unavailable":
        return err("google_unavailable");
      default: {
        const never: never = checked.error;
        return never;
      }
    }
  }
  if (input.type !== "CLOUDFLARE" || input.secret === "") return ok(undefined);
  const checked = await deps.verifyCloudflare({
    baseUrl: input.baseUrl,
    apiToken: input.secret,
  });
  if (checked.ok) return ok(undefined);
  switch (checked.error) {
    case "invalid":
      return err("cloudflare_invalid");
    case "unavailable":
      return err("cloudflare_unavailable");
    default: {
      const never: never = checked.error;
      return never;
    }
  }
}

// The list query, exported so a test can check its SQL never reads the
// secret (AC-8).
export const listApiKeysQuery = (conn: Kysely<DB>) =>
  conn
    .selectFrom("api_keys")
    .select([
      "id",
      "name",
      "type",
      "base_url",
      "secret_updated_at",
      "sender_email",
      "calendar_id",
      "dev_inbox",
      "ops_bcc",
    ])
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
    senderEmail: r.sender_email,
    calendarId: r.calendar_id,
    devInbox: r.dev_inbox,
    opsBcc: r.ops_bcc,
  }));
}

// Spec 0007 AC-2: the testbed form's IDP choices, live `IDP` keys by name.
export async function listIdpKeyOptions(
  conn: Kysely<DB>,
): Promise<readonly { readonly id: string; readonly name: string }[]> {
  return conn
    .selectFrom("api_keys")
    .select(["id", "name"])
    .where("type", "=", "IDP")
    .where("deleted_at", "is", null)
    .orderBy(sql`lower(name)`)
    .execute();
}

const googleAuditFields = (s: Stored) =>
  s.type === "GOOGLE"
    ? {
        senderEmail: s.senderEmail,
        calendarId: s.calendarId,
        devInbox: s.devInbox,
        opsBcc: s.opsBcc,
      }
    : {};

export type ApiKeyCreateError =
  UniqueError | CloudflareCheckError | GoogleCheckError;

// AC-2, AC-7. The id is made here so the ciphertext can be bound to its row
// before the insert. A live key with the same name ignoring case is refused
// through api_keys_name_lower_uq (ON CONFLICT DO NOTHING, aimed at that index
// only, so a second live CLOUDFLARE or GOOGLE key still raises its own
// conflict); secret_updated_at takes its default, the DB clock.
export async function createApiKey(
  conn: Kysely<DB>,
  keyring: Keyring,
  input: ApiKeyCreate,
  actorId: string,
  deps: ApiKeyDeps = LIVE_DEPS,
): Promise<Result<{ readonly id: string }, ApiKeyCreateError>> {
  const checked = await checkCredential(deps, input);
  if (!checked.ok) return checked;
  const secret = newSecret(input);
  // Both schemas require a secret on create; this is a broken invariant.
  if (secret === undefined) throw new Error("api key create without a secret");
  const fields = storedFields(input);
  const id = crypto.randomUUID();
  const ciphertext = encryptSecret(keyring, secret, aad(id));
  try {
    return await conn.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("api_keys")
        .values({
          id,
          name: fields.name,
          type: fields.type,
          base_url: fields.baseUrl,
          secret_ciphertext: ciphertext,
          sender_email: fields.senderEmail,
          calendar_id: fields.calendarId,
          dev_inbox: fields.devInbox,
          ops_bcc: fields.opsBcc,
        })
        .onConflict((oc) =>
          oc
            .expression(sql`lower(name)`)
            .where("deleted_at", "is", null)
            .doNothing(),
        )
        .returning("id")
        .executeTakeFirst();
      if (!row) return err("duplicate_name");
      await audit(trx, {
        actorUserId: actorId,
        action: "api_key.created",
        targetType: "api_key",
        targetId: id,
        summary: "API key created",
        metadata: {
          type: fields.type,
          baseUrl: fields.baseUrl,
          ...googleAuditFields(fields),
        },
      });
      return ok({ id });
    });
  } catch (e) {
    const unique = uniqueError(e);
    if (unique) return err(unique);
    throw new Error(WRITE_FAILED);
  }
}

export type ApiKeyUpdateError =
  | UniqueError
  | CloudflareCheckError
  | GoogleCheckError
  | "not_found"
  // Spec 0006 AC-12: the web process never decrypts a stored token, so a
  // change that moves a token to another type or account needs it typed.
  | "cloudflare_retype"
  // Spec 0013 AC-4: a sender, calendar, or type change to GOOGLE needs the
  // key file again; a type change away from GOOGLE needs the new key typed.
  | "google_file_required"
  | "key_required"
  | { readonly kind: "type_in_use"; readonly names: readonly string[] };

// A type change to or from CLOUDFLARE, or a CLOUDFLARE key moving account.
const needsCloudflareToken = (before: Stored, after: Stored): boolean =>
  (before.type === "CLOUDFLARE") !== (after.type === "CLOUDFLARE") ||
  (before.type === "CLOUDFLARE" && before.baseUrl !== after.baseUrl);

// A key becoming GOOGLE, or a GOOGLE key changing who it acts as or where.
const needsGoogleFile = (before: Stored, after: Stored): boolean =>
  after.type === "GOOGLE" &&
  (before.type !== "GOOGLE" ||
    before.senderEmail !== after.senderEmail ||
    before.calendarId !== after.calendarId);

const AUDITED_FIELDS = [
  "name",
  "type",
  "baseUrl",
  "senderEmail",
  "calendarId",
  "devInbox",
  "opsBcc",
] as const;

const COLUMN = {
  name: "name",
  type: "type",
  baseUrl: "base_url",
  senderEmail: "sender_email",
  calendarId: "calendar_id",
  devInbox: "dev_inbox",
  opsBcc: "ops_bcc",
} as const satisfies Record<(typeof AUDITED_FIELDS)[number], string>;

// AC-4, AC-5, AC-12 (spec 0013 AC-4). The row lock serializes concurrent
// saves (the last one wins) and holds the key while the type change checks
// run. A blank secret (or no key file) keeps the stored one; a new one is
// stored fresh (new IV) and bumps secret_updated_at. A save that changes
// nothing writes nothing. A new CLOUDFLARE token or GOOGLE key file is
// checked first, outside the transaction. A duplicate name or a second
// CLOUDFLARE or GOOGLE key aborts the transaction, so it is mapped outside.
export async function updateApiKey(
  conn: Kysely<DB>,
  keyring: Keyring,
  id: string,
  input: ApiKeyUpdate,
  actorId: string,
  deps: ApiKeyDeps = LIVE_DEPS,
): Promise<Result<void, ApiKeyUpdateError>> {
  const checked = await checkCredential(deps, input);
  if (!checked.ok) return checked;
  const secret = newSecret(input);
  const ciphertext =
    secret === undefined ? undefined : encryptSecret(keyring, secret, aad(id));
  const after = storedFields(input);
  try {
    return await conn.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("api_keys")
        .select([
          "name",
          "type",
          "base_url",
          "sender_email",
          "calendar_id",
          "dev_inbox",
          "ops_bcc",
        ])
        .where("id", "=", id)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) return err("not_found");
      const before: Stored = {
        name: row.name,
        type: ApiKeyType.parse(row.type),
        baseUrl: row.base_url,
        senderEmail: row.sender_email,
        calendarId: row.calendar_id,
        devInbox: row.dev_inbox,
        opsBcc: row.ops_bcc,
      };
      const changed = changedFields(AUDITED_FIELDS, before, after);
      const fieldsChanged = Object.keys(changed).length > 0;
      if (!fieldsChanged && ciphertext === undefined) return ok(undefined);

      if (ciphertext === undefined) {
        if (needsGoogleFile(before, after)) return err("google_file_required");
        if (before.type === "GOOGLE" && after.type !== "GOOGLE")
          return err("key_required");
        if (needsCloudflareToken(before, after))
          return err("cloudflare_retype");
      }

      if (before.type === "IDP" && after.type !== "IDP") {
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
          ...Object.fromEntries(
            AUDITED_FIELDS.filter((k) => k in changed).map((k) => [
              COLUMN[k],
              after[k],
            ]),
          ),
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
    const unique = uniqueError(e);
    if (unique) return err(unique);
    throw new Error(WRITE_FAILED);
  }
}

export type DeleteApiKeyError =
  | { readonly kind: "blocked"; readonly blockers: readonly Blocker[] }
  | { readonly kind: "not_found" };

// AC-6 (spec 0002 AC-14). Lock, check the blockers again, then soft delete,
// so a testbed assigned meanwhile cannot slip in. The name is free for
// reuse afterwards (unique among live rows only). A GOOGLE key has no
// blockers: from the worker's next run, emails wait (spec 0013 AC-4).
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

// Spec 0012 AC-11: the worker's revoke source, read at the start of each
// reconcile run, so a rotated token takes effect on the next run. The
// keyring is read only when a live CLOUDFLARE key exists. Never throws: any
// error from the read, the keyring, or the decrypt answers `broken`, and
// nothing about it (least of all the token) is logged here.
export async function cloudflareRevokeConfig(
  conn: Kysely<DB>,
  keyring: () => Keyring,
): Promise<RevokeSource> {
  try {
    const row = await conn
      .selectFrom("api_keys")
      .select(["id", "base_url", "secret_ciphertext"])
      .where("type", "=", "CLOUDFLARE")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) return { kind: "off" };
    const apiToken = decryptSecret(
      keyring(),
      row.secret_ciphertext,
      aad(row.id),
    );
    return { kind: "on", config: { baseUrl: row.base_url, apiToken } };
  } catch {
    return { kind: "broken" };
  }
}

export type GoogleMailConfig = {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId: string;
  readonly senderEmail: string;
  readonly calendarId: string;
  readonly devInbox: string | null;
  readonly opsBcc: string | null;
  // The key's updated_at as ISO: any save makes a new token cache entry.
  readonly stamp: string;
};

// Spec 0013 AC-5, AC-9: the worker's Google settings, read at the start of
// each jobs step, or null when no live GOOGLE key exists. The keyring is
// read only when one does. A key that cannot be read throws one fixed
// message, never the key or its decrypt error.
export async function googleMailConfig(
  conn: Kysely<DB>,
  keyring: () => Keyring,
): Promise<GoogleMailConfig | null> {
  const row = await conn
    .selectFrom("api_keys")
    .select([
      "id",
      "secret_ciphertext",
      "sender_email",
      "calendar_id",
      "dev_inbox",
      "ops_bcc",
      "updated_at",
    ])
    .where("type", "=", "GOOGLE")
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  try {
    const secret = GoogleSecret.parse(
      JSON.parse(decryptSecret(keyring(), row.secret_ciphertext, aad(row.id))),
    );
    // api_keys_google_fields_check makes these non null for GOOGLE.
    if (row.sender_email === null || row.calendar_id === null)
      throw new Error("google fields missing");
    return {
      ...secret,
      senderEmail: row.sender_email,
      calendarId: row.calendar_id,
      devInbox: row.dev_inbox,
      opsBcc: row.ops_bcc,
      stamp: row.updated_at.toISOString(),
    };
  } catch {
    throw new Error("the GOOGLE API key can't be read");
  }
}

// Spec 0013 AC-21: whether a live GOOGLE key exists. Never decrypts.
export async function googleConfigured(conn: Kysely<DB>): Promise<boolean> {
  const row = await conn
    .selectFrom("api_keys")
    .select("id")
    .where("type", "=", "GOOGLE")
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row !== undefined;
}
