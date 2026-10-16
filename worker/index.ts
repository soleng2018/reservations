// The background worker (spec 0004 AC-11): `npm run worker`. Dev and prod
// share one database, so a worker started anywhere IS the production worker;
// the advisory lock keeps it to one.
import { setTimeout as sleep } from "node:timers/promises";
import { revokeStateLine, type RevokeKind } from "@/lib/reconcile";
import { authentik } from "@/server/authentik/client";
import {
  cloudflareRevokeConfig,
  googleMailConfig,
} from "@/server/catalog/api-keys";
import { db } from "@/server/db";
import { dbEnv, encryptionEnv, workerEnv } from "@/server/env";
import { renderBookingEmail } from "@/server/email/compose";
import { SAMPLE_BOOKING_DETAILS } from "@/server/email/sample";
import { purgeDoneJobs, runJobs, type Handlers } from "@/server/jobs/runner";
import { runSendEmail } from "@/server/jobs/send-email";
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
  sweepUnlinkedLearners,
} from "@/server/worker/sweep";
import { teardownDeletedTestbeds } from "@/server/worker/teardown";

const PURGE = "purge rate limits";

// Spec 0013 AC-8: the job kinds this worker runs. send_welcome waits for
// feature 16.
const HANDLERS: Handlers = { send_email: runSendEmail };

const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);

async function main(): Promise<number> {
  if (!workerEnv().WORKER_ENABLED) {
    log("worker: WORKER_ENABLED is not true, so the worker is not starting");
    return 0;
  }

  // Spec 0013 AC-22: the smoke check. Email needs react-dom/server, which
  // only loads without the react-server condition (the server-only hook).
  try {
    await renderBookingEmail("booked", SAMPLE_BOOKING_DETAILS);
  } catch (e) {
    log(
      `worker: the email renderer failed to load (${e instanceof Error ? e.message : String(e)}), exiting`,
    );
    return 1;
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
  let lastRevokeKind: RevokeKind | undefined;
  // Spec 0012 AC-11: read at the start of each reconciler run from the live
  // CLOUDFLARE API key, so a rotated token works on the next tick. The
  // keyring is read only while that key exists. The state is logged on the
  // first run and again only when it changes.
  const revokeSource = async () => {
    const source = await cloudflareRevokeConfig(
      conn,
      () => encryptionEnv().keyring,
    );
    const line = revokeStateLine(lastRevokeKind, source.kind);
    if (line) log(`worker: ${line}`);
    lastRevokeKind = source.kind;
    return source;
  };
  // Spec 0013 AC-9: the "no Google key" wait is logged when it starts, not
  // every tick.
  let googleWaiting = false;
  const jobs = async () => {
    const step = await runJobs(conn, {
      handlers: HANDLERS,
      config: () => googleMailConfig(conn, () => encryptionEnv().keyring),
    });
    if (step.kind === "no_key") {
      if (!googleWaiting)
        log("jobs: no Google key, email and calendar jobs wait");
      googleWaiting = true;
      return;
    }
    googleWaiting = false;
    for (const f of step.failed) console.error(`jobs: ${f} failed`);
    if (step.breaker)
      console.error(
        "jobs: Google rejected the service account key, jobs wait 5 minutes",
      );
  };
  while (!stop.signal.aborted) {
    // A dead lock connection is noticed here even when idle.
    await lock.query("select 1").catch((e: Error) => lost(e.message));
    const now = Date.now();
    const steps: readonly Step[] = [
      { name: "complete ended bookings", run: () => completeEnded(conn) },
      { name: "guest saga sweeper", run: () => sweepGuestSagas(api, conn) },
      {
        name: "unlinked learner sweeper",
        run: () => sweepUnlinkedLearners(conn),
      },
      {
        name: "testbed create sweeper",
        run: () => sweepTestbedCreates(api, conn),
      },
      {
        name: "access reconciler",
        run: () => reconcileAccess(api, conn, revokeSource),
      },
      {
        name: "testbed teardown",
        run: () => teardownDeletedTestbeds(api, conn),
      },
      { name: "jobs", run: jobs },
      ...(purgeDue(lastPurge, now)
        ? [
            { name: PURGE, run: () => purgeRateLimits(conn) },
            { name: "purge done jobs", run: () => purgeDoneJobs(conn) },
          ]
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
