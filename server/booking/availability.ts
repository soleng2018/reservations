import "server-only";
import { sql, type Kysely } from "kysely";
import { DurationUnit, LIVE_BOOKING_STATUSES } from "@/lib/db-enums";
import { durationMs } from "@/lib/duration";
import { freeStarts, HORIZON_MS, LEAD_MS } from "@/lib/slots";
import { bookableTestbedsOfType, dbNow } from "@/server/db/bookings";
import type { DB } from "@/server/db/types";

// What /book offers (spec 0004 AC-3). Reads only; the saga rechecks at
// confirm under locks.

export type BookableType = { readonly id: string; readonly name: string };

// Live types with at least one bookable testbed, by name.
export async function bookableTypes(
  conn: Kysely<DB>,
): Promise<readonly BookableType[]> {
  return conn
    .selectFrom("testbed_types as ty")
    .select(["ty.id", "ty.name"])
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
}

// Free starts for the type from DB now(): an unknown or deleted type, or one
// with no bookable testbed, has none.
export async function startsFor(
  conn: Kysely<DB>,
  testbedTypeId: string,
): Promise<readonly Date[]> {
  const type = await conn
    .selectFrom("testbed_types")
    .select(["duration_value", "duration_unit"])
    .where("id", "=", testbedTypeId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!type) return [];
  const testbeds = await bookableTestbedsOfType(conn, testbedTypeId);
  if (testbeds.length === 0) return [];

  const now = await dbNow(conn);
  const length = durationMs(
    type.duration_value,
    DurationUnit.parse(type.duration_unit),
  );
  const ids = testbeds.map((t) => t.id);
  const busy = await conn
    .selectFrom("bookings")
    .select([
      "testbed_id as testbedId",
      "starts_at as startsAt",
      "ends_at as endsAt",
    ])
    .where("testbed_id", "in", ids)
    .where("status", "in", LIVE_BOOKING_STATUSES)
    .where("starts_at", "<", new Date(now.getTime() + HORIZON_MS + length))
    .where("ends_at", ">", now)
    .execute();

  return freeStarts({
    now,
    leadMs: LEAD_MS,
    horizonMs: HORIZON_MS,
    durationMs: length,
    testbedIds: ids,
    busy,
  });
}
