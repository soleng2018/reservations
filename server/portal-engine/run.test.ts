import { sql, type Insertable, type Kysely, type Transaction } from "kysely";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { PortalResetRunMode } from "@/lib/db-enums";
import { ok } from "@/lib/result";
import { cancelBooking, rescheduleBooking } from "@/server/db/bookings";
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
import type { Bookings, DB } from "@/server/db/types";
import { claimDueRun, keepingLease, stopCheck } from "./claim";
import type { PortalClient } from "./portal";
import { queueEndedResets } from "./queue";
import { makeFake, populatedState } from "./testing";
import { executeRun } from "./run";

afterAll(() => db().destroy());

const setMode = (trx: Kysely<DB>, mode: "off" | PortalResetRunMode) =>
  // mode_changed_at is cleared too: the live row holds the time of the last
  // real switch, and a booking that ended before it would never queue.
  trx
    .updateTable("portal_reset_settings")
    .set({ mode, mode_changed_at: null })
    .execute();

async function world(trx: Transaction<DB>) {
  const type = await makeType(trx);
  const testbed = await makeTestbed(trx, type.id);
  const other = await makeTestbed(trx, type.id);
  const user = await makeUser(trx);
  const book = (
    from: number,
    to: number,
    extra: Partial<Insertable<Bookings>> = {},
  ) =>
    trx
      .insertInto("bookings")
      .values({
        user_id: user.id,
        testbed_id: testbed.id,
        testbed_type_id: type.id,
        starts_at: slot(from),
        ends_at: slot(to),
        status: "confirmed",
        ...extra,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  return { type, testbed, other, user, book };
}

const runsOf = (trx: Kysely<DB>, testbedId: string) =>
  trx
    .selectFrom("portal_reset_runs")
    .selectAll()
    .where("testbed_id", "=", testbedId)
    .execute();

const insertRun = (
  trx: Kysely<DB>,
  testbedId: string,
  extra: Record<string, unknown> = {},
) =>
  sql<{ id: string }>`
    insert into hol_app.portal_reset_runs
      (testbed_id, ended_key, event, mode, lab_ended_at, due_at, state,
       lease_until, resumes)
    values (${testbedId}::uuid, ${crypto.randomUUID()}, 'lab_ended',
      ${(extra.mode as string) ?? "live"}, now(),
      ${sql.raw((extra.due as string) ?? "now()")},
      ${(extra.state as string) ?? "queued"},
      ${sql.raw((extra.lease as string) ?? "null")},
      ${(extra.resumes as number) ?? 0})
    returning id`
    .execute(trx)
    .then((r) => r.rows[0]?.id ?? "");

describe.skipIf(!hasDb)("queueing (AC-1 to AC-3)", () => {
  it("queues nothing while the mode is off", () =>
    inRollback(async (trx) => {
      await setMode(trx, "off");
      const w = await world(trx);
      await w.book(-1.5, -0.5, { status: "completed" });
      expect(await queueEndedResets(trx)).toBe(0);
      const cur = await w.book(-0.5, 1);
      await cancelBooking(trx, {
        id: cur.id,
        expectedVersion: cur.version,
        source: "admin",
        byUserId: null,
      });
      expect(await runsOf(trx, w.testbed.id)).toEqual([]);
    }));

  it("queues an ended booking once, due five minutes after it ended", () =>
    inRollback(async (trx) => {
      await setMode(trx, "live");
      const w = await world(trx);
      // Ended 10 minutes ago, inside the 45 minute lookback whatever the
      // time of day (a slot end is up to 60 minutes back).
      const b = await w.book(-1.5, -0.5, {
        ends_at: new Date(Date.now() - 10 * 60_000),
      });
      await queueEndedResets(trx);
      await queueEndedResets(trx);
      const runs = await runsOf(trx, w.testbed.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        event: "lab_ended",
        mode: "live",
        state: "queued",
        booking_id: b.id,
      });
      expect(runs[0]?.ended_key).toBe(
        `end:${b.id}:${Math.floor(b.ends_at.getTime() / 1000)}`,
      );
      expect(runs[0]!.due_at.getTime() - runs[0]!.lab_ended_at.getTime()).toBe(
        300_000,
      );
    }));

  it("ignores a booking that ended before the mode was changed", () =>
    inRollback(async (trx) => {
      await setMode(trx, "live");
      await sql`update hol_app.portal_reset_settings set mode_changed_at = now()`.execute(
        trx,
      );
      const w = await world(trx);
      await w.book(-1.5, -0.5);
      expect(await queueEndedResets(trx)).toBe(0);
    }));

  it("a Current cancel queues an early end, an Upcoming one nothing", () =>
    inRollback(async (trx) => {
      await setMode(trx, "dry_run");
      const w = await world(trx);
      const upcoming = await w.book(3, 4);
      await cancelBooking(trx, {
        id: upcoming.id,
        expectedVersion: upcoming.version,
        source: "admin",
        byUserId: null,
      });
      expect(await runsOf(trx, w.testbed.id)).toEqual([]);
      const current = await w.book(-0.5, 1);
      const done = await cancelBooking(trx, {
        id: current.id,
        expectedVersion: current.version,
        source: "admin",
        byUserId: null,
      });
      expect(done.ok).toBe(true);
      const runs = await runsOf(trx, w.testbed.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ event: "ended_early", mode: "dry_run" });
      expect(runs[0]?.ended_key).toMatch(/^early:/);
    }));

  it("moving a Current booking queues a run for the old testbed", () =>
    inRollback(async (trx) => {
      await setMode(trx, "live");
      const w = await world(trx);
      const current = await w.book(-0.5, 1);
      const moved = await rescheduleBooking(trx, {
        id: current.id,
        expectedVersion: current.version,
        testbedId: w.other.id,
        testbedTypeId: w.type.id,
        startsAt: slot(4),
        endsAt: slot(5),
      });
      expect(moved.ok).toBe(true);
      const runs = await runsOf(trx, w.testbed.id);
      expect(runs.map((r) => r.event)).toEqual(["moved"]);
      expect(await runsOf(trx, w.other.id)).toEqual([]);
    }));
});

