"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { currentSession } from "@/server/auth/require";
import { AUTHENTIK_PROVIDER_ID } from "@/server/auth/sign-in";
import { signOutTarget } from "@/server/auth/sign-out";

// Public by design (it starts sign in), so it calls no require* (AC-14
// allow list). Both entry points use it; the role decides where you land.
export async function signInWithSso(): Promise<never> {
  const res = await auth().api.signInSocial({
    body: {
      provider: AUTHENTIK_PROVIDER_ID,
      callbackURL: "/auth/landing",
      errorCallbackURL: "/auth/error",
      disableRedirect: true,
    },
  });
  if (!res.url) redirect("/auth/error?reason=unavailable");
  redirect(res.url);
}

// Any signed in role may sign out, so it calls no require* (AC-14 allow
// list). Reads the role and id token first, then ends the app session, then
// sends the browser to Authentik's end session URL (AC-12).
export async function signOut(): Promise<never> {
  const current = await currentSession();
  if (!current) redirect("/");
  const target = await signOutTarget(
    current.session.authUserId,
    current.user.role,
  );
  await auth().api.signOut({ headers: await headers() });
  redirect(target);
}
