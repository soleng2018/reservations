import { z } from "zod";
import { Timezone } from "./timezones";

// The admin's Add User and Edit User form (spec 0008 AC-4, AC-6). Parsed on
// the server. The email is only trimmed; comparisons use lower().

const required = (message: string) =>
  z.string({ error: message }).trim().min(1, message).max(200, message);

const INVALID_EMAIL = "Enter a valid email address.";
const NO_ZONE = "Choose a timezone from the list.";

export const LearnerInput = z.object({
  name: required("Enter the full name."),
  company: required("Enter the company name."),
  email: z
    .string({ error: INVALID_EMAIL })
    .trim()
    .max(254, INVALID_EMAIL)
    .pipe(z.email(INVALID_EMAIL)),
  timezone: z.string({ error: NO_ZONE }).pipe(Timezone),
});
export type LearnerInput = z.infer<typeof LearnerInput>;