describe.skipIf(!hasDb)("claiming (AC-4, AC-5, AC-9)", () => {
  it("is not claimable before due_at, and is at due_at", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const conn = asConn(trx);
      const id = await insertRun(trx, w.testbed.id, {
        due: "now() + interval '1 second'",
      });
      expect(await claimDueRun(conn)).toBeUndefined();
      await sql`update hol_app.portal_reset_runs set due_at = now() where id = ${id}::uuid`.execute(
        trx,
      );
      const claimed = await claimDueRun(conn);
      expect(claimed?.id).toBe(id);
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select(["state", "lease_until", "started_at"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe("running");
      expect(row.lease_until).not.toBeNull();
      expect(row.started_at).not.toBeNull();
    }));

  it("runs one at a time per testbed, together across testbeds", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const conn = asConn(trx);
      await insertRun(trx, w.testbed.id);
      await insertRun(trx, w.testbed.id);
      await insertRun(trx, w.other.id);
      const first = await claimDueRun(conn);
      const second = await claimDueRun(conn);
      const third = await claimDueRun(conn);
      expect([first, second].map((r) => r?.testbedId).sort()).toEqual(
        [w.testbed.id, w.other.id].sort(),
      );
      expect(third).toBeUndefined();
    }));

  it("resumes an expired lease, and ends the fourth resume as crashed", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const conn = asConn(trx);
      const id = await insertRun(trx, w.testbed.id, {
        state: "running",
        lease: "now() - interval '1 second'",
        resumes: 2,
      });
      const resumed = await claimDueRun(conn);
      expect(resumed).toMatchObject({ id, resumes: 3 });
      await sql`update hol_app.portal_reset_runs set lease_until = now() - interval '1 second' where id = ${id}::uuid`.execute(
        trx,
      );
      expect(await claimDueRun(conn)).toBeUndefined();
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select(["state", "abort_reason"])
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ state: "aborted", abort_reason: "crashed" });
    }));
});

