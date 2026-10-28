import "server-only";
import { sql, type Kysely } from "kysely";
import { RETENTION_DAYS } from "@/lib/portal-reset/timing";
import type { DB } from "@/server/db/types";

// Spec 0023 AC-29: the daily purge. A run that finished more than 30 days ago
// goes, and its item records go with it (on delete cascade). A run that is
// queued, running, or held has no `finished_at` and is never touched. The
// permanent audit log is not part of this and is never deleted. The cutoff is
// the database clock.
export async function purgePortalResetRuns(conn: Kysely<DB>): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    delete from hol_app.portal_reset_runs
    where finished_at is not null
      and finished_at < now() - make_interval(days => ${RETENTION_DAYS})
    returning id`.execute(conn);
  return rows.length;
}
