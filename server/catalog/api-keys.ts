import "server-only";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { GoogleServiceAccountKey } from "@/lib/booking-email";
import {
  GOOGLE_BASE_URL,
  type GoogleServiceAccountFields,
  type GoogleSignInFields,
  type StandardKeyCreate,
  type StandardKeyUpdate,
} from "@/lib/catalog-input";
import { changedFields } from "@/lib/changed-fields";
import { ApiKeyType, GoogleAuthMethod } from "@/lib/db-enums";
import type { Blocker } from "@/lib/delete-flow";
import { sameMailbox } from "@/lib/email-routing";
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
import type {
  MailCredentials,
  OAuthCredentials,
  ServiceAccountCredentials,
} from "@/server/google/token";
import {
  verifyGoogleKey,
  type GoogleSignIn,
  type VerifyGoogleError,
  type VerifyGoogleInput,
} from "@/server/google/verify";

// Feature 8 (spec 0006). A secret is written here and nowhere else: it is
// encrypted before the insert, and never returned to a browser, logged, or
// audited. This is the only app file that names its column, and the only
// place one is decrypted, for the worker only: the CLOUDFLARE token (spec
// 0012 AC-11) and the GOOGLE credential (spec 0013 AC-5, AC-30).

export type ApiKeyRow = {
  readonly id: string;
  readonly name: string;
  readonly type: ApiKeyType;
  readonly baseUrl: string;
  readonly secretUpdatedAt: Date;
  // GOOGLE only (spec 0013 AC-1, AC-25); null for every other type.
  readonly senderEmail: string | null;
  readonly calendarId: string | null;
  readonly devInbox: string | null;
  readonly opsBcc: string | null;
  readonly googleAuth: GoogleAuthMethod | null;
  // When the worker's breaker found Google no longer accepts the key
  // (AC-31, AC-32); null while it works.
  readonly googleRejectedAt: Date | null;
};

// Spec 0013 AC-1, AC-4, AC-28, AC-29: a GOOGLE save carries, by method, the
// parsed key file or a finished Google sign in (the action ran AC-28 steps 3
// to 8), or null on an edit that keeps the stored credential.
export type GoogleKeyCreate =
  | (GoogleServiceAccountFields & { readonly keyFile: GoogleServiceAccountKey })
  | (GoogleSignInFields & { readonly signIn: GoogleSignIn });
export type GoogleKeyUpdate =
  | (GoogleServiceAccountFields & {
      readonly keyFile: GoogleServiceAccountKey | null;
    })
  | (GoogleSignInFields & { readonly signIn: GoogleSignIn | null });
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
  readonly googleAuth: GoogleAuthMethod | null;
};

// The sender by method: typed for a service account, the signed in account
// for Google sign in. An edit with no new sign in posts no sender, so the
// stored one is carried over (spec 0013 AC-29).
const googleSender = (
  input: GoogleKeyCreate | GoogleKeyUpdate,
  storedSender: string | null,
): string | null => {
  switch (input.googleAuth) {
    case "service_account":
      return input.senderEmail;
    case "oauth":
      return input.signIn ? input.signIn.senderEmail : storedSender;
    default: {
      const never: never = input;
      return never;
    }
  }
};

const storedFields = (
  input: ApiKeyCreate | ApiKeyUpdate,
  storedSender: string | null = null,
): Stored =>
  input.type === "GOOGLE"
    ? {
        name: input.name,
        type: input.type,
        baseUrl: GOOGLE_BASE_URL,
        senderEmail: googleSender(input, storedSender),
        calendarId: input.calendarId,
        devInbox: input.devInbox,
        opsBcc: input.opsBcc,
        googleAuth: input.googleAuth,
      }
    : {
        name: input.name,
        type: input.type,
        baseUrl: input.baseUrl,
        senderEmail: null,
        calendarId: null,
        devInbox: null,
        opsBcc: null,
        googleAuth: null,
      };

