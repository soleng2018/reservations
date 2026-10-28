import "server-only";
import { sql, type Kysely } from "kysely";
import type { PortalResetAbortReason } from "@/lib/db-enums";
import { audit } from "@/server/audit";
import type { DB } from "@/server/db/types";
import type { ItemRecord } from "./interpret";

// Ending a run (spec 0023 AC-8, AC-29, AC-31): one transaction writes the
// outcome, the run level audit row, and the report email job. Item records
// are saved as the run goes (`appendItems`), so a resume or a crash keeps
// them and the counts are read back from them, never held in memory.
export type Counts = Readonly<Record<string, number>>;

// What a guard stop adds to the audit (AC-25): the step and a route pattern,
// never a value.
export type GuardNote = {
  readonly stepKey: string | null;
  readonly route: string;
};

export type Finish =
  | {
      readonly kind: "done" | "incomplete";
      readonly counts: Counts;
      readonly mode: "dry_run" | "live";
      // Steps whose first pass failure the second pass fixed (AC-28).
      readonly resolvedSteps?: readonly string[];
    }
  | {
      readonly kind: "aborted";
      readonly reason: PortalResetAbortReason;
      readonly counts: Counts;
      readonly guard?: GuardNote;
    };

const cut = (text: string | null, max: number): string | null =>
  text === null ? null : text.slice(0, max);

// Save what a step recorded (AC-28). The sequence continues from the run's
// last row, so a resumed run appends. Lengths are cut to the column checks;
// the message is already redacted text.
export async function appendItems(
  conn: Kysely<DB>,
  runId: string,
  records: readonly ItemRecord[],
): Promise<void> {
  if (records.length === 0) return;
  await conn.transaction().execute(async (trx) => {
    const last = await trx
      .selectFrom("portal_reset_run_items")
      .select((eb) => eb.fn.max("seq").as("seq"))
      .where("run_id", "=", runId)
      .executeTakeFirst();
    const base = last?.seq ?? 0;
    await trx
      .insertInto("portal_reset_run_items")
      .values(
        records.map((r, i) => ({
          run_id: runId,
          seq: base + i + 1,
          step_key: r.stepKey.slice(0, 80),
          kind: r.kind,
          label: cut(r.label, 120),
          item_id: cut(r.itemId, 200),
          method: r.method,
          route: cut(r.route, 200),
          status: r.status,
          message: r.message,
          pass: r.pass,
        })),
      )
      .execute();
  });
}

// The numbers of a run, from its saved rows (AC-8). `failed` counts only
// failures the second pass did not fix.
async function itemCounts(trx: Kysely<DB>, runId: string): Promise<Counts> {
  const { rows } = await sql<{ kind: string; resolved: boolean; n: string }>`
    select kind, resolved, count(*)::text as n
    from hol_app.portal_reset_run_items
    where run_id = ${runId}::uuid
    group by kind, resolved`.execute(trx);
  return rows.reduce<Record<string, number>>((acc, r) => {
    const key =
      r.kind === "failed" ? (r.resolved ? "resolved" : "failed") : r.kind;
    return { ...acc, [key]: (acc[key] ?? 0) + Number(r.n) };
  }, {});
}

export const reportKey = (runId: string) => `reset-report:${runId}`;

// AC-31: a live run that was aborted (not by `mode_off`), ended incomplete, or
// found a route is reported. A dry run, a done run, and `mode_off` are not.
const needsReport = (f: Finish, mode: string, counts: Counts): boolean =>
  mode === "live" &&
  (f.kind === "incomplete" ||
    (f.kind === "aborted" && f.reason !== "mode_off") ||
    (counts.route_found ?? 0) > 0);

async function queueReport(trx: Kysely<DB>, runId: string): Promise<void> {
  const settings = await trx
    .selectFrom("portal_reset_settings")
    .select("abort_email")
    .executeTakeFirst();
  const address = settings?.abort_email ?? null;
  if (address !== null) {
    await trx
      .insertInto("jobs")
      .values({
        kind: "send_reset_report",
        // The id only: the address and the body are read at send time.
        payload: JSON.stringify({ runId }),
        idempotency_key: reportKey(runId),
      })
      .onConflict((oc) => oc.column("idempotency_key").doNothing())
      .execute();
  }
  await trx
    .updateTable("portal_reset_runs")
    .set({ report_note: address === null ? "no_address" : "queued" })
    .where("id", "=", runId)
    .execute();
}

// Only a `running` run ends, so a run whose lease was taken over cannot be
// finished twice. Returns whether this call ended it.
export async function finishRunIn(
  trx: Kysely<DB>,
  runId: string,
  f: Finish,
): Promise<boolean> {
  const { rows } = await sql<{ mode: string }>`
    update hol_app.portal_reset_runs
    set state = ${f.kind}, abort_reason = ${f.kind === "aborted" ? f.reason : null},
      lease_until = null, finished_at = now(), report_note = 'not_needed'
    where id = ${runId}::uuid and state = 'running'
    returning mode`.execute(trx);
  const ended = rows[0];
  if (!ended) return false;
  if (f.kind !== "aborted" && f.resolvedSteps !== undefined) {
    await sql`
      update hol_app.portal_reset_run_items
      set resolved = true
      where run_id = ${runId}::uuid and kind = 'failed' and pass = 1
        and step_key = any(${f.resolvedSteps}::text[])`.execute(trx);
  }
  const counts: Counts = { ...f.counts, ...(await itemCounts(trx, runId)) };
  await sql`
    update hol_app.portal_reset_runs
    set counts = ${JSON.stringify(counts)}::jsonb
    where id = ${runId}::uuid`.execute(trx);
  await audit(trx, {
    actorUserId: null,
    action:
      f.kind === "aborted"
        ? "portal_reset.run_aborted"
        : "portal_reset.run_finished",
    targetType: "portal_reset_run",
    targetId: runId,
    summary:
      f.kind === "aborted"
        ? `Portal reset aborted: ${f.reason}`
        : `Portal reset ${f.kind}`,
    metadata:
      f.kind === "aborted"
        ? { reason: f.reason, counts }
        : { outcome: f.kind, mode: f.mode, counts },
  });
  if (f.kind === "aborted" && f.guard !== undefined) {
    await audit(trx, {
      actorUserId: null,
      action: "portal_reset.guard_stop",
      targetType: "portal_reset_run",
      targetId: runId,
      summary: "Portal reset stopped by a guard",
      metadata: { stepKey: f.guard.stepKey, route: f.guard.route },
    });
  }
  if (needsReport(f, ended.mode, counts)) await queueReport(trx, runId);
  return true;
}

export const finishRun = (
  conn: Kysely<DB>,
  runId: string,
  f: Finish,
): Promise<boolean> =>
  conn.transaction().execute((trx) => finishRunIn(trx, runId, f));
