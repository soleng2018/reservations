import "server-only";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { EmailStatus } from "@/lib/db-enums";
import { routeEmail } from "@/lib/email-routing";
import {
  LINK_HOURS,
  setPasswordUrl,
  WELCOME_SUBJECT,
  type WelcomeEmailDetails,
} from "@/lib/welcome-email";
import { newToken } from "@/server/auth/set-password-links";
import { dbNow } from "@/server/db/bookings";
import type { DB } from "@/server/db/types";
import { composeWelcomeEmail } from "@/server/email/compose";
import { sendRaw } from "@/server/google/gmail";
import type { JobHandler, JobOutcome } from "./runner";
import { GMAIL_RETRY, gmailRefused, UNREADABLE } from "./send-email";
import { sendWelcomePayload } from "./welcome-queue";

// Spec 0014 AC-1 to AC-8: the send_welcome handler, worker only (it loads the
// renderer; the web process queues through welcome-queue.ts). It runs in the
// job's transaction, which the runner commits on every outcome, so nothing is
// written before the Gmail call: the token, the row id, and the message are
// built in memory, sent, and only then written.

export const STALE_WELCOME =
  "Not sent: queued over 72 hours ago. Resend from the user page.";

const DONE: JobOutcome = { kind: "done" };
const HOUR_MS = 3_600_000;

type Recipient = {
  readonly id: string;
  readonly email: string;
};

// AC-6: every welcome row has the same shape; only a sent row has sent_to.
async function writeEmailRow(
  trx: Kysely<DB>,
  row: {
    readonly id: string;
    readonly jobId: string;
    readonly user: Recipient;
    readonly details: WelcomeEmailDetails;
    readonly status: Exclude<EmailStatus, "queued">;
    readonly lastError: string | null;
    readonly sent?: { readonly to: string; readonly providerId: string };
  },
): Promise<void> {
  await trx
    .insertInto("email_messages")
    .values({
      id: row.id,
      user_id: row.user.id,
      job_id: row.jobId,
      kind: "welcome",
      to_address: row.user.email,
      subject: WELCOME_SUBJECT,
      details: JSON.stringify(row.details),
      status: row.status,
      last_error: row.lastError,
      ...(row.sent
        ? {
            sent_to: row.sent.to,
            provider_message_id: row.sent.providerId,
            sent_at: sql<Date>`now()`,
          }
        : {}),
    })
    .execute();
}

// AC-3: a welcome sent (or suppressed) to the current address since this job
// was queued already covers it. The worker runs one job at a time, so this
// read needs no extra lock.
async function alreadyCovered(
  trx: Kysely<DB>,
  user: Recipient,
  queuedAt: Date,
): Promise<boolean> {
  const row = await trx
    .selectFrom("email_messages")
    .select("id")
    .where("user_id", "=", user.id)
    .where("kind", "=", "welcome")
    .where("status", "in", ["sent", "suppressed"])
    .where(sql<string>`lower(to_address)`, "=", user.email.toLowerCase())
    .where("created_at", ">=", queuedAt)
    .executeTakeFirst();
  return row !== undefined;
}

export const runSendWelcome: JobHandler = async (trx, job, ctx) => {
  const payload = sendWelcomePayload.safeParse(job.payload);
  if (!payload.success) return { kind: "final", error: UNREADABLE };
  // AC-2: queued before spec 0014, with no link base.
  const { userId, appUrl } = payload.data;
  if (appUrl === undefined) return DONE;

  // AC-1: FOR SHARE, so an email change in flight commits first (AC-14).
  const user = await trx
    .selectFrom("users")
    .select([
      "id",
      "email",
      "name",
      "timezone",
      "role",
      "status",
      "authentik_user_pk",
      "set_password_pending",
    ])
    .where("id", "=", userId)
    .forShare()
    .executeTakeFirst();
  if (
    !user ||
    user.role !== "learner" ||
    user.status !== "active" ||
    user.authentik_user_pk === null ||
    !user.set_password_pending
  )
    return DONE;

  if (await alreadyCovered(trx, user, job.createdAt)) return DONE;

  const now = await dbNow(trx);
  const details: WelcomeEmailDetails = {
    name: user.name,
    expiresAt: new Date(now.getTime() + LINK_HOURS * HOUR_MS).toISOString(),
    timeZone: user.timezone,
  };
  const rowId = randomUUID();
  const write = (
    status: Exclude<EmailStatus, "queued">,
    lastError: string | null,
    sent?: { readonly to: string; readonly providerId: string },
  ) =>
    writeEmailRow(trx, {
      id: rowId,
      jobId: job.id,
      user,
      details,
      status,
      lastError,
      sent,
    });

  // AC-2: a long outage shows on the console instead of mailing a stale link.
  if (now.getTime() - job.createdAt.getTime() > LINK_HOURS * HOUR_MS) {
    await write("suppressed", STALE_WELCOME);
    return DONE;
  }

  // AC-5: test addresses as for booking emails, but never the Ops BCC.
  const route = routeEmail(user.email, { ...ctx.cfg, opsBcc: null });
  if (route.kind === "suppress") {
    await write("suppressed", route.reason);
    return DONE;
  }

  const { token, hash } = newToken();
  const { raw } = await composeWelcomeEmail({
    emailId: rowId,
    details,
    email: user.email,
    url: setPasswordUrl(appUrl, token),
    senderEmail: ctx.cfg.senderEmail,
    to: route.to,
    subjectPrefix: route.subjectPrefix,
  });
  const sent = await ctx.google((t) => sendRaw(ctx.fetch, t, raw));
  if (!sent.ok) {
    const e = sent.error;
    if (e === "breaker") return { kind: "breaker" };
    if (e === "retry") return { kind: "retry", error: GMAIL_RETRY };
    const error = gmailRefused(e.status);
    await write("failed", error);
    return { kind: "final", error };
  }

  await write("sent", null, { to: route.to, providerId: sent.value.id });
  await trx
    .insertInto("set_password_links")
    .values({
      user_id: user.id,
      email_message_id: rowId,
      token_hash: hash,
      email: user.email.toLowerCase(),
      expires_at: new Date(details.expiresAt),
    })
    .execute();
  return DONE;
};
