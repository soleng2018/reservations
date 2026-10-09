import { z } from "zod";
import { DurationUnit, TestbedClientKind } from "./db-enums";

// Admin catalog form input (spec 0004 AC-1, AC-2). Parsed on the server.

const INT_MAX = 2_147_483_647; // the column is a Postgres integer

export const CatalogName = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(200, "Use at most 200 characters.");

const HttpsUrl = z
  .string()
  .trim()
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
