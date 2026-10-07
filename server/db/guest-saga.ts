import "server-only";
import { sql, type Kysely } from "kysely";
import { err, ok, type Result } from "@/lib/result";
import { completeEndedForUser, lockBookableTestbed } from "./bookings";
import type { DB } from "./types";

// The rows the guest booking saga writes (spec 0001's saga, spec 0002's data
// steps). Feature 6 drives the steps and makes the real Authentik calls:
//   1. startGuestBooking   (transaction)
//   2. Authentik find or create by email, then recordAuthentikUser (own commit)
//   3. confirmGuestBooking (transaction)
// On any failure, compensateGuestBooking; the sweeper runs it for rows found
// by staleProvisioning. Constraint errors from step 1 propagate: map them with
// mapConstraintError outside the transaction.

export type GuestBookingInput = {
  readonly name: string;
  readonly company: string;
  readonly email: string;
  readonly timezone: string;
  readonly testbedId: string;
  readonly testbedTypeId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
};

export type SagaRef = { readonly userId: string; readonly bookingId: string };

// A retry this long after the user's own earlier attempt replaces it, instead
// of waiting for the 10 minute sweeper.
const STALE_OWN_ATTEMPT = sql<Date>`now() - interval '1 minute'`;
const SWEEP_AFTER = sql<Date>`now() - interval '10 minutes'`;
// Rechecked in the delete itself, so a booking made meanwhile keeps the row.
const HAS_NO_BOOKINGS = sql<boolean>`not exists (
  select 1 from hol_app.bookings b where b.user_id = users.id
)`;

// Step 1: find or create the learner by email and hold the slot as
// provisioning. An admin email is told apart (spec 0003 AC-5: its own message
// and audit); a deactivated account gets the generic refusal.
export async function startGuestBooking(
  trx: Kysely<DB>,
  input: GuestBookingInput,
): Promise<Result<SagaRef, "admin_email" | "refused" | "not_bookable">> {
  await trx
    .insertInto("users")
    .values({
      role: "learner",
      name: input.name,
      company: input.company,
      email: input.email,
      timezone: input.timezone,
    })
    .onConflict((oc) => oc.expression(sql`lower(email)`).doNothing())
    .execute();

  // FOR UPDATE serializes two sagas for the same email.
  const user = await trx
    .selectFrom("users")
    .select(["id", "role", "status"])
    .where(sql<string>`lower(email)`, "=", input.email.toLowerCase())
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (user.role === "admin") return err("admin_email");
  if (user.status !== "active") return err("refused");

  // The user's own crashed attempt would block them via one live booking. Its
  // compensation is just this delete: the same user continues in this saga,
  // so their Authentik user and row stay.
  await trx
    .deleteFrom("bookings")
    .where("user_id", "=", user.id)
    .where("status", "=", "provisioning")
    .where("created_at", "<", STALE_OWN_ATTEMPT)
    .execute();

  await completeEndedForUser(trx, user.id);

  const testbed = await lockBookableTestbed(trx, input.testbedId);
  if (!testbed.ok) return testbed;

  const booking = await trx
    .insertInto("bookings")
    .values({
      user_id: user.id,
      testbed_id: input.testbedId,
      testbed_type_id: input.testbedTypeId,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      status: "provisioning",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return ok({ userId: user.id, bookingId: booking.id });
}

// Step 2, right after the Authentik call, in its own commit. The pending flag
// is raised only when this saga created the Authentik user, so compensation
// never deletes one that already existed.
export async function recordAuthentikUser(
  conn: Kysely<DB>,
  userId: string,
  authentik: { readonly pk: number; readonly created: boolean },
): Promise<void> {
  await conn
    .updateTable("users")
    .set({
      authentik_user_pk: authentik.pk,
      // A created user has no password yet; the first sign in clears this.
      ...(authentik.created
        ? { authentik_pending_saga: true, set_password_pending: true }
        : {}),
    })
    .where("id", "=", userId)
    .execute();
}

// Step 3. "gone" means the sweeper already removed the booking: compensate
// and tell the user to try again.
export async function confirmGuestBooking(
  trx: Kysely<DB>,
  ref: SagaRef,
): Promise<Result<void, "gone">> {
  const confirmed = await trx
    .updateTable("bookings")
    .set({ status: "confirmed" })
    .where("id", "=", ref.bookingId)
    .where("status", "=", "provisioning")
    .returning("id")
    .executeTakeFirst();
  if (!confirmed) return err("gone");
  await trx
    .updateTable("users")
    .set({ authentik_pending_saga: false })
    .where("id", "=", ref.userId)
    .execute();
  return ok(undefined);
}

// Undoes a saga that did not confirm (AC-13). Deletes the provisioning
// booking; then, if the learner has no other booking, deletes the Authentik
// user this saga created and the users row. A row whose Authentik call never
// succeeded (pk null) goes too. A reused Authentik user and its row stay.
export async function compensateGuestBooking(
  conn: Kysely<DB>,
  ref: SagaRef,
  deleteAuthentikUser: (pk: number) => Promise<void>,
): Promise<void> {
  await conn
    .deleteFrom("bookings")
    .where("id", "=", ref.bookingId)
    .where("status", "=", "provisioning")
    .execute();

  const orphan = await conn
    .selectFrom("users")
    .select(["authentik_user_pk", "authentik_pending_saga"])
    .where("id", "=", ref.userId)
    .where("role", "=", "learner")
    .where(HAS_NO_BOOKINGS)
    .executeTakeFirst();
  if (!orphan) return;

  const pk = orphan.authentik_user_pk;
  if (pk !== null && !orphan.authentik_pending_saga) return;
  if (pk !== null) await deleteAuthentikUser(pk);

  await conn
    .deleteFrom("users")
    .where("id", "=", ref.userId)
    .where(HAS_NO_BOOKINGS)
    .execute();
}

// Provisioning bookings older than 10 minutes, for the sweeper to compensate.
export async function staleProvisioning(
  conn: Kysely<DB>,
): Promise<readonly SagaRef[]> {
  return conn
    .selectFrom("bookings")
    .select(["id as bookingId", "user_id as userId"])
    .where("status", "=", "provisioning")
    .where("created_at", "<", SWEEP_AFTER)
    .execute();
}
