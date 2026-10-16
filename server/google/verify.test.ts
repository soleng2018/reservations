import { describe, expect, it } from "vitest";
import { err, ok } from "@/lib/result";
import {
  fakeGoogleFetch,
  fakeServiceAccountKey,
  type FakeAnswer,
} from "./testing";
import type { MintError, MintToken } from "./token";
import { verifyGoogleKey } from "./verify";

// covers: spec 0013 AC-2
const key = fakeServiceAccountKey();
const input = {
  clientEmail: key.client_email,
  privateKey: key.private_key,
  privateKeyId: key.private_key_id,
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
