import "server-only";
import type { Kysely } from "kysely";
import { z } from "zod";
import { err, ok, type Result } from "@/lib/result";
import type { CoreApi } from "@/server/authentik/client";
import { issueSetPasswordLink } from "@/server/authentik/learners";
import type { DB } from "@/server/db/types";

// The set password email job (spec 0003 AC-6, AC-8). The link is requested
// from Authentik when the job runs, so a failure retries the job and never
// undoes the booking. Feature 16 renders and sends the email.

export const sendWelcomePayload = z.object({ userId: z.uuid() });
export type SendWelcomePayload = z.infer<typeof sendWelcomePayload>;

export type SetPasswordEmail = {
  readonly to: string;
  readonly name: string;
  readonly link: string;
};

// The saga's job, one per user ever.
export const welcomeKey = (userId: string) => `welcome:${userId}`;

// A resend's job: one per user per hour, so the rate limit's three attempts
// in an hour still send one email.
export const resendKey = (userId: string, now: Date) =>
  `welcome:${userId}:resend:${now.toISOString().slice(0, 13)}`;

// Inside the caller's transaction. A repeat of the same key is a no op.
export async function enqueueWelcome(
  conn: Kysely<DB>,
  userId: string,
  idempotencyKey: string,
): Promise<void> {
  await conn
    .insertInto("jobs")
    .values({
      kind: "send_welcome",
      payload: JSON.stringify({ userId } satisfies SendWelcomePayload),
      idempotency_key: idempotencyKey,
    })
    .onConflict((oc) => oc.column("idempotency_key").doNothing())
    .execute();
}

// "skipped": the learner already set a password, or is no longer an active
// learner. "unavailable": retry the job later.
export async function runSendWelcome(
  api: CoreApi,
  conn: Kysely<DB>,
  payload: unknown,
  send: (email: SetPasswordEmail) => Promise<void>,
): Promise<Result<"sent" | "skipped", "unavailable">> {
  const { userId } = sendWelcomePayload.parse(payload);
  const user = await conn
    .selectFrom("users")
    .select(["email", "name", "authentik_user_pk"])
    .where("id", "=", userId)
    .where("role", "=", "learner")
    .where("status", "=", "active")
    .where("set_password_pending", "=", true)
    .executeTakeFirst();
  if (!user || user.authentik_user_pk === null) return ok("skipped");

  const link = await issueSetPasswordLink(api, user.authentik_user_pk);
  if (!link.ok) {
    // A guard refusal here means the user became an admin: never send.
    return link.error === "unavailable" ? err("unavailable") : ok("skipped");
  }
  await send({ to: user.email, name: user.name, link: link.value });
  return ok("sent");
}
