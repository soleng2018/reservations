import "server-only";
import { sql, type Kysely } from "kysely";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import type { CoreApi } from "@/server/authentik/client";
import {
  deleteSagaLearner,
  findOrCreateLearner,
} from "@/server/authentik/learners";
import {
  compensateGuestBooking,
  confirmGuestBooking,
  recordAuthentikUser,
  startGuestBooking,
  type GuestBookingInput,
  type SagaRef,
} from "@/server/db/guest-saga";
import type { DB } from "@/server/db/types";
import { enqueueWelcome, welcomeKey } from "@/server/jobs/send-welcome";

// The guest booking saga with its Authentik step (spec 0001 saga, spec 0002
// data steps, spec 0003 AC-5, 6, 15, 16). Feature 6 adds the form, Turnstile,
// and booking rate limits in front of it. Constraint errors from step 1
// propagate: map them with mapConstraintError.

export type GuestBookingError =
  | "admin_email" // "This email can't be used for booking."
  | "refused" // the generic refusal
  | "not_bookable"
  | "unavailable" // "Sign in is temporarily unavailable, try again shortly"
  | "gone"; // the sweeper removed the hold: try again

export async function bookAsGuest(
  api: CoreApi,
  conn: Kysely<DB>,
  input: GuestBookingInput,
): Promise<Result<SagaRef, GuestBookingError>> {
  const started = await conn
    .transaction()
    .execute((trx) => startGuestBooking(trx, input));
  if (!started.ok) {
    if (started.error === "admin_email") await auditAdminEmail(conn, input);
    return started;
  }
  const ref = started.value;

  try {
    const learner = await findOrCreateLearner(api, {
      email: input.email,
      name: input.name,
      holUserId: ref.userId,
    });
    if (!learner.ok) {
      await compensate(api, conn, ref);
      return err(await refusal(conn, ref, learner.error));
    }
    const { pk, created, tagged } = learner.value;
    await recordAuthentikUser(conn, ref.userId, { pk, created });
    if (created || tagged)
      await audit(conn, {
        actorUserId: null,
        action: created
          ? "user.created_in_authentik"
          : "user.tagged_in_authentik",
        targetType: "user",
        targetId: ref.userId,
        summary: created
          ? "Learner created in Authentik"
          : "Existing Authentik user tagged as a learner",
        metadata: { authentikUserPk: pk },
      });

    const confirmed = await conn.transaction().execute(async (trx) => {
      const done = await confirmGuestBooking(trx, ref);
      if (done.ok && created)
        await enqueueWelcome(trx, ref.userId, welcomeKey(ref.userId));
      return done;
    });
    if (!confirmed.ok) {
      await compensate(api, conn, ref);
      return confirmed;
    }
    return ok(ref);
  } catch (e) {
    await compensate(api, conn, ref);
    throw e;
  }
}

async function refusal(
  conn: Kysely<DB>,
  ref: SagaRef,
  error: "is_admin" | "refused" | "username_taken" | "unavailable",
): Promise<GuestBookingError> {
  switch (error) {
    case "is_admin":
      await audit(conn, {
        actorUserId: null,
        action: "booking.refused_admin_email",
        targetType: "user",
        targetId: ref.userId,
        summary:
          "Guest booking refused: the email belongs to an Authentik admin",
      });
      return "admin_email";
    case "username_taken":
      await audit(conn, {
        actorUserId: null,
        action: "booking.refused_username_taken",
        targetType: "user",
        targetId: ref.userId,
        summary: "Guest booking refused: the username belongs to another email",
      });
      return "unavailable";
    case "refused":
      return "refused";
    case "unavailable":
      return "unavailable";
    default: {
      const never: never = error;
      return never;
    }
  }
}

// The admin row caught in step 1 (AC-5).
async function auditAdminEmail(
  conn: Kysely<DB>,
  input: GuestBookingInput,
): Promise<void> {
  const admin = await conn
    .selectFrom("users")
    .select("id")
    .where(sql<string>`lower(email)`, "=", input.email.toLowerCase())
    .executeTakeFirst();
  await audit(conn, {
    actorUserId: null,
    action: "booking.refused_admin_email",
    targetType: "user",
    targetId: admin?.id ?? "unknown",
    summary: "Guest booking refused: the email belongs to an admin",
  });
}

// Undo, never masking the outcome the user sees. A failed Authentik delete
// is logged; the user it created stays tagged with its hol_user_id.
async function compensate(
  api: CoreApi,
  conn: Kysely<DB>,
  ref: SagaRef,
): Promise<void> {
  try {
    await compensateGuestBooking(conn, ref, async (pk) => {
      const deleted = await deleteSagaLearner(api, pk);
      if (!deleted.ok && deleted.error !== "not_found")
        throw new Error(`authentik delete of ${pk} failed: ${deleted.error}`);
    });
  } catch (e) {
    console.error("guest saga: compensation failed", ref, e);
  }
}
