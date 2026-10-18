import "server-only";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { bookingPhase } from "@/lib/booking-phase";
import {
  BookingStatus,
  DurationUnit,
  LIVE_BOOKING_STATUSES,
} from "@/lib/db-enums";
import { durationMs } from "@/lib/duration";
import { preferFirst } from "@/lib/manage-reservations";
import { err, type Result } from "@/lib/result";
import { HORIZON_MS, isOfferableStart, LEAD_MS } from "@/lib/slots";
import { audit } from "@/server/audit";
import {
  bookableTestbedsOfType,
  cancelBooking,
  dbNow,
  lockBookableTestbed,
  rescheduleBooking,
} from "@/server/db/bookings";
import { mapConstraintError } from "@/server/db/constraint-errors";
import { STALE_OWN_ATTEMPT } from "@/server/db/guest-saga";
import { Refusal, refusable } from "@/server/db/refusal";
import type { DB } from "@/server/db/types";

// A signed in learner's own bookings (spec 0011): the /reservations list, the
// reschedule page's load, and the learner's cancel and reschedule. Every
// query filters by the session learner, so another learner's id behaves like
// an unknown one. Both writes lock in one order: the users row, the booking,
// the type, then each candidate testbed.

// The bookableTestbedsOfType rule as SQL over the aliases `b` (bookings) and
// `ty` (its type): a live booking whose type is live and still has a testbed
// that can take a booking.
const RESCHEDULABLE = sql<boolean>`(
  b.status = 'confirmed' and b.ends_at > now() and ty.deleted_at is null
  and exists (
    select 1 from hol_app.testbeds bt
    where bt.testbed_type_id = ty.id
      and bt.deleted_at is null
      and bt.authentik_group_pk is not null
  )
)`;

export type LearnerBookingRow = {
  readonly id: string;
  readonly version: number;
  readonly status: BookingStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly testbedName: string;
  readonly typeName: string;
  readonly reschedulable: boolean;
};

// AC-1: confirmed and completed rows only (cancelled and provisioning never
// show). Soft deleted testbed and type names still show. Reads only: no
// completeEndedForUser here.
export async function learnerBookings(
  conn: Kysely<DB>,
  userId: string,
): Promise<readonly LearnerBookingRow[]> {
  const rows = await conn
    .selectFrom("bookings as b")
    .innerJoin("testbeds as t", "t.id", "b.testbed_id")
    .innerJoin("testbed_types as ty", "ty.id", "b.testbed_type_id")
    .select([
      "b.id",
      "b.version",
      "b.status",
      "b.starts_at",
      "b.ends_at",
      "t.name as testbedName",
      "ty.name as typeName",
      RESCHEDULABLE.as("reschedulable"),
    ])
    .where("b.user_id", "=", userId)
    .where("b.status", "in", ["confirmed", "completed"])
    .execute();
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    status: BookingStatus.parse(r.status),
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    testbedName: r.testbedName,
    typeName: r.typeName,
    reschedulable: r.reschedulable,
  }));
}

// AC-2: the one active booking rule. A provisioning row older than
// STALE_OWN_ATTEMPT is a crashed attempt the saga replaces, so it does not
// count.
export async function hasLiveBooking(
  conn: Kysely<DB>,
  userId: string,
): Promise<boolean> {
  const row = await conn
    .selectFrom("bookings")
    .select("id")
    .where("user_id", "=", userId)
    .where((eb) =>
      eb.or([
        eb.and([
          eb("status", "=", "provisioning"),
          eb("created_at", ">=", STALE_OWN_ATTEMPT),
        ]),
        eb.and([
          eb("status", "=", "confirmed"),
          eb("ends_at", ">", sql<Date>`now()`),
        ]),
      ]),
    )
    .executeTakeFirst();
  return row !== undefined;
}

export type ReschedulableBooking = {
  readonly id: string;
  readonly version: number;
  readonly testbedId: string;
  readonly testbedName: string;
  readonly typeId: string;
  readonly typeName: string;
  readonly durationValue: number;
  readonly durationUnit: DurationUnit;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly current: boolean; // started by the DB clock (display only)
};

export type OwnReschedulable =
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ok"; readonly booking: ReschedulableBooking };

const isId = (id: string) => z.uuid().safeParse(id).success;

