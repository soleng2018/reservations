import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { ok } from "@/lib/result";
import type { GoogleMailConfig } from "@/server/catalog/api-keys";
import { db } from "@/server/db";
import {
  asConn,
  hasDb,
  inRollback,
  makeTestbed,
  makeType,
} from "@/server/db/testing";
import type { DB } from "@/server/db/types";
import {
  fakeGoogleFetch,
  serviceAccountCredentials,
} from "@/server/google/testing";
import type { MintToken } from "@/server/google/token";
import { reportKey } from "@/server/portal-engine/report";
import { runJobs } from "./runner";
import { runSendResetReport } from "./send-reset-report";

afterAll(() => db().destroy());

// covers: AC-29 (report_failed), AC-31 (the report job)

const config = (): GoogleMailConfig => ({
  id: crypto.randomUUID(),
  credentials: serviceAccountCredentials(),
  secretUpdatedAt: new Date("2026-10-15T00:00:00.000Z"),
  senderEmail: "labs@nile.example",
  calendarId: "c_abc@group.calendar.google.com",
  devInbox: "dev-inbox@nile.example",
  opsBcc: "ops@nile.example",
  stamp: crypto.randomUUID(),
});
const mint: MintToken = async () =>
  ok({ token: "t", expiresAt: Date.now() + 3_600_000 });

async function queued(trx: Transaction<DB>, email: string | null) {
  await trx
    .updateTable("jobs")
    .set({ status: "failed" })
    .where("status", "in", ["pending", "running"])
    .execute();
  await trx
    .updateTable("portal_reset_settings")
    .set({ abort_email: email })
    .execute();
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const { rows } = await sql<{ id: string }>`
    insert into hol_app.portal_reset_runs
      (testbed_id, ended_key, event, mode, lab_ended_at, due_at, state,
       counts, finished_at)
    values (${testbed.id}::uuid, ${crypto.randomUUID()}, 'lab_ended', 'live',
      now(), now(), 'incomplete', '{"failed": 1}', now())
    returning id`.execute(trx);
  const runId = rows[0]?.id ?? "";
  await sql`
    insert into hol_app.portal_reset_run_items
      (run_id, seq, step_key, kind, label, method, route, status, message, pass)
    values (${runId}::uuid, 1, 'segments', 'failed', 'Lab segment', 'DELETE',
      '/api/v1/segments/{id}', 409, 'Segment is in use', 2)`.execute(trx);
  await trx
    .insertInto("jobs")
    .values({
      kind: "send_reset_report",
      payload: JSON.stringify({ runId }),
      idempotency_key: reportKey(runId),
    })
    .execute();
  return runId;
}

const go = (trx: Transaction<DB>, google: ReturnType<typeof fakeGoogleFetch>) =>
  runJobs(asConn(trx), {
    handlers: { send_reset_report: runSendResetReport },
    config: async () => config(),
    fetch: google.fetch,
    mint,
  });

const jobOf = (trx: Kysely<DB>, runId: string) =>
  trx
    .selectFrom("jobs")
    .select(["status", "payload"])
    .where("idempotency_key", "=", reportKey(runId))
    .executeTakeFirstOrThrow();

describe.skipIf(!hasDb)("send_reset_report", () => {
  it("sends one email to the saved address, rerouted for a test address, with the unresolved failure", () =>
    inRollback(async (trx) => {
      const runId = await queued(trx, "ops@example.com");
      const google = fakeGoogleFetch(() => ({
        status: 200,
        json: { id: "m1" },
      }));
      await go(trx, google);
      expect(google.requests).toHaveLength(1);
      const { raw } = JSON.parse(google.requests[0]?.body ?? "{}") as {
        raw: string;
      };
      const mime = Buffer.from(raw, "base64url")
        .toString("utf8")
        .replace(/=\r?\n/g, "");
      expect(mime).toContain("dev-inbox@nile.example");
      expect(mime).toContain("[dev] ");
      expect(mime).toContain("Segment is in use");
      expect(mime).not.toContain("ops@nile.example");
      expect((await jobOf(trx, runId)).status).toBe("done");
    }));

  it("sends nothing when the address was cleared", () =>
    inRollback(async (trx) => {
      const runId = await queued(trx, null);
      const google = fakeGoogleFetch(() => ({
        status: 200,
        json: { id: "m" },
      }));
      await go(trx, google);
      expect(google.requests).toHaveLength(0);
      expect((await jobOf(trx, runId)).status).toBe("done");
    }));

  it("a refusal from Gmail fails the job and writes report_failed", () =>
    inRollback(async (trx) => {
      const runId = await queued(trx, "ops@nile.example");
      const google = fakeGoogleFetch(() => ({ status: 400, json: {} }));
      await go(trx, google);
      expect((await jobOf(trx, runId)).status).toBe("failed");
      const rows = await trx
        .selectFrom("audit_events")
        .select(["action", "actor_user_id"])
        .where("target_id", "=", runId)
        .execute();
      expect(rows).toEqual([
        { action: "portal_reset.report_failed", actor_user_id: null },
      ]);
    }));
});
