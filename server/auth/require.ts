import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { UserRole, UserStatus } from "@/lib/db-enums";
import { db } from "@/server/db";
import { adminEntryPath } from "@/server/env";
import { auth } from "./index";

export type SessionUser = {
  readonly id: string; // users.id
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly name: string;
  readonly email: string;
  readonly timezone: string;
};

export type CurrentSession = {
  readonly user: SessionUser;
  readonly session: { readonly id: string; readonly expiresAt: Date };
};

// The signed in app user, or undefined. Reads the DB session every time, so a
// deleted session or deactivated row takes effect at once.
export async function currentSession(): Promise<CurrentSession | undefined> {
  const found = await auth().api.getSession({ headers: await headers() });
  if (!found) return undefined;
  const row = await db()
    .selectFrom("users")
    .select(["id", "role", "status", "name", "email", "timezone"])
    .where("auth_user_id", "=", found.user.id)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    user: {
      ...row,
      role: UserRole.parse(row.role),
      status: UserStatus.parse(row.status),
    },
    session: { id: found.session.id, expiresAt: found.session.expiresAt },
  };
}

async function requireRole(
  role: UserRole,
  signInPath: string,
): Promise<CurrentSession> {
  const current = await currentSession();
  if (!current) redirect(signInPath);
  if (current.user.status === "deactivated")
    redirect("/auth/error?reason=deactivated");
  if (current.user.role !== role) redirect("/auth/error?reason=not_authorized");
  return current;
}

// Every admin page and Server Action calls this first (AC-14).
export const requireAdmin = (): Promise<CurrentSession> =>
  requireRole("admin", adminEntryPath());

// Every learner page and Server Action calls this first (AC-14).
export const requireLearner = (): Promise<CurrentSession> =>
  requireRole("learner", "/reservations");
