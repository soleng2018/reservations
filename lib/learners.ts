import type { CancelSource, UserStatus } from "./db-enums";
import { firstName } from "./manage-reservations";

// Learner admin (spec 0008), safe on both sides.

export const LEARNER_MESSAGES = {
  duplicate: "A user with this email already exists.",
  settingUp: "A user with this email is being set up. Try again in a minute.",
  adminEmail: "This email can't be used for a learner account.",
  authentikConflict:
    "This email matches another Authentik account. Ask the owner to fix it in Authentik.",
  authentikDisabled:
    "This email's Authentik account is disabled. Ask the owner to enable it in Authentik.",
  unavailable: "Authentik is unavailable. Nothing was changed, try again.",
  gone: "This user no longer exists.",
  emailLocked: "This email can't change after the learner signs in.",
  refused: "This account can't be managed here. Check it in Authentik.",
  notEligible: "This learner has already set a password, or is deactivated.",
  bookingPending:
    "A booking for this user is being set up. Try again in a minute.",
  authentikMissing:
    "This learner's Authentik account no longer exists. Ask the owner to restore it.",
  stale: "This reservation already changed. The page has been refreshed.",
  generic: "Something went wrong. Try again.",
} as const;

// What the edit dialog starts from (AC-6), carried by the list and detail
// rows. The email is editable only until the learner first signs in.
export type LearnerEditDefaults = {
  readonly name: string;
  readonly company: string;
  readonly email: string;
  readonly timezone: string;
  readonly emailEditable: boolean;
};

// AC-6: a list or detail row's values, as the edit dialog's defaults.
export const editDefaults = (row: {
  readonly name: string;
  readonly company: string | null;
  readonly email: string;
  readonly timezone: string;
  readonly emailEditable: boolean;
}): LearnerEditDefaults => ({
  name: row.name,
  company: row.company ?? "",
  email: row.email,
  timezone: row.timezone,
  emailEditable: row.emailEditable,
});

export const reservationCountLabel = (n: number) =>
  `${n} reservation${n === 1 ? "" : "s"}`;

export const learnerStatusLabel = (status: UserStatus) =>
  status === "active" ? "Active" : "Deactivated";

// AC-1: what the list's search matches. No company adds nothing.
export const learnerSearchText = (row: {
  readonly name: string;
  readonly company: string | null;
  readonly email: string;
}) => [row.name, row.company, row.email].filter((v) => v !== null).join(" ");

// AC-2: the line under a Cancelled badge.
export const cancelledByLabel = (source: CancelSource) => `by ${source}`;

// AC-6: the helper under a locked email field.
export const emailLockedHelper = (name: string) =>
  `${firstName(name)} has signed in, so their email can't change here.`;

// AC-8: the toast after a deactivation.
export const deactivatedToast = (name: string, cancelled: number) =>
  cancelled === 0
    ? `Deactivated ${name}.`
    : `Deactivated ${name} and cancelled ${reservationCountLabel(cancelled)}.`;
