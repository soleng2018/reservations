import { z } from "zod";
import { err, ok, type Result } from "./result";

// Spec 0013 AC-25 to AC-28 (amended 2026-10-16): Google sign in for a
// GOOGLE key, the pure parts. Safe on both sides. Nothing here logs, and no
// error carries the input (a client file holds its secret).

// Google redirects only to https or a loopback address, and dev runs on
// plain http at a LAN IP, so the address Google opens is pasted back.
// Nothing needs to listen there.
export const GOOGLE_LOOPBACK_REDIRECT = "http://127.0.0.1:47613/";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";

export const GOOGLE_SIGN_IN_SCOPES = [
  "openid",
  "email",
  GMAIL_SEND,
  CALENDAR_EVENTS,
] as const;

// AC-26. The Desktop app OAuth client JSON from Google Cloud; only these
// fields are read.
export const GoogleOAuthClientFile = z.object({
  installed: z.object({
    client_id: z.string().endsWith(".apps.googleusercontent.com"),
    client_secret: z.string().min(1),
  }),
});

export type GoogleOAuthClient = {
  readonly clientId: string;
  readonly clientSecret: string;
};

// "web": a Web application client. "service_account": a service account
// key in the wrong place. "invalid": anything else, invalid JSON included.
export type ClientFileError = "web" | "service_account" | "invalid";

const JsonObject = z.record(z.string(), z.unknown());

const parseJsonObject = (text: string) => {
  try {
    const parsed = JsonObject.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export function parseGoogleClientFile(
  text: string,
): Result<GoogleOAuthClient, ClientFileError> {
  const json = parseJsonObject(text);
  if (json === undefined) return err("invalid");
  if ("web" in json) return err("web");
  if (json.type === "service_account") return err("service_account");
  const parsed = GoogleOAuthClientFile.safeParse(json);
  return parsed.success
    ? ok({
        clientId: parsed.data.installed.client_id,
        clientSecret: parsed.data.installed.client_secret,
      })
    : err("invalid");
}

// AC-26 (AC-3 widened): an OAuth client file uploaded as a service account
// key.
export const isOAuthClientFile = (text: string): boolean => {
  const json = parseJsonObject(text);
  return json !== undefined && ("installed" in json || "web" in json);
};

// AC-28 step 3. "missing": blank. "incomplete": another origin or path, or
// no code or state. "cancelled": the account said no. "failed": any other
// error Google sent back.
export type ReturnUrlError = "missing" | "incomplete" | "cancelled" | "failed";

export type GoogleReturn = { readonly code: string; readonly state: string };

export function parseGoogleReturnUrl(
  text: string | undefined,
): Result<GoogleReturn, ReturnUrlError> {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return err("missing");
  const url = URL.parse(trimmed);
  const expected = new URL(GOOGLE_LOOPBACK_REDIRECT);
  if (
    url === null ||
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname
  )
    return err("incomplete");
  const error = url.searchParams.get("error");
  if (error !== null)
    return err(error === "access_denied" ? "cancelled" : "failed");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return err("incomplete");
  return ok({ code, state });
}

// AC-27: where "Open Google sign in" goes.
export function googleAuthUrl(input: {
  readonly clientId: string;
  readonly state: string;
  readonly codeChallenge: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: GOOGLE_LOOPBACK_REDIRECT,
    response_type: "code",
    scope: GOOGLE_SIGN_IN_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

// AC-28 step 6: the account can untick either permission on Google's screen.
export const hasRequiredScopes = (scope: string): boolean => {
  const granted = new Set(scope.split(" "));
  return granted.has(GMAIL_SEND) && granted.has(CALENDAR_EVENTS);
};

// AC-28 step 7. The id_token comes straight from Google's token endpoint
// over TLS, so its signature is not checked; its payload names the account.
const IdTokenPayload = z.object({
  iss: z.enum(["https://accounts.google.com", "accounts.google.com"]),
  aud: z.string(),
  email: z.email(),
  email_verified: z.literal(true),
});

const decodeBase64Url = (part: string): string => {
  const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export function idTokenEmail(
  idToken: string,
  clientId: string,
): Result<string, "invalid"> {
  const parts = idToken.split(".");
  if (parts.length !== 3) return err("invalid");
  try {
    const parsed = IdTokenPayload.safeParse(
      JSON.parse(decodeBase64Url(parts[1])),
    );
    return parsed.success && parsed.data.aud === clientId
      ? ok(parsed.data.email)
      : err("invalid");
  } catch {
    return err("invalid");
  }
}
