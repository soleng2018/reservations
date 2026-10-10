import "server-only";
import { sql, type Kysely } from "kysely";
import { LIVE_BOOKING_STATUSES } from "@/lib/db-enums";
import type { Blocker } from "@/lib/delete-flow";
import type { DB } from "./types";

// What stops a catalog soft delete (AC-4). The caller's transaction first
// locks the target with lockForDelete, then runs the blocker query, then sets
// deleted_at, so a concurrent booking (which holds FOR SHARE) cannot slip in
// between the check and the delete (AC-14).

// Locks a live catalog row FOR UPDATE. False when it is missing or already
// soft deleted.
export async function lockForDelete(
  trx: Kysely<DB>,
  table: "testbeds" | "testbed_types",
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

// Live bookings on this testbed that have not ended, labelled by learner.
export async function testbedBlockers(
  trx: Kysely<DB>,
  testbedId: string,
): Promise<readonly Blocker[]> {
  return trx
    .selectFrom("bookings")
    .innerJoin("users", "users.id", "bookings.user_id")
    .select(["bookings.id", "users.name as label"])
    .where("bookings.testbed_id", "=", testbedId)
    .where("bookings.status", "in", LIVE_BOOKING_STATUSES)
    .where("bookings.ends_at", ">", sql<Date>`now()`)
    .orderBy("bookings.starts_at")
    .execute();
}
