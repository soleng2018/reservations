"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { currentSession } from "@/server/auth/require";
import { AUTHENTIK_PROVIDER_ID } from "@/server/auth/sign-in";
import { endAuthentikSessionsFor, signOutPath } from "@/server/auth/sign-out";
import { adminEntryPath } from "@/server/env";

// Public by design (it starts sign in), so it calls no require* (AC-14
// allow list). Both entry points use it; the role decides where you land.
export async function signInWithSso(): Promise<never> {
  // Authentik unreachable (the provider could not be set up, or the call
  // failed) shows the unavailable page, not a 500 (AC-15).
  const url = await auth()
    .api.signInSocial({
      body: {
        provider: AUTHENTIK_PROVIDER_ID,
        callbackURL: "/auth/landing",
        errorCallbackURL: "/auth/error",
        disableRedirect: true,
      },
    })
    .then(
      (res) => res.url,
      (e: unknown) => {
        console.error("sign in: could not start", e);
        return undefined;
      },
    );
  redirect(url ?? "/auth/error?reason=unavailable");
}

// Any signed in role may sign out, so it calls no require* (AC-14 allow
// list). Reads the role first, ends the app session, then ends every
// Authentik session of the user through the API, and returns straight to the
// app. The browser never visits Authentik (AC-12).
export async function signOut(): Promise<never> {
  const current = await currentSession();
  if (!current) redirect("/");
  await auth().api.signOut({ headers: await headers() });
  const ended = await endAuthentikSessionsFor(current.user.id);
  redirect(signOutPath(current.user.role, adminEntryPath(), ended));
}
