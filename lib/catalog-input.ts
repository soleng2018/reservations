import { z } from "zod";
import { ApiKeyType, DurationUnit, TestbedClientKind } from "./db-enums";

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

export const TestbedClientInput = z.object({
  kind: TestbedClientKind,
  name: CatalogName,
  url: HttpsUrl,
});

export const TestbedInput = z.object({
  name: CatalogName,
  testbedTypeId: z.uuid("Choose a type."),
  portalUrl: HttpsUrl,
  lmsUrl: HttpsUrl,
  clients: z.array(TestbedClientInput),
});
export type TestbedInput = z.infer<typeof TestbedInput>;

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

const ApiKeyBase = z.object({
  name: CatalogName,
  type: z.enum(ApiKeyType.options, "Choose a type."),
  baseUrl: ApiKeyBaseUrl,
});

export const ApiKeyCreateInput = ApiKeyBase.extend({
  secret: ApiKeySecret.min(1, "Enter the key."),
});
export type ApiKeyCreateInput = z.infer<typeof ApiKeyCreateInput>;

// A blank secret keeps the stored one.
export const ApiKeyUpdateInput = ApiKeyBase.extend({ secret: ApiKeySecret });
export type ApiKeyUpdateInput = z.infer<typeof ApiKeyUpdateInput>;
