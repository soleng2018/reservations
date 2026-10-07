"use server";

import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { AUTHENTIK_PROVIDER_ID } from "@/server/auth/sign-in";

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
