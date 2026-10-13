import "server-only";
import type { Kysely } from "kysely";
import { currentSession } from "@/server/auth/require";
import type { DB } from "@/server/db/types";

export type LearnerAccount = {
  readonly id: string;
  readonly name: string;
  readonly company: string | null;
  readonly email: string;
  readonly timezone: string;
};

// Spec 0011 AC-13: the active learner signed in on public /book, with their
// users row as stored, or undefined for anyone else (no session, an admin,
// a deactivated user). Never redirects: /book stays public.
export async function sessionAccount(
  conn: Kysely<DB>,
): Promise<LearnerAccount | undefined> {
  const current = await currentSession();
  if (current?.user.role !== "learner" || current.user.status !== "active")
    return undefined;
  return conn
    .selectFrom("users")
    .select(["id", "name", "company", "email", "timezone"])
    .where("id", "=", current.user.id)
    .where("role", "=", "learner")
    .where("status", "=", "active")
    .executeTakeFirst();
}
