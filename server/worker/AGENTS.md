# server/worker

The background worker: one long running process that completes ended bookings, sweeps stuck sagas, and keeps the membership of each testbed's predefined Authentik group in step with bookings. Governing spec: [0004](../../docs/specs/0004-core-booking-loop/index.md) (AC-11, AC-12).

## Files

- `../../worker/index.ts`: the process entry (`npm run worker`). Checks `WORKER_ENABLED`, takes the lock, runs ticks until SIGTERM or SIGINT, then exits 0.
- `../../worker/server-only-hook.mjs`: `npm run worker` runs without `--conditions=react-server`, because React Email needs `react-dom/server`, so this `--import` hook maps `server-only` to its empty module. The entry renders the sample booking and welcome emails before taking the lock and exits 1 if the renderer fails to load ([spec 0013](../../docs/specs/0013-email-delivery-booking-confirmations/index.md) AC-22).
- `lock.ts`: `lockClient` (a dedicated `pg` client, never the pool) and `tryWorkerLock` (`pg_try_advisory_lock`).
- `loop.ts`: `runTick` runs steps in order, each under `STEP_TIMEOUT_MS`; `TICK_PAUSE_MS` between ticks; `purgeDue` for the daily rate limit purge; `WORKER_LOCK_KEY`.
- `sweep.ts`: `completeEnded`, `sweepGuestSagas` (provisioning over 10 minutes), `sweepUnlinkedLearners` (learner rows an add saga left with no Authentik pk and no bookings, after 10 minutes; [spec 0008](../../docs/specs/0008-admin-users/index.md) AC-12), `purgeRateLimits`.
- `reconcile.ts`: `reconcileAccess`, the access reconciler. The pure diff it applies is `membershipDiff` in `lib/reconcile.ts`.
- `release.ts`: `releaseDeletedTestbeds`, the step right after the reconciler ([spec 0017](../../docs/specs/0017-testbed-domain-predefined-groups/index.md) AC-9). The groups are the owner's, so it deletes nothing: it stamps a soft deleted testbed's `authentik_group_deleted_at` with an `authentik_group.released` audit row once the group is shared with a live testbed, gone, or drained of tagged learners; returns how many it stamped.
- The `jobs` step (after release) runs `runJobs` from `server/jobs/runner.ts` with the `send_email`, `calendar_upsert`, `calendar_delete`, and `send_welcome` handlers (`HANDLERS` in the entry); with no `GOOGLE` API key the jobs wait, logged once. The daily purge also runs `purgeDoneJobs` ([spec 0013](../../docs/specs/0013-email-delivery-booking-confirmations/index.md) AC-8 to AC-10) and `purgeSetPasswordLinks`, which deletes links 30 days past expiry ([spec 0014](../../docs/specs/0014-set-password-welcome-email/index.md) AC-16).

## Rules

- Authentik is shared, so a worker started anywhere reconciles the real groups. Leave `WORKER_ENABLED=false` in `.env.local` unless you mean to run it; the advisory lock makes a second worker log "another worker holds the lock" and exit.
- The lock lives on its own client for the life of the process. Losing that connection means losing the lock, so the process exits 1.
- One failing or timed out step is logged and never stops the rest of the tick. A step cannot be cancelled once sent, so keep each step safe to run again.
- A shutdown signal lets the current step finish and skips the rest; never exit in the middle of a step.
- `reconcileAccess` is the only code that adds or removes testbed group members. Desired members are active learners with a confirmed booking that is Current by the DB clock; a soft deleted testbed's group is emptied. It removes only members tagged `hol_learner` and never touches untagged ones. Every add or remove goes through `guardGroupWrite` and is audited (`access.granted`, `access.revoked`); a removal also ends the learner's Authentik sessions.
- When the Cloudflare revoke is on, each removal then calls Access `revoke_user` through `makeRevoker` in `server/cloudflare/access.ts` (even when ending the sessions failed), and the audit row comes last with `sessionsEnded` and `vmRevoke`. The base URL and token come from the `CLOUDFLARE` API key through `cloudflareRevokeConfig`, read once per reconciler run, never from env. The revoke blocks new requests only; never describe it as closing an open VM session ([spec 0012](../../docs/specs/0012-lab-access-result-screens/index.md) AC-10, AC-11).
- Release stamps a deleted testbed only once the reconciler has emptied its group of tagged learners (untagged members never block it), the group is gone, or a live testbed shares it. Anything else leaves the row unstamped for the next tick. A stamped row is skipped by both release and `reconcileAccess`. Neither step ever deletes a group.
- Sweepers handle rows one by one and log a failed row without stopping the others.
- Tests: pure tick logic gets plain tests; DB steps run inside `inRollback` with the fake Authentik from `server/authentik/testing.ts`.

_Drafted by /sync from the introducing change, worth a quick human pass._
