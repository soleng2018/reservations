import type { z } from "zod";

// Field errors keyed by the dotted input path (`name`, `clients.0.url`),
// the first message per field. Safe on both sides.
export type FieldErrors = Readonly<Record<string, string>>;

export function fieldErrors(error: z.ZodError): FieldErrors {
  return error.issues.reduce<Record<string, string>>((acc, issue) => {
    const key = issue.path.map(String).join(".");
    return key in acc ? acc : { ...acc, [key]: issue.message };
  }, {});
}
