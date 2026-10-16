"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  API_KEY_MESSAGES,
  googleCalendarMessage,
  googleDelegationMessage,
  googleInvalidMessage,
  MAX_KEY_FILE_BYTES,
  signInAgain,
  typeInUseMessage,
} from "@/lib/api-keys";
import {
  parseGoogleKeyFile,
  type GoogleServiceAccountKey,
} from "@/lib/booking-email";
import {
  ApiKeyCreateInput,
  ApiKeyUpdateInput,
  TestbedInput,
  TestbedTypeInput,
} from "@/lib/catalog-input";
import type { Blocker, DeleteRemoveError } from "@/lib/delete-flow";
import { fieldErrors, type FieldErrors } from "@/lib/form-errors";
import {
  googleAuthUrl,
  isOAuthClientFile,
  parseGoogleClientFile,
  parseGoogleReturnUrl,
  type GoogleOAuthClient,
  type GoogleReturn,
  type ReturnUrlError,
} from "@/lib/google-sign-in";
import { ok, err, type Result } from "@/lib/result";
import { TESTBED_MESSAGES, type TestbedEditDefaults } from "@/lib/testbeds";
import { requireAdmin } from "@/server/auth/require";
import { authentik } from "@/server/authentik/client";
import {
  createApiKey,
  deleteApiKey,
  updateApiKey,
  type ApiKeyCreate,
  type ApiKeyCreateError,
  type ApiKeyUpdate,
  type ApiKeyUpdateError,
} from "@/server/catalog/api-keys";
import {
  createTestbed,
  deleteTestbed,
  getTestbedForEdit,
  updateTestbed,
} from "@/server/catalog/testbeds";
import {
  createTestbedType,
  deleteTestbedType,
  updateTestbedType,
} from "@/server/catalog/testbed-types";
import type { Keyring } from "@/server/crypto/secrets";
import { db } from "@/server/db";
import { dbNow } from "@/server/db/bookings";
import {
  apiKeyBlockers,
  testbedBlockers,
  testbedTypeBlockers,
} from "@/server/db/delete-blockers";
import { assertEncryptionEnv } from "@/server/env";
import { newPkce } from "@/server/google/oauth";
import {
  clearSignInCookie,
  readSignInCookie,
  setSignInCookie,
} from "@/server/google/sign-in-cookie";
import {
  verifyGoogleSignIn,
  type GoogleSignIn,
  type VerifySignInError,
} from "@/server/google/verify";

export type AdminFormState =
  | { readonly kind: "idle" }
  | { readonly kind: "saved"; readonly message: string }
  | {
      readonly kind: "error";
      readonly message?: string;
      readonly fields: FieldErrors;
      // Shown under the field errors (spec 0008 AC-5: "View user").
      readonly link?: { readonly href: string; readonly label: string };
      // Spec 0013 AC-28: the Google sign in's code was spent, so the dialog
      // clears the pasted address and starts the sign in over.
      readonly restart?: true;
    };

// Spec 0013 AC-27: what Sign in with Google answers.
export type GoogleSignInStart =
  AdminFormState | { readonly kind: "started"; readonly url: string };

const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : undefined;
};

const texts = (form: FormData, key: string) =>
  form.getAll(key).map((v) => (typeof v === "string" ? v : ""));

const isId = (id: unknown): id is string => z.uuid().safeParse(id).success;

const parseTestbedType = (form: FormData) =>
  TestbedTypeInput.safeParse({
    name: text(form, "name"),
    durationValue: text(form, "durationValue"),
    durationUnit: text(form, "durationUnit"),
  });

const DUPLICATE_TYPE: AdminFormState = {
  kind: "error",
  fields: { name: "A testbed type with this name already exists." },
};
const TYPE_GONE = "This testbed type no longer exists.";

// AC-1. The list on /admin/testbed-types shows the result.
export async function createTestbedTypeAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = parseTestbedType(form);
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };

  const created = await createTestbedType(db(), parsed.data, user.id);
  if (!created.ok) return DUPLICATE_TYPE;
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Created ${parsed.data.name}.` };
}

// Feature 7. The page binds the row's id.
export async function updateTestbedTypeAction(
  id: string,
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = parseTestbedType(form);
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };
  if (!isId(id)) return { kind: "error", message: TYPE_GONE, fields: {} };

  const updated = await updateTestbedType(db(), id, parsed.data, user.id);
  if (!updated.ok) {
    switch (updated.error) {
      case "duplicate_name":
        return DUPLICATE_TYPE;
      case "not_found":
        revalidatePath("/admin", "layout");
        return { kind: "error", message: TYPE_GONE, fields: {} };
      default: {
        const never: never = updated.error;
        return never;
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Updated ${parsed.data.name}.` };
}

