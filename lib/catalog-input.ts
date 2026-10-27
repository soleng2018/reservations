import { z } from "zod";
import {
  ApiKeyType,
  DurationUnit,
  GoogleAuthMethod,
  TestbedClientKind,
} from "./db-enums";

// Admin catalog form input (spec 0004 AC-1, AC-2). Parsed on the server.

const INT_MAX = 2_147_483_647; // the column is a Postgres integer

export const CatalogName = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(200, "Use at most 200 characters.");

export const HttpsUrl = z
  .string()
  .trim()
  .max(2048, "Use at most 2048 characters.")
  .pipe(z.url({ protocol: /^https$/, error: "Enter an https:// URL." }));

export const TestbedTypeInput = z.object({
  name: CatalogName,
  durationValue: z.coerce
    .number({ error: "Enter a whole number." })
    .int("Enter a whole number.")
    .min(1, "Use at least 1.")
    .max(INT_MAX, "That's too long."),
  durationUnit: DurationUnit,
});
export type TestbedTypeInput = z.infer<typeof TestbedTypeInput>;

export const MAX_TESTBED_CLIENTS = 20;

const emptyToNull = (v: string | undefined) => (v ? v : null);

// Spec 0007 AC-2: a client's OS login, both optional. The username is
// trimmed; the password is kept exactly as typed. Fixed messages only, so a
// password never reaches an issue.
export const TestbedClientInput = z
  .object({
    kind: TestbedClientKind,
    name: CatalogName,
    url: HttpsUrl,
    osUsername: z
      .string()
      .trim()
      .max(200, "Use at most 200 characters.")
      .optional()
      .transform(emptyToNull),
    osPassword: z
      .string()
      .max(200, "Use at most 200 characters.")
      .optional()
      .transform(emptyToNull),
  })
  .refine((c) => c.osPassword === null || c.osUsername !== null, {
    message: "Enter the OS username for this password.",
    path: ["osUsername"],
  });
export type TestbedClientInput = z.infer<typeof TestbedClientInput>;

// Spec 0017 AC-1: two or more dot separated labels (1 to 63 letters, digits,
// or inner hyphens) with a last label of 2 to 63 letters. The length cap sits
// beside it. The same pattern is the check `testbeds_domain_format_check`.
export const DOMAIN_PATTERN =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const DOMAIN_MAX_LENGTH = 253;

const DOMAIN_SHAPE_MESSAGE = "Enter a domain name, like nile.global.";

// Trimmed, then lower cased, so `NileWorkshop-1.COM` is stored as
// `nileworkshop-1.com`. The cap aborts first, so the pattern never runs on
// an oversized value.
export const DomainInput = z
  .string({ error: "Enter the domain." })
  .trim()
  .toLowerCase()
  .min(1, "Enter the domain.")
  .max(DOMAIN_MAX_LENGTH, { error: DOMAIN_SHAPE_MESSAGE, abort: true })
  .regex(DOMAIN_PATTERN, DOMAIN_SHAPE_MESSAGE);

// Spec 0018 AC-2: the exact Authentik group name, same rule as a name with its
// own empty message.
export const GroupName = z
  .string()
  .trim()
  .min(1, "Enter the group name.")
  .max(200, "Use at most 200 characters.");

export const TestbedInput = z.object({
  name: CatalogName,
  groupName: GroupName,
  testbedTypeId: z.uuid("Choose a type."),
  // Empty (the None option) or missing means no IDP.
  idpApiKeyId: z.preprocess(
    (v) => (v === "" || v === undefined ? null : v),
    z.uuid("Choose an IDP.").nullable(),
  ),
  portalUrl: HttpsUrl,
  lmsUrl: HttpsUrl,
  clients: z
    .array(TestbedClientInput)
    .max(MAX_TESTBED_CLIENTS, `Use at most ${MAX_TESTBED_CLIENTS} clients.`),
});
export type TestbedInput = z.infer<typeof TestbedInput>;

// Spec 0017 AC-20: no `domain` key either way. The domain comes from the
// group on the server, so a forged `domain` field is dropped here.
// Spec 0018 AC-4: an edit changes the Name but never reads a posted group
// name, so a forged `groupName` field is dropped here.
export const TestbedUpdateInput = TestbedInput.omit({ groupName: true });
export type TestbedUpdateInput = z.infer<typeof TestbedUpdateInput>;

// Spec 0006 AC-3. The base URL is shown and audited, so no secret may hide
// in it: no user, password, or query string. Zod runs these even when the
// URL check failed, so a URL that does not parse passes here (it already
// has its error).
const ApiKeyBaseUrl = HttpsUrl.refine((u) => {
  const url = URL.parse(u);
  return url === null || (url.username === "" && url.password === "");
}, "Remove credentials from the URL.").refine(
  (u) => (URL.parse(u)?.search ?? "") === "",
  "Remove the query string from the URL.",
);

// Fixed messages only: the secret's value never reaches an issue.
const ApiKeySecret = z
  .string({ error: "Enter the key." })
  .trim()
  .max(4096, "Use at most 4096 characters.");

// Every type but GOOGLE: a base URL and a typed secret.
const StandardKeyType = ApiKeyType.exclude(["GOOGLE"]);

const ApiKeyBase = z.object({
  name: CatalogName,
  type: StandardKeyType,
  baseUrl: ApiKeyBaseUrl,
});

// Spec 0006 AC-12: a CLOUDFLARE key's base URL is exactly the account route
// the revoke path extends (spec 0012 AC-11). No trailing slash.
export const CLOUDFLARE_BASE_URL =
  /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]{32}$/;

