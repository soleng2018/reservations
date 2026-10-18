import "server-only";
import { createPrivateKey } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { JWT } from "google-auth-library";
import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";
import { GOOGLE_TIMEOUT_MS, type GoogleFetch } from "./http";
import { refreshAccessToken, type OAuthClientCredentials } from "./oauth";

// Spec 0013 AC-2, AC-9, AC-30. An access token acting as the sender mailbox:
// for a service account through domain wide delegation, for Google sign in
// through its refresh token. Nothing here logs, and no error carries the
// key or a token.

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

// The decrypted GOOGLE secret, tagged by the key's google_auth column.
export type ServiceAccountCredentials = {
  readonly method: "service_account";
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId: string;
};
export type OAuthCredentials = OAuthClientCredentials & {
  readonly method: "oauth";
};

export type GoogleCredentials = {
  readonly credentials: ServiceAccountCredentials | OAuthCredentials;
  readonly senderEmail: string;
};

// "delegation": Google's unauthorized_client for a service account, the
// client ID has no domain wide delegation entry for both scopes. "invalid":
// invalid_grant or invalid_client (a deleted key, a sender outside the
// domain, a revoked or expired sign in) or a private key that does not
// parse. "unavailable": a timeout, network error, 429, or 5xx.
export type MintError = "delegation" | "invalid" | "unavailable";

export type MintedToken = {
  readonly token: string;
  // Epoch milliseconds, from Google's reply.
  readonly expiresAt: number;
};

export type MintToken = (
  creds: GoogleCredentials,
) => Promise<Result<MintedToken, MintError>>;

// Gaxios puts the token endpoint's reply on the error.
const TokenFailure = z.object({
  response: z.object({
    status: z.number(),
    data: z.object({ error: z.string() }).partial().nullish(),
  }),
});

const classify = (e: unknown): MintError => {
  const failure = TokenFailure.safeParse(e);
  if (!failure.success) return "unavailable"; // no reply: a network error
  const { status, data } = failure.data.response;
  switch (data?.error) {
    case "unauthorized_client":
      return "delegation";
    case "invalid_grant":
    case "invalid_client":
      return "invalid";
  }
  return status === 429 || status >= 500 ? "unavailable" : "invalid";
};

const TIMED_OUT = Symbol("timed out");

// The library retries the token POST itself, so the whole mint is raced
// against the timeout as well as each request.
async function mintServiceAccount(
  creds: ServiceAccountCredentials,
  senderEmail: string,
): Promise<Result<MintedToken, MintError>> {
  try {
    createPrivateKey(creds.privateKey);
  } catch {
    return err("invalid");
  }
  const jwt = new JWT({
    email: creds.clientEmail,
    key: creds.privateKey,
    keyId: creds.privateKeyId,
    subject: senderEmail,
    scopes: [...GOOGLE_SCOPES],
    transporterOptions: { timeout: GOOGLE_TIMEOUT_MS },
  });
  const timer = new AbortController();
  try {
    const result = await Promise.race([
      jwt.authorize(),
      sleep(GOOGLE_TIMEOUT_MS, TIMED_OUT, { signal: timer.signal }),
    ]);
    if (result === TIMED_OUT) return err("unavailable");
    const token = result.access_token;
    if (!token) return err("unavailable");
    return ok({
      token,
      expiresAt: result.expiry_date ?? Date.now() + 30 * 60_000,
    });
  } catch (e) {
    return err(classify(e));
  } finally {
    timer.abort();
  }
}

// AC-30: by method. A Google sign in has no delegation to blame, so every
// refusal is "invalid"; the fetch is injected so tests use a fake.
export function mintAccessToken(
  creds: GoogleCredentials,
  fetchFn: GoogleFetch = fetch,
): Promise<Result<MintedToken, MintError>> {
  const { credentials } = creds;
  switch (credentials.method) {
    case "service_account":
      return mintServiceAccount(credentials, creds.senderEmail);
    case "oauth":
      return refreshAccessToken(fetchFn, credentials);
    default: {
      const never: never = credentials;
      return never;
    }
  }
}

// A token is replaced this long before Google's expiry.
const EXPIRY_MARGIN_MS = 5 * 60_000;

export type MailCredentials = GoogleCredentials & {
  // The GOOGLE key's secret_updated_at: only a new secret (which also comes
  // with any change of sender) means a new token, so the worker's own marker
  // writes never drop it (AC-30).
  readonly stamp: string;
};

export type TokenError = "rejected" | "unavailable";

export type TokenSource = (opts?: {
  readonly fresh?: boolean;
}) => Promise<Result<string, TokenError>>;

// The worker's token for the current key, a lazy cache keyed by its stamp
// (AC-9). `fresh` drops the cached token first, for the one retry after a
// 401. Expiry is a local cache rule, so the process clock is fine here.
let cached:
  { readonly stamp: string; readonly minted: MintedToken } | undefined;

export function googleAccessToken(
  cfg: MailCredentials,
  mint: MintToken = (creds) => mintAccessToken(creds),
): TokenSource {
  return async ({ fresh = false } = {}) => {
    const hit =
      !fresh &&
      cached?.stamp === cfg.stamp &&
      cached.minted.expiresAt - EXPIRY_MARGIN_MS > Date.now()
        ? cached.minted
        : undefined;
    if (hit) return ok(hit.token);
    cached = undefined;
    const minted = await mint(cfg);
    if (!minted.ok)
      return err(minted.error === "unavailable" ? "unavailable" : "rejected");
    cached = { stamp: cfg.stamp, minted: minted.value };
    return ok(minted.value.token);
  };
}