// Feature 7, the delete flow's check: the live testbeds using this type.
export async function checkTestbedTypeDelete(
  id: string,
): Promise<Result<readonly Blocker[], "unavailable">> {
  await requireAdmin();
  if (!isId(id)) return ok([]);
  return ok(await testbedTypeBlockers(db(), id));
}

// Feature 7, the delete flow's remove (spec 0002 AC-4, AC-14).
export async function deleteTestbedTypeAction(
  id: string,
): Promise<Result<void, DeleteRemoveError>> {
  const { user } = await requireAdmin();
  if (!isId(id)) return err({ kind: "failed", message: TYPE_GONE });

  const deleted = await deleteTestbedType(db(), id, user.id);
  revalidatePath("/admin", "layout");
  if (deleted.ok) return ok(undefined);
  switch (deleted.error.kind) {
    case "blocked":
      return err(deleted.error);
    case "not_found":
      return err({ kind: "failed", message: TYPE_GONE });
    default: {
      const never: never = deleted.error;
      return never;
    }
  }
}

// Feature 8 (spec 0006). The secret is read from the form, encrypted, and
// never sent back: errors carry fixed messages, and the dialog keeps what
// was typed on the client. A GOOGLE key's files are never echoed either;
// after a failed save the admin picks them again (spec 0013 AC-3, AC-26).
const apiKeyFields = (form: FormData) => ({
  name: text(form, "name"),
  type: text(form, "type"),
  baseUrl: text(form, "baseUrl"),
  secret: text(form, "secret") ?? "",
  googleAuth: text(form, "googleAuth"),
  senderEmail: text(form, "senderEmail"),
  calendarId: text(form, "calendarId"),
  devInbox: text(form, "devInbox"),
  opsBcc: text(form, "opsBcc"),
});

// A JSON file from the form as text, or null when none was chosen (an empty
// file input still posts an empty File, its name varying by browser, so any
// empty file counts as none). The size is checked before reading; the
// contents never reach a message or a log (spec 0013 AC-1, AC-26).
async function readJsonFile(
  form: FormData,
  key: string,
): Promise<Result<string | null, "too_large">> {
  const file = form.get(key);
  if (!(file instanceof File) || file.size === 0) return ok(null);
  if (file.size > MAX_KEY_FILE_BYTES) return err("too_large");
  return ok(await file.text());
}

// Spec 0013 AC-3, AC-26: the service account key file.
async function readKeyFile(
  form: FormData,
): Promise<Result<GoogleServiceAccountKey | null, string>> {
  const file = await readJsonFile(form, "keyFile");
  if (!file.ok) return err(API_KEY_MESSAGES.keyFileTooLarge);
  if (file.value === null) return ok(null);
  const parsed = parseGoogleKeyFile(file.value);
  if (parsed.ok) return parsed;
  return err(
    isOAuthClientFile(file.value)
      ? API_KEY_MESSAGES.keyFileOAuth
      : API_KEY_MESSAGES.keyFileInvalid,
  );
}

// Spec 0013 AC-26: the Desktop app OAuth client file.
async function readClientFile(
  form: FormData,
): Promise<Result<GoogleOAuthClient | null, string>> {
  const file = await readJsonFile(form, "clientFile");
  if (!file.ok) return err(API_KEY_MESSAGES.clientFileTooLarge);
  if (file.value === null) return ok(null);
  const parsed = parseGoogleClientFile(file.value);
  if (parsed.ok) return parsed;
  switch (parsed.error) {
    case "web":
      return err(API_KEY_MESSAGES.clientFileWeb);
    case "service_account":
      return err(API_KEY_MESSAGES.clientFileServiceAccount);
    case "invalid":
      return err(API_KEY_MESSAGES.clientFileInvalid);
    default: {
      const never: never = parsed.error;
      return never;
    }
  }
}

