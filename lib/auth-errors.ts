// What /auth/error says for each reason (spec 0003 API surface). Plain words,
// no hints about admin access or whether an account exists elsewhere.
export type AuthErrorView = {
  readonly title: string;
  readonly message: string;
  readonly reserveLink: boolean;
  readonly signIn: boolean;
};

const views = {
  unknown: {
    title: "No reservations found",
    message: "We couldn't find reservations for this account.",
    reserveLink: true,
    signIn: false,
  },
  deactivated: {
    title: "Account deactivated",
    message: "This account is deactivated.",
    reserveLink: false,
    signIn: false,
  },
  unavailable: {
    title: "Sign in unavailable",
    message: "Sign in is temporarily unavailable, try again shortly.",
    reserveLink: false,
    signIn: false,
  },
  not_authorized: {
    title: "Not authorized",
    message: "You don't have access to this page.",
    reserveLink: false,
    signIn: false,
  },
  signout_partial: {
    title: "Signed out of HOL",
    message:
      "You're signed out of HOL, but we couldn't end your Authentik session. Close the browser to finish.",
    reserveLink: false,
    signIn: false,
  },
  // Spec 0014 AC-19: Better Auth's state outlived (a slow password page, or a
  // sign in finished in another browser). One click signs in again.
  timed_out: {
    title: "Sign in timed out",
    message:
      "Your sign in expired before it finished. Sign in again to continue.",
    reserveLink: false,
    signIn: true,
  },
} as const satisfies Record<string, AuthErrorView>;

export type AuthErrorReason = keyof typeof views;

const isReason = (v: string): v is AuthErrorReason => Object.hasOwn(views, v);

// Better Auth's state_mismatch (only) reads as timed out; every other code of
// its own reads as unavailable.
const fromError = (error: string | undefined): string | undefined =>
  error === "state_mismatch" ? "timed_out" : error;

// Our own redirects pass `reason`. Better Auth's OAuth callback passes `error`,
// holding the code returned by validateUserInfo (one of our reasons) or one
// of its own codes (state mismatch, a failed hook).
export function authErrorView(params: {
  readonly reason?: string;
  readonly error?: string;
}): AuthErrorView {
  const code = params.reason ?? fromError(params.error) ?? "";
  return views[isReason(code) ? code : "unavailable"];
}
