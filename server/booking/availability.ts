import "server-only";
import { sql, type Kysely } from "kysely";
import { DurationUnit, LIVE_BOOKING_STATUSES } from "@/lib/db-enums";
import { durationMs } from "@/lib/duration";
import { freeStarts, HORIZON_MS, isOfferableStart, LEAD_MS } from "@/lib/slots";
import { preferFirst } from "@/lib/manage-reservations";
import { bookableTestbedsOfType, dbNow } from "@/server/db/bookings";
import type { DB } from "@/server/db/types";

// What /book offers (spec 0004 AC-3, spec 0010 AC-1, AC-4, AC-7). Reads only;
// the saga rechecks at confirm under locks.

export type BookableType = {
  readonly id: string;
  readonly name: string;
  readonly durationValue: number;
  readonly durationUnit: DurationUnit;
};

// Live types with at least one bookable testbed, by name.
export async function bookableTypes(
  conn: Kysely<DB>,
): Promise<readonly BookableType[]> {
  const rows = await conn
    .selectFrom("testbed_types as ty")
    .select(["ty.id", "ty.name", "ty.duration_value", "ty.duration_unit"])
    .where("ty.deleted_at", "is", null)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("testbeds as t")
          .select(sql`1`.as("one"))
          .whereRef("t.testbed_type_id", "=", "ty.id")
          .where("t.deleted_at", "is", null)
          .where("t.authentik_group_pk", "is not", null),
      ),
    )
    .orderBy(sql`lower(ty.name)`)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    durationValue: r.duration_value,
    durationUnit: DurationUnit.parse(r.duration_unit),
  }));
}

// A live type's length, or null when the type is unknown or deleted.
async function typeDuration(
  conn: Kysely<DB>,
  testbedTypeId: string,
): Promise<number | null> {
  const type = await conn
    .selectFrom("testbed_types")
    .select(["duration_value", "duration_unit"])
    .where("id", "=", testbedTypeId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return type
    ? durationMs(type.duration_value, DurationUnit.parse(type.duration_unit))
    : null;
}

// A reschedule reads availability as if its own booking were gone (spec
// 0011 AC-7, AC-8): its own range never counts as busy. /book passes none.
export type ExcludeOwn = { readonly excludeBookingId?: string };

// Live bookings of these testbeds that overlap [from, to), less the excluded
// one.
const busyRanges = (
  conn: Kysely<DB>,
  testbedIds: readonly string[],
  from: Date,
  to: Date,
  { excludeBookingId }: ExcludeOwn = {},
) =>
  conn
    .selectFrom("bookings")
    .select([
      "testbed_id as testbedId",
      "starts_at as startsAt",
      "ends_at as endsAt",
    ])
    .where("testbed_id", "in", testbedIds)
    .where("status", "in", LIVE_BOOKING_STATUSES)
    .where("starts_at", "<", to)
    .where("ends_at", ">", from)
    .$if(excludeBookingId !== undefined, (q) =>
      q.where("id", "!=", excludeBookingId ?? ""),
    )
    .execute();

export type Starts = {
  readonly starts: readonly Date[];
  readonly durationMs: number; // 0 for an unknown or unbookable type
  readonly now: Date; // DB now(), the clock the starts were computed from
};

// Free starts for the type from one DB now() read: an unknown or deleted
// type, or one with no bookable testbed, has none.
export async function startsFor(
  conn: Kysely<DB>,
  testbedTypeId: string,
  opts: ExcludeOwn = {},
): Promise<Starts> {
  const now = await dbNow(conn);
  const none = { starts: [], durationMs: 0, now };
  const length = await typeDuration(conn, testbedTypeId);
  if (length === null) return none;
  const testbeds = await bookableTestbedsOfType(conn, testbedTypeId);
  if (testbeds.length === 0) return none;

  const ids = testbeds.map((t) => t.id);
  const busy = await busyRanges(
    conn,
    ids,
    now,
    new Date(now.getTime() + HORIZON_MS + length),
    opts,
  );
  const starts = freeStarts({
    now,
    leadMs: LEAD_MS,
    horizonMs: HORIZON_MS,
    durationMs: length,
    testbedIds: ids,
    busy,
  });
  return { starts, durationMs: length, now };
}

// The testbed the saga would most likely assign (spec 0010 AC-7): the first
// bookable testbed of the type, in the saga's lower(name) order, with no live
// booking overlapping [start, start + duration). A reschedule keeps its own
// testbed when it can (spec 0011 AC-8): `preferTestbedId` is tried first.
// Advice only; it takes no lock and holds nothing. Null when none is free or
// the start is no longer offered.
export async function firstFreeTestbed(
  conn: Kysely<DB>,
  testbedTypeId: string,
  startsAt: Date,
  opts: ExcludeOwn & { readonly preferTestbedId?: string } = {},
): Promise<{ readonly testbedName: string; readonly endsAt: Date } | null> {
  const length = await typeDuration(conn, testbedTypeId);
  if (length === null) return null;
  if (!isOfferableStart(startsAt, await dbNow(conn), LEAD_MS, HORIZON_MS))
    return null;
  const bookable = await bookableTestbedsOfType(conn, testbedTypeId);
  if (bookable.length === 0) return null;
  const testbeds =
    opts.preferTestbedId === undefined
      ? bookable
      : preferFirst(bookable, opts.preferTestbedId);

  const endsAt = new Date(startsAt.getTime() + length);
  const busy = new Set(
    (
      await busyRanges(
        conn,
        testbeds.map((t) => t.id),
        startsAt,
        endsAt,
        opts,
      )
    ).map((b) => b.testbedId),
  );
  const free = testbeds.find((t) => !busy.has(t.id));
  return free ? { testbedName: free.name, endsAt } : null;
}