describe.skipIf(!hasDb)("stop check (AC-6)", () => {
  it("goes, then stops for mode off, the hard cap, and a starting lab", () =>
    inRollback(async (trx) => {
      await setMode(trx, "live");
      const w = await world(trx);
      const conn = asConn(trx);
      const id = await insertRun(trx, w.testbed.id, {
        state: "running",
        lease: "now() - interval '1 minute'",
      });
      expect(await stopCheck(conn, id)).toBe("go");
      const lease = await trx
        .selectFrom("portal_reset_runs")
        .select(sql<boolean>`lease_until > now()`.as("renewed"))
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(lease.renewed).toBe(true);

      await w.book(-0.5, 1);
      expect(await stopCheck(conn, id)).toBe("lab_started");

      await setMode(trx, "off");
      expect(await stopCheck(conn, id)).toBe("mode_off");

      await setMode(trx, "live");
      await trx
        .deleteFrom("bookings")
        .where("testbed_id", "=", w.testbed.id)
        .execute();
      await sql`update hol_app.portal_reset_runs set lab_ended_at = now() - interval '3 hours' where id = ${id}::uuid`.execute(
        trx,
      );
      expect(await stopCheck(conn, id)).toBe("deadline");
    }));

  it("has no hard cap for a run that was held (AC-14)", () =>
    inRollback(async (trx) => {
      await setMode(trx, "live");
      const w = await world(trx);
      const id = await insertRun(trx, w.testbed.id, { state: "running" });
      await sql`update hol_app.portal_reset_runs
        set lab_ended_at = now() - interval '3 hours',
          sign_in_reason = 'idp_rejected'
        where id = ${id}::uuid`.execute(trx);
      expect(await stopCheck(asConn(trx), id)).toBe("go");
    }));

  it("keepingLease renews the lease while the work runs and clears its timer", () =>
    inRollback(async (trx) => {
      await setMode(trx, "live");
      const w = await world(trx);
      const conn = asConn(trx);
      const id = await insertRun(trx, w.testbed.id, {
        state: "running",
        lease: "now() - interval '1 minute'",
      });
      const timers: Array<() => void> = [];
      const realSet = globalThis.setInterval;
      const set = vi.spyOn(globalThis, "setInterval").mockImplementation(((
        fn: () => void,
      ) => {
        timers.push(fn);
        return realSet(() => undefined, 1e9);
      }) as unknown as typeof setInterval);
      const clear = vi.spyOn(globalThis, "clearInterval");
      try {
        const out = await keepingLease(conn, id, async () => {
          timers.forEach((tick) => tick());
          await new Promise((r) => setTimeout(r, 50));
          const row = await trx
            .selectFrom("portal_reset_runs")
            .select(sql<boolean>`lease_until > now()`.as("renewed"))
            .where("id", "=", id)
            .executeTakeFirstOrThrow();
          return row.renewed;
        });
        expect(out).toBe(true);
        expect(clear).toHaveBeenCalledTimes(1);
      } finally {
        set.mockRestore();
        clear.mockRestore();
      }
    }));

  it("ignores a lab that starts later", () =>
    inRollback(async (trx) => {
      await setMode(trx, "live");
      const w = await world(trx);
      const id = await insertRun(trx, w.testbed.id, { state: "running" });
      await w.book(1, 2);
      expect(await stopCheck(asConn(trx), id)).toBe("go");
    }));

  it("is lost when the run is no longer running", () =>
    inRollback(async (trx) => {
      const w = await world(trx);
      const id = await insertRun(trx, w.testbed.id, { state: "queued" });
      expect(await stopCheck(asConn(trx), id)).toBe("lost");
    }));
});

const oneStep = async (trx: Kysely<DB>) => {
  await trx.deleteFrom("portal_reset_steps").execute();
  await trx
    .insertInto("portal_reset_steps")
    .values({
      position: 1,
      feature_name: "Tracer",
      enabled: true,
      definition: JSON.stringify({ parts: [{ kind: "wait", seconds: 1 }] }),
    })
    .execute();
};

