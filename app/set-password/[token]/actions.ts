"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/server/auth";
import { AUTHENTIK_PROVIDER_ID } from "@/server/auth/sign-in";
import {
  beginSetPassword,
  type StartRefusal,
} from "@/server/auth/start-set-password";
import { authentik } from "@/server/authentik/client";
import { db } from "@/server/db";
import { clientIp } from "@/server/request-ip";

export type StartState = { readonly state: StartRefusal } | undefined;

// Starts sign in as signInWithSso does, so the state cookie lands on the
// app host the learner clicked from.
const startSignIn = () =>
  auth()
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
        console.error("set password: could not start sign in", e);
        return undefined;
      },
    );

// Spec 0014 AC-10. Public by design (the token is the credential), so it
// calls no require* (allow list). The page binds the token; a token of the
// wrong shape is a miss like any other. useActionState also passes the last
// state and the form, which it needs neither of.
export async function startSetPassword(token: string): Promise<StartState> {
  const started = await beginSetPassword(
    {
      conn: db(),
      api: authentik(),
      ip: clientIp(await headers()),
      startSignIn,
    },
    z.string().catch("").parse(token),
  );
  if (!started.ok) return { state: started.error };
  // Outside the transaction: redirect throws.
  redirect(started.value);
}
