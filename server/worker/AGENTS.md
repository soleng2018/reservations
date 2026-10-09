# server/worker

The background worker: one long running process that completes ended bookings, sweeps stuck sagas, and keeps testbed `pod-*` group membership in step with bookings. Governing spec: [0004](../../docs/specs/0004-core-booking-loop/index.md) (AC-11, AC-12).

## Files

- `../../worker/index.ts`: the process entry (`npm run worker`). Checks `WORKER_ENABLED`, takes the lock, runs ticks until SIGTERM or SIGINT, then exits 0.
- `lock.ts`: `lockClient` (a dedicated `pg` client, never the pool) and `tryWorkerLock` (`pg_try_advisory_lock`).
- `loop.ts`: `runTick` runs steps in order, each under `STEP_TIMEOUT_MS`; `TICK_PAUSE_MS` between ticks; `purgeDue` for the daily rate limit purge; `WORKER_LOCK_KEY`.
- `sweep.ts`: `completeEnded`, `sweepGuestSagas` (provisioning over 10 minutes), `sweepTestbedCreates` (no group pk after 10 minutes), `purgeRateLimits`.
- `reconcile.ts`: `reconcileAccess`, the access reconciler. The pure diff it applies is `membershipDiff` in `lib/reconcile.ts`.

## Rules

- Dev and prod share one database, so a worker started anywhere is the production worker. Leave `WORKER_ENABLED=false` in `.env.local` unless you mean to run it; the advisory lock makes a second worker log "another worker holds the lock" and exit.
- The lock lives on its own client for the life of the process. Losing that connection means losing the lock, so the process exits 1.
- One failing or timed out step is logged and never stops the rest of the tick. A step cannot be cancelled once sent, so keep each step safe to run again.
- A shutdown signal lets the current step finish and skips the rest; never exit in the middle of a step.
- `reconcileAccess` is the only code that adds or removes `pod-*` members. Desired members are learners with a confirmed booking that is Current by the DB clock; a soft deleted testbed's group is emptied. It removes only members tagged `hol_learner` and never touches untagged ones. Every add or remove goes through `guardGroupWrite` and is audited (`access.granted`, `access.revoked`); a removal also ends the learner's Authentik sessions.
- Sweepers handle rows one by one and log a failed row without stopping the others.
- Tests: pure tick logic gets plain tests; DB steps run inside `inRollback` with the fake Authentik from `server/authentik/testing.ts`.

_Drafted by /sync from the introducing change, worth a quick human pass._
