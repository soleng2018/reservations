"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { sql } from "kysely";
import { z } from "zod";
import { err, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import { requireLearner } from "@/server/auth/require";
import { cancelOwnBooking } from "@/server/booking/manage";
import { db } from "@/server/db";
import { resendKey, enqueueWelcome } from "@/server/jobs/send-welcome";
import { countHourlyAttempt } from "@/server/rate-limit";
import { clientIp } from "@/server/request-ip";
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
  const ip = clientIp(await headers());
  const parsed = resendInput.safeParse({
    email: form.get("email"),
    token: form.get("cf-turnstile-response"),
  });

  const conn = db();
  const ipAllowed = await countHourlyAttempt(conn, `resend:ip:${ip}`, PER_IP);
  if (!parsed.success) return GENERIC;
  const { email, token } = parsed.data;
  const emailAllowed = await countHourlyAttempt(
    conn,
    `resend:email:${email}`,
    PER_EMAIL,
  );
  if (!ipAllowed || !emailAllowed) return GENERIC;

  const human = await verifyTurnstile(
    token,
    ip === "untrusted" ? undefined : ip,
  );
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

const CancelInput = z.object({
  bookingId: z.uuid(),
  version: z.number().int(),
});

// Spec 0011 AC-4, AC-5: the learner cancels their own Upcoming or Current
// booking. The page binds the id and the version it showed. Bad input, an
// id that is not theirs, and a booking that changed meanwhile all read as
// `stale`, so the reply reveals nothing about another learner's booking.
export async function cancelReservationAction(
  bookingId: string,
  version: number,
): Promise<Result<void, "stale">> {
  const { user } = await requireLearner();
  const input = CancelInput.safeParse({ bookingId, version });
  const done: Result<void, "stale"> = input.success
    ? await cancelOwnBooking(
        db(),
        user.id,
        input.data.bookingId,
        input.data.version,
      )
    : err("stale");
  revalidatePath("/reservations");
  return done;
}