const RETURN_URL_MESSAGES = {
  missing: API_KEY_MESSAGES.signInMissing,
  incomplete: API_KEY_MESSAGES.signInIncomplete,
  cancelled: API_KEY_MESSAGES.signInCancelled,
  failed: API_KEY_MESSAGES.signInFailed,
} as const satisfies Record<ReturnUrlError, string>;

// What a GOOGLE save brings from the form besides its fields, by the chosen
// method, before anything reaches Google: a service account's key file, or a
// Google sign in's client file and pasted address (null on an edit with
// none). A file for the other method is ignored (AC-29).
type GoogleUpload =
  | { readonly method: "none" }
  | {
      readonly method: "service_account";
      readonly keyFile: GoogleServiceAccountKey | null;
    }
  | {
      readonly method: "oauth";
      readonly signIn: {
        readonly client: GoogleOAuthClient;
        readonly returned: GoogleReturn;
      } | null;
    };

// AC-28 steps 2 and 3 (AC-1 on create): every error is a field error, all
// reported with the step 1 ones. On create a key needs its credential; on an
// edit a blank address keeps the stored sign in, and a pasted one needs the
// client file again.
async function readGoogleUpload(
  form: FormData,
  creating: boolean,
): Promise<Result<GoogleUpload, FieldErrors>> {
  if (text(form, "type") !== "GOOGLE") return ok({ method: "none" });
  switch (text(form, "googleAuth")) {
    case "service_account": {
      const keyFile = await readKeyFile(form);
      if (!keyFile.ok) return err({ keyFile: keyFile.error });
      if (creating && keyFile.value === null)
        return err({ keyFile: API_KEY_MESSAGES.keyFileMissing });
      return ok({ method: "service_account", keyFile: keyFile.value });
    }
    case "oauth": {
      const client = await readClientFile(form);
      const returned = parseGoogleReturnUrl(text(form, "returnUrl"));
      const keepsSignIn =
        !creating && !returned.ok && returned.error === "missing";
      const clientError = !client.ok
        ? client.error
        : client.value === null && !keepsSignIn
          ? API_KEY_MESSAGES.clientFileMissing
          : undefined;
      const returnError =
        returned.ok || keepsSignIn
          ? undefined
          : RETURN_URL_MESSAGES[returned.error];
      if (clientError !== undefined || returnError !== undefined)
        return err({
          ...(clientError === undefined ? {} : { clientFile: clientError }),
          ...(returnError === undefined ? {} : { returnUrl: returnError }),
        });
      if (keepsSignIn) return ok({ method: "oauth", signIn: null });
      // Both checked above: a client file and an address are in hand.
      if (!client.ok || client.value === null || !returned.ok)
        throw new Error("google sign in upload without its parts");
      return ok({
        method: "oauth",
        signIn: { client: client.value, returned: returned.value },
      });
    }
    // The method's own Zod error reports it.
    default:
      return ok({ method: "none" });
  }
}

const apiKeyFormError = (
  parsed: { readonly success: boolean; readonly error?: z.ZodError },
  upload: Result<GoogleUpload, FieldErrors>,
): AdminFormState => ({
  kind: "error",
  fields: {
    ...(parsed.error ? fieldErrors(parsed.error) : {}),
    ...(upload.ok ? {} : upload.error),
  },
});

const NOT_CONFIGURED: AdminFormState = {
  kind: "error",
  message: API_KEY_MESSAGES.notConfigured,
  fields: {},
};

const fieldError = (
  field: string,
  message: string,
  restart = false,
): AdminFormState => ({
  kind: "error",
  fields: { [field]: message },
  ...(restart ? { restart: true } : {}),
});

