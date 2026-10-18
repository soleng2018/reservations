import type { EmailKind, EmailStatus } from "./db-enums";

// Spec 0013 AC-21: how the learner page's Emails section names each email.
// Safe on both sides.

export const EMAIL_KIND_LABEL = {
  booked: "Booked",
  rescheduled: "Rescheduled",
  cancelled: "Cancelled",
  welcome: "Welcome",
  reminder: "Reminder",
} as const satisfies Record<EmailKind, string>;

export const EMAIL_STATUS_LABEL = {
  queued: "Queued",
  sent: "Sent",
  failed: "Failed",
  suppressed: "Suppressed",
} as const satisfies Record<EmailStatus, string>;

// The error line under the status: a failed or suppressed email's reason,
// or a queued one's latest problem. A sent email shows none.
export const emailErrorLine = (
  status: EmailStatus,
  lastError: string | null,
): string | null => (status === "sent" ? null : lastError);

export const EMAIL_NOT_SET_UP =
  "Email isn't set up yet. Add a Google key on API Keys.";