// AC-6: the reschedule page's load. `missing` for a malformed id, an unknown
// one, or another learner's booking (the page renders notFound()); a booking
// of theirs that is no longer live or reschedulable is `unavailable`.
export async function ownReschedulable(
  conn: Kysely<DB>,
  userId: string,
  bookingId: string,
): Promise<OwnReschedulable> {
  if (!isId(bookingId)) return { kind: "missing" };
  const row = await conn
    .selectFrom("bookings as b")
    .innerJoin("testbeds as t", "t.id", "b.testbed_id")
    .innerJoin("testbed_types as ty", "ty.id", "b.testbed_type_id")
    .select([
      "b.id",
      "b.version",
      "b.testbed_id",
      "t.name as testbedName",
      "b.testbed_type_id",
      "ty.name as typeName",
      "ty.duration_value",
      "ty.duration_unit",
      "b.starts_at",
      "b.ends_at",
      RESCHEDULABLE.as("reschedulable"),
      sql<boolean>`b.starts_at <= now()`.as("current"),
    ])
    .where("b.id", "=", bookingId)
    .where("b.user_id", "=", userId)
    .executeTakeFirst();
  if (!row) return { kind: "missing" };
  if (!row.reschedulable) return { kind: "unavailable" };
  return {
    kind: "ok",
    booking: {
      id: row.id,
      version: row.version,
      testbedId: row.testbed_id,
      testbedName: row.testbedName,
      typeId: row.testbed_type_id,
      typeName: row.typeName,
      durationValue: row.duration_value,
      durationUnit: DurationUnit.parse(row.duration_unit),
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      current: row.current,
    },
  };
}

// Locks the learner's row FOR SHARE while they are active (AC-4, AC-9).
// Deactivation holds FOR UPDATE on it, so the two run one after the other
// and a learner deactivated meanwhile is refused.
async function lockActiveLearner(
  trx: Kysely<DB>,
  userId: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom("users")
    .select("id")
    .where("id", "=", userId)
    .where("role", "=", "learner")
    .where("status", "=", "active")
    .forShare()
    .executeTakeFirst();
  return row !== undefined;
}

// AC-4, AC-5, AC-17: the learner cancels their own Upcoming or Current
// booking at the version they saw. Any miss (stale version, ended, another
// learner's id, deactivated meanwhile) is `stale` and writes nothing.
export async function cancelOwnBooking(
  conn: Kysely<DB>,
  userId: string,
  bookingId: string,
  version: number,
): Promise<Result<void, "stale">> {
  return refusable<void, "stale">(() =>
    conn.transaction().execute(async (trx) => {
      if (!(await lockActiveLearner(trx, userId))) throw new Refusal("stale");
      const booking = await trx
        .selectFrom("bookings")
        .select(["testbed_id", "starts_at", "ends_at"])
        .where("id", "=", bookingId)
        .where("user_id", "=", userId)
        .where("status", "=", "confirmed")
        .where("ends_at", ">", sql<Date>`now()`)
        .where("version", "=", version)
        .forUpdate()
        .executeTakeFirst();
      if (!booking) throw new Refusal("stale");
      const cancelled = await cancelBooking(trx, {
        id: bookingId,
        expectedVersion: version,
        source: "learner",
        byUserId: userId,
      });
      if (!cancelled.ok) throw new Refusal("stale");
      await audit(trx, {
        actorUserId: userId,
        action: "booking.cancelled",
        targetType: "booking",
        targetId: bookingId,
        summary: "Reservation cancelled",
        metadata: {
          source: "learner",
          userId,
          testbedId: booking.testbed_id,
          phase: bookingPhase(
            {
              status: "confirmed",
              startsAt: booking.starts_at,
              endsAt: booking.ends_at,
            },
            await dbNow(trx),
          ),
        },
      });
    }),
  );
}

export type RescheduleInput = {
  readonly bookingId: string;
  readonly version: number;
  readonly startsAt: Date;
};

export type Rescheduled = {
  readonly testbedName: string;
  readonly typeName: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
};

export type RescheduleRefusal =
  "stale" | "slot_taken" | "same_time" | "unavailable";

// Postgres aborts the transaction on these, so they are mapped outside it.
const PgCode = z.object({ code: z.string() });
const RETRYABLE = new Set(["40P01", "40001"]); // deadlock, serialization

// AC-9: an overlap a concurrent commit caused, a deadlock, or a serialization
// failure all mean "pick again". Anything else is a bug and is rethrown.
export function toRescheduleError(e: unknown): "slot_taken" {
  const pg = PgCode.safeParse(e);
  if (pg.success && RETRYABLE.has(pg.data.code)) return "slot_taken";
  const mapped = mapConstraintError(e); // rethrows anything unexpected
  if (!mapped.ok && mapped.error === "overlap") return "slot_taken";
  throw e;
}

// The learner's booking as it is now, when a first try committed and its
// reply was lost: same start, one version on (AC-9 step 1). No `ends_at >
// now()` guard on purpose: it reports a move that did commit and writes nothing.
async function alreadyRescheduled(
  trx: Kysely<DB>,
  userId: string,
  input: RescheduleInput,
): Promise<Rescheduled | undefined> {
  const row = await trx
    .selectFrom("bookings as b")
    .innerJoin("testbeds as t", "t.id", "b.testbed_id")
    .innerJoin("testbed_types as ty", "ty.id", "b.testbed_type_id")
    .select([
      "t.name as testbedName",
      "ty.name as typeName",
      "b.starts_at",
      "b.ends_at",
    ])
    .where("b.id", "=", input.bookingId)
    .where("b.user_id", "=", userId)
    .where("b.status", "=", "confirmed")
    .where("b.starts_at", "=", input.startsAt)
    .where("b.version", "=", input.version + 1)
    .executeTakeFirst();
  return row
    ? {
        testbedName: row.testbedName,
        typeName: row.typeName,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
      }
    : undefined;
}

