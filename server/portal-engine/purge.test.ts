import { sql } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
} from "@/server/db/testing";
import { purgePortalResetRuns } from "./purge";

afterAll(() => db().destroy());

// covers: AC-29 (retention)
describe.skipIf(!hasDb)("purgePortalResetRuns", () => {
  it("drops runs finished over 30 days ago with their items, never an unfinished run, never the audit log", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const testbed = await makeTestbed(trx, type.id);
      const make = async (state: string, finished: string | null) => {
        const { rows } = await sql<{ id: string }>`
          insert into hol_app.portal_reset_runs
            (testbed_id, ended_key, event, mode, lab_ended_at, due_at, state,
             abort_reason, finished_at)
          values (${testbed.id}::uuid, ${crypto.randomUUID()}, 'lab_ended',
            'live', now(), now(), ${state},
            ${state === "aborted" ? "crashed" : null},
            ${finished === null ? null : sql.raw(finished)})
          returning id`.execute(trx);
        const id = rows[0]?.id ?? "";
        await sql`
          insert into hol_app.portal_reset_run_items
            (run_id, seq, step_key, kind, pass)
          values (${id}::uuid, 1, 's', 'deleted', 1)`.execute(trx);
        return id;
      };
      const old = await make("done", "now() - interval '31 days'");
      const recent = await make("done", "now() - interval '29 days'");
      const running = await make("running", null);
      await trx
        .insertInto("audit_events")
        .values({
          actor_user_id: null,
          action: "portal_reset.run_finished",
          target_type: "portal_reset_run",
          target_id: old,
          summary: "kept",
          metadata: "{}",
        })
        .execute();
      expect(await purgePortalResetRuns(asConn(trx))).toBeGreaterThanOrEqual(1);
      const left = await trx
        .selectFrom("portal_reset_runs")
        .select("id")
        .where("id", "in", [old, recent, running])
        .execute();
      expect(left.map((r) => r.id).sort()).toEqual([recent, running].sort());
      const items = await trx
        .selectFrom("portal_reset_run_items")
        .select("run_id")
        .where("run_id", "=", old)
        .execute();
      expect(items).toEqual([]);
      const audit = await trx
        .selectFrom("audit_events")
        .select("id")
        .where("target_id", "=", old)
        .execute();
      expect(audit).toHaveLength(1);
    }));
});
