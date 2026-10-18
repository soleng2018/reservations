import "server-only";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { DB } from "@/server/db/types";

// Spec 0014 AC-15: queuing the set password email. Web safe: the handler
// (send-welcome.ts) renders the email, and the web process never loads the
// renderer.

// `appUrl` is optional so a job queued before spec 0014 still parses, and is
// then skipped (AC-2).
export const sendWelcomePayload = z.object({
  userId: z.uuid(),
  appUrl: z.url().optional(),
});
export type SendWelcomePayload = z.infer<typeof sendWelcomePayload>;

// The saga's job, one per user ever.
export const welcomeKey = (userId: string) => `welcome:${userId}`;

// A resend's job: one per user per hour, so the rate limit's three attempts
// in an hour still send one email.
export const resendKey = (userId: string, now: Date) =>
  `welcome:${userId}:resend:${now.toISOString().slice(0, 13)}`;

// AC-14: an admin's email fix. The change's DB time keeps a fix that goes
// X to Y, back to X, then to Y again from reusing the first Y's key.
export const emailChangeKey = (userId: string, email: string, at: Date) =>
  `welcome:${userId}:email:${email.toLowerCase()}:${at.getTime()}`;

// Inside the caller's transaction. A repeat of the same key is a no op.
// `appUrl` is the queuing process's own origin (AC-15): one worker serves dev
// and prod, so the link must come back to the app the learner used.
export async function enqueueWelcome(
  conn: Kysely<DB>,
  userId: string,
  idempotencyKey: string,
  appUrl: string,
): Promise<void> {
  await conn
    .insertInto("jobs")
    .values({
      kind: "send_welcome",
      payload: JSON.stringify({ userId, appUrl } satisfies SendWelcomePayload),
      idempotency_key: idempotencyKey,
    })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .execute();
}
