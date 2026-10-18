import { SetPasswordLinkEndReason, UserRole, UserStatus } from "./db-enums";

// Spec 0014 AC-9: which view a set password link gets. Pure, so the page and
// the action decide the same way (server/auth/set-password-links.ts reads
// the rows, with the DB clock's verdict on expiry).

export type LinkFacts = {
  readonly endedReason: SetPasswordLinkEndReason | null;
  // expires_at > now(), by the DB clock.
  readonly unexpired: boolean;
  // lower(users.email) when it was sent.
  readonly email: string;
};

export type UserFacts = {
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly authentikUserPk: number | null;
  readonly setPasswordPending: boolean;
  readonly email: string;
};

export type LinkView = "live" | "already_set" | "dead";

// AC-9, AC-10: the page's copy.
export const SET_PASSWORD_COPY = {
  liveHeading: "Set your password",
  liveButton: "Set my password",
  liveHelper:
    "You'll choose a password on Nile's sign in page, then come straight back here signed in.",
  alreadySet: "Your password is already set.",
  dead: "This link has expired or was already used.",
  unavailable: "Sign in is unavailable right now. Try again in a minute.",
  limited: "Too many attempts. Try again in an hour.",
} as const;

export function linkView(link: LinkFacts, user: UserFacts): LinkView {
  const sameAddress = link.email === user.email.toLowerCase();
  const activeLearner = user.role === "learner" && user.status === "active";
  if (!sameAddress || !activeLearner) return "dead";
  if (user.setPasswordPending)
    return link.endedReason === null &&
      link.unexpired &&
      user.authentikUserPk !== null
      ? "live"
      : "dead";
  // AC-9 Already set: opened again after the first sign in, expired or not,
  // unless an email change ended it.
  return link.endedReason === "email_changed" ? "dead" : "already_set";
}