// AC-28 steps 5 to 8 failed. Each one after the exchange spent the code, so
// the dialog starts the sign in over (`restart`).
function signInError(e: VerifySignInError): AdminFormState {
  switch (e.kind) {
    case "refused":
      return fieldError("returnUrl", API_KEY_MESSAGES.signInRefused, true);
    case "client":
      return fieldError("clientFile", API_KEY_MESSAGES.clientInvalid, true);
    case "no_refresh":
      return fieldError("returnUrl", API_KEY_MESSAGES.noRefresh, true);
    case "scopes":
      return fieldError("returnUrl", API_KEY_MESSAGES.scopes, true);
    case "no_email":
      return fieldError("returnUrl", API_KEY_MESSAGES.noEmail, true);
    case "calendar":
      return fieldError(
        "calendarId",
        signInAgain(googleCalendarMessage(e.sender)),
        true,
      );
    case "exchange_unavailable":
      return {
        kind: "error",
        message: API_KEY_MESSAGES.googleUnavailable,
        fields: {},
      };
    case "check_unavailable":
      return {
        kind: "error",
        message: signInAgain(API_KEY_MESSAGES.googleUnavailable),
        fields: {},
        restart: true,
      };
    default: {
      const never: never = e;
      return never;
    }
  }
}

// AC-28 steps 4 to 8, after the form's own checks passed: the cookie that
// started this sign in, then the code exchange and its checks. The cookie
// is kept when step 4 fails, so a typo can be fixed and saved again, and
// when Google couldn't be reached at the exchange (it may never have seen
// the code, so the same save can be retried). It is deleted once Google
// answered the exchange (a code works once).
async function finishSignIn(
  userId: string,
  keyring: Keyring,
  calendarId: string,
  signIn: {
    readonly client: GoogleOAuthClient;
    readonly returned: GoogleReturn;
  },
): Promise<Result<GoogleSignIn, AdminFormState>> {
  const cookie = await readSignInCookie({
    keyring,
    userId,
    now: await dbNow(db()),
    state: signIn.returned.state,
    clientId: signIn.client.clientId,
  });
  if (!cookie.ok)
    return err(fieldError("returnUrl", API_KEY_MESSAGES.signInExpired));
  const verified = await verifyGoogleSignIn({
    code: signIn.returned.code,
    codeVerifier: cookie.value.codeVerifier,
    clientId: signIn.client.clientId,
    clientSecret: signIn.client.clientSecret,
    calendarId,
  });
  if (verified.ok || verified.error.kind !== "exchange_unavailable")
    await clearSignInCookie();
  return verified.ok ? verified : err(signInError(verified.error));
}

// A save's GOOGLE credential, ready for the catalog: the key file as read,
// or a finished sign in (null keeps the stored one on an edit).
type GoogleCredential =
  | { readonly method: "none" }
  | {
      readonly method: "service_account";
      readonly keyFile: GoogleServiceAccountKey | null;
    }
  | { readonly method: "oauth"; readonly signIn: GoogleSignIn | null };

async function googleCredential(
  upload: GoogleUpload,
  userId: string,
  keyring: Keyring,
  calendarId: string,
): Promise<Result<GoogleCredential, AdminFormState>> {
  if (upload.method !== "oauth" || upload.signIn === null)
    return ok(
      upload.method === "oauth" ? { method: "oauth", signIn: null } : upload,
    );
  const finished = await finishSignIn(
    userId,
    keyring,
    calendarId,
    upload.signIn,
  );
  return finished.ok
    ? ok({ method: "oauth", signIn: finished.value })
    : finished;
}

// Undefined when the form's method and the parsed fields disagree, which
// the readers above rule out.
function toCreate(
  data: ApiKeyCreateInput,
  credential: GoogleCredential,
): ApiKeyCreate | undefined {
  if (data.type !== "GOOGLE") return data;
  if (data.googleAuth === "service_account")
    return credential.method === "service_account" && credential.keyFile
      ? { ...data, keyFile: credential.keyFile }
      : undefined;
  return credential.method === "oauth" && credential.signIn
    ? { ...data, signIn: credential.signIn }
    : undefined;
}

function toUpdate(
  data: ApiKeyUpdateInput,
  credential: GoogleCredential,
): ApiKeyUpdate | undefined {
  if (data.type !== "GOOGLE") return data;
  if (data.googleAuth === "service_account")
    return credential.method === "service_account"
      ? { ...data, keyFile: credential.keyFile }
      : undefined;
  return credential.method === "oauth"
    ? { ...data, signIn: credential.signIn }
    : undefined;
}

// Who an uploaded GOOGLE key acts as, for the save check's messages.
type GoogleContext = { readonly sender: string; readonly clientId: string };

