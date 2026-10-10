import { z } from "zod";
import { Timezone } from "./timezones";

// The guest Step 1 form (spec 0004 AC-3, AC-4). Parsed on the server.

const required = (what: string) =>
  z
    .string({ error: `Enter your ${what}.` })
    .trim()
    .min(1, `Enter your ${what}.`)
    .max(200, "Use at most 200 characters.");

export const BookInput = z.object({
  name: required("name"),
  company: required("company"),
  email: z
    .string({ error: "Enter your email." })
    .trim()
    .max(254, "Use at most 254 characters.")
    .pipe(z.email("Enter a valid email address.")),
  timezone: z.string({ error: "Choose a timezone." }).pipe(Timezone),
  testbedTypeId: z.uuid("Choose a lab type."),
  startsAt: z.iso
    .datetime({ error: "Choose a start time." })
    .transform((s) => new Date(s)),
});
export type BookInput = z.infer<typeof BookInput>;

// Every outcome /book can show, as a code the client turns into a message.
export const BOOK_ERRORS = {
  invalid: "Please fix the fields marked below.",
  limited: "Please try again in a little while.",
  slot_taken: "That time was just taken. Please pick another.",
  has_live_booking: "You already have an active booking. Sign in to manage it.",
  booking_pending:
    "Your booking is still being set up. Please try again in a minute.",
  admin_email: "This email can't be used for booking.",
  refused: "We couldn't complete this booking.",
  unavailable: "Sign in is temporarily unavailable, try again shortly",
  gone: "Your booking took too long to finish. Please try again.",
} as const;
export type BookErrorCode = keyof typeof BOOK_ERRORS;
