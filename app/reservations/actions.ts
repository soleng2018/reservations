"use server";

import { headers } from "next/headers";
import { sql } from "kysely";
import { z } from "zod";
import { audit } from "@/server/audit";
import { db } from "@/server/db";
import { resendKey, enqueueWelcome } from "@/server/jobs/send-welcome";
import { countHourlyAttempt } from "@/server/rate-limit";
import { verifyTurnstile } from "@/server/turnstile";

export type ResendState = { readonly message: string } | undefined;

// The same reply whatever happened, so it never reveals an account (AC-8).
const GENERIC: ResendState = {
  message:
    "If that email has a reservation waiting for a password, we've sent a new link. Check your inbox.",
};

const PER_EMAIL = 3;
const PER_IP = 10;

const resendInput = z.object({
  email: z.email().trim().toLowerCase(),
  token: z.string().min(1),
});

// Public by design (before sign in), so it calls no require* (AC-14 allow
// list). Turnstile plus hourly limits per email and per IP, where every
// attempt counts. Only an active learner still waiting to set a password
// gets a new send_welcome job.
export async function resendSetPassword(
  _prev: ResendState,
  form: FormData,
): Promise<ResendState> {
  const ip = (await headers()).get("cf-connecting-ip") ?? undefined;
  const parsed = resendInput.safeParse({
    email: form.get("email"),
    token: form.get("cf-turnstile-response"),
  });

  const conn = db();
  const ipAllowed = await countHourlyAttempt(
    conn,
    `resend:ip:${ip ?? "unknown"}`,
    PER_IP,
  );
  if (!parsed.success) return GENERIC;
  const { email, token } = parsed.data;
  const emailAllowed = await countHourlyAttempt(
    conn,
    `resend:email:${email}`,
    PER_EMAIL,
  );
  if (!ipAllowed || !emailAllowed) return GENERIC;

  const human = await verifyTurnstile(token, ip);
  if (!human.ok) return GENERIC;

  const learner = await conn
    .selectFrom("users")
    .select("id")
    .where(sql<string>`lower(email)`, "=", email)
    .where("role", "=", "learner")
    .where("status", "=", "active")
    .where("set_password_pending", "=", true)
    .executeTakeFirst();
  if (!learner) return GENERIC;

  await conn.transaction().execute(async (trx) => {
    await enqueueWelcome(trx, learner.id, resendKey(learner.id, new Date()));
    await audit(trx, {
      actorUserId: null,
      action: "set_password.resent",
      targetType: "user",
      targetId: learner.id,
      summary: "Set password email resent on request",
    });
  });
  return GENERIC;
}
