// The background worker (spec 0004 AC-11): `npm run worker`. Dev and prod
// share one database, so a worker started anywhere IS the production worker;
// the advisory lock keeps it to one.
import { setTimeout as sleep } from "node:timers/promises";
import { authentik } from "@/server/authentik/client";
import { db } from "@/server/db";
import { dbEnv, workerEnv } from "@/server/env";
import { lockClient, tryWorkerLock } from "@/server/worker/lock";
import {
  purgeDue,
  runTick,
  STEP_TIMEOUT_MS,
  TICK_PAUSE_MS,
  WORKER_LOCK_KEY,
  type Step,
} from "@/server/worker/loop";
import { reconcileAccess } from "@/server/worker/reconcile";
import {
  completeEnded,
  purgeRateLimits,
  sweepGuestSagas,
  sweepTestbedCreates,
} from "@/server/worker/sweep";

const PURGE = "purge rate limits";

const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);

async function main(): Promise<number> {
  if (!workerEnv().WORKER_ENABLED) {
    log("worker: WORKER_ENABLED is not true, so the worker is not starting");
    return 0;
  }

  const lock = lockClient(dbEnv());
  await lock.connect();
  if (!(await tryWorkerLock(lock, WORKER_LOCK_KEY))) {
    log("worker: another worker holds the lock, exiting");
    await lock.end();
    return 0;
  }

  const stop = new AbortController();
  // Losing the lock connection means losing the lock: exit non zero.
  const lost = (why: string) => {
    if (stop.signal.aborted) return;
    log(`worker: lock connection lost (${why}), exiting`);
    process.exit(1);
  };
  lock.on("error", (e) => lost(e.message));
  lock.on("end", () => lost("closed"));
  const onSignal = (signal: string) => {
    log(`worker: ${signal}, finishing the current step`);
    stop.abort();
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));

  const api = authentik();
  const conn = db();
  log("worker: started");

  // A loop, not recursion: the process runs for days, and a promise chain
  // per tick would grow without bound.
  let lastPurge: number | undefined;
  while (!stop.signal.aborted) {
    // A dead lock connection is noticed here even when idle.
    await lock.query("select 1").catch((e: Error) => lost(e.message));
    const now = Date.now();
    const steps: readonly Step[] = [
      { name: "complete ended bookings", run: () => completeEnded(conn) },
      { name: "guest saga sweeper", run: () => sweepGuestSagas(api, conn) },
      {
        name: "testbed create sweeper",
        run: () => sweepTestbedCreates(api, conn),
      },
      { name: "access reconciler", run: () => reconcileAccess(api, conn) },
      ...(purgeDue(lastPurge, now)
        ? [{ name: PURGE, run: () => purgeRateLimits(conn) }]
        : []),
    ];
    const outcomes = await runTick(steps, {
      timeoutMs: STEP_TIMEOUT_MS,
      shouldStop: () => stop.signal.aborted,
      log,
    });
    if (outcomes.some((o) => o.name === PURGE && o.ok)) lastPurge = now;
    await sleep(TICK_PAUSE_MS, undefined, { signal: stop.signal }).catch(
      () => undefined,
    );
  }

  await lock.end().catch(() => undefined);
  await conn.destroy();
  log("worker: stopped");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error("worker: crashed", e);
    process.exit(1);
  },
);
