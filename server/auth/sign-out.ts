import "server-only";
import { z } from "zod";
import type { UserRole } from "@/lib/db-enums";
import { db } from "@/server/db";
import { authEnv } from "@/server/env";
import { AUTHENTIK_PROVIDER_ID } from "./sign-in";

const discoverySchema = z.object({ end_session_endpoint: z.url() });

// Learners return to the landing page, admins to the unlisted entry page.
// Both are registered on the provider by the setup script (AC-12).
export const postLogoutPath = (role: UserRole, adminEntry: string): string =>
  role === "admin" ? adminEntry : "/";

// Authentik's RP initiated logout URL. Without an id token Authentik asks
// the user to confirm, so the hint is sent whenever we have one.
export function endSessionUrl(
  endpoint: string,
  postLogoutRedirect: string,
  idToken: string | undefined,
): string {
  const url = new URL(endpoint);
  if (idToken) url.searchParams.set("id_token_hint", idToken);
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirect);
  return url.toString();
}

// The end session endpoint from OIDC discovery (value sourcing, spec 0003),
// or undefined when Authentik can't be reached in 10 seconds.
async function endSessionEndpoint(): Promise<string | undefined> {
  const env = authEnv();
  try {
    const res = await fetch(
      `${env.AUTHENTIK_URL}/application/o/hol/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(10_000), next: { revalidate: 3600 } },
    );
    if (!res.ok) return undefined;
    const parsed = discoverySchema.safeParse(await res.json());
    return parsed.success ? parsed.data.end_session_endpoint : undefined;
  } catch (e) {
    console.warn("sign out: discovery unavailable", e);
    return undefined;
  }
}

// Where to send the browser after the app session is gone. Read before the
// session is deleted, since the id token lives on the account row.
export async function signOutTarget(
  authUserId: string,
  role: UserRole,
): Promise<string> {
  const env = authEnv();
  const back = `${env.APP_URL}${postLogoutPath(role, env.ADMIN_ENTRY_PATH)}`;
  const [endpoint, account] = await Promise.all([
    endSessionEndpoint(),
    db()
      .selectFrom("hol_auth.account")
      .select("idToken")
      .where("userId", "=", authUserId)
      .where("providerId", "=", AUTHENTIK_PROVIDER_ID)
      .executeTakeFirst(),
  ]);
  // Authentik unreachable: the app session still ends, just not Authentik's.
  if (!endpoint) return back;
  return endSessionUrl(endpoint, back, account?.idToken ?? undefined);
}
