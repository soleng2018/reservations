import "server-only";
import { sql, type Kysely } from "kysely";
import { bookingPhase } from "@/lib/booking-phase";
import { BookingStatus, LIVE_BOOKING_STATUSES } from "@/lib/db-enums";
import type { Blocker } from "@/lib/delete-flow";
import { dbNow } from "./bookings";
import type { DB } from "./types";

// What stops a catalog soft delete (AC-4). The caller's transaction first
// locks the target with lockForDelete, then runs the blocker query, then sets
// deleted_at, so a concurrent booking (which holds FOR SHARE) cannot slip in
// between the check and the delete (AC-14).

// Locks a live catalog row FOR UPDATE. False when it is missing or already
// soft deleted.
export async function lockForDelete(
  trx: Kysely<DB>,
  table: "testbeds" | "testbed_types" | "api_keys",
  id: string,
): Promise<boolean> {
  const row = await trx
    .selectFrom(table)
    .select("id")
    .where("id", "=", id)
    .where("deleted_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined;
}

// Non deleted testbeds still using this type.
export async function testbedTypeBlockers(
  trx: Kysely<DB>,
  testbedTypeId: string,
): Promise<readonly Blocker[]> {
  return trx
    .selectFrom("testbeds")
    .select(["id", "name as label"])
    .where("testbed_type_id", "=", testbedTypeId)
    .where("deleted_at", "is", null)
    .orderBy("name")
    .execute();
}

// Non deleted testbeds using this key as their IDP, by lower(name). Blocks
// a delete and an IDP to AI type change (spec 0006 AC-5, AC-6).
export async function apiKeyBlockers(
  trx: Kysely<DB>,
  apiKeyId: string,
): Promise<readonly Blocker[]> {
  return trx
    .selectFrom("testbeds")
    .select(["id", "name as label"])
    .where("idp_api_key_id", "=", apiKeyId)
    .where("deleted_at", "is", null)
    .orderBy(sql`lower(name)`)
    .execute();
}

// Live bookings on this testbed that have not ended, by start, labelled
// `<learner> — <phase> reservation` (spec 0007 AC-6). The phase uses the
// DB clock read in the same transaction as the query.
export async function testbedBlockers(
  trx: Kysely<DB>,
  testbedId: string,
): Promise<readonly Blocker[]> {
  const rows = await trx
    .selectFrom("bookings")
    .innerJoin("users", "users.id", "bookings.user_id")
    .select([
      "bookings.id",
      "bookings.status",
      "bookings.starts_at",
      "bookings.ends_at",
      "users.name",
    ])
    .where("bookings.testbed_id", "=", testbedId)
    .where("bookings.status", "in", LIVE_BOOKING_STATUSES)
    .where("bookings.ends_at", ">", sql<Date>`now()`)
    .orderBy("bookings.starts_at")
    .execute();
  if (rows.length === 0) return [];
  const now = await dbNow(trx);
  return rows.map((r) => {
    const phase = bookingPhase(
      {
        status: BookingStatus.parse(r.status),
        startsAt: r.starts_at,
        endsAt: r.ends_at,
      },
      now,
    );
    return { id: r.id, label: `${r.name} — ${phase} reservation` };
  });
}
