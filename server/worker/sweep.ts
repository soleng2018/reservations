import "server-only";
import { sql, type Kysely } from "kysely";
import type { CoreApi } from "@/server/authentik/client";
import { compensateGuestSaga } from "@/server/booking/guest-booking";
import { HAS_NO_BOOKINGS, staleProvisioning } from "@/server/db/guest-saga";
import type { DB } from "@/server/db/types";

// The worker's sweepers (spec 0004 AC-11). Each handles its rows one by one
// and logs a failed row without stopping the rest.

// Confirmed bookings whose window is over become completed.
export async function completeEnded(conn: Kysely<DB>): Promise<number> {
  const done = await conn
    .updateTable("bookings")
    .set({ status: "completed" })
    .where("status", "=", "confirmed")
    .where("ends_at", "<=", sql<Date>`now()`)
    .returning("id")
    .execute();
  return done.length;
}

// Guest sagas stuck in provisioning for over 10 minutes are compensated
// (booking, plus the Authentik user and row that saga created).
export async function sweepGuestSagas(
  api: CoreApi,
  conn: Kysely<DB>,
): Promise<number> {
  const stale = await staleProvisioning(conn);
  for (const ref of stale) await compensateGuestSaga(api, conn, ref);
  return stale.length;
}

// Spec 0008 AC-12: learner rows an add saga left with no Authentik pk (it
// crashed before storing one), 10 minutes on. "No pk, no bookings" is checked
// again in each delete, so a row a guest booking picked up meanwhile stays.
export async function sweepUnlinkedLearners(conn: Kysely<DB>): Promise<number> {
  const rows = await conn
    .selectFrom("users")
    .select("id")
    .where("role", "=", "learner")
    .where("authentik_user_pk", "is", null)
    .where("created_at", "<", sql<Date>`now() - interval '10 minutes'`)
    .where(HAS_NO_BOOKINGS)
    .execute();
  return rows.reduce<Promise<number>>(async (count, row) => {
    const n = await count;
    try {
      const gone = await conn
        .deleteFrom("users")
        .where("id", "=", row.id)
        .where("role", "=", "learner")
        .where("authentik_user_pk", "is", null)
        .where(HAS_NO_BOOKINGS)
        .executeTakeFirst();
      return Number(gone.numDeletedRows) > 0 ? n + 1 : n;
    } catch (e) {
      console.error(`worker: unlinked learner ${row.id} delete failed`, e);
      return n;
    }
  }, Promise.resolve(0));
}

// Rate limit buckets end within an hour; keep two for safety.
export async function purgeRateLimits(conn: Kysely<DB>): Promise<number> {
  const gone = await conn
    .deleteFrom("rate_limits")
    .where("window_start", "<", sql<Date>`now() - interval '2 hours'`)
    .executeTakeFirst();
  return Number(gone.numDeletedRows);
}
