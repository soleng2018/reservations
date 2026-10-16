import "server-only";
import { err, ok, type Result } from "@/lib/result";
import { calendarPath, googleRequest, type GoogleFetch } from "./http";
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

const LIVE: VerifyGoogleDeps = { mint: mintAccessToken, fetch };

export async function verifyGoogleKey(
  input: VerifyGoogleInput,
  deps: VerifyGoogleDeps = LIVE,
): Promise<Result<void, VerifyGoogleError>> {
  const minted = await deps.mint(input);
  if (!minted.ok) return minted;
  const reply = await googleRequest(
    deps.fetch,
    `${calendarPath(input.calendarId)}/events?maxResults=1`,
    { method: "GET", token: minted.value.token },
  );
  if (!reply.ok) return err("unavailable");
  const { status } = reply.value;
  await reply.value.body?.cancel();
  if (status >= 200 && status < 300) return ok(undefined);
  if (status === 429 || status >= 500) return err("unavailable");
  // A fresh token refused: the key itself.
  if (status === 401) return err("invalid");
  // 403, 404, and a malformed id alike: this sender can't open it.
  return err("calendar");
}
