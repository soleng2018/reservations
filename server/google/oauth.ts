import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { GOOGLE_LOOPBACK_REDIRECT } from "@/lib/google-sign-in";
import { err, ok, type Result } from "@/lib/result";
import { GOOGLE_TIMEOUT_MS, type GoogleFetch } from "./http";

// Spec 0013 AC-27, AC-28, AC-30 (amended 2026-10-16): Google sign in's calls
// to the token endpoint. Nothing here logs, and no error carries the code,
// the verifier, the client secret, or a token; Google's error body is read
// only for its `error` code.

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const randomToken = () => randomBytes(32).toString("base64url");

export type Pkce = {
  readonly state: string;
  readonly codeVerifier: string;
  readonly codeChallenge: string;
};

// AC-27: `state` ties the pasted address to this sign in; the verifier
// (PKCE) means only this server can redeem the code.
export function newPkce(): Pkce {
  const codeVerifier = randomToken();
  return {
    state: randomToken(),
    codeVerifier,
    codeChallenge: createHash("sha256")
      .update(codeVerifier)
      .digest("base64url"),
  };
}

type TokenReply = { readonly status: number; readonly json: unknown };

// One form encoded POST with the 10 second timeout. A timeout or a network
// error is "network"; any reply is returned with its parsed JSON body (or
// undefined when it has none).
async function postToken(
  fetchFn: GoogleFetch,
  params: Readonly<Record<string, string>>,
): Promise<Result<TokenReply, "network">> {
  try {
    const res = await fetchFn(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    const json: unknown = await res.json().catch(() => undefined);
    return ok({ status: res.status, json });
  } catch {
    return err("network");
  }
}

const ErrorReply = z.object({ error: z.string() });

const errorCode = (json: unknown): string | undefined => {
  const parsed = ErrorReply.safeParse(json);
  return parsed.success ? parsed.data.error : undefined;
};

const busy = (status: number) => status === 429 || status >= 500;

// AC-28 step 5. "refused": the code was used, expired, or doesn't match
// this verifier. "client": Google doesn't know this client or its secret.
// "no_refresh": no lasting sign in came back. "unavailable": a timeout, a
// network error, a 429, or a 5xx.
export type ExchangeError = "refused" | "client" | "no_refresh" | "unavailable";

export type Exchanged = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly scope: string;
  // Missing only if Google left out openid; step 7 then refuses it.
  readonly idToken: string;
};

const ExchangeReply = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  scope: z.string(),
  id_token: z.string().default(""),
});

export async function exchangeGoogleCode(
  fetchFn: GoogleFetch,
  input: {
    readonly code: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly codeVerifier: string;
  },
): Promise<Result<Exchanged, ExchangeError>> {
  const reply = await postToken(fetchFn, {
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: GOOGLE_LOOPBACK_REDIRECT,
    code_verifier: input.codeVerifier,
  });
  if (!reply.ok) return err("unavailable");
  const { status, json } = reply.value;
  if (status >= 200 && status < 300) {
    const parsed = ExchangeReply.safeParse(json);
    if (!parsed.success) return err("unavailable");
    const { refresh_token: refreshToken } = parsed.data;
    if (refreshToken === undefined) return err("no_refresh");
    return ok({
      accessToken: parsed.data.access_token,
      refreshToken,
      scope: parsed.data.scope,
      idToken: parsed.data.id_token,
    });
  }
  switch (errorCode(json)) {
    case "invalid_grant":
      return err("refused");
    case "invalid_client":
    case "unauthorized_client":
      return err("client");
  }
  // Any other 4xx (a malformed request) can only be fixed by starting over.
  return err(busy(status) ? "unavailable" : "refused");
}

export type OAuthClientCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
};

const RefreshReply = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().default(3600),
});

// AC-30: the worker's access token for a Google sign in key. "invalid" means
// Google no longer accepts this sign in (invalid_grant, invalid_client,
// unauthorized_client, or any other 4xx); a refresh_token in the reply is
// ignored. Expiry is a local cache rule, so the process clock is fine.
export async function refreshAccessToken(
  fetchFn: GoogleFetch,
  creds: OAuthClientCredentials,
): Promise<
  Result<
    { readonly token: string; readonly expiresAt: number },
    "invalid" | "unavailable"
  >
> {
  const reply = await postToken(fetchFn, {
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
  });
  if (!reply.ok) return err("unavailable");
  const { status, json } = reply.value;
  if (status >= 200 && status < 300) {
    const parsed = RefreshReply.safeParse(json);
    if (!parsed.success) return err("unavailable");
    return ok({
      token: parsed.data.access_token,
      expiresAt: Date.now() + parsed.data.expires_in * 1000,
    });
  }
  return err(busy(status) ? "unavailable" : "invalid");
}
