import { describe, expect, it } from "vitest";
import { err, ok } from "@/lib/result";
import {
  fakeGoogleFetch,
  serviceAccountCredentials,
  type FakeAnswer,
} from "./testing";
import {
  googleAccessToken,
  mintAccessToken,
  type MailCredentials,
  type MintError,
  type MintToken,
} from "./token";

// covers: spec 0013 AC-2, AC-9, AC-30
const creds = (stamp = "2026-10-15T00:00:00.000Z"): MailCredentials => ({
  credentials: serviceAccountCredentials(),
  senderEmail: "labs@nile.example",
  stamp,
});

const signIn = {
  method: "oauth",
  clientId: "client.apps.googleusercontent.com",
  clientSecret: "GOCSPX-canary-secret",
  refreshToken: "1//canary-refresh-token",
} as const;

// Counts mints; each token is numbered.
const counting = (answer: "ok" | MintError = "ok", lifetimeMs = 3_600_000) => {
  let n = 0;
  const mint: MintToken = async () => {
    n += 1;
    return answer === "ok"
      ? ok({ token: `token-${n}`, expiresAt: Date.now() + lifetimeMs })
      : err(answer);
  };
  return {
    mint,
    get count() {
      return n;
    },
  };
};

describe("googleAccessToken (spec 0013 AC-9)", () => {
  it("mints once and reuses the token while the key is unchanged", async () => {
    const m = counting();
    const source = googleAccessToken(creds("stamp-a"), m.mint);
    expect(await source()).toEqual({ ok: true, value: "token-1" });
    expect(await googleAccessToken(creds("stamp-a"), m.mint)()).toEqual({
      ok: true,
      value: "token-1",
    });
    expect(m.count).toBe(1);
  });

  it("mints again for a new key stamp, and when asked for a fresh token", async () => {
    const m = counting();
    await googleAccessToken(creds("stamp-b"), m.mint)();
    expect(await googleAccessToken(creds("stamp-c"), m.mint)()).toEqual({
      ok: true,
      value: "token-2",
    });
    expect(
      await googleAccessToken(creds("stamp-c"), m.mint)({ fresh: true }),
    ).toEqual({ ok: true, value: "token-3" });
  });

  it("mints again when the cached token is about to expire", async () => {
    const m = counting("ok", 60_000);
    const source = googleAccessToken(creds("stamp-d"), m.mint);
    await source();
    await source();
    expect(m.count).toBe(2);
  });

  it.each<[MintError, string]>([
    ["delegation", "rejected"],
    ["invalid", "rejected"],
    ["unavailable", "unavailable"],
  ])("answers %s as %s and caches nothing", async (answer, error) => {
    const m = counting(answer);
    const source = googleAccessToken(creds("stamp-e"), m.mint);
    expect(await source()).toEqual({ ok: false, error });
    await source();
    expect(m.count).toBe(2);
  });
});

describe("mintAccessToken (spec 0013 AC-2, AC-30)", () => {
  it("refuses a private key that does not parse, without calling Google", async () => {
    const google = fakeGoogleFetch(() => ({ status: 200 }));
    expect(
      await mintAccessToken(
        {
          ...creds(),
          credentials: {
            ...serviceAccountCredentials(),
            privateKey:
              "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n",
          },
        },
        google.fetch,
      ),
    ).toEqual({ ok: false, error: "invalid" });
    expect(google.requests).toHaveLength(0);
  });

  it("mints a Google sign in token with the refresh grant through the given fetch", async () => {
    const google = fakeGoogleFetch(() => ({
      status: 200,
      json: {
        access_token: "ya29.from-refresh",
        expires_in: 3599,
        refresh_token: "1//ignored",
      },
    }));
    const before = Date.now();
    const minted = await mintAccessToken(
      { credentials: signIn, senderEmail: "hol.sender@gmail.com" },
      google.fetch,
    );
    expect(minted).toEqual({
      ok: true,
      value: { token: "ya29.from-refresh", expiresAt: expect.any(Number) },
    });
    if (minted.ok)
      expect(minted.value.expiresAt).toBeGreaterThanOrEqual(before + 3_599_000);
    expect(google.requests).toHaveLength(1);
    const [req] = google.requests;
    expect(req.url).toBe("https://oauth2.googleapis.com/token");
    expect(req.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(req.body))).toEqual({
      grant_type: "refresh_token",
      client_id: signIn.clientId,
      client_secret: signIn.clientSecret,
      refresh_token: signIn.refreshToken,
    });
  });

  it.each<[FakeAnswer, MintError]>([
    [{ status: 400, json: { error: "invalid_grant" } }, "invalid"],
    [{ status: 401, json: { error: "invalid_client" } }, "invalid"],
    [{ status: 400, json: { error: "unauthorized_client" } }, "invalid"],
    [{ status: 403, json: {} }, "invalid"],
    [{ status: 429 }, "unavailable"],
    [{ status: 503 }, "unavailable"],
    ["network", "unavailable"],
  ])(
    "maps a Google sign in refresh answer %j to %s, never echoing Google's body",
    async (answer, error) => {
      const google = fakeGoogleFetch(() => answer);
      const minted = await mintAccessToken(
        { credentials: signIn, senderEmail: "hol.sender@gmail.com" },
        google.fetch,
      );
      expect(minted).toEqual({ ok: false, error });
    },
  );
});
