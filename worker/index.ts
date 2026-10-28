// The background worker (spec 0004 AC-11): `npm run worker`. Dev and prod
// share one database, so a worker started anywhere IS the production worker;
// the advisory lock keeps it to one.
import { setTimeout as sleep } from "node:timers/promises";
import { revokeStateLine, type RevokeKind } from "@/lib/reconcile";
import { authentik } from "@/server/authentik/client";
import {
  cleanupHookConfig,
  cloudflareRevokeConfig,
  googleMailConfig,
} from "@/server/catalog/api-keys";
import { db } from "@/server/db";
import { dbEnv, encryptionEnv, workerEnv } from "@/server/env";
import { purgeSetPasswordLinks } from "@/server/auth/set-password-links";
import {
  renderBookingEmail,
  renderResetReport,
  renderWelcomeEmail,
} from "@/server/email/compose";
import {
  SAMPLE_BOOKING_DETAILS,
  SAMPLE_CLIENT_LOGINS,
  SAMPLE_REMINDER_DETAILS,
  SAMPLE_RESET_REPORT,
  SAMPLE_WELCOME,
} from "@/server/email/sample";
import {
  breakerLogLine,
  purgeDoneJobs,
  runJobs,
  type Handlers,
} from "@/server/jobs/runner";
import { runCleanupHooks } from "@/server/jobs/cleanup-hook";
import { syncBookingEvent } from "@/server/jobs/calendar-sync";
import { queueReminders } from "@/server/jobs/reminders";
import { runSendEmail } from "@/server/jobs/send-email";
import { runSendResetReport } from "@/server/jobs/send-reset-report";
import { runSendWelcome } from "@/server/jobs/send-welcome";
import { lockClient, tryWorkerLock } from "@/server/worker/lock";
import {
  purgeDue,
  runTick,
  STEP_TIMEOUT_MS,
  TICK_PAUSE_MS,
  WORKER_LOCK_KEY,
  type Step,
} from "@/server/worker/loop";
import { checkBrowser } from "@/server/portal-engine/browser-check";
import { checkAutomationPermissions } from "@/server/authentik/permission-check";
import { claimDueRun } from "@/server/portal-engine/claim";
import { realRunDeps } from "@/server/portal-engine/deps";
import { runLanes } from "@/server/portal-engine/lanes";
import { purgePortalResetRuns } from "@/server/portal-engine/purge";
import { queueEndedResets } from "@/server/portal-engine/queue";
import { executeRun } from "@/server/portal-engine/run";
import { reconcileAccess } from "@/server/worker/reconcile";
import { releaseDeletedTestbeds } from "@/server/worker/release";
import {
  completeEnded,
  purgeRateLimits,
  sweepGuestSagas,
  sweepUnlinkedLearners,
} from "@/server/worker/sweep";

const PURGE = "purge rate limits";

// Spec 0013 AC-8, spec 0014 AC-1: the job kinds this worker runs.
const HANDLERS: Handlers = {
  send_email: runSendEmail,
  calendar_upsert: syncBookingEvent,
  calendar_delete: syncBookingEvent,
  send_welcome: runSendWelcome,
  send_reset_report: runSendResetReport,
};

const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);

async function main(): Promise<number> {
  if (!workerEnv().WORKER_ENABLED) {
    log("worker: WORKER_ENABLED is not true, so the worker is not starting");
    return 0;
  }

  // Spec 0013 AC-22, spec 0014 AC-17, spec 0015 AC-7: the smoke check. Email needs
  // react-dom/server, which only loads without the react-server condition
  // (the server-only hook).
  try {
    await renderBookingEmail(
      "booked",
      SAMPLE_BOOKING_DETAILS,
      SAMPLE_CLIENT_LOGINS,
    );
    await renderBookingEmail(
      "reminder",
      SAMPLE_REMINDER_DETAILS,
      SAMPLE_CLIENT_LOGINS,
    );
    await renderWelcomeEmail(
      SAMPLE_WELCOME.details,
      SAMPLE_WELCOME.email,
      SAMPLE_WELCOME.url,
    );
    await renderResetReport(SAMPLE_RESET_REPORT);
  } catch (e) {
    log(
      `worker: the email renderer failed to load (${e instanceof Error ? e.message : String(e)}), exiting`,
    );
    return 1;
  }

  // Spec 0023 AC-40: the reset signs in with a headless Chromium, so launch
  // it once here. A worker that cannot start it exits 1 at deploy.
  const browser = await checkBrowser();
  if (!browser.ok) {
    log(`worker: Chromium failed to start (${browser.error}), exiting`);
    return 1;
  }

  // Spec 0023 AC-39: a missing provisioning permission is logged once and
  // never stops the worker.
  const permissionLine = await checkAutomationPermissions();
  if (permissionLine) log(`worker: ${permissionLine}`);

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
    if (step.breaker) console.error(breakerLogLine(step.method));
  };
  // Spec 0021 AC-13: its own step, with no Google key needed. The hook's
  // URL and secret are read per call (AC-10) and never logged.
  const cleanupHook = async () => {
    const step = await runCleanupHooks(conn, {
      source: () => cleanupHookConfig(conn, () => encryptionEnv().keyring),
    });
    for (const f of step.failed) console.error(`cleanup hook: ${f} failed`);
  };
  // Spec 0023 AC-1, AC-2: ended labs get a reset run queued by the tick.
  const resetQueue = async () => {
    const queued = await queueEndedResets(conn);
    if (queued > 0) log(`portal reset: queued ${queued}`);
  };
  // Spec 0023 AC-11: the run lanes go beside the tick, only here, where the
  // worker lock is held, so a long run never delays another step.
  const lanes = runLanes(
    {
      claim: () => claimDueRun(conn),
      execute: (run) =>
        executeRun(
          run,
          realRunDeps(conn, () => stop.signal.aborted),
        ),
      pause: (ms) =>
        sleep(ms, undefined, { signal: stop.signal }).catch(() => undefined),
      log,
    },
    {
      lanes: workerEnv().PORTAL_RESET_LANES,
      shouldStop: () => stop.signal.aborted,
    },
  );
  const reminders = async () => {
    const { queued } = await queueReminders(conn);
    if (queued > 0) log(`reminders: queued ${queued}`);
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
        name: "access reconciler",
        run: () => reconcileAccess(api, conn, revokeSource),
      },
      {
        name: "testbed release",
        run: () => releaseDeletedTestbeds(api, conn),
      },
      // Spec 0015 AC-2: right before "jobs", so a reminder queued here can
      // send in the same tick.
      { name: "reminders", run: reminders },
      { name: "cleanup hook", run: cleanupHook },
      { name: "portal reset queue", run: resetQueue },
      { name: "jobs", run: jobs },
      ...(purgeDue(lastPurge, now)
        ? [
            { name: PURGE, run: () => purgeRateLimits(conn) },
            { name: "purge done jobs", run: () => purgeDoneJobs(conn) },
            {
              name: "purge set password links",
              run: () => purgeSetPasswordLinks(conn),
            },
            {
              name: "purge portal reset runs",
              run: () => purgePortalResetRuns(conn),
            },
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

  // Spec 0023 AC-10: the lanes finish the call they are in, then stop.
  await lanes;
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
