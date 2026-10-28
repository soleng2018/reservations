import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { redactMessage } from "@/lib/portal-reset/redact";
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
import type { ItemRecord, StepEnv } from "./interpret";
import type { PortalClient } from "./portal";
import { executeRun, readProgress, type RunDeps } from "./run";
import { makeFake } from "./testing";

afterAll(() => db().destroy());

// Spec 0023 AC-8, AC-9, AC-10, AC-19, AC-28, AC-31, AC-33: the phases, the
// resume, the saved item records, and the report job. The interpreter is
// stubbed here (it has its own tests); the run, its tables, and the job
// queue are real.

const steps = async (trx: Kysely<DB>, names: readonly string[]) => {
  await trx.deleteFrom("portal_reset_steps").execute();
  await trx
    .insertInto("portal_reset_steps")
    .values(
      names.map((name, i) => ({
        position: i + 1,
        feature_name: name,
        seed_key: name,
        enabled: true,
        definition: JSON.stringify({ parts: [{ kind: "wait", seconds: 1 }] }),
      })),
    )
    .execute();
};

const settings = (
  trx: Kysely<DB>,
  mode: "dry_run" | "live",
  abortEmail: string | null,
) =>
  trx
    .updateTable("portal_reset_settings")
    .set({ mode, abort_email: abortEmail })
    .execute();

async function claimed(
  trx: Transaction<DB>,
  opts: { mode?: "dry_run" | "live"; email?: string | null; names?: string[] },
) {
  await steps(trx, opts.names ?? ["a", "b"]);
  await settings(
    trx,
    opts.mode ?? "live",
    opts.email === undefined ? "ops@nile.test" : opts.email,
  );
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  await sql`
    insert into hol_app.portal_reset_runs
      (testbed_id, ended_key, event, mode, lab_ended_at, due_at)
    values (${testbed.id}::uuid, ${crypto.randomUUID()}, 'lab_ended',
      ${opts.mode ?? "live"}, now(), now())`.execute(trx);
  const conn = asConn(trx);
  const run = await claimDueRun(conn);
  if (!run) throw new Error("no run claimed");
  return { conn, run };
}

const portal = (): { client: PortalClient; closed: () => boolean } => {
  const tenant = makeFake();
  let closed = false;
  return {
    client: {
      call: tenant.portal.call,
      close: async () => {
        closed = true;
      },
    },
    closed: () => closed,
  };
};

const failure = (stepKey: string, pass: 1 | 2, label: string): ItemRecord => ({
  stepKey,
  kind: "failed",
  label,
  itemId: label,
  method: "DELETE",
  route: "/api/v1/things/{id}",
  status: 500,
  message: redactMessage("boom"),
  pass,
});

type Stubs = {
  readonly run: (key: string, pass: 1 | 2, env: StepEnv) => Promise<boolean>;
  readonly recheck?: (key: string, pass: 1 | 2) => boolean;
  readonly stop?: () => boolean;
};

const deps = (conn: Kysely<DB>, p: PortalClient, s: Stubs): RunDeps => ({
  conn,
  signIn: async () => ok(p),
  runStep: async (step, env) =>
    (await s.run(step.seedKey ?? step.id, env.pass, env)) ? "done" : "failed",
  recheckStep: async (step, env) =>
    s.recheck?.(step.seedKey ?? step.id, env.pass) ?? true,
  shouldStop: s.stop ?? (() => false),
});