const fakePortal = () => {
  const state = { calls: 0, closed: false };
  // The guard lists (AC-26) are read from a real fake tenant; only the calls
  // a step makes are counted.
  const tenant = makeFake();
  const portal: PortalClient = {
    call: async (req) => {
      if (!req.path.startsWith("/api/v1/x")) return tenant.portal.call(req);
      state.calls += 1;
      return ok({ status: 200, body: {} });
    },
    close: async () => {
      state.closed = true;
    },
  };
  return { state, portal };
};

describe.skipIf(!hasDb)("the tracer run (AC-8, AC-1, AC-6, AC-10)", () => {
  const start = async (trx: Transaction<DB>) => {
    // Steps before settings, the order the save tests lock them in.
    await oneStep(trx);
    await setMode(trx, "live");
    const w = await world(trx);
    const conn = asConn(trx);
    await insertRun(trx, w.testbed.id);
    const run = await claimDueRun(conn);
    if (!run) throw new Error("no run claimed");
    return { w, conn, run };
  };

  it("signs in, runs the step, finishes done, and writes one audit row", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      const { state, portal } = fakePortal();
      await executeRun(run, {
        conn,
        signIn: async () => ok(portal),
        runStep: async (_s, ctx) => {
          await ctx.portal.call({ method: "GET", path: "/api/v1/x" });
          return "done";
        },
        recheckStep: async () => true,
        shouldStop: () => false,
      });
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select(["state", "finished_at", "lease_until", "report_note"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe("done");
      expect(row.finished_at).not.toBeNull();
      expect(row.lease_until).toBeNull();
      expect(state).toEqual({ calls: 1, closed: true });
      const events = await trx
        .selectFrom("audit_events")
        .select(["action", "actor_user_id", "target_type"])
        .where("target_id", "=", run.id)
        .execute();
      expect(events).toEqual([
        {
          action: "portal_reset.run_finished",
          actor_user_id: null,
          target_type: "portal_reset_run",
        },
      ]);
    }));

  it("a failed step makes the run incomplete", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      await executeRun(run, {
        conn,
        signIn: async () => ok(fakePortal().portal),
        runStep: async () => "failed",
        recheckStep: async () => true,
        shouldStop: () => false,
      });
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select("state")
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe("incomplete");
    }));

  it("mode off ends aborted with no sign in and no call", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      await setMode(trx, "off");
      let signedIn = false;
      await executeRun(run, {
        conn,
        signIn: async () => {
          signedIn = true;
          return ok(fakePortal().portal);
        },
        runStep: async () => "done",
        recheckStep: async () => true,
        shouldStop: () => false,
      });
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select(["state", "abort_reason"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ state: "aborted", abort_reason: "mode_off" });
      expect(signedIn).toBe(false);
    }));

  it("a list that deletes segments before policy groups ends invalid_list with no sign in (decision D7)", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      const del = (list: string, path: string) =>
        JSON.stringify({
          parts: [
            {
              kind: "delete_each",
              list: {
                method: "GET",
                path: list,
                itemsAt: "content",
                idField: "id",
              },
              delete: { path },
            },
          ],
        });
      await trx.deleteFrom("portal_reset_steps").execute();
      await trx
        .insertInto("portal_reset_steps")
        .values([
          {
            position: 1,
            feature_name: "Segments",
            enabled: true,
            definition: del(
              "/api/v1/settings/segments",
              "/api/v1/settings/segments/{id}",
            ),
          },
          {
            position: 2,
            feature_name: "Groups",
            enabled: true,
            definition: del(
              "/api/v3/policy/groups",
              "/api/v3/policy/groups/{id}",
            ),
          },
        ])
        .execute();
      let signedIn = false;
      await executeRun(run, {
        conn,
        signIn: async () => {
          signedIn = true;
          return ok(fakePortal().portal);
        },
        runStep: async () => "done",
        recheckStep: async () => true,
        shouldStop: () => false,
      });
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select(["state", "abort_reason"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ state: "aborted", abort_reason: "invalid_list" });
      expect(signedIn).toBe(false);
    }));

  it("a lab that starts aborts with no further step", () =>
    inRollback(async (trx) => {
      const { w, conn, run } = await start(trx);
      await w.book(-0.5, 1);
      let steps = 0;
      await executeRun(run, {
        conn,
        signIn: async () => ok(fakePortal().portal),
        runStep: async () => {
          steps += 1;
          return "done";
        },
        recheckStep: async () => true,
        shouldStop: () => false,
      });
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select(["state", "abort_reason"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ state: "aborted", abort_reason: "lab_started" });
      expect(steps).toBe(0);
    }));

  it("a stop signal leaves the run queued with its lease released", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      const { state, portal } = fakePortal();
      await executeRun(run, {
        conn,
        signIn: async () => ok(portal),
        runStep: async () => "done",
        recheckStep: async () => true,
        shouldStop: () => true,
      });
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select(["state", "lease_until", "finished_at"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        state: "queued",
        lease_until: null,
        finished_at: null,
      });
      expect(state.closed).toBe(true);
    }));

  it("a refused sign in ends the run before any portal call", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      await executeRun(run, {
        conn,
        signIn: async () => ({
          ok: false,
          error: { kind: "sign_in", reason: "timeout" },
        }),
        runStep: async () => "done",
        recheckStep: async () => true,
        shouldStop: () => false,
      });
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select(["state", "abort_reason"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ state: "aborted", abort_reason: "sign_in_failed" });
    }));

  // covers: AC-25, AC-26
  const guardStopRows = (trx: Kysely<DB>, runId: string) =>
    trx
      .selectFrom("audit_events")
      .select(["action", "metadata"])
      .where("target_id", "=", runId)
      .orderBy("action")
      .execute();

  it("a step that calls a denied path ends guard_stop, sends nothing, and audits the route", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      const tenant = makeFake();
      await executeRun(run, {
        conn,
        signIn: async () => ok(tenant.portal),
        runStep: async (_s, ctx) => {
          await ctx.portal.call({
            method: "GET",
            path: "/api/v1/idps/abc12345",
          });
          return "done";
        },
        recheckStep: async () => true,
        shouldStop: () => false,
      });
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select(["state", "abort_reason"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ state: "aborted", abort_reason: "guard_stop" });
      expect(tenant.calls.some((c) => c.includes("idps"))).toBe(false);
      expect(await guardStopRows(trx, run.id)).toEqual([
        {
          action: "portal_reset.guard_stop",
          metadata: { stepKey: "Tracer", route: "/api/v1/idps/{id}" },
        },
        {
          action: "portal_reset.run_aborted",
          metadata: { reason: "guard_stop", counts: {} },
        },
      ]);
    }));

  it("two protected SSIDs end the run guard_stop before any step or write", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      const state = populatedState();
      state.ssids = [
        ...state.ssids,
        { id: "second", ssid: { popTunnelUsed: true } },
      ];
      const tenant = makeFake(state);
      let steps = 0;
      await executeRun(run, {
        conn,
        signIn: async () => ok(tenant.portal),
        runStep: async () => {
          steps += 1;
          return "done";
        },
        recheckStep: async () => true,
        shouldStop: () => false,
      });
      const row = await trx
        .selectFrom("portal_reset_runs")
        .select(["state", "abort_reason"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ state: "aborted", abort_reason: "guard_stop" });
      expect(steps).toBe(0);
      expect(tenant.writes).toHaveLength(0);
    }));

  it("a write that holds the protected id is refused at the choke point", () =>
    inRollback(async (trx) => {
      const { conn, run } = await start(trx);
      const tenant = makeFake();
      await executeRun(run, {
        conn,
        signIn: async () => ok(tenant.portal),
        runStep: async (_s, ctx) => {
          await ctx.portal.call({
            method: "DELETE",
            path: "/api/v1/settings/ssids/ssid-protected",
          });
          return "done";
        },
        recheckStep: async () => true,
        shouldStop: () => false,
      });
      expect(tenant.writes).toHaveLength(0);
      expect(tenant.state.ssids.map((r) => r.id)).toContain("ssid-protected");
      const rows = await guardStopRows(trx, run.id);
      expect(rows[0]?.metadata).toEqual({
        stepKey: "Tracer",
        route: "/api/v1/settings/ssids/{id}",
      });
    }));
});