const googleContext = (input: ApiKeyCreate | ApiKeyUpdate): GoogleContext =>
  input.type === "GOOGLE" &&
  input.googleAuth === "service_account" &&
  input.keyFile
    ? { sender: input.senderEmail, clientId: input.keyFile.client_id }
    : { sender: "", clientId: "" };

// A sign in's code is spent once the save gets this far, so any refusal
// from here on starts it over (AC-28).
const spent = (input: ApiKeyCreate | ApiKeyUpdate) =>
  input.type === "GOOGLE" &&
  input.googleAuth === "oauth" &&
  input.signIn !== null;

const withRestart = (
  state: AdminFormState,
  restart: boolean,
): AdminFormState =>
  restart && state.kind === "error" ? { ...state, restart: true } : state;

// The save errors create and update share (spec 0006 AC-3, AC-12, spec 0013
// AC-1, AC-2).
const apiKeyError = (
  e: ApiKeyCreateError,
  google: GoogleContext,
): AdminFormState => {
  switch (e) {
    case "duplicate_name":
      return fieldError("name", API_KEY_MESSAGES.duplicateName);
    case "cloudflare_exists":
      return fieldError("type", API_KEY_MESSAGES.cloudflareExists);
    case "cloudflare_invalid":
      return fieldError("secret", API_KEY_MESSAGES.cloudflareInvalid);
    case "cloudflare_unavailable":
      return {
        kind: "error",
        message: API_KEY_MESSAGES.cloudflareUnavailable,
        fields: {},
      };
    case "google_exists":
      return fieldError("type", API_KEY_MESSAGES.googleExists);
    case "google_delegation":
      return fieldError(
        "keyFile",
        googleDelegationMessage(google.sender, google.clientId),
      );
    case "google_invalid":
      return fieldError("keyFile", googleInvalidMessage(google.sender));
    case "google_calendar":
      return fieldError("calendarId", googleCalendarMessage(google.sender));
    case "google_unavailable":
      return {
        kind: "error",
        message: API_KEY_MESSAGES.googleUnavailable,
        fields: {},
      };
    default: {
      const never: never = e;
      return never;
    }
  }
};

// Spec 0013 AC-27 (amended 2026-10-16): Sign in with Google, called from the
// button (not the form's submit). It reads only the client file, keeps the
// sign in in progress in an encrypted cookie for this admin, and answers
// the Google address to open. Starting again replaces the cookie.
export async function startGoogleSignInAction(
  form: FormData,
): Promise<GoogleSignInStart> {
  const { user } = await requireAdmin();
  const encryption = assertEncryptionEnv();
  if (!encryption.ok) return NOT_CONFIGURED;
  const client = await readClientFile(form);
  if (!client.ok) return fieldError("clientFile", client.error);
  if (client.value === null)
    return fieldError("clientFile", API_KEY_MESSAGES.clientFileMissing);

  const { state, codeVerifier, codeChallenge } = newPkce();
  await setSignInCookie(encryption.value.keyring, user.id, {
    state,
    codeVerifier,
    clientId: client.value.clientId,
    issuedAt: await dbNow(db()),
  });
  return {
    kind: "started",
    url: googleAuthUrl({
      clientId: client.value.clientId,
      state,
      codeChallenge,
    }),
  };
}

