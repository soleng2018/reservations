import { describe, expect, it } from "vitest";
import {
  GOOGLE_LOOPBACK_REDIRECT,
  googleAuthUrl,
  hasRequiredScopes,
  idTokenEmail,
  isOAuthClientFile,
  parseGoogleClientFile,
  parseGoogleReturnUrl,
} from "./google-sign-in";

// covers: spec 0013 AC-26, AC-27, AC-28 steps 3, 6, 7
const CLIENT_ID = "1234-abc.apps.googleusercontent.com";

const b64url = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = (payload: Record<string, unknown>) =>
  [
    b64url({ alg: "RS256" }),
    b64url({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      email: "hol.sender@gmail.com",
      email_verified: true,
      ...payload,
    }),
    "sig",
  ].join(".");

describe("parseGoogleClientFile (AC-26)", () => {
  it("reads the Desktop app client's id and secret, ignoring the rest", () => {
    expect(
      parseGoogleClientFile(
        JSON.stringify({
          installed: {
            client_id: CLIENT_ID,
            client_secret: "GOCSPX-x",
            project_id: "p",
            redirect_uris: ["http://localhost"],
          },
        }),
      ),
    ).toEqual({
      ok: true,
      value: { clientId: CLIENT_ID, clientSecret: "GOCSPX-x" },
    });
  });

  it.each<[string, string]>([
    [
      JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: "s" } }),
      "web",
    ],
    [
      JSON.stringify({ type: "service_account", client_id: "1" }),
      "service_account",
    ],
    ["not json", "invalid"],
    ["[]", "invalid"],
    ["null", "invalid"],
    [
      JSON.stringify({
        installed: { client_id: "1234", client_secret: "s" },
      }),
      "invalid",
    ],
    [
      JSON.stringify({
        installed: { client_id: CLIENT_ID, client_secret: "" },
      }),
      "invalid",
    ],
  ])("answers %s as %s", (text, error) => {
    expect(parseGoogleClientFile(text)).toEqual({ ok: false, error });
  });

  it("tells an OAuth client file from a service account key (AC-3 widened)", () => {
    expect(isOAuthClientFile(JSON.stringify({ installed: {} }))).toBe(true);
    expect(isOAuthClientFile(JSON.stringify({ web: {} }))).toBe(true);
    expect(isOAuthClientFile(JSON.stringify({ type: "service_account" }))).toBe(
      false,
    );
    expect(isOAuthClientFile("{")).toBe(false);
  });
});

describe("parseGoogleReturnUrl (AC-28 step 3)", () => {
  it("reads the code and state from the loopback address", () => {
    expect(
      parseGoogleReturnUrl(
        ` ${GOOGLE_LOOPBACK_REDIRECT}?state=st-1&code=4/0Ab-c&scope=email `,
      ),
    ).toEqual({ ok: true, value: { code: "4/0Ab-c", state: "st-1" } });
  });

  it.each<[string | undefined, string]>([
    [undefined, "missing"],
    ["   ", "missing"],
    ["not a url", "incomplete"],
    ["http://localhost:47613/?state=s&code=c", "incomplete"],
    ["http://127.0.0.1:47614/?state=s&code=c", "incomplete"],
    ["https://127.0.0.1:47613/?state=s&code=c", "incomplete"],
    ["http://127.0.0.1:47613/other?state=s&code=c", "incomplete"],
    ["http://127.0.0.1:47613/?state=s", "incomplete"],
    ["http://127.0.0.1:47613/?code=c", "incomplete"],
    ["http://127.0.0.1:47613/?error=access_denied&state=s", "cancelled"],
    ["http://127.0.0.1:47613/?error=server_error&state=s", "failed"],
  ])("answers %j as %s", (text, error) => {
    expect(parseGoogleReturnUrl(text)).toEqual({ ok: false, error });
  });
});

describe("googleAuthUrl (AC-27)", () => {
  it("asks for offline access to both scopes with PKCE, back to the loopback address", () => {
    const url = new URL(
      googleAuthUrl({ clientId: CLIENT_ID, state: "st", codeChallenge: "ch" }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: "http://127.0.0.1:47613/",
      response_type: "code",
      scope:
        "openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events",
      access_type: "offline",
      prompt: "consent",
      state: "st",
      code_challenge: "ch",
      code_challenge_method: "S256",
    });
  });
});

describe("hasRequiredScopes (AC-28 step 6)", () => {
  it("needs both gmail.send and calendar.events", () => {
    const send = "https://www.googleapis.com/auth/gmail.send";
    const events = "https://www.googleapis.com/auth/calendar.events";
    expect(hasRequiredScopes(`openid ${events} ${send}`)).toBe(true);
    expect(hasRequiredScopes(`openid ${send}`)).toBe(false);
    expect(hasRequiredScopes(`openid ${events}`)).toBe(false);
    expect(hasRequiredScopes("")).toBe(false);
  });
});

describe("idTokenEmail (AC-28 step 7)", () => {
  it("answers the verified email for this client", () => {
    expect(idTokenEmail(idToken({}), CLIENT_ID)).toEqual({
      ok: true,
      value: "hol.sender@gmail.com",
    });
    expect(
      idTokenEmail(idToken({ iss: "accounts.google.com" }), CLIENT_ID),
    ).toEqual({ ok: true, value: "hol.sender@gmail.com" });
  });

  it.each<[string, string]>([
    ["an unverified email", idToken({ email_verified: false })],
    ["another client", idToken({ aud: "other.apps.googleusercontent.com" })],
    ["another issuer", idToken({ iss: "https://evil.example" })],
    ["no email", idToken({ email: undefined })],
    ["two parts", "a.b"],
    ["a payload that isn't JSON", "a.bm90IGpzb24.c"],
    ["an empty token", ""],
  ])("refuses %s", (_, token) => {
    expect(idTokenEmail(token, CLIENT_ID)).toEqual({
      ok: false,
      error: "invalid",
    });
  });
});