// An object rule, since it needs the type. It runs on the trimmed URL, and
// only once the type and the URL have no error of their own, so a bad URL
// shows one message.
const cloudflareBaseUrl = {
  message: "Enter https://api.cloudflare.com/client/v4/accounts/<account id>.",
  path: ["baseUrl"],
  when: (payload: z.core.ParsePayload) =>
    payload.issues.every(
      (i) => i.path?.[0] !== "type" && i.path?.[0] !== "baseUrl",
    ),
};
const isCloudflareBaseUrl = (key: {
  readonly type: ApiKeyType;
  readonly baseUrl: string;
}) => key.type !== "CLOUDFLARE" || CLOUDFLARE_BASE_URL.test(key.baseUrl);

// Spec 0021 AC-1: a CLEANUP key's URL is the hook the worker calls, with no
// fragment either, and its secret signs every call, so it is at least 16
// characters when given (a blank secret on edit keeps the stored one).
export const CLEANUP_SECRET_MIN = 16;
const quiet = (path: string) => (payload: z.core.ParsePayload) =>
  payload.issues.every((i) => i.path?.[0] !== "type" && i.path?.[0] !== path);
const cleanupFragment = {
  message: "Remove the # part from the URL.",
  path: ["baseUrl"],
  when: quiet("baseUrl"),
};
const cleanupSecret = {
  message: `Use at least ${CLEANUP_SECRET_MIN} characters.`,
  path: ["secret"],
  when: quiet("secret"),
};
const isCleanupUrl = (key: {
  readonly type: ApiKeyType;
  readonly baseUrl: string;
}) => key.type !== "CLEANUP" || !key.baseUrl.includes("#");
const isCleanupSecret = (key: {
  readonly type: ApiKeyType;
  readonly secret: string;
}) =>
  key.type !== "CLEANUP" ||
  key.secret === "" ||
  key.secret.length >= CLEANUP_SECRET_MIN;

const StandardKeyCreate = ApiKeyBase.extend({
  secret: ApiKeySecret.min(1, "Enter the key."),
})
  .refine(isCloudflareBaseUrl, cloudflareBaseUrl)
  .refine(isCleanupUrl, cleanupFragment)
  .refine(isCleanupSecret, cleanupSecret);
export type StandardKeyCreate = z.infer<typeof StandardKeyCreate>;

// A blank secret keeps the stored one.
const StandardKeyUpdate = ApiKeyBase.extend({
  secret: ApiKeySecret,
})
  .refine(isCloudflareBaseUrl, cloudflareBaseUrl)
  .refine(isCleanupUrl, cleanupFragment)
  .refine(isCleanupSecret, cleanupSecret);
export type StandardKeyUpdate = z.infer<typeof StandardKeyUpdate>;

// Spec 0013 AC-1: a GOOGLE key's base URL is this constant, stored and never
// shown in the form.
export const GOOGLE_BASE_URL = "https://www.googleapis.com";

const EMAIL_MESSAGE = "Enter an email address.";
const CALENDAR_ID_MESSAGE =
  "Enter the calendar ID from the calendar's settings.";

const EmailAddress = z.string().trim().pipe(z.email(EMAIL_MESSAGE));
// Blank becomes null.
const OptionalEmail = z
  .string()
  .trim()
  .optional()
  .transform(emptyToNull)
  .pipe(z.email(EMAIL_MESSAGE).nullable());

// The files are not here: the action reads them from the FormData and parses
// them with parseGoogleKeyFile (lib/booking-email.ts) and
// parseGoogleClientFile (lib/google-sign-in.ts). The pasted sign in address
// is parsed there too, after these fields (spec 0013 AC-28).
const googleCommon = {
  name: CatalogName,
  type: z.literal("GOOGLE"),
  calendarId: z
    .string()
    .trim()
    .min(1, CALENDAR_ID_MESSAGE)
    .max(255, CALENDAR_ID_MESSAGE)
    .regex(/^[^\s/]+$/, CALENDAR_ID_MESSAGE),
  devInbox: OptionalEmail,
  opsBcc: OptionalEmail,
};

// Spec 0013 AC-1: the service account acts as the typed sender mailbox.
const GoogleServiceAccountFields = z.object({
  ...googleCommon,
  googleAuth: z.literal(GoogleAuthMethod.enum.service_account),
  senderEmail: EmailAddress,
});
export type GoogleServiceAccountFields = z.infer<
  typeof GoogleServiceAccountFields
>;

// Spec 0013 AC-25: no sender field; the sender is the account that signed
// in (AC-28).
const GoogleSignInFields = z.object({
  ...googleCommon,
  googleAuth: z.literal(GoogleAuthMethod.enum.oauth),
});
export type GoogleSignInFields = z.infer<typeof GoogleSignInFields>;

const GoogleKeyFields = z.discriminatedUnion(
  "googleAuth",
  [GoogleServiceAccountFields, GoogleSignInFields],
  "Choose a sign in method.",
);
export type GoogleKeyFields = z.infer<typeof GoogleKeyFields>;

const TYPE_MESSAGE = "Choose a type.";

export const ApiKeyCreateInput = z.discriminatedUnion(
  "type",
  [StandardKeyCreate, GoogleKeyFields],
  TYPE_MESSAGE,
);
export type ApiKeyCreateInput = z.infer<typeof ApiKeyCreateInput>;

export const ApiKeyUpdateInput = z.discriminatedUnion(
  "type",
  [StandardKeyUpdate, GoogleKeyFields],
  TYPE_MESSAGE,
);
export type ApiKeyUpdateInput = z.infer<typeof ApiKeyUpdateInput>;
