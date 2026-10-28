import "server-only";
import { sql, type Kysely } from "kysely";
import type { PortalResetEvent } from "@/lib/db-enums";
import { LOOKBACK, START_DELAY } from "@/lib/portal-reset/timing";
import type { DB } from "@/server/db/types";

// Queueing a reset run (spec 0023 AC-1 to AC-3). The database is the clock:
// every time here is SQL `now()` or a column. A run is queued only while the
// saved mode is dry_run or live, for a live testbed with a domain.

const secs = (ms: number) => ms / 1000;

export type EarlyEnd = {
  readonly bookingId: string;
  readonly testbedId: string;
  readonly version: number;
  readonly event: Exclude<PortalResetEvent, "lab_ended">;
};

// AC-3: a Current booking that is cancelled or moved queues one run in the
// caller's transaction, so the run exists if and only if the change commits.
// One insert; it never fails the cancel (a repeat is a no-op on `ended_key`).
export async function queuePortalReset(
  trx: Kysely<DB>,
  e: EarlyEnd,
): Promise<void> {
  const prefix = e.event === "ended_early" ? "early" : "moved";
  await sql`
    insert into hol_app.portal_reset_runs
      (testbed_id, booking_id, ended_key, event, mode, lab_ended_at, due_at)
    select t.id, ${e.bookingId}::uuid, ${`${prefix}:${e.bookingId}:${e.version}`},
      ${e.event}, s.mode, now(), now() + make_interval(secs => ${secs(START_DELAY)})
    from hol_app.portal_reset_settings s, hol_app.testbeds t
    where s.mode in ('dry_run', 'live')
      and t.id = ${e.testbedId}::uuid
      and t.deleted_at is null
      and t.domain is not null
    on conflict (ended_key) do nothing`.execute(trx);
}

// AC-2: the worker step. A booking that ended normally in the last 45
// minutes, and not before the mode was last changed, gets one run. Returns
// how many were queued.
export async function queueEndedResets(conn: Kysely<DB>): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    insert into hol_app.portal_reset_runs
      (testbed_id, booking_id, ended_key, event, mode, lab_ended_at, due_at)
    select t.id, b.id,
      'end:' || b.id || ':' || floor(extract(epoch from b.ends_at))::bigint,
      'lab_ended', s.mode, b.ends_at,
      b.ends_at + make_interval(secs => ${secs(START_DELAY)})
    from hol_app.bookings b
    join hol_app.testbeds t on t.id = b.testbed_id
    cross join hol_app.portal_reset_settings s
    where s.mode in ('dry_run', 'live')
      and b.status in ('confirmed', 'completed')
      and b.ends_at <= now()
      and b.ends_at > now() - make_interval(secs => ${secs(LOOKBACK)})
      and b.ends_at >= coalesce(s.mode_changed_at, '-infinity'::timestamptz)
      and t.deleted_at is null
      and t.domain is not null
    on conflict (ended_key) do nothing
    returning id`.execute(conn);
  return rows.length;
}
