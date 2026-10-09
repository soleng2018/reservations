import "server-only";
import { sql, type Kysely } from "kysely";
import { DurationUnit, LIVE_BOOKING_STATUSES } from "@/lib/db-enums";
import { durationMs } from "@/lib/duration";
import { err, ok, type Result } from "@/lib/result";
import { HORIZON_MS, isOfferableStart, LEAD_MS } from "@/lib/slots";
import {
  bookableTestbedsOfType,
  completeEndedForUser,
  dbNow,
  lockBookableTestbed,
} from "./bookings";
import type { DB } from "./types";

// The rows the guest booking saga writes (spec 0001's saga, spec 0002's data
// steps, spec 0004's testbed assignment). server/booking/guest-booking.ts
// drives the steps and makes the real Authentik calls:
//   1. startGuestBooking   (transaction; any refusal rolls it all back)
//   2. Authentik find or create by email, then recordAuthentikUser (own commit)
//   3. confirmGuestBooking (transaction)
// On any failure, compensateGuestBooking; the sweeper runs it for rows found
// by staleProvisioning.

// The client never picks the testbed or the end time (spec 0004).
export type GuestBookingInput = {
  readonly name: string;
  readonly company: string;
  readonly email: string;
  readonly timezone: string;
  readonly testbedTypeId: string;
  readonly startsAt: Date;
};

export type SagaRef = { readonly userId: string; readonly bookingId: string };

export type StartedBooking = SagaRef & {
  readonly testbedId: string;
  readonly testbedName: string;
  readonly typeName: string;
  readonly endsAt: Date;
};

export type StepOneError =
  | "admin_email"
  | "refused"
  | "has_live_booking" // a confirmed Upcoming or Current booking
  | "booking_pending" // a provisioning attempt still in flight
  | "not_bookable" // the type has no bookable testbed at all
  | "slot_taken"; // every testbed is taken, or the start is no longer offered

// A retry this long after the user's own earlier attempt replaces it, instead
// of waiting for the 10 minute sweeper.
const STALE_OWN_ATTEMPT = sql<Date>`now() - interval '1 minute'`;
const SWEEP_AFTER = sql<Date>`now() - interval '10 minutes'`;
// Rechecked in the delete itself, so a booking made meanwhile keeps the row.
const HAS_NO_BOOKINGS = sql<boolean>`not exists (
  select 1 from hol_app.bookings b where b.user_id = users.id
)`;

// Step 1: find or create the learner by email, then assign a testbed and hold
// the slot as provisioning (spec 0004 AC-5). An admin email is told apart
// (spec 0003 AC-5: its own message and audit); a deactivated account gets the
// generic refusal. The caller must roll the transaction back on any error,
// so a refused new email leaves no users row (AC-9).
export async function startGuestBooking(
  trx: Kysely<DB>,
  input: GuestBookingInput,
): Promise<Result<StartedBooking, StepOneError>> {
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

  // A plain select is enough: the user row lock serializes their sagas.
  const live = await trx
    .selectFrom("bookings")
    .select("status")
    .where("user_id", "=", user.id)
    .where("status", "in", LIVE_BOOKING_STATUSES)
    .executeTakeFirst();
  if (live)
    return err(
      live.status === "provisioning" ? "booking_pending" : "has_live_booking",
    );

  // The one read the end time comes from, held FOR SHARE so the type cannot
  // change or be deleted under this booking.
  const type = await trx
    .selectFrom("testbed_types")
    .select(["name", "duration_value", "duration_unit"])
    .where("id", "=", input.testbedTypeId)
    .where("deleted_at", "is", null)
    .forShare()
    .executeTakeFirst();
  if (!type) return err("not_bookable");
  const endsAt = new Date(
    input.startsAt.getTime() +
      durationMs(type.duration_value, DurationUnit.parse(type.duration_unit)),
  );
  if (!isOfferableStart(input.startsAt, await dbNow(trx), LEAD_MS, HORIZON_MS))
    return err("slot_taken");

  // First testbed (lower(name) order) whose insert passes the overlap
  // exclusion wins. ON CONFLICT DO NOTHING turns an overlap, including one a
  // concurrent saga commits while this insert waits, into an empty result.
  const candidates = await bookableTestbedsOfType(trx, input.testbedTypeId);
  const assign = async (
    i: number,
    anyLocked: boolean,
  ): Promise<Result<StartedBooking, StepOneError>> => {
    const candidate = candidates[i];
    if (!candidate) return err(anyLocked ? "slot_taken" : "not_bookable");
    const locked = await lockBookableTestbed(trx, candidate.id);
    if (!locked.ok) return assign(i + 1, anyLocked);
    const booking = await trx
      .insertInto("bookings")
      .values({
        user_id: user.id,
        testbed_id: candidate.id,
        testbed_type_id: input.testbedTypeId,
        starts_at: input.startsAt,
        ends_at: endsAt,
        status: "provisioning",
      })
      .onConflict((oc) => oc.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!booking) return assign(i + 1, true);
    return ok({
      userId: user.id,
      bookingId: booking.id,
      testbedId: candidate.id,
      testbedName: locked.value.name,
      typeName: type.name,
      endsAt,
    });
  };
  return assign(0, false);
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
