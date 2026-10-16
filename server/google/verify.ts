import "server-only";
import { hasRequiredScopes, idTokenEmail } from "@/lib/google-sign-in";
import { err, ok, type Result } from "@/lib/result";
import { calendarPath, googleRequest, type GoogleFetch } from "./http";
import { exchangeGoogleCode } from "./oauth";
import {
  mintAccessToken,
  type GoogleCredentials,
  type MintToken,
} from "./token";

// Spec 0013 AC-2. The save time check of an uploaded GOOGLE key, outside any
// transaction, on the typed values only (the web process never decrypts a
// stored key). It mints a token as the sender, then reads one event from the
// calendar. The read proves access, not write permission. Not audited.

export type VerifyGoogleInput = GoogleCredentials & {
  readonly calendarId: string;
};

export type VerifyGoogleError =
  "invalid" | "delegation" | "calendar" | "unavailable";

export type VerifyGoogleDeps = {
  readonly mint: MintToken;
  readonly fetch: GoogleFetch;
};

const LIVE: VerifyGoogleDeps = {
  mint: (creds) => mintAccessToken(creds),
  fetch,
};

// One event from the calendar, as the token's account. "invalid": a fresh
// token refused (401). "calendar": 403, 404, or a malformed id alike, this
// account can't open it.
async function readCalendar(
  fetchFn: GoogleFetch,
  token: string,
  calendarId: string,
): Promise<Result<void, "invalid" | "calendar" | "unavailable">> {
  const reply = await googleRequest(
    fetchFn,
    `${calendarPath(calendarId)}/events?maxResults=1`,
    { method: "GET", token },
  );
  if (!reply.ok) return err("unavailable");
  const { status } = reply.value;
  await reply.value.body?.cancel();
  if (status >= 200 && status < 300) return ok(undefined);
  if (status === 429 || status >= 500) return err("unavailable");
  if (status === 401) return err("invalid");
  return err("calendar");
}

export async function verifyGoogleKey(
  input: VerifyGoogleInput,
  deps: VerifyGoogleDeps = LIVE,
): Promise<Result<void, VerifyGoogleError>> {
  const minted = await deps.mint(input);
  if (!minted.ok) return minted;
  return readCalendar(deps.fetch, minted.value.token, input.calendarId);
}

// Spec 0013 AC-28 steps 5 to 8 (amended 2026-10-16): a pasted sign in,
// exchanged and checked. Runs after every check that doesn't need Google,
// since the code works once. The exchange's access token is used for the
// calendar read only, then dropped; the worker mints its own.
export type VerifySignInInput = {
  readonly code: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly calendarId: string;
};

export type GoogleSignIn = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  // The account that signed in, from the id_token (step 7).
  readonly senderEmail: string;
};

// "exchange_unavailable" and "check_unavailable" differ only in whether the
// code was spent. "refused" also covers a fresh token the calendar refused.
export type VerifySignInError =
  | {
      readonly kind:
        | "refused"
        | "client"
        | "no_refresh"
        | "exchange_unavailable"
        | "scopes"
        | "no_email"
        | "check_unavailable";
    }
  | { readonly kind: "calendar"; readonly sender: string };

export async function verifyGoogleSignIn(
  input: VerifySignInInput,
  deps: { readonly fetch: GoogleFetch } = { fetch },
): Promise<Result<GoogleSignIn, VerifySignInError>> {
  const exchanged = await exchangeGoogleCode(deps.fetch, input);
  if (!exchanged.ok) {
    switch (exchanged.error) {
      case "refused":
      case "client":
      case "no_refresh":
        return err({ kind: exchanged.error });
      case "unavailable":
        return err({ kind: "exchange_unavailable" });
      default: {
        const never: never = exchanged.error;
        return never;
      }
    }
  }
  const { accessToken, refreshToken, scope, idToken } = exchanged.value;
  if (!hasRequiredScopes(scope)) return err({ kind: "scopes" });
  const sender = idTokenEmail(idToken, input.clientId);
  if (!sender.ok) return err({ kind: "no_email" });
  const read = await readCalendar(deps.fetch, accessToken, input.calendarId);
  if (!read.ok) {
    switch (read.error) {
      case "invalid":
        return err({ kind: "refused" });
      case "calendar":
        return err({ kind: "calendar", sender: sender.value });
      case "unavailable":
        return err({ kind: "check_unavailable" });
      default: {
        const never: never = read.error;
        return never;
      }
    }
  }
  return ok({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    refreshToken,
    senderEmail: sender.value,
  });
}
