import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import type { CancelSource } from "@/lib/db-enums";
import { err, ok, type Result } from "@/lib/result";
import type { DB, Testbeds } from "./types";

// Data rules for booking writes (spec 0002). Every function takes the caller's
// transaction; Kysely's Transaction is a Kysely, so the type is the same.

export type Testbed = Selectable<Testbeds>;

// Marks the user's ended confirmed bookings completed, so a learner whose lab
// just ended can book again at once (AC-2). Never touches provisioning rows.
export async function completeEndedForUser(
  trx: Kysely<DB>,
  userId: string,
): Promise<void> {
  await trx
    .updateTable("bookings")
    .set({ status: "completed" })
    .where("user_id", "=", userId)
    .where("status", "=", "confirmed")
    .where("ends_at", "<=", sql<Date>`now()`)
    .execute();
}

// Locks the testbed and its type FOR SHARE and checks it can take a booking:
// not deleted, Authentik group set, type not deleted (AC-14). A concurrent
// soft delete holds FOR UPDATE, so the two serialize.
export async function lockBookableTestbed(
  trx: Kysely<DB>,
  testbedId: string,
): Promise<Result<Testbed, "not_bookable">> {
  const testbed = await trx
    .selectFrom("testbeds")
    .selectAll()
    .where("id", "=", testbedId)
    .forShare()
    .executeTakeFirst();
  if (!testbed || testbed.deleted_at || !testbed.authentik_group_pk) {
    return err("not_bookable");
  }
  const type = await trx
    .selectFrom("testbed_types")
    .select("id")
    .where("id", "=", testbed.testbed_type_id)
    .where("deleted_at", "is", null)
    .forShare()
    .executeTakeFirst();
  return type ? ok(testbed) : err("not_bookable");
}

// The guard every reschedule and cancel shares (AC-12): still confirmed, not
// ended, and unchanged since the user saw it. Zero rows means "reload".
type Guard = { readonly id: string; readonly expectedVersion: number };

export type Reschedule = Guard & {
  readonly testbedId: string;
  readonly testbedTypeId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
};

export async function rescheduleBooking(
  trx: Kysely<DB>,
  r: Reschedule,
): Promise<Result<{ version: number }, "stale">> {
  const row = await trx
    .updateTable("bookings")
    .set({
      testbed_id: r.testbedId,
      testbed_type_id: r.testbedTypeId,
      starts_at: r.startsAt,
      ends_at: r.endsAt,
    })
    .where("id", "=", r.id)
    .where("status", "=", "confirmed")
    .where("ends_at", ">", sql<Date>`now()`)
    .where("version", "=", r.expectedVersion)
    .returning("version")
    .executeTakeFirst();
  return row ? ok(row) : err("stale");
}

export type Cancel = Guard & {
  readonly source: CancelSource;
  // Null when the system cancelled (deactivation sweep).
  readonly byUserId: string | null;
};

// Keeps ends_at: access ends because the status is no longer live.
export async function cancelBooking(
  trx: Kysely<DB>,
  c: Cancel,
): Promise<Result<{ version: number }, "stale">> {
  const row = await trx
    .updateTable("bookings")
    .set({
      status: "cancelled",
      cancelled_at: sql<Date>`now()`,
      cancel_source: c.source,
      cancelled_by_user_id: c.byUserId,
    })
    .where("id", "=", c.id)
    .where("status", "=", "confirmed")
    .where("ends_at", ">", sql<Date>`now()`)
    .where("version", "=", c.expectedVersion)
    .returning("version")
    .executeTakeFirst();
  return row ? ok(row) : err("stale");
}
