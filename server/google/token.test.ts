import { describe, expect, it } from "vitest";
import { err, ok } from "@/lib/result";
import { fakeServiceAccountKey } from "./testing";
import {
  googleAccessToken,
  mintAccessToken,
  type MailCredentials,
  type MintError,
  type MintToken,
} from "./token";

// covers: spec 0013 AC-2, AC-9
const key = fakeServiceAccountKey();
const creds = (stamp = "2026-10-15T00:00:00.000Z"): MailCredentials => ({
  clientEmail: key.client_email,
  privateKey: key.private_key,
  privateKeyId: key.private_key_id,
  senderEmail: "labs@nile.example",
  stamp,
});

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

describe("mintAccessToken (spec 0013 AC-2)", () => {
  it("refuses a private key that does not parse, without calling Google", async () => {
    expect(
      await mintAccessToken({
        ...creds(),
        privateKey:
          "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----\n",
      }),
    ).toEqual({ ok: false, error: "invalid" });
  });
});
