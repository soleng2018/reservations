import "server-only";
import { sql, type Kysely } from "kysely";
import type { PortalResetAbortReason } from "@/lib/db-enums";
import { audit } from "@/server/audit";
import type { DB } from "@/server/db/types";

// Ending a run (spec 0023 AC-8, AC-29): one transaction writes the outcome
// and the run level audit row. The report email joins it with task 7.
export type Counts = Readonly<Record<string, number>>;

export type Finish =
  | {
      readonly kind: "done" | "incomplete";
      readonly counts: Counts;
      readonly mode: "dry_run" | "live";
    }
  | {
      readonly kind: "aborted";
      readonly reason: PortalResetAbortReason;
      readonly counts: Counts;
    };

// Only a `running` run ends, so a run whose lease was taken over cannot be
// finished twice. Returns whether this call ended it.
export async function finishRunIn(
  trx: Kysely<DB>,
  runId: string,
  f: Finish,
): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`
    update hol_app.portal_reset_runs
    set state = ${f.kind}, abort_reason = ${f.kind === "aborted" ? f.reason : null},
      counts = ${JSON.stringify(f.counts)}::jsonb, lease_until = null,
      finished_at = now(), report_note = 'not_needed'
    where id = ${runId}::uuid and state = 'running'
    returning id`.execute(trx);
  if (rows.length === 0) return false;
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
        ? { reason: f.reason, counts: f.counts }
        : { outcome: f.kind, mode: f.mode, counts: f.counts },
  });
  return true;
}

export const finishRun = (
  conn: Kysely<DB>,
  runId: string,
  f: Finish,
): Promise<boolean> =>
  conn.transaction().execute((trx) => finishRunIn(trx, runId, f));
