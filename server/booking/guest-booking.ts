import "server-only";
import { sql, type Kysely } from "kysely";
import { err, ok, type Result } from "@/lib/result";
import { audit } from "@/server/audit";
import type { CoreApi } from "@/server/authentik/client";
import {
  deleteSagaLearner,
  findOrCreateLearner,
  type FindOrCreateError,
} from "@/server/authentik/learners";
import {
  compensateGuestBooking,
  confirmGuestBooking,
  recordAuthentikUser,
  startGuestBooking,
  type GuestBookingInput,
  type SagaRef,
  type StartedBooking,
  type StepOneError,
} from "@/server/db/guest-saga";
import type { DB } from "@/server/db/types";
import { enqueueWelcome, welcomeKey } from "@/server/jobs/send-welcome";

// The guest booking saga with its Authentik step (spec 0001 saga, spec 0002
// data steps, spec 0003 AC-5, 6, 15, 16, spec 0004 AC-5 to AC-10). /book puts
// Turnstile and the rate limits in front of it. It never writes pod group
// membership: the worker's reconciler owns that.

export type GuestBookingError =
  | StepOneError
  | "unavailable" // "Sign in is temporarily unavailable, try again shortly"
  | "gone"; // the sweeper removed the hold: try again

export type BookedGuest = StartedBooking & {
  readonly newUser: boolean; // this saga created the Authentik user
};

// Thrown inside the step 1 transaction so a refusal rolls back every write
// (the new users row included), then turned back into a Result outside.
class StepOneRefusal extends Error {
  constructor(readonly code: StepOneError) {
    super(code);
  }
}

async function runStepOne(
  conn: Kysely<DB>,
  input: GuestBookingInput,
): Promise<Result<StartedBooking, StepOneError>> {
  try {
    return ok(
      await conn.transaction().execute(async (trx) => {
        const started = await startGuestBooking(trx, input);
        if (!started.ok) throw new StepOneRefusal(started.error);
        return started.value;
      }),
    );
  } catch (e) {
    if (e instanceof StepOneRefusal) return err(e.code);
    throw e;
  }
}

export async function bookAsGuest(
  api: CoreApi,
  conn: Kysely<DB>,
  input: GuestBookingInput,
): Promise<Result<BookedGuest, GuestBookingError>> {
  const started = await runStepOne(conn, input);
  if (!started.ok) {
    if (started.error === "admin_email") await auditAdminEmail(conn, input);
    return started;
  }
  const booked = started.value;
  const ref: SagaRef = { userId: booked.userId, bookingId: booked.bookingId };

  try {
    const learner = await findOrCreateLearner(api, {
      email: input.email,
      name: input.name,
      holUserId: ref.userId,
    });
    if (!learner.ok) {
      await compensateGuestSaga(api, conn, ref);
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
      if (!done.ok) return done;
      if (created)
        await enqueueWelcome(trx, ref.userId, welcomeKey(ref.userId));
      await audit(trx, {
        actorUserId: null,
        action: "booking.created",
        targetType: "booking",
        targetId: ref.bookingId,
        summary: "Guest booking confirmed",
        metadata: { userId: ref.userId, testbedId: booked.testbedId },
      });
      return done;
    });
    if (!confirmed.ok) {
      await compensateGuestSaga(api, conn, ref);
      return confirmed;
    }
    return ok({ ...booked, newUser: created });
  } catch (e) {
    await compensateGuestSaga(api, conn, ref);
    throw e;
  }
}

async function refusal(
  conn: Kysely<DB>,
  ref: SagaRef,
  error: FindOrCreateError,
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
    case "duplicate_email":
      await audit(conn, {
        actorUserId: null,
        action: "booking.refused_duplicate_email",
        targetType: "user",
        targetId: ref.userId,
        summary:
          "Guest booking refused: two Authentik users have this email, differing only by case",
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
// is logged; the user it created stays tagged with its hol_user_id. The
// worker's saga sweeper runs the same undo.
export async function compensateGuestSaga(
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