// AC-9, AC-17: move the learner's own booking to a new start in one locked
// transaction, keeping its testbed when it is free, else the first free one
// in lower(name) order. Every refusal rolls the whole transaction back, so
// the original booking is untouched. `now()` in every guard is the
// transaction's start time.
export async function rescheduleOwnBooking(
  conn: Kysely<DB>,
  userId: string,
  input: RescheduleInput,
): Promise<Result<Rescheduled, RescheduleRefusal>> {
  try {
    return await refusable<Rescheduled, RescheduleRefusal>(() =>
      conn.transaction().execute(async (trx) => {
        // (0) the learner, serialized with deactivation.
        if (!(await lockActiveLearner(trx, userId))) throw new Refusal("stale");

        // (1) the booking at the version the learner saw.
        const booking = await trx
          .selectFrom("bookings")
          .select(["testbed_id", "testbed_type_id", "starts_at", "ends_at"])
          .where("id", "=", input.bookingId)
          .where("user_id", "=", userId)
          .where("status", "=", "confirmed")
          .where("ends_at", ">", sql<Date>`now()`)
          .where("version", "=", input.version)
          .forUpdate()
          .executeTakeFirst();
        if (!booking) {
          const done = await alreadyRescheduled(trx, userId, input);
          if (done) return done;
          throw new Refusal("stale");
        }

        // (2) the type, held so its duration cannot change under us.
        const type = await trx
          .selectFrom("testbed_types")
          .select(["name", "duration_value", "duration_unit"])
          .where("id", "=", booking.testbed_type_id)
          .where("deleted_at", "is", null)
          .forShare()
          .executeTakeFirst();
        if (!type) throw new Refusal("unavailable");

        // (3) the new range, from the type's current duration.
        const endsAt = new Date(
          input.startsAt.getTime() +
            durationMs(
              type.duration_value,
              DurationUnit.parse(type.duration_unit),
            ),
        );
        // same_time before the offerable check: a Current booking's own start
        // is past, and "already your time" is the truer reply there.
        if (input.startsAt.getTime() === booking.starts_at.getTime())
          throw new Refusal("same_time");
        const now = await dbNow(trx);
        if (!isOfferableStart(input.startsAt, now, LEAD_MS, HORIZON_MS))
          throw new Refusal("slot_taken");

        // (4) the kept testbed first, then the rest; the overlap constraint
        // stays the last word.
        const candidates = preferFirst(
          await bookableTestbedsOfType(trx, booking.testbed_type_id),
          booking.testbed_id,
        );
        const assign = async (
          i: number,
          anyLocked: boolean,
        ): Promise<Rescheduled> => {
          const candidate = candidates[i];
          if (!candidate)
            throw new Refusal(anyLocked ? "slot_taken" : "unavailable");
          const locked = await lockBookableTestbed(trx, candidate.id);
          if (!locked.ok) return assign(i + 1, anyLocked);
          const clash = await trx
            .selectFrom("bookings")
            .select("id")
            .where("testbed_id", "=", candidate.id)
            .where("id", "!=", input.bookingId)
            .where("status", "in", LIVE_BOOKING_STATUSES)
            .where("starts_at", "<", endsAt)
            .where("ends_at", ">", input.startsAt)
            .executeTakeFirst();
          if (clash) return assign(i + 1, true);

          const moved = await rescheduleBooking(trx, {
            id: input.bookingId,
            expectedVersion: input.version,
            testbedId: candidate.id,
            testbedTypeId: booking.testbed_type_id,
            startsAt: input.startsAt,
            endsAt,
          });
          if (!moved.ok) throw new Refusal("stale");

          // (5) the audit row, in the same transaction.
          await audit(trx, {
            actorUserId: userId,
            action: "booking.rescheduled",
            targetType: "booking",
            targetId: input.bookingId,
            summary: "Reservation rescheduled",
            metadata: {
              fromStartsAt: booking.starts_at.toISOString(),
              toStartsAt: input.startsAt.toISOString(),
              fromTestbedId: booking.testbed_id,
              toTestbedId: candidate.id,
              phase: bookingPhase(
                {
                  status: "confirmed",
                  startsAt: booking.starts_at,
                  endsAt: booking.ends_at,
                },
                now,
              ),
            },
          });
          return {
            testbedName: locked.value.name,
            typeName: type.name,
            startsAt: input.startsAt,
            endsAt,
          };
        };
        return assign(0, false);
      }),
    );
  } catch (e) {
    return err(toRescheduleError(e));
  }
}
