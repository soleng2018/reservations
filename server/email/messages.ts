import "server-only";
import type { Kysely } from "kysely";
import { EmailKind, EmailStatus } from "@/lib/db-enums";
import type { DB } from "@/server/db/types";

// Spec 0013 AC-21: a learner's email history for the console, newest first.
// Explicit columns, never `details` (it holds the lab links).

export const EMAIL_HISTORY_LIMIT = 50;

export type EmailRow = {
  readonly id: string;
  readonly createdAt: Date;
  readonly kind: EmailKind;
  readonly subject: string;
  // Where it went (sent_to), else where it was addressed.
  readonly to: string;
  readonly status: EmailStatus;
  readonly lastError: string | null;
};

export const listUserEmailsQuery = (conn: Kysely<DB>, userId: string) =>
  conn
    .selectFrom("email_messages")
    .select([
      "id",
      "created_at",
      "kind",
      "subject",
      "to_address",
      "sent_to",
      "status",
      "last_error",
    ])
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(EMAIL_HISTORY_LIMIT);

export async function listUserEmails(
  conn: Kysely<DB>,
  userId: string,
): Promise<readonly EmailRow[]> {
  const rows = await listUserEmailsQuery(conn, userId).execute();
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    kind: EmailKind.parse(r.kind),
    subject: r.subject,
    to: r.sent_to ?? r.to_address,
    status: EmailStatus.parse(r.status),
    lastError: r.last_error,
  }));
}