// AC-2, AC-3, AC-9, AC-12 (spec 0013 AC-1 to AC-3, AC-25 to AC-28).
export async function createApiKeyAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const encryption = assertEncryptionEnv();
  if (!encryption.ok) return NOT_CONFIGURED;
  const { keyring } = encryption.value;
  const parsed = ApiKeyCreateInput.safeParse(apiKeyFields(form));
  const upload = await readGoogleUpload(form, true);
  if (!parsed.success || !upload.ok) return apiKeyFormError(parsed, upload);

  const credential = await googleCredential(
    upload.value,
    user.id,
    keyring,
    parsed.data.type === "GOOGLE" ? parsed.data.calendarId : "",
  );
  if (!credential.ok) return credential.error;
  const input = toCreate(parsed.data, credential.value);
  if (!input) throw new Error("api key create without its credential");

  const created = await createApiKey(db(), keyring, input, user.id);
  if (!created.ok)
    return withRestart(
      apiKeyError(created.error, googleContext(input)),
      spent(input),
    );
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Created ${input.name}.` };
}

// AC-4, AC-5, AC-9, AC-12 (spec 0013 AC-4, AC-29). The page binds the row's
// id; a blank key, no key file, or no pasted sign in keeps the stored one.
export async function updateApiKeyAction(
  id: string,
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const encryption = assertEncryptionEnv();
  if (!encryption.ok) return NOT_CONFIGURED;
  const { keyring } = encryption.value;
  const parsed = ApiKeyUpdateInput.safeParse(apiKeyFields(form));
  const upload = await readGoogleUpload(form, false);
  if (!parsed.success || !upload.ok) return apiKeyFormError(parsed, upload);
  if (!isId(id))
    return { kind: "error", message: API_KEY_MESSAGES.gone, fields: {} };

  const credential = await googleCredential(
    upload.value,
    user.id,
    keyring,
    parsed.data.type === "GOOGLE" ? parsed.data.calendarId : "",
  );
  if (!credential.ok) return credential.error;
  const input = toUpdate(parsed.data, credential.value);
  if (!input) throw new Error("api key update without its credential");

  const updated = await updateApiKey(db(), keyring, id, input, user.id);
  if (!updated.ok)
    return withRestart(updateError(updated.error, input), spent(input));
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Updated ${input.name}.` };
}

function updateError(
  e: ApiKeyUpdateError,
  input: ApiKeyUpdate,
): AdminFormState {
  if (typeof e === "object") {
    switch (e.kind) {
      case "type_in_use":
        return fieldError("type", typeInUseMessage(e.names));
      default: {
        const never: never = e.kind;
        return never;
      }
    }
  }
  switch (e) {
    case "duplicate_name":
    case "cloudflare_exists":
    case "cloudflare_invalid":
    case "cloudflare_unavailable":
    case "google_exists":
    case "google_invalid":
    case "google_delegation":
    case "google_calendar":
    case "google_unavailable":
      return apiKeyError(e, googleContext(input));
    case "cloudflare_retype":
      return fieldError("secret", API_KEY_MESSAGES.cloudflareRetype);
    case "google_file_required":
      return fieldError("keyFile", API_KEY_MESSAGES.googleFileRequired);
    case "google_file_switch":
      return fieldError("keyFile", API_KEY_MESSAGES.fileSwitch);
    case "google_sign_in_required":
      return fieldError("returnUrl", API_KEY_MESSAGES.signInRequired);
    case "google_sign_in_switch":
      return fieldError("returnUrl", API_KEY_MESSAGES.signInSwitch);
    case "key_required":
      return fieldError("secret", API_KEY_MESSAGES.keyRequired);
    case "not_found":
      revalidatePath("/admin", "layout");
      return { kind: "error", message: API_KEY_MESSAGES.gone, fields: {} };
    default: {
      const never: never = e;
      return never;
    }
  }
}

// AC-6, the delete flow's check: the live testbeds using this key as their
// IDP.
export async function checkApiKeyDelete(
  id: string,
): Promise<Result<readonly Blocker[], "unavailable">> {
  await requireAdmin();
  if (!isId(id)) return ok([]);
  return ok(await apiKeyBlockers(db(), id));
}

// AC-6, the delete flow's remove (spec 0002 AC-14).
export async function deleteApiKeyAction(
  id: string,
): Promise<Result<void, DeleteRemoveError>> {
  const { user } = await requireAdmin();
  const gone = { kind: "failed", message: API_KEY_MESSAGES.gone } as const;
  if (!isId(id)) return err(gone);

  const deleted = await deleteApiKey(db(), id, user.id);
  revalidatePath("/admin", "layout");
  if (deleted.ok) return ok(undefined);
  switch (deleted.error.kind) {
    case "blocked":
      return err(deleted.error);
    case "not_found":
      return err(gone);
    default: {
      const never: never = deleted.error;
      return never;
    }
  }
}

// Feature 9 (spec 0007). Clients arrive as parallel lists in form order; an
// OS login is never echoed back (errors carry fixed messages, and the dialog
// keeps what was typed on the client).
const parseTestbed = (form: FormData) => {
  const kinds = texts(form, "clientKind");
  const names = texts(form, "clientName");
  const urls = texts(form, "clientUrl");
  const osUsernames = texts(form, "clientOsUsername");
  const osPasswords = texts(form, "clientOsPassword");
  return TestbedInput.safeParse({
    name: text(form, "name"),
    testbedTypeId: text(form, "testbedTypeId"),
    idpApiKeyId: text(form, "idpApiKeyId"),
    portalUrl: text(form, "portalUrl"),
    lmsUrl: text(form, "lmsUrl"),
    clients: kinds.map((kind, i) => ({
      kind,
      name: names[i],
      url: urls[i],
      osUsername: osUsernames[i],
      osPassword: osPasswords[i],
    })),
  });
};