// Spec 0013 AC-35: an inbox in the sender's own mailbox would put a learner's
// invite in the organizer's calendar, so a save refuses it. Ops BCC is
// checked first, one error at a time. A null sender or inbox never clashes,
// and a non GOOGLE row has neither.
export type MailboxClashError =
  "google_ops_bcc_sender" | "google_dev_inbox_sender";

export const mailboxClash = (fields: Stored): MailboxClashError | null => {
  const sender = fields.senderEmail;
  if (sender === null) return null;
  if (fields.opsBcc !== null && sameMailbox(fields.opsBcc, sender))
    return "google_ops_bcc_sender";
  if (fields.devInbox !== null && sameMailbox(fields.devInbox, sender))
    return "google_dev_inbox_sender";
  return null;
};

// Spec 0013 AC-3: only these three fields of a service account key file are
// stored. AC-28: a Google sign in stores its client and refresh token. The
// stored JSON carries no method; the google_auth column names the schema.
const GoogleSecret = z.object({
  clientEmail: z.string(),
  privateKey: z.string(),
  privateKeyId: z.string(),
});
const GoogleOAuthSecret = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  refreshToken: z.string(),
});

// The plain text to encrypt, or undefined to keep the stored secret.
const newSecret = (input: ApiKeyCreate | ApiKeyUpdate): string | undefined => {
  if (input.type !== "GOOGLE")
    return input.secret === "" ? undefined : input.secret;
  switch (input.googleAuth) {
    case "service_account":
      return input.keyFile
        ? JSON.stringify({
            clientEmail: input.keyFile.client_email,
            privateKey: input.keyFile.private_key,
            privateKeyId: input.keyFile.private_key_id,
          } satisfies z.infer<typeof GoogleSecret>)
        : undefined;
    case "oauth":
      return input.signIn
        ? JSON.stringify({
            clientId: input.signIn.clientId,
            clientSecret: input.signIn.clientSecret,
            refreshToken: input.signIn.refreshToken,
          } satisfies z.infer<typeof GoogleOAuthSecret>)
        : undefined;
    default: {
      const never: never = input;
      return never;
    }
  }
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
// credential was given: a typed CLOUDFLARE token, or a GOOGLE key file. A
// Google sign in arrives already checked (the action ran AC-28), so it is
// skipped here. The result is not audited.
async function checkCredential(
  deps: ApiKeyDeps,
  input: ApiKeyCreate | ApiKeyUpdate,
): Promise<Result<void, CloudflareCheckError | GoogleCheckError>> {
  if (input.type === "GOOGLE") {
    if (input.googleAuth === "oauth" || !input.keyFile) return ok(undefined);
    const checked = await deps.verifyGoogle({
      credentials: {
        method: "service_account",
        clientEmail: input.keyFile.client_email,
        privateKey: input.keyFile.private_key,
        privateKeyId: input.keyFile.private_key_id,
      },
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
      "google_auth",
      "google_rejected_at",
    ])
    .where("deleted_at", "is", null)
    .orderBy(sql`lower(name)`);

const googleAuthOf = (v: string | null): GoogleAuthMethod | null =>
  v === null ? null : GoogleAuthMethod.parse(v);

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
    googleAuth: googleAuthOf(r.google_auth),
    googleRejectedAt: r.google_rejected_at,
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
        googleAuth: s.googleAuth,
        senderEmail: s.senderEmail,
        calendarId: s.calendarId,
        devInbox: s.devInbox,
        opsBcc: s.opsBcc,
      }
    : {};

export type ApiKeyCreateError =
  UniqueError | CloudflareCheckError | GoogleCheckError | MailboxClashError;

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
  const fields = storedFields(input);
  // Before the Google call, so a clash costs none (spec 0013 AC-35).
  const clash = mailboxClash(fields);
  if (clash) return err(clash);
  const checked = await checkCredential(deps, input);
  if (!checked.ok) return checked;
  const secret = newSecret(input);
  // Both schemas require a secret on create; this is a broken invariant.
  if (secret === undefined) throw new Error("api key create without a secret");
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
          google_auth: fields.googleAuth,
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
  | MailboxClashError
  | "not_found"
  // Spec 0006 AC-12: the web process never decrypts a stored token, so a
  // change that moves a token to another type or account needs it typed.
  | "cloudflare_retype"
  // Spec 0013 AC-4, AC-29: a sender, calendar, or type change to a GOOGLE
  // service account needs the key file again, and so does a switch to it; a
  // calendar change on Google sign in, or a switch to it, needs a new sign
  // in. A type change away from GOOGLE needs the new key typed.
  | GoogleCredentialNeeded
  | "key_required"
  | { readonly kind: "type_in_use"; readonly names: readonly string[] };

type GoogleCredentialNeeded =
  | "google_file_required"
  | "google_file_switch"
  | "google_sign_in_required"
  | "google_sign_in_switch";

// A type change to or from CLOUDFLARE, or a CLOUDFLARE key moving account.
const needsCloudflareToken = (before: Stored, after: Stored): boolean =>
  (before.type === "CLOUDFLARE") !== (after.type === "CLOUDFLARE") ||
  (before.type === "CLOUDFLARE" && before.baseUrl !== after.baseUrl);

// Spec 0013 AC-29: what a GOOGLE save with no new credential is missing, by
// method, or undefined when the stored one still fits.
const needsGoogleCredential = (
  before: Stored,
  after: Stored,
): GoogleCredentialNeeded | undefined => {
  // api_keys_google_fields_check: a GOOGLE key always has a method.
  if (after.type !== "GOOGLE" || after.googleAuth === null) return undefined;
  const wasGoogle = before.type === "GOOGLE";
  switch (after.googleAuth) {
    case "service_account":
      if (!wasGoogle) return "google_file_required";
      if (before.googleAuth !== "service_account") return "google_file_switch";
      return before.senderEmail !== after.senderEmail ||
        before.calendarId !== after.calendarId
        ? "google_file_required"
        : undefined;
    case "oauth":
      if (!wasGoogle || before.googleAuth !== "oauth")
        return "google_sign_in_switch";
      return before.calendarId !== after.calendarId
        ? "google_sign_in_required"
        : undefined;
    default: {
      const never: never = after.googleAuth;
      return never;
    }
  }
};

// google_rejected_at is not audited (AC-29).
const AUDITED_FIELDS = [
  "name",
  "type",
  "baseUrl",
  "googleAuth",
  "senderEmail",
  "calendarId",
  "devInbox",
  "opsBcc",
] as const;

const COLUMN = {
  name: "name",
  type: "type",
  baseUrl: "base_url",
  googleAuth: "google_auth",
  senderEmail: "sender_email",
  calendarId: "calendar_id",
  devInbox: "dev_inbox",
  opsBcc: "ops_bcc",
} as const satisfies Record<(typeof AUDITED_FIELDS)[number], string>;

// AC-4, AC-5, AC-12 (spec 0013 AC-4, AC-29). The row lock serializes
// concurrent saves (the last one wins) and holds the key while the type
// change checks run. A blank secret (or no key file or sign in) keeps the
// stored one; a new one is stored fresh (new IV), bumps secret_updated_at,
// and clears google_rejected_at (AC-31). A save that changes nothing writes
// nothing. A new CLOUDFLARE token or GOOGLE key file is checked first,
// outside the transaction. A switch of sign in method replaces the secret,
// google_auth, and sender_email in one update. A duplicate name or a second
// CLOUDFLARE or GOOGLE key aborts the transaction, so it is mapped outside.
export async function updateApiKey(
  conn: Kysely<DB>,
  keyring: Keyring,
  id: string,
  input: ApiKeyUpdate,
  actorId: string,
  deps: ApiKeyDeps = LIVE_DEPS,
): Promise<Result<void, ApiKeyUpdateError>> {
  // Spec 0013 AC-35, before the Google call. With no new sign in the sender
  // is not known yet (null), so the check in the transaction covers it.
  const clash = mailboxClash(storedFields(input));
  if (clash) return err(clash);
  const checked = await checkCredential(deps, input);
  if (!checked.ok) return checked;
  const secret = newSecret(input);
  const ciphertext =
    secret === undefined ? undefined : encryptSecret(keyring, secret, aad(id));
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
          "google_auth",
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
        googleAuth: googleAuthOf(row.google_auth),
      };
      const after = storedFields(input, before.senderEmail);
      const changed = changedFields(AUDITED_FIELDS, before, after);
      const fieldsChanged = Object.keys(changed).length > 0;
      if (!fieldsChanged && ciphertext === undefined) return ok(undefined);

      if (ciphertext === undefined) {
        const needed = needsGoogleCredential(before, after);
        if (needed) return err(needed);
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

      // AC-35 again, with the sender carried over from the locked row: a
      // clashing row saved before AC-35 is refused once anything is saved.
      const storedClash = mailboxClash(after);
      if (storedClash) return err(storedClash);

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
          // A new secret earns a fresh start, and only a GOOGLE key may hold
          // the marker (api_keys_google_fields_check).
          ...(ciphertext !== undefined || after.type !== "GOOGLE"
            ? { google_rejected_at: null }
            : {}),
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

export type GoogleMailConfig = MailCredentials & {
  readonly id: string;
  readonly calendarId: string;
  readonly devInbox: string | null;
  readonly opsBcc: string | null;
  // The guard for the worker's own marker writes (AC-31); `stamp` is the
  // same instant as ISO.
  readonly secretUpdatedAt: Date;
};

// AC-30: the decrypted secret, parsed with the schema its column names,
// never by guessing from its shape.
const googleCredentials = (
  method: GoogleAuthMethod,
  plaintext: string,
): ServiceAccountCredentials | OAuthCredentials => {
  const json: unknown = JSON.parse(plaintext);
  switch (method) {
    case "service_account":
      return { method, ...GoogleSecret.parse(json) };
    case "oauth":
      return { method, ...GoogleOAuthSecret.parse(json) };
    default: {
      const never: never = method;
      return never;
    }
  }
};

// Spec 0013 AC-5, AC-9, AC-30: the worker's Google settings, read at the
// start of each jobs step, or null when no live GOOGLE key exists. The
// keyring is read only when one does. A key that cannot be read throws one
// fixed message, never the key or its decrypt error.
export async function googleMailConfig(
  conn: Kysely<DB>,
  keyring: () => Keyring,
): Promise<GoogleMailConfig | null> {
  const row = await conn
    .selectFrom("api_keys")
    .select([
      "id",
      "secret_ciphertext",
      "secret_updated_at",
      "google_auth",
      "sender_email",
      "calendar_id",
      "dev_inbox",
      "ops_bcc",
    ])
    .where("type", "=", "GOOGLE")
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  try {
    // api_keys_google_fields_check makes these non null for GOOGLE.
    if (
      row.sender_email === null ||
      row.calendar_id === null ||
      row.google_auth === null
    )
      throw new Error("google fields missing");
    const credentials = googleCredentials(
      GoogleAuthMethod.parse(row.google_auth),
      decryptSecret(keyring(), row.secret_ciphertext, aad(row.id)),
    );
    return {
      id: row.id,
      credentials,
      senderEmail: row.sender_email,
      calendarId: row.calendar_id,
      devInbox: row.dev_inbox,
      opsBcc: row.ops_bcc,
      secretUpdatedAt: row.secret_updated_at,
      stamp: row.secret_updated_at.toISOString(),
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
