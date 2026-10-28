import type { PortalResetSignInReason } from "@/lib/db-enums";

// Spec 0023 AC-14: what a failed sign in does to a run. Two reasons cannot be
// fixed by trying again at once: the app could not make the credential
// (`credential_failed`), or the sign in refused the password the app had just
// set (`idp_rejected`). Those put the run on hold. The other four are
// transient: one retry after 20 seconds, then the run ends. Safe on both sides.

export const HOLD_REASONS: readonly PortalResetSignInReason[] = [
  "credential_failed",
  "idp_rejected",
];

export const holdsRun = (reason: PortalResetSignInReason): boolean =>
  HOLD_REASONS.includes(reason);

// Plain words for the report email (AC-15); never the portal's own reply.
export const SIGN_IN_TEXT: Readonly<Record<PortalResetSignInReason, string>> = {
  credential_failed:
    "The app could not prepare the portal sign in account in Authentik.",
  idp_rejected:
    "The sign in refused the password the app had just set for the portal account.",
  browser_unavailable: "The headless browser could not be started.",
  portal_unreachable: "The portal could not be reached.",
  timeout: "The portal sign in took too long.",
  token_missing: "The portal sign in finished but gave no access token.",
};

// What the run does when the portal rejects its token twice (AC-17).
export const SESSION_LOST_REASON: PortalResetSignInReason = "token_missing";
