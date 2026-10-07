// What /auth/error says for each reason (spec 0003 API surface). Plain words,
// no hints about admin access or whether an account exists elsewhere.
export type AuthErrorView = {
  readonly title: string;
  readonly message: string;
  readonly reserveLink: boolean;
};

const views = {
  unknown: {
    title: "No reservations found",
    message: "We couldn't find reservations for this account.",
    reserveLink: true,
  },
  deactivated: {
    title: "Account deactivated",
    message: "This account is deactivated.",
    reserveLink: false,
  },
  unavailable: {
    title: "Sign in unavailable",
    message: "Sign in is temporarily unavailable, try again shortly.",
    reserveLink: false,
  },
  not_authorized: {
    title: "Not authorized",
    message: "You don't have access to this page.",
    reserveLink: false,
  },
} as const satisfies Record<string, AuthErrorView>;

export type AuthErrorReason = keyof typeof views;

const isReason = (v: string): v is AuthErrorReason => Object.hasOwn(views, v);

// Our own redirects pass `reason`. Better Auth's OAuth callback passes `error`,
// holding the code returned by validateUserInfo (one of our reasons) or one
// of its own codes (state mismatch, a failed hook), which read as unavailable.
export function authErrorView(params: {
  readonly reason?: string;
  readonly error?: string;
}): AuthErrorView {
  const code = params.reason ?? params.error ?? "";
  return views[isReason(code) ? code : "unavailable"];
}
