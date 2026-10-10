import "server-only";
import type { UserRole } from "@/lib/db-enums";
import { endAuthentikSessions } from "@/server/authentik/sessions";
import { authentik } from "@/server/authentik/client";
import { db } from "@/server/db";

// Learners return to the landing page, admins to the unlisted entry page,
// on the request's own base URL (AC-12). If Authentik's sessions could not
// be ended, the app session is still gone and the page says so.
export const signOutPath = (
  role: UserRole,
  adminEntry: string,
  authentikEnded: boolean,
): string => {
  if (!authentikEnded) return "/auth/error?reason=signout_partial";
  return role === "admin" ? adminEntry : "/";
};

// Ends every Authentik session of this app user (AC-12). True when nothing
// is left, including a user never linked to Authentik.
export async function endAuthentikSessionsFor(
  usersId: string,
): Promise<boolean> {
  const row = await db()
    .selectFrom("users")
    .select("authentik_user_pk")
    .where("id", "=", usersId)
    .executeTakeFirst();
  const pk = row?.authentik_user_pk ?? null;
  if (pk === null) return true;
  const ended = await endAuthentikSessions(authentik(), pk);
  return ended.ok;
}
