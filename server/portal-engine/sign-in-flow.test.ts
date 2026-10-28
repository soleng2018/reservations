import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
  makeUser,
  slot,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import { claimDueRun, settleHeldRuns } from "./claim";
import { executeRun, type RunDeps, type SignInError } from "./run";
import { SessionLost } from "./stop";
import { ok } from "@/lib/result";
import { makeFake } from "./testing";

afterAll(() => db().destroy());

const deps = (conn: Kysely<DB>, signIn: RunDeps["signIn"]): RunDeps => ({
  conn,
  signIn,
  runStep: async () => "done",
  recheckStep: async () => true,
  shouldStop: () => false,
});

const failing =
  (error: SignInError): RunDeps["signIn"] =>
  async () => ({ ok: false, error });

async function start(trx: Transaction<DB>, mode: "live" | "dry_run" = "live") {
  await trx.updateTable("portal_reset_settings").set({ mode }).execute();
  await trx
    .updateTable("portal_reset_settings")
    .set({ abort_email: "owner@example.test" })
    .execute();
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  await sql`
    insert into hol_app.portal_reset_runs
      (testbed_id, ended_key, event, mode, lab_ended_at, due_at)
    values (${testbed.id}::uuid, ${crypto.randomUUID()}, 'lab_ended',
      ${mode}, now(), now())`.execute(trx);
  const conn = asConn(trx);
  const run = await claimDueRun(conn);
  if (!run) throw new Error("no run claimed");
  return { conn, run, testbed, type };
}

const stateOf = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("portal_reset_runs")
    .select(["state", "abort_reason", "sign_in_reason", "report_note"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const actions = async (trx: Kysely<DB>, id: string) =>
  (
    await trx
      .selectFrom("audit_events")
      .select("action")
      .where("target_id", "=", id)
      .orderBy("action")
      .execute()
  ).map((a) => a.action);

const jobKeys = async (trx: Kysely<DB>, id: string) =>
  (
    await trx
      .selectFrom("jobs")
      .select("idempotency_key")
      .where("kind", "=", "send_reset_report")
      .where("idempotency_key", "like", `reset-report:${id}%`)
      .orderBy("idempotency_key")
      .execute()
  ).map((j) => j.idempotency_key);

describe.skipIf(!hasDb)("sign in failures (AC-14, AC-15)", () => {
  it("holds the run on a refused password, audits once, and emails at once", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      await executeRun(
        run,
        deps(conn, failing({ kind: "sign_in", reason: "idp_rejected" })),
      );
      expect(await stateOf(trx, run.id)).toEqual({
        state: "held",
        abort_reason: null,
        sign_in_reason: "idp_rejected",
        report_note: "queued",
      });
      expect(await actions(trx, run.id)).toEqual([
        "portal_reset.sign_in_failed",
      ]);
      expect(await jobKeys(trx, run.id)).toEqual([
        `reset-report:${run.id}:held`,
      ]);
    }));

  it("holds on credential_failed too, and sends no email in a dry run", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx, "dry_run");
      await executeRun(
        run,
        deps(conn, failing({ kind: "sign_in", reason: "credential_failed" })),
      );
      expect((await stateOf(trx, run.id)).state).toBe("held");
      expect(await jobKeys(trx, run.id)).toEqual([]);
    }));

  it("ends a transient failure aborted, with the reason, one audit row, and one email", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      await executeRun(
        run,
        deps(conn, failing({ kind: "sign_in", reason: "token_missing" })),
      );
      expect(await stateOf(trx, run.id)).toMatchObject({
        state: "aborted",
        abort_reason: "sign_in_failed",
        sign_in_reason: "token_missing",
        report_note: "queued",
      });
      expect(await actions(trx, run.id)).toEqual([
        "portal_reset.run_aborted",
        "portal_reset.sign_in_failed",
      ]);
      expect(await jobKeys(trx, run.id)).toEqual([`reset-report:${run.id}`]);
    }));

  it("audit rows carry the testbed, the domain, and the reason, nothing else", () =>
    inRollback(async (trx) => {
      const { conn, run, testbed } = await start(trx);
      await executeRun(
        run,
        deps(conn, failing({ kind: "sign_in", reason: "idp_rejected" })),
      );
      const row = await trx
        .selectFrom("audit_events")
        .select("metadata")
        .where("target_id", "=", run.id)
        .where("action", "=", "portal_reset.sign_in_failed")
        .executeTakeFirstOrThrow();
      expect(row.metadata).toEqual({
        testbedId: testbed.id,
        domain: testbed.domain,
        reason: "idp_rejected",
      });
    }));

  it.each(["tenant_mismatch", "testbed_unavailable"] as const)(
    "ends %s with that reason and an email",
    (kind) =>
      inRollback(async (trx) => {
        const { conn, run } = await start(trx);
        await executeRun(run, deps(conn, failing({ kind })));
        expect(await stateOf(trx, run.id)).toMatchObject({
          state: "aborted",
          abort_reason: kind,
        });
        expect(await jobKeys(trx, run.id)).toEqual([`reset-report:${run.id}`]);
      }),
  );

  it("a second 401 mid run ends it as a sign in failure", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      const { portal } = makeFake();
      await executeRun(run, {
        ...deps(conn, async () => ok(portal)),
        runStep: async () => {
          throw new SessionLost("token_missing");
        },
      });
      expect(await stateOf(trx, run.id)).toMatchObject({
        state: "aborted",
        abort_reason: "sign_in_failed",
        sign_in_reason: "token_missing",
      });
    }));
});