const testbedError = {
  duplicateName: {
    kind: "error",
    fields: { name: TESTBED_MESSAGES.duplicateName },
  },
  typeGone: {
    kind: "error",
    fields: { testbedTypeId: TESTBED_MESSAGES.typeGone },
  },
  idpGone: {
    kind: "error",
    fields: { idpApiKeyId: TESTBED_MESSAGES.idpGone },
  },
  gone: { kind: "error", message: TESTBED_MESSAGES.gone, fields: {} },
} as const satisfies Record<string, AdminFormState>;

// Spec 0004 AC-2, spec 0007 AC-2.
export async function createTestbedAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = parseTestbed(form);
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };

  const created = await createTestbed(authentik(), db(), parsed.data, user.id);
  if (!created.ok) {
    switch (created.error) {
      case "duplicate_name":
        return testbedError.duplicateName;
      case "type_not_found":
        return testbedError.typeGone;
      case "idp_not_found":
        return testbedError.idpGone;
      case "group_failed":
        return {
          kind: "error",
          message: TESTBED_MESSAGES.groupFailed,
          fields: {},
        };
      default: {
        const never: never = created.error;
        return never;
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Created ${parsed.data.name}.` };
}

// AC-3, the edit dialog's load on open: the one payload with OS logins.
export async function loadTestbedForEdit(
  id: string,
): Promise<Result<TestbedEditDefaults, "not_found">> {
  await requireAdmin();
  if (!isId(id)) return err("not_found");
  return getTestbedForEdit(db(), id);
}

// AC-3, AC-4, AC-5. The page binds the row's id.
export async function updateTestbedAction(
  id: string,
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const { user } = await requireAdmin();
  const parsed = parseTestbed(form);
  if (!parsed.success)
    return { kind: "error", fields: fieldErrors(parsed.error) };
  if (!isId(id)) return testbedError.gone;

  const updated = await updateTestbed(db(), id, parsed.data, user.id);
  if (!updated.ok) {
    switch (updated.error) {
      case "duplicate_name":
        return testbedError.duplicateName;
      case "type_not_found":
        return testbedError.typeGone;
      case "idp_not_found":
        return testbedError.idpGone;
      case "not_ready":
        return {
          kind: "error",
          message: TESTBED_MESSAGES.notReady,
          fields: {},
        };
      case "not_found":
        revalidatePath("/admin", "layout");
        return testbedError.gone;
      default: {
        const never: never = updated.error;
        return never;
      }
    }
  }
  revalidatePath("/admin", "layout");
  return { kind: "saved", message: `Updated ${parsed.data.name}.` };
}

// AC-6, the delete flow's check: the testbed's Upcoming, Current, and
// Pending reservations, phased by the DB clock in the same transaction.
export async function checkTestbedDelete(
  id: string,
): Promise<Result<readonly Blocker[], "unavailable">> {
  await requireAdmin();
  if (!isId(id)) return ok([]);
  const blockers = await db()
    .transaction()
    .execute((trx) => testbedBlockers(trx, id));
  revalidatePath("/admin", "layout");
  return ok(blockers);
}

// AC-6, the delete flow's remove (spec 0002 AC-14).
export async function deleteTestbedAction(
  id: string,
): Promise<Result<void, DeleteRemoveError>> {
  const { user } = await requireAdmin();
  const gone = { kind: "failed", message: TESTBED_MESSAGES.gone } as const;
  if (!isId(id)) return err(gone);

  const deleted = await deleteTestbed(db(), id, user.id);
  revalidatePath("/admin", "layout");
  if (deleted.ok) return ok(undefined);
  switch (deleted.error.kind) {
    case "blocked":
      return err(deleted.error);
    case "not_found":
      return err(gone);
    default: {
      const never: never = deleted.error;
      return never;
    }
  }
}