const finished = (trx: Kysely<DB>, id: string) =>
  trx
    .selectFrom("portal_reset_runs")
    .select(["state", "abort_reason", "report_note", "counts", "progress"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const reportJobs = (trx: Kysely<DB>, runId: string) =>
  trx
    .selectFrom("jobs")
    .select(["payload", "idempotency_key"])
    .where("kind", "=", "send_reset_report")
    .where("idempotency_key", "=", `reset-report:${runId}`)
    .execute();

describe("progress (AC-9)", () => {
  it("reads a saved shape and falls back to the start on anything else", () => {
    const saved = { phase: 3, done: ["a"], failed: ["a", "b"], bad: [] };
    expect(readProgress(saved)).toEqual(saved);
    expect(readProgress({}).phase).toBe(1);
    expect(readProgress({ phase: 9 }).phase).toBe(1);
    expect(readProgress(null).done).toEqual([]);
  });
});

describe.skipIf(!hasDb)("phases (AC-19)", () => {
  it("runs each step once and re-reads each once when nothing fails", () =>
    inRollback(async (trx) => {
      const { conn, run } = await claimed(trx, {});
      const seen: string[] = [];
      const p = portal();
      await executeRun(
        run,
        deps(conn, p.client, {
          run: async (k, pass) => {
            seen.push(`run:${k}:${pass}`);
            return true;
          },
          recheck: (k, pass) => {
            seen.push(`check:${k}:${pass}`);
            return true;
          },
        }),
      );
      expect(seen).toEqual(["run:a:1", "run:b:1", "check:a:1", "check:b:1"]);
      const row = await finished(trx, run.id);
      expect(row.state).toBe("done");
      expect(row.report_note).toBe("not_needed");
      expect(p.closed()).toBe(true);
    }));

  it("a leftover found by the re-read sends only that step to the second pass", () =>
    inRollback(async (trx) => {
      const { conn, run } = await claimed(trx, {});
      const seen: string[] = [];
      await executeRun(
        run,
        deps(conn, portal().client, {
          run: async (k, pass) => {
            seen.push(`run:${k}:${pass}`);
            return true;
          },
          recheck: (k, pass) => {
            seen.push(`check:${k}:${pass}`);
            return !(k === "b" && pass === 1);
          },
        }),
      );
      expect(seen).toEqual([
        "run:a:1",
        "run:b:1",
        "check:a:1",
        "check:b:1",
        "run:b:2",
        "check:b:2",
      ]);
      expect((await finished(trx, run.id)).state).toBe("done");
    }));

  it("a step the second pass fixes is resolved and sends no email", () =>
    inRollback(async (trx) => {
      const { conn, run } = await claimed(trx, {});
      await executeRun(
        run,
        deps(conn, portal().client, {
          run: async (k, pass, env) => {
            if (k === "a" && pass === 1) {
              env.record(failure("a", 1, "one"));
              return false;
            }
            return true;
          },
        }),
      );
      const row = await finished(trx, run.id);
      expect(row.state).toBe("done");
      expect(row.counts).toMatchObject({ resolved: 1, steps: 2 });
      expect(row.counts).not.toHaveProperty("failed");
      expect(await reportJobs(trx, run.id)).toEqual([]);
      const items = await trx
        .selectFrom("portal_reset_run_items")
        .select(["step_key", "kind", "resolved", "pass", "seq"])
        .where("run_id", "=", run.id)
        .execute();
      expect(items).toEqual([
        { step_key: "a", kind: "failed", resolved: true, pass: 1, seq: 1 },
      ]);
    }));

  it("a step that fails twice ends incomplete, with a report that holds only the run id", () =>
    inRollback(async (trx) => {
      const { conn, run } = await claimed(trx, {});
      await executeRun(
        run,
        deps(conn, portal().client, {
          run: async (k, pass, env) => {
            if (k !== "a") return true;
            env.record(failure("a", pass, "one"));
            return false;
          },
        }),
      );
      const row = await finished(trx, run.id);
      expect(row.state).toBe("incomplete");
      expect(row.report_note).toBe("queued");
      expect(row.counts).toMatchObject({ failed: 2, failedSteps: 1 });
      const jobs = await reportJobs(trx, run.id);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload).toEqual({ runId: run.id });
    }));

  it("with no abort address the report is not queued and the run says so", () =>
    inRollback(async (trx) => {
      const { conn, run } = await claimed(trx, { email: null });
      await executeRun(
        run,
        deps(conn, portal().client, { run: async () => false }),
      );
      const row = await finished(trx, run.id);
      expect(row.state).toBe("incomplete");
      expect(row.report_note).toBe("no_address");
      expect(await reportJobs(trx, run.id)).toEqual([]);
    }));

  it("a live abort other than mode_off is reported", () =>
    inRollback(async (trx) => {
      const { conn, run } = await claimed(trx, {});
      const p = portal();
      await executeRun(run, {
        ...deps(conn, p.client, { run: async () => true }),
        signIn: async () => ({ ok: false, error: "sign_in_failed" }),
      });
      const row = await finished(trx, run.id);
      expect(row).toMatchObject({
        state: "aborted",
        abort_reason: "sign_in_failed",
        report_note: "queued",
      });
      expect(await reportJobs(trx, run.id)).toHaveLength(1);
    }));
});

describe.skipIf(!hasDb)("dry run (AC-33)", () => {
  it("skips the re-reads, ends done, and sends no email", () =>
    inRollback(async (trx) => {
      const { conn, run } = await claimed(trx, { mode: "dry_run" });
      let rechecks = 0;
      await executeRun(
        run,
        deps(conn, portal().client, {
          run: async (_k, _pass, env) => {
            env.record({ ...failure("a", 1, "x"), kind: "would_delete" });
            return true;
          },
          recheck: () => {
            rechecks += 1;
            return false;
          },
        }),
      );
      const row = await finished(trx, run.id);
      expect(row.state).toBe("done");
      expect(row.counts).toMatchObject({ would_delete: 2 });
      expect(rechecks).toBe(0);
      expect(await reportJobs(trx, run.id)).toEqual([]);
    }));
});

describe.skipIf(!hasDb)("resume and shutdown (AC-9, AC-10)", () => {
  it("a stop signal before the next write releases the run with its progress and records", () =>
    inRollback(async (trx) => {
      const { conn, run } = await claimed(trx, {});
      let stopping = false;
      const p = portal();
      await executeRun(
        run,
        deps(conn, p.client, {
          stop: () => stopping,
          run: async (k, _pass, env) => {
            if (k === "a") return true;
            env.record(failure("b", 1, "kept"));
            stopping = true;
            await env.beforeWrite();
            return true;
          },
        }),
      );
      const row = await finished(trx, run.id);
      expect(row.state).toBe("queued");
      expect(row.progress).toEqual({
        phase: 1,
        done: ["a"],
        failed: [],
        bad: [],
      });
      const items = await trx
        .selectFrom("portal_reset_run_items")
        .select("label")
        .where("run_id", "=", run.id)
        .execute();
      expect(items).toEqual([{ label: "kept" }]);
      expect(p.closed()).toBe(true);
    }));

  it("a resumed run starts at the step it was in and appends its records", () =>
    inRollback(async (trx) => {
      const first = await claimed(trx, {});
      await sql`
        update hol_app.portal_reset_runs
        set progress = ${JSON.stringify({
          phase: 1,
          done: ["a"],
          failed: [],
          bad: [],
        })}::jsonb
        where id = ${first.run.id}::uuid`.execute(trx);
      await sql`
        insert into hol_app.portal_reset_run_items
          (run_id, seq, step_key, kind, pass)
        values (${first.run.id}::uuid, 1, 'a', 'deleted', 1)`.execute(trx);
      const run = {
        ...first.run,
        progress: { phase: 1, done: ["a"], failed: [], bad: [] },
      };
      const seen: string[] = [];
      await executeRun(
        run,
        deps(first.conn, portal().client, {
          run: async (k, pass, env) => {
            seen.push(`${k}:${pass}`);
            env.record({ ...failure(k, 1, "later"), kind: "deleted" });
            return true;
          },
        }),
      );
      expect(seen).toEqual(["b:1"]);
      const seqs = await trx
        .selectFrom("portal_reset_run_items")
        .select("seq")
        .where("run_id", "=", run.id)
        .orderBy("seq")
        .execute();
      expect(seqs.map((r) => r.seq)).toEqual([1, 2]);
      const row = await finished(trx, run.id);
      expect(row.state).toBe("done");
      expect(row.counts).toMatchObject({ deleted: 2 });
    }));
});
