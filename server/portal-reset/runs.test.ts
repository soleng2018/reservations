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
import { listRuns, readRun } from "./runs";

afterAll(() => db().destroy());

describe.skipIf(!hasDb)("recent resets (AC-32)", () => {
  it("lists runs newest first with their counts, and pages the items 200 at a time", () =>
    inRollback(async (trx) => {
      const type = await makeType(trx);
      const tb = await makeTestbed(trx, type.id, { name: "Reset testbed" });
      const run = await sql<{ id: string }>`
        insert into hol_app.portal_reset_runs
          (testbed_id, ended_key, event, mode, lab_ended_at, due_at, state,
           counts)
        values (${tb.id}::uuid, ${crypto.randomUUID()}, 'lab_ended', 'live',
          now() + interval '1 day', now(), 'done', '{"deleted": 3}'::jsonb)
        returning id`.execute(trx);
      const id = run.rows[0]?.id ?? "";
      await sql`
        insert into hol_app.portal_reset_run_items
          (run_id, seq, step_key, kind, label, pass)
        select ${id}::uuid, g, 'step', 'deleted', 'Item ' || g, 1
        from generate_series(1, 250) g`.execute(trx);

      const runs = await listRuns(asConn(trx));
      expect(runs[0]).toMatchObject({
        id,
        testbedName: "Reset testbed",
        state: "done",
        counts: { deleted: 3 },
      });

      const first = await readRun(asConn(trx), id, 1);
      expect(first?.items).toHaveLength(200);
      expect(first).toMatchObject({ total: 250, pages: 2, page: 1 });
      const second = await readRun(asConn(trx), id, 2);
      expect(second?.items).toHaveLength(50);
      expect(second?.items[0]?.seq).toBe(201);
      // A page past the end shows the last one.
      expect((await readRun(asConn(trx), id, 9))?.page).toBe(2);
    }));

  it("answers undefined for an unknown run", () =>
    inRollback(async (trx) => {
      expect(
        await readRun(asConn(trx), crypto.randomUUID(), 1),
      ).toBeUndefined();
    }));
});
