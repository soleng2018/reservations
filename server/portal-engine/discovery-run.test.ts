import { sql, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { ok } from "@/lib/result";
import { db } from "@/server/db";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { claimDueRun } from "./claim";
import { executeRun, type RunDeps } from "./run";
import { makeFake } from "./testing";

afterAll(() => db().destroy());

async function start(trx: Transaction<DB>, minutesAgo = 6) {
  await trx
    .updateTable("portal_reset_settings")
    .set({ mode: "live", abort_email: "owner@example.test" })
    .execute();
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  await sql`
    insert into hol_app.portal_reset_runs
      (testbed_id, ended_key, event, mode, lab_ended_at, due_at)
    values (${testbed.id}::uuid, ${crypto.randomUUID()}, 'lab_ended', 'live',
      now() - make_interval(mins => ${minutesAgo}), now())`.execute(trx);
  const conn = asConn(trx);
  const run = await claimDueRun(conn);
  if (!run) throw new Error("no run claimed");
  return { conn, run };
}

const deps = (
  conn: RunDeps["conn"],
  discover: RunDeps["discover"],
): RunDeps => ({
  conn,
  signIn: async () => ok(makeFake().portal),
  runStep: async () => "done",
  recheckStep: async () => true,
  shouldStop: () => false,
  discover,
});

const row = (trx: Transaction<DB>, id: string) =>
  trx
    .selectFrom("portal_reset_runs")
    .select(["state", "counts", "progress"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

describe.skipIf(!hasDb)("discovery inside a run (AC-19, AC-38)", () => {
  it("runs once, and a route it could not clear makes the run incomplete", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      let calls = 0;
      await executeRun(
        run,
        deps(conn, async () => {
          calls += 1;
          return { failed: true, counts: { discoveryPages: 4 } };
        }),
      );
      expect(calls).toBe(1);
      const r = await row(trx, run.id);
      expect(r.state).toBe("incomplete");
      expect(r.counts).toMatchObject({ discoveryPages: 4 });
    }));

  it("a clean discovery leaves the run done", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      await executeRun(
        run,
        deps(conn, async () => ({
          failed: false,
          counts: { discoveryRoutes: 0 },
        })),
      );
      expect((await row(trx, run.id)).state).toBe("done");
    }));

  it("does not start after 15 minutes from the lab end, and says so", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx, 16);
      let calls = 0;
      await executeRun(
        run,
        deps(conn, async () => {
          calls += 1;
          return { failed: false, counts: {} };
        }),
      );
      expect(calls).toBe(0);
      const r = await row(trx, run.id);
      expect(r.state).toBe("done");
      expect(r.counts).toMatchObject({ discoverySkippedForTime: 1 });
    }));

  it("a resumed run does not discover twice", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      await sql`
        update hol_app.portal_reset_runs
        set progress = ${JSON.stringify({
          phase: 2,
          done: [],
          failed: [],
          bad: [],
          discovered: true,
          discoveryFailed: false,
          discovery: {},
        })}::jsonb
        where id = ${run.id}::uuid`.execute(trx);
      let calls = 0;
      await executeRun(
        {
          ...run,
          progress: {
            phase: 2,
            done: [],
            failed: [],
            bad: [],
            discovered: true,
          },
        },
        deps(conn, async () => {
          calls += 1;
          return { failed: false, counts: {} };
        }),
      );
      expect(calls).toBe(0);
    }));
});
