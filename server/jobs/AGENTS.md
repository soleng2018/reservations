# server/jobs

## Overview

The database backed job queue (the `jobs` table) and its handlers: booking emails, the shared calendar mirror, and the set password job. Web code only queues rows inside its own transaction; the worker's `jobs` step claims and runs them. The email itself is built in `server/email/` and sent through `server/google/`.

## Key files

| File | Owns |
|---|---|
| `runner.ts` | `runJobs` (the worker step), `claimJob`, `finishJob`, `sweepExhausted`, `googleCaller` (one fresh token retry on a 401), the breaker, `purgeDoneJobs` |
| `booking-notice.ts` | `queueBookingNotice`: one `send_email` job plus its `email_messages` row plus one calendar job per booking change; payload schemas and idempotency keys |
| `send-email.ts` | `runSendEmail`, the `send_email` handler (stale skip, test address routing, compose, Gmail send) |
| `calendar-sync.ts` | `syncBookingEvent` for `calendar_upsert` and `calendar_delete`, `queueCalendarBackfill` (`npm run calendar:backfill`) |
| `send-welcome.ts` | `runSendWelcome`, the `send_welcome` handler (spec 0014): eligibility under the user's `FOR SHARE` lock, one send per user at a time (`alreadyCovered`), a new link token per email, then the row and the link hash written only after Gmail answers |
| `welcome-queue.ts` | `enqueueWelcome`, `sendWelcomePayload` (`{ userId, appUrl }`), and the keys `welcomeKey`, `resendKey`, `emailChangeKey`; every caller passes `appUrl()` so the link comes back to the app that queued it |
| `../email/compose.ts` | `renderBookingEmail` (React Email to HTML and text), `renderInvite` (the `.ics`), `composeBookingEmail` (the MIME message) |
| `../email/templates/` | the booked, rescheduled, and cancelled templates and their shared frame, card, button, and footer |
| `../email/messages.ts` | a learner's email history for the admin console |

## Conventions

- Queue, never call: a booking change calls `queueBookingNotice` inside the same transaction as the change (`server/db/guest-saga.ts`, `server/db/bookings.ts`), so the notice exists only if the change commits. Nothing in the web process calls Google for a booking, and a failed send never undoes the booking.
- Idempotency keys make a repeat queue nothing: `email:<booking>:<kind>:<version>` and `calendar:<booking>:<version>` (`onConflict ... doNothing`).
- A handler runs inside the job's transaction and returns a `JobOutcome` (`done`, `retry`, `final`, `breaker`); `finishJob` records it in that same transaction. Throw only for bugs: a thrown handler rolls back, counts the attempt, and its message is logged, never stored.
- `runSendEmail` locks its `email_messages` row `FOR UPDATE` first; a row that is gone or no longer `queued` finishes the job, so a rerun never sends twice.
- A booking's emails go out in version order: `claimJob` skips an email while an older one of the same booking is still queued.
- Staleness uses the DB clock (`dbNow`), never `Date.now()`; the process clock is only the step's own time budget.
- Test addresses (`dev-`, `hol-test-`, `.test`, `example.com`, and so on, in `lib/email-routing.ts`) go to the key's dev inbox with a `[dev] ` subject prefix, or are suppressed when no dev inbox is set. Real addresses get the ops BCC, except a welcome, which never does (it carries a working set password link).
- Reads name their columns. Lab links are copied into `email_messages.details` when queued; `messages.ts` never selects `details`, and no handler reads a client's OS login.
- Calendar handlers sync the booking's current row (event id = booking id without dashes), so a late or repeated job still leaves the right event. A calendar failure never touches the email.
- To add a job kind: add it to `JobKind` in `lib/db-enums.ts` (it has a DB CHECK, so a migration too), a handler here, and an entry in `HANDLERS` in `worker/index.ts`.

## Gotchas

- With no `GOOGLE` API key, `runJobs` returns `no_key` before claiming, so jobs wait and spend no attempt.
- The breaker (Google still refuses a fresh token) gives the attempt back, pushes the job 5 minutes out, stops the step for this tick, and marks the key `google_rejected_at` (the Needs attention badge). The first successful Google call clears it. Both writes are guarded by `secret_updated_at`, so a key saved since the worker read it is never marked.
- At most 8 attempts (`jobs_attempts_check`), backoff doubling from 1 minute to an hour. A job that crashed on its last attempt is failed by `sweepExhausted`; a failed `send_email` job fails its email row too, so it never blocks later emails.
- The worker renders React Email, which needs `react-dom/server`, so it runs without the `react-server` condition (see `server/worker/AGENTS.md`). Keep `booking-notice.ts` and `welcome-queue.ts` free of renderer imports: the web process loads them.
- A welcome's raw token and its `/set-password/` URL live only in memory and in the sent email: never in a row, `jobs.payload`, `last_error`, `details`, audit metadata, or a log (spec 0014 AC-4, AC-18; `send-welcome.test.ts` scans for them).
- Template snapshots live in `../email/__snapshots__/`; a copy change updates them on purpose (`vitest -u`), and `../email/testing.ts` walks the MIME tree for the part layout tests.

## Agent skills

- [react-email](../../.claude/skills/react-email/): `resend/react-email`, the email templates and rendering
- [gws-gmail](../../.claude/skills/gws-gmail/): `googleworkspace/cli`, Gmail send
- [gws-calendar](../../.claude/skills/gws-calendar/): `googleworkspace/cli`, Google Calendar events

## Related specs

- [0013 Email delivery and booking confirmations](../../docs/specs/0013-email-delivery-booking-confirmations/index.md)
- [0001 Stack](../../docs/specs/0001-stack-architecture/index.md) (the jobs table design)
- [0003 Authentik sign in and provisioning](../../docs/specs/0003-authentik-sign-in-provisioning/index.md) (the welcome job)
- [0014 Set password and welcome email](../../docs/specs/0014-set-password-welcome-email/index.md) (the welcome handler and the app's own link)

_Drafted by /audit from the repo, worth a quick human pass. Edit freely: once a line stops matching this draft, later runs treat it as curated and will flag rather than overwrite it._