describe.skipIf(!hasDb)("a held run (AC-14)", () => {
  const held = async (trx: Transaction<DB>, minutesAgo: number) => {
    const s = await start(trx);
    await executeRun(
      s.run,
      deps(s.conn, failing({ kind: "sign_in", reason: "idp_rejected" })),
    );
    await sql`
      update hol_app.portal_reset_runs
      set lease_until = now() - make_interval(mins => ${minutesAgo})
      where id = ${s.run.id}::uuid`.execute(trx);
    return s;
  };

  it("waits until 30 minutes have passed", () =>
    inRollback(async (trx) => {
      const s = await held(trx, 29);
      await settleHeldRuns(s.conn);
      expect((await stateOf(trx, s.run.id)).state).toBe("held");
    }));

  it("goes back to the queue after 30 minutes with no lab, and is claimed again", () =>
    inRollback(async (trx) => {
      const s = await held(trx, 31);
      const again = await claimDueRun(s.conn);
      expect(again?.id).toBe(s.run.id);
      expect((await stateOf(trx, s.run.id)).state).toBe("running");
    }));

  it("is not tried again while a lab is Current, and ends lab_started with a second email", () =>
    inRollback(async (trx) => {
      const s = await held(trx, 31);
      const user = await makeUser(trx);
      await trx
        .insertInto("bookings")
        .values({
          user_id: user.id,
          testbed_id: s.testbed.id,
          testbed_type_id: s.type.id,
          starts_at: slot(-0.5),
          ends_at: slot(1),
          status: "confirmed",
        })
        .execute();
      await settleHeldRuns(s.conn);
      expect(await stateOf(trx, s.run.id)).toMatchObject({
        state: "aborted",
        abort_reason: "lab_started",
      });
      expect(await jobKeys(trx, s.run.id)).toEqual([
        `reset-report:${s.run.id}`,
        `reset-report:${s.run.id}:held`,
      ]);
    }));

  it("blocks no other run on its testbed", () =>
    inRollback(async (trx) => {
      const s = await held(trx, 1);
      await sql`
        insert into hol_app.portal_reset_runs
          (testbed_id, ended_key, event, mode, lab_ended_at, due_at)
        values (${s.testbed.id}::uuid, ${crypto.randomUUID()}, 'lab_ended',
          'live', now(), now())`.execute(trx);
      const next = await claimDueRun(s.conn);
      expect(next).toBeDefined();
      expect(next?.id).not.toBe(s.run.id);
    }));
});
