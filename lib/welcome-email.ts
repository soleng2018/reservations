import { z } from "zod";
import { formatDateTime } from "./format-time";

// Spec 0014: the set password email's pure parts. Safe on both sides.

// AC-7. As stored, before any "[dev] " routing prefix.
export const WELCOME_SUBJECT = "Set your password for Nile Hands-On Labs";

// AC-4: how long the app's own link lives, from the DB clock at send.
export const LINK_HOURS = 72;

// AC-8: what a welcome email showed. Never the token or the URL.
export const WelcomeEmailDetails = z.object({
  name: z.string(),
  expiresAt: z.iso.datetime({ offset: true }),
  timeZone: z.string(),
});
export type WelcomeEmailDetails = z.infer<typeof WelcomeEmailDetails>;

// AC-4: 32 random bytes, base64url without padding.
export const SetPasswordToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

// AC-4: the link in the email, on the app the welcome was queued from.
export const setPasswordUrl = (appUrl: string, token: string) =>
  `${appUrl}/set-password/${token}`;

// AC-7: "This link works once and expires <expiry>."
export const welcomeExpiry = (details: WelcomeEmailDetails) =>
  formatDateTime(new Date(details.expiresAt), details.timeZone);
