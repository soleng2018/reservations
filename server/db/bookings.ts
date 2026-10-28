import "server-only";
import { sql, type Kysely, type Selectable } from "kysely";
import type { CancelSource } from "@/lib/db-enums";
import { err, ok, type Result } from "@/lib/result";
import { cleanupHookOn } from "@/server/catalog/api-keys";
import { queueBookingNotice } from "@/server/jobs/booking-notice";
import { queueCleanupNotice } from "@/server/jobs/cleanup-queue";
import { queuePortalReset } from "@/server/portal-engine/queue";
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

// The type's testbeds that can take a booking (live, group pk stored), in
// lower(name) order: the assignment order of spec 0004 AC-5.
export async function bookableTestbedsOfType(
  conn: Kysely<DB>,
  testbedTypeId: string,
): Promise<readonly { readonly id: string; readonly name: string }[]> {
  return conn
    .selectFrom("testbeds")
    .select(["id", "name"])
    .where("testbed_type_id", "=", testbedTypeId)
    .where("deleted_at", "is", null)
    .where("authentik_group_pk", "is not", null)
    .orderBy(sql`lower(name)`)
    .orderBy("id")
    .execute();
}

// The database clock (spec 0001: the DB is the clock). Inside a transaction
// this is the transaction's start time.
export async function dbNow(conn: Kysely<DB>): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`select now() as now`.execute(conn);
  const [row] = rows;
  if (!row) throw new Error("select now() returned no row");
  return row.now;
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
  // Spec 0021 AC-3: with a live CLEANUP key, a Current booking's old slot is
  // read first (the caller holds the row FOR UPDATE; Current is decided in
  // SQL, the database being the clock).
  // Spec 0023 AC-3 needs the old slot too, so it is always read.
  const old = await trx
    .selectFrom("bookings")
    .select([
      "testbed_id",
      "starts_at",
      "ends_at",
      sql<boolean>`starts_at <= now()`.as("was_current"),
    ])
    .where("id", "=", r.id)
    .where("status", "=", "confirmed")
    .where("ends_at", ">", sql<Date>`now()`)
    .where("version", "=", r.expectedVersion)
    .forUpdate()
    .executeTakeFirst();
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
  if (!row) return err("stale");
  // Spec 0013 AC-6: the rescheduled notice, in this transaction.
  await queueBookingNotice(trx, r.id, row.version, "rescheduled");
  if (old?.was_current) {
    if (await cleanupHookOn(trx))
      await queueCleanupNotice(trx, {
        bookingId: r.id,
        version: row.version,
        event: "booking.moved",
        oldTestbedId: old.testbed_id,
        oldStartsAt: old.starts_at,
        oldEndsAt: old.ends_at,
      });
    // Spec 0023 AC-3: the old testbed gets a portal reset.
    await queuePortalReset(trx, {
      bookingId: r.id,
      testbedId: old.testbed_id,
      version: row.version,
      event: "moved",
    });
  }
  return ok(row);
}

export type Cancel = Guard & {
  readonly source: CancelSource;
  // Null when the system cancelled (deactivation sweep).
  readonly byUserId: string | null;
};

// Keeps ends_at: access ends because the status is no longer live. Every
// cancel (learner, admin, deactivation) queues the learner's one
// cancellation notice in this transaction (spec 0013 AC-6, AC-13).
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
    .returning([
      "version",
      "testbed_id",
      "starts_at",
      "ends_at",
      sql<boolean>`starts_at <= now()`.as("was_current"),
    ])
    .executeTakeFirst();
  if (!row) return err("stale");
  await queueBookingNotice(trx, c.id, row.version, "cancelled");
  // Spec 0021 AC-2: only a Current booking (confirmed, started, not ended)
  // frees its testbed early, and only with a live CLEANUP key.
  if (row.was_current && (await cleanupHookOn(trx)))
    await queueCleanupNotice(trx, {
      bookingId: c.id,
      version: row.version,
      event: "booking.ended_early",
      oldTestbedId: row.testbed_id,
      oldStartsAt: row.starts_at,
      oldEndsAt: row.ends_at,
    });
  // Spec 0023 AC-3: the same Current rule queues a portal reset.
  if (row.was_current)
    await queuePortalReset(trx, {
      bookingId: c.id,
      testbedId: row.testbed_id,
      version: row.version,
      event: "ended_early",
    });
  return ok({ version: row.version });
}
