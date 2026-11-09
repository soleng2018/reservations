// The "two logins, one password" notice shown on the booking page and in the
// lab access and reminder emails. One copy, so the screen and the emails
// never drift apart. Safe on both sides.

export const WINDOW_NOTICE = {
  title: "Lab links work only during your window.",
  body: "They turn on when it starts and off when it ends, so plan your time.",
} as const;

export const LOGINS_TITLE = "You'll have two logins, one password";

export const WORK_EMAIL = {
  heading: "Your real work email",
  tag: "For the reservation system",
  body: "Use it to book, reschedule, or cancel. After you book, we'll email you a link to set your password.",
} as const;

export const SAME_PASSWORD =
  "Both use the same password: the one you set from that link.";

export const LAB_LOGIN_HEADING = "Your lab login";
export const LAB_LOGIN_TAG = "Only for the lab itself";

// The learner's real lab login when the booking has one; otherwise the
// pattern, so the notice never shows a blank or a wrong address.
export function labLoginBody(nileLogin: string | null): string {
  return nileLogin === null
    ? "A separate address we create for you (firstname.lastname@labdomain). Use it only to sign in to the lab itself. It's in your booking confirmation email."
    : "A separate address we create for you. Use it only to sign in to the lab itself.";
}
