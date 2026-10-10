import "server-only";
import { sql, type Kysely } from "kysely";
import type { CoreApi } from "@/server/authentik/client";
import { compensateGuestSaga } from "@/server/booking/guest-booking";
import { undoTestbedCreate } from "@/server/catalog/testbeds";
import { staleProvisioning } from "@/server/db/guest-saga";
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

// Testbed creates that never stored a group pk, 10 minutes on, are undone:
// `pod-<slug>` goes only if it carries the row's id, then the row.
export async function sweepTestbedCreates(
  api: CoreApi,
  conn: Kysely<DB>,
): Promise<number> {
  const rows = await conn
    .selectFrom("testbeds")
    .select("id")
    .where("authentik_group_pk", "is", null)
    .where("created_at", "<", sql<Date>`now() - interval '10 minutes'`)
    .execute();
  const undone = await rows.reduce<Promise<number>>(async (count, row) => {
    const n = await count;
    try {
      const r = await undoTestbedCreate(api, conn, row.id);
      if (!r.ok) console.error(`worker: testbed ${row.id} undo: ${r.error}`);
      return r.ok && r.value ? n + 1 : n;
    } catch (e) {
      console.error(`worker: testbed ${row.id} undo failed`, e);
      return n;
    }
  }, Promise.resolve(0));
  return undone;
}

// Rate limit buckets end within an hour; keep two for safety.
export async function purgeRateLimits(conn: Kysely<DB>): Promise<number> {
  const gone = await conn
    .deleteFrom("rate_limits")
    .where("window_start", "<", sql<Date>`now() - interval '2 hours'`)
    .executeTakeFirst();
  return Number(gone.numDeletedRows);
}
