import "server-only";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";
import {
  decryptSecret,
  encryptSecret,
  secretAad,
  type Keyring,
} from "@/server/crypto/secrets";
import { appUrl } from "@/server/env";

// Spec 0013 AC-27, AC-28 (amended 2026-10-16): the Google sign in in
// progress, held for at most 10 minutes in an encrypted cookie bound to the
// admin who started it. The web process decrypts this cookie and nothing
// else; the cookie holds only ciphertext, and nothing here logs.

const NAME = "hol_google_sign_in";
const PATH = "/admin";
const MAX_AGE_SECONDS = 600;
const MAX_AGE_MS = MAX_AGE_SECONDS * 1000;

export type SignIn = {
  readonly state: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  // The DB clock when the sign in started.
  readonly issuedAt: Date;
};

const StoredSignIn = z.object({
  state: z.string().min(1),
  codeVerifier: z.string().min(1),
  clientId: z.string().min(1),
  issuedAt: z.iso.datetime(),
});

// Another admin's session can't use it: the admin's id is in the AAD.
const aad = (userId: string) => secretAad("google_sign_in", "cookie", userId);

// Starting again replaces the cookie. Secure only over https, so dev over
// plain http works.
export async function setSignInCookie(
  keyring: Keyring,
  userId: string,
  signIn: SignIn,
): Promise<void> {
  const value = encryptSecret(
    keyring,
    JSON.stringify({
      ...signIn,
      issuedAt: signIn.issuedAt.toISOString(),
    } satisfies z.infer<typeof StoredSignIn>),
    aad(userId),
  );
  (await cookies()).set(NAME, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: appUrl().startsWith("https:"),
    path: PATH,
    maxAge: MAX_AGE_SECONDS,
  });
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// AC-28 step 4: the cookie must exist, decrypt for this admin, be under 10
// minutes old by the DB clock, and match the pasted state and the client
// file's id (so the secret can't be swapped for another client's). Any
// miss is one answer.
export async function readSignInCookie(input: {
  readonly keyring: Keyring;
  readonly userId: string;
  readonly now: Date;
  readonly state: string;
  readonly clientId: string;
}): Promise<Result<SignIn, "expired">> {
  const value = (await cookies()).get(NAME)?.value;
  if (!value) return err("expired");
  let stored: z.infer<typeof StoredSignIn>;
  try {
    stored = StoredSignIn.parse(
      JSON.parse(decryptSecret(input.keyring, value, aad(input.userId))),
    );
  } catch {
    return err("expired");
  }
  const issuedAt = new Date(stored.issuedAt);
  const age = input.now.getTime() - issuedAt.getTime();
  if (age < 0 || age > MAX_AGE_MS) return err("expired");
  if (!same(stored.state, input.state) || stored.clientId !== input.clientId)
    return err("expired");
  return ok({ ...stored, issuedAt });
}

// After every attempt that reached the code exchange (a code works once),
// and on success. Same name and path as the set.
export async function clearSignInCookie(): Promise<void> {
  (await cookies()).delete({ name: NAME, path: PATH });
}
