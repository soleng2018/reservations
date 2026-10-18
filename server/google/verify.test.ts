import { describe, expect, it } from "vitest";
import { err, ok } from "@/lib/result";
import {
  FAKE_CLIENT_ID,
  fakeGoogleFetch,
  fakeIdToken,
  serviceAccountCredentials,
  type FakeAnswer,
  type RecordedRequest,
} from "./testing";
import type { MintError, MintToken } from "./token";
import { verifyGoogleKey, verifyGoogleSignIn } from "./verify";

// covers: spec 0013 AC-2, AC-28
const input = {
  credentials: serviceAccountCredentials(),
  senderEmail: "labs@nile.example",
  calendarId: "c_abc123#x@group.calendar.google.com",
};

const minting =
  (answer: "ok" | MintError): MintToken =>
  async () =>
    answer === "ok"
      ? ok({ token: "ya29.test-token", expiresAt: Date.now() + 3_600_000 })
      : err(answer);

const verify = (mint: "ok" | MintError, calendar: FakeAnswer) => {
  const google = fakeGoogleFetch(() => calendar);
  return {
    google,
    result: verifyGoogleKey(input, {
      mint: minting(mint),
      fetch: google.fetch,
    }),
  };
};

describe("verifyGoogleKey (spec 0013 AC-2)", () => {
  it("mints as the sender, then reads one event from the encoded calendar", async () => {
    const { google, result } = verify("ok", {
      status: 200,
      json: { items: [] },
    });
    expect(await result).toEqual({ ok: true, value: undefined });
    expect(google.requests).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "https://www.googleapis.com/calendar/v3/calendars/c_abc123%23x%40group.calendar.google.com/events?maxResults=1",
        headers: expect.objectContaining({
          authorization: "Bearer ya29.test-token",
        }),
      }),
    ]);
  });

  it.each<[MintError, string]>([
    ["delegation", "delegation"],
    ["invalid", "invalid"],
    ["unavailable", "unavailable"],
  ])(
    "answers %s from the token call without reading the calendar",
    async (mint, error) => {
      const { google, result } = verify(mint, { status: 200 });
      expect(await result).toEqual({ ok: false, error });
      expect(google.requests).toHaveLength(0);
    },
  );

  it.each<[FakeAnswer, string]>([
    [{ status: 404 }, "calendar"],
    [{ status: 403 }, "calendar"],
    [{ status: 400 }, "calendar"],
    [{ status: 401 }, "invalid"],
    [{ status: 429 }, "unavailable"],
    [{ status: 503 }, "unavailable"],
    ["network", "unavailable"],
  ])("maps the calendar read %j to %s", async (answer, error) => {
    expect(await verify("ok", answer).result).toEqual({ ok: false, error });
  });
});

const BOTH_SCOPES =
  "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.events openid https://www.googleapis.com/auth/userinfo.email";

const signInInput = {
  code: "4/0canary-auth-code",
  codeVerifier: "canary-code-verifier",
  clientId: FAKE_CLIENT_ID,
  clientSecret: "GOCSPX-canary-secret",
  calendarId: "c_abc123#x@group.calendar.google.com",
};

const exchangeReply = (over: Record<string, unknown> = {}): FakeAnswer => ({
  status: 200,
  json: {
    access_token: "ya29.canary-access",
    expires_in: 3599,
    refresh_token: "1//canary-refresh",
    scope: BOTH_SCOPES,
    token_type: "Bearer",
    id_token: fakeIdToken({}),
    ...over,
  },
});

// The token endpoint answers `exchange`, the calendar answers `calendar`.
const signIn = (
  exchange: FakeAnswer,
  calendar: FakeAnswer = { status: 200 },
) => {
  const google = fakeGoogleFetch((req: RecordedRequest) =>
    req.url.startsWith("https://oauth2.googleapis.com/") ? exchange : calendar,
  );
  return {
    google,
    result: verifyGoogleSignIn(signInInput, { fetch: google.fetch }),
  };
};

describe("verifyGoogleSignIn (spec 0013 AC-28 steps 5 to 8)", () => {
  it("exchanges the code with its verifier, then reads the calendar with the new token", async () => {
    const { google, result } = signIn(exchangeReply());
    expect(await result).toEqual({
      ok: true,
      value: {
        clientId: FAKE_CLIENT_ID,
        clientSecret: "GOCSPX-canary-secret",
        refreshToken: "1//canary-refresh",
        senderEmail: "hol.sender@gmail.com",
      },
    });
    const [exchange, read] = google.requests;
    expect(exchange.url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toEqual({
      grant_type: "authorization_code",
      code: signInInput.code,
      client_id: FAKE_CLIENT_ID,
      client_secret: "GOCSPX-canary-secret",
      redirect_uri: "http://127.0.0.1:47613/",
      code_verifier: "canary-code-verifier",
    });
    expect(read).toEqual(
      expect.objectContaining({
        method: "GET",
        url: "https://www.googleapis.com/calendar/v3/calendars/c_abc123%23x%40group.calendar.google.com/events?maxResults=1",
        headers: expect.objectContaining({
          authorization: "Bearer ya29.canary-access",
        }),
      }),
    );
    expect(google.requests).toHaveLength(2);
  });

  it.each<[string, FakeAnswer, string]>([
    [
      "invalid_grant",
      { status: 400, json: { error: "invalid_grant" } },
      "refused",
    ],
    [
      "invalid_client",
      { status: 401, json: { error: "invalid_client" } },
      "client",
    ],
    [
      "another 4xx",
      { status: 400, json: { error: "invalid_request" } },
      "refused",
    ],
    ["a 429", { status: 429 }, "exchange_unavailable"],
    ["a 500", { status: 500 }, "exchange_unavailable"],
    ["a network error", "network", "exchange_unavailable"],
    [
      "no refresh token",
      exchangeReply({ refresh_token: undefined }),
      "no_refresh",
    ],
    [
      "a missing scope",
      exchangeReply({
        scope: "openid https://www.googleapis.com/auth/gmail.send",
      }),
      "scopes",
    ],
    [
      "an unverified email",
      exchangeReply({ id_token: fakeIdToken({ email_verified: false }) }),
      "no_email",
    ],
    [
      "another client's id_token",
      exchangeReply({
        id_token: fakeIdToken({ aud: "other.apps.googleusercontent.com" }),
      }),
      "no_email",
    ],
    ["no id_token", exchangeReply({ id_token: undefined }), "no_email"],
  ])(
    "answers %s at the exchange without reading the calendar",
    async (_, exchange, kind) => {
      const { google, result } = signIn(exchange);
      expect(await result).toEqual({ ok: false, error: { kind } });
      expect(google.requests).toHaveLength(1);
    },
  );

  it.each<[FakeAnswer, unknown]>([
    [{ status: 404 }, { kind: "calendar", sender: "hol.sender@gmail.com" }],
    [{ status: 403 }, { kind: "calendar", sender: "hol.sender@gmail.com" }],
    [{ status: 401 }, { kind: "refused" }],
    [{ status: 503 }, { kind: "check_unavailable" }],
    ["network", { kind: "check_unavailable" }],
  ])(
    "maps the calendar read %j after the exchange",
    async (calendar, error) => {
      expect(await signIn(exchangeReply(), calendar).result).toEqual({
        ok: false,
        error,
      });
    },
  );
});
