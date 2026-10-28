import "server-only";
import { sql, type Kysely } from "kysely";
import type { PortalResetRunMode } from "@/lib/db-enums";
import { HARD_CAP, LEASE, START_MARGIN } from "@/lib/portal-reset/timing";
import type { DB } from "@/server/db/types";
import { finishRunIn } from "./report";

// Claiming a due run, the stop check, and the lease (spec 0023 AC-4 to AC-6,
// AC-9). Every comparison is the database clock.

const secs = (ms: number) => ms / 1000;

export type ClaimedRun = {
  readonly id: string;
  readonly testbedId: string;
  readonly bookingId: string | null;
  readonly mode: PortalResetRunMode;
  readonly labEndedAt: Date;
  readonly resumes: number;
};

// A queued run whose `due_at` has passed, or a running run whose lease has
// expired (resumed, at most 3 times). A testbed with another running run
// waits (the unique index would refuse it anyway). The run's `mode` follows
// the saved mode at the claim; an `off` mode is left for the stop check to
// end as `mode_off`.
export async function claimDueRun(
  conn: Kysely<DB>,
): Promise<ClaimedRun | undefined> {
  return conn.transaction().execute(async (trx) => {
    const { rows } = await sql<{
      id: string;
      testbed_id: string;
      booking_id: string | null;
      mode: PortalResetRunMode;
      lab_ended_at: Date;
      resumes: number;
      was_running: boolean;
    }>`
      select r.id, r.testbed_id, r.booking_id, r.mode, r.lab_ended_at,
        r.resumes, r.state = 'running' as was_running
      from hol_app.portal_reset_runs r
      where (
          (r.state = 'queued' and r.due_at <= now()
            and not exists (
              select 1 from hol_app.portal_reset_runs o
              where o.testbed_id = r.testbed_id and o.state = 'running'))
          or (r.state = 'running' and r.lease_until < now())
        )
      order by r.due_at
      for update skip locked
      limit 1`.execute(trx);
    const row = rows[0];
    if (!row) return undefined;
    // A fourth resume is a crash loop: end it (AC-9).
    if (row.was_running && row.resumes >= 3) {
      await finishRunIn(trx, row.id, {
        kind: "aborted",
        reason: "crashed",
        counts: {},
      });
      return undefined;
    }
    const claimed = await sql<{ mode: PortalResetRunMode }>`
      update hol_app.portal_reset_runs r
      set state = 'running',
        lease_until = now() + make_interval(secs => ${secs(LEASE)}),
        started_at = coalesce(r.started_at, now()),
        resumes = r.resumes + (case when ${row.was_running} then 1 else 0 end),
        mode = coalesce(
          (select s.mode from hol_app.portal_reset_settings s
            where s.mode in ('dry_run', 'live')),
          r.mode)
      where r.id = ${row.id}::uuid
      returning r.mode`.execute(trx);
    return {
      id: row.id,
      testbedId: row.testbed_id,
      bookingId: row.booking_id,
      mode: claimed.rows[0]?.mode ?? row.mode,
      labEndedAt: row.lab_ended_at,
      resumes: row.resumes + (row.was_running ? 1 : 0),
    };
  });
}

export type StopReason = "mode_off" | "deadline" | "lab_started";
// `lost`: the run is no longer `running` (its lease was taken over).
export type Stop = "go" | "lost" | StopReason;

// AC-6: one query by the database clock, run before the first call and
// before every write and every step. It also renews the lease.
export async function stopCheck(
  conn: Kysely<DB>,
  runId: string,
): Promise<Stop> {
  const { rows } = await sql<{
    mode_off: boolean;
    past_cap: boolean;
    lab_active: boolean;
  }>`
    update hol_app.portal_reset_runs r
    set lease_until = now() + make_interval(secs => ${secs(LEASE)})
    where r.id = ${runId}::uuid and r.state = 'running'
    returning
      coalesce((select s.mode = 'off' from hol_app.portal_reset_settings s),
        true) as mode_off,
      now() >= r.lab_ended_at + make_interval(secs => ${secs(HARD_CAP)})
        as past_cap,
      exists (
        select 1 from hol_app.bookings b
        where b.testbed_id = r.testbed_id and b.status = 'confirmed'
          and b.starts_at <= now() + make_interval(secs => ${secs(START_MARGIN)})
          and b.ends_at > now()
      ) as lab_active`.execute(conn);
  const row = rows[0];
  if (!row) return "lost";
  return row.mode_off
    ? "mode_off"
    : row.past_cap
      ? "deadline"
      : row.lab_active
        ? "lab_started"
        : "go";
}

// AC-10: hand the run back with its progress, for the next claim.
export async function releaseRun(
  conn: Kysely<DB>,
  runId: string,
  progress: Readonly<Record<string, unknown>>,
): Promise<void> {
  await sql`
    update hol_app.portal_reset_runs
    set state = 'queued', lease_until = null,
      progress = ${JSON.stringify(progress)}::jsonb
    where id = ${runId}::uuid and state = 'running'`.execute(conn);
}
