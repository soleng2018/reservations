// The only way to make text that run records and emails accept (spec 0023
// AC-30). The portal's message comes from `errors[].message` or `message`,
// never the raw body. Safe on both sides.
declare const redacted: unique symbol;
export type RedactedText = string & { readonly [redacted]: true };

const MAX_LENGTH = 300;

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const messageOf = (item: unknown): string | null =>
  isRecord(item) && typeof item.message === "string" ? item.message : null;

// The message fields of a reply body, and nothing else.
export function portalMessage(body: unknown): string {
  if (!isRecord(body)) return "";
  const errors = Array.isArray(body.errors)
    ? body.errors.map(messageOf).filter((m): m is string => m !== null)
    : [];
  const top = typeof body.message === "string" ? [body.message] : [];
  return [...errors, ...top].join("; ");
}

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;
const JWT = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const LONG_RUN = /[A-Za-z0-9_-]{24,}/g;

export function redactMessage(text: string): RedactedText {
  const clean = text
    .replace(URL_LIKE, "[url]")
    .replace(EMAIL, "[email]")
    .replace(JWT, "[token]")
    .replace(LONG_RUN, "[token]")
    .slice(0, MAX_LENGTH);
  return clean as RedactedText;
}

export const redactedPortalMessage = (body: unknown): RedactedText =>
  redactMessage(portalMessage(body));
