# 0015. Reminder email before a booking starts

**Date**: 2026-10-20
**Status**: Accepted
**Builds on**: [spec 0013](../0013-email-delivery-booking-confirmations/index.md) (the job queue, the `send_email` handler, routing, the lab access template, the invite). **Amends** spec 0013 AC-10 (the claim order: a queued reminder never holds back another email, AC-10 here). **Settles** [spec 0001](../0001-stack-architecture/index.md)'s follow-up "decide where the reminder lead time is configured" (a code constant) and confirms [spec 0002](../0002-data-model/index.md)'s plan of a job keyed `reminder:<booking id>:<version>`.

## Summary

Every confirmed booking that was made more than 24 hours ahead gets one reminder email 24 hours before it starts, with the same access card and links as the booked email and a calendar invite. A small worker step checks each tick (the worker's loop, every 30 seconds) for bookings that just crossed their 24 hour mark and queues the reminder then, so a cancelled booking is never picked and a rescheduled one is judged again by its new time. A reminder that is already queued is checked again when it sends: if the booking changed, or the start is less than an hour away, it is quietly skipped. No new table, no new setting, and no learner opt out.

## Requirements

**User stories**:
- As a learner, I want an email the day before my lab with everything I need, so that I show up on time with the links at hand.
- As a learner who cancelled or moved a booking, I never want a reminder for a time that is no longer mine.
- As the owner, I want reminders to need no setup and to catch up safely after a worker outage, so that nobody gets a confusing late reminder.

**Acceptance criteria**:

*When a reminder is due (worker)*
- **AC-1**: `REMINDER_LEAD_MS = 24 * 60 * 60 * 1000` lives in `lib/slots.ts` beside `LEAD_MS` (1 hour) and `HORIZON_MS`. It is the only place the lead time is set; there is no env var or admin setting.
- **AC-2**: A new worker step, "reminders", runs every tick right before "jobs" (after "testbed teardown"), so a reminder it queues can send in the same tick (a tick runs every 30 seconds, `TICK_PAUSE_MS`). It calls `queueReminders(conn)` in `server/jobs/reminders.ts`, which reads the due bookings in one query by the DB clock (`now()`), oldest `starts_at` first, then queues them one by one until none are left or 20 seconds have passed (checked before each booking, as the jobs step checks its budget); any left over are picked up next tick. The constants enter SQL as intervals, `make_interval(secs => <ms> / 1000.0)`, so 24 hours is elapsed time and a daylight saving change never shifts it. A booking is **due** when all hold:
  1. `status = 'confirmed'`;
  2. `starts_at <= now() + REMINDER_LEAD_MS` (it has crossed its 24 hour mark);
  3. `starts_at >= now() + LEAD_MS` (it is still at least 1 hour away; later than that it never gets a reminder);
  4. its current version has a notice row made at or before `starts_at - REMINDER_LEAD_MS` (AC-3);
  5. no `email_messages` row exists with this `booking_id`, `kind = 'reminder'`, and `booking_version = bookings.version`.
- **AC-3**: The **notice row** of a booking's current version is its `email_messages` row with `booking_id` = the booking, `booking_version = bookings.version`, and `kind in ('booked', 'rescheduled')` (the email that version queued, spec 0013 AC-6; a correlated subquery served by `email_messages_one_per_version_uq`, taking the earliest `created_at` if both kinds somehow exist). Its `created_at` is when that version was made, and its `details.appUrl` is the app the learner used (AC-5). A version with no notice row (a booking made or moved before spec 0013 shipped, or a test row) is **never due**: it gets no reminder, rather than a guessed age or a guessed link. So a booking made less than 24 hours before its start gets no reminder, and neither does one rescheduled into its last 24 hours; a booking rescheduled earlier than that is judged by its new start. `bookings.updated_at` and `bookings.created_at` are never used for this (the worker's calendar writes bump `updated_at`, and `created_at` is wrong for any later version).
- **AC-4**: Each due booking is queued in its own transaction: lock the booking `FOR SHARE`, then read the version, status, start, and notice row again under the lock and check AC-2 again (a miss queues nothing), then call `queueReminder(trx, bookingId, version, notice)` in `server/jobs/booking-notice.ts`. It inserts one `send_email` job (payload `{ emailMessageId }`, idempotency key `reminderJobKey(bookingId, version)` = `reminder:<bookingId>:<version>`, a separate helper from `emailJobKey` on purpose, `ON CONFLICT DO NOTHING RETURNING id`; no row returned means it already exists and the function stops), then one `email_messages` row (`kind = 'reminder'`, `status = 'queued'`, `booking_version` = the locked version, `to_address` = `users.email` now, `subject` per AC-6, `details` per AC-5). It queues no calendar job. Lock order: the sweep takes only the booking lock and reads the user without one, so it can wait behind a cancel or reschedule (user `FOR SHARE`, then booking `FOR UPDATE`) but never holds a lock they need first; its inserts touch only new `jobs` and `email_messages` rows. A booking that fails (a throw inside its transaction) is rolled back, logged ("reminders: <booking id> failed: <message>"), and tried again next tick; it never stops the others, and the time budget means a booking that keeps failing can't hold the rest up. Running the step twice queues one reminder.

*What the reminder says*
- **AC-5**: `BookingEmailKind` in `lib/booking-email.ts` gains `reminder`. The `details` snapshot is `BookingEmailDetails` built by the same explicit read as spec 0013 AC-11 (never `os_username` or `os_password`), at the moment the sweep queues it, with three differences: `timezone` = `bookingZone(trx, bookingId, users.timezone)`, `newAccount` = `false`, and `appUrl` = the notice row's `details.appUrl` (parsed with `z.object({ appUrl: z.url() })`; the worker's own `appUrl()` is never used, since one worker serves dev and prod). A notice row whose `appUrl` doesn't parse fails that booking (logged and tried again, AC-4); every notice row the app writes carries one, so this means hand edited data. `links` (Portal URL, LMS URL, clients in `position` order) are read as for booked, so they are current at queue time.
- **AC-6**: Subject: `Reminder: Your Nile Hands-On Lab starts <formatEmailDateTime(startsAt, timezone)>`, from `emailSubject("reminder", details)`, e.g. "Reminder: Your Nile Hands-On Lab starts Thu, Oct 22, 2026, 5:00 AM PT". A rerouted test address gets the `[dev] ` prefix (spec 0013 AC-16).
- **AC-7**: The body is the lab access email (spec 0013 AC-12): `LabAccessEmail` in `server/email/templates/lab-access-email.tsx` widens its `kind` to `"booked" | "rescheduled" | "reminder"`, with a `reminder` branch for the `EmailFrame` title, preview, heading, and intro (no new template file), and the same frame, details card, links, and footer. For a reminder: the hidden preview line "Your lab starts soon. Access links and session details inside.", the heading "Your lab starts soon", and the intro "Hi <first name>, this is a reminder that your reservation starts <time>. The links below become active at your start time and stop working when your session ends." (times per spec 0013 AC-14). The plain text part says the same. It attaches the same invite as the booked email: `METHOD:REQUEST`, the booking's UID, and `SEQUENCE` = the version, so a calendar that already has the event sees no change (a learner who deleted or declined the event may see it offered again). `renderBookingEmail`, `composeBookingEmail`, and every exhaustive `switch` on `BookingEmailKind` gain the `reminder` branch, and the worker's start up render check (`worker/index.ts`, spec 0013 AC-22) and the email samples (`server/email/sample.ts`) render a reminder too.

*When it sends (the `send_email` handler)*
- **AC-8**: For a `reminder` row, after spec 0013 AC-18's ended check, the handler reads the booking (no lock; the email row is already locked). If the booking is gone, not `confirmed`, or its `version` differs from the row's `booking_version`, the row is set `suppressed` with `last_error` "The booking changed before the reminder went out." If `details.startsAt` is less than `LEAD_MS` after `dbNow()`, it is set `suppressed` with "Too close to the start to send a reminder." In both cases nothing is sent and the job is `done`. The floor is checked again here on purpose, so a reminder queued right at the 1 hour edge, or held back by a Google outage, may be suppressed instead of arriving late. The booking read takes no lock (holding one across the Gmail call would block cancels), so this race is accepted: a cancel or reschedule that commits after the read still lets the reminder go out, and its own cancelled or rescheduled email follows.
- **AC-9**: A reminder never has a Bcc: the handler routes it with `routeEmail(to_address, { ...ctx.cfg, opsBcc: null })`, as the welcome does. Test addresses go to the dev inbox, or are suppressed with no dev inbox, as for booking emails.
- **AC-10**: Ordering (amends spec 0013 AC-10). A queued reminder never holds back another email, and a reminder waits for the confirmation it follows. In `claimJob`, the `not exists` clause becomes exactly:
  ```sql
  not exists (
    select 1
    from hol_app.email_messages m
    join hol_app.email_messages older
      on older.booking_id = m.booking_id
     and older.status = 'queued'
     and older.kind <> 'reminder'
     and (older.booking_version < m.booking_version
          or (m.kind = 'reminder' and older.booking_version = m.booking_version))
    where m.job_id = j.id
  )
  ```
  So booked, rescheduled, and cancelled emails keep spec 0013's version order and ignore reminders; a reminder waits for any queued booked, rescheduled, or cancelled email of a lower version, and for the booked or rescheduled email of its own version.

*Cancel, reschedule, outage, console*
- **AC-11**: No stale reminder: a cancelled booking is never due (AC-2.1); a reschedule bumps the version (spec 0002), so the new version is judged on its own (AC-3) and an unsent reminder for the old version is suppressed at send (AC-8). A reminder already sent for an older version stays `sent`; the rescheduled or cancelled email that follows covers the change.
- **AC-12**: Catch up: when the worker comes back after an outage, every confirmed booking that crossed its 24 hour mark and still starts at least 1 hour later gets its reminder on the next tick; one starting sooner gets none (no row is written). With no live `GOOGLE` key, reminders queue as rows and wait like every other email (spec 0013 AC-9), and AC-8 decides at send.
- **AC-13**: The learner detail page's Emails section (spec 0013 AC-21) lists reminder rows with the Kind "Reminder" and the usual statuses (Queued, Sent, Failed, Suppressed with the reason). This already holds: `lib/email-log.ts` maps `reminder` to "Reminder"; the build only adds a regression check.

*Proof*
- **AC-14**: Tests: DB tests inside `inRollback` for the due rules (exactly at the 24 hour mark, just before it, the 1 hour floor, a booking made inside the window, a reschedule into and out of the window, a cancelled booking, a second run queuing nothing, a version with no notice row never due, the reminder's `appUrl` taken from the notice row), for each AC-8 suppress path, and for the AC-10 claim rule both ways (a queued reminder for version 1 doesn't hold back the version 2 rescheduled email; a reminder waits for its own version's queued booked email); Vitest snapshots of the reminder HTML, plain text, and `.ics` (fixed details, `America/New_York` and `Asia/Kolkata`); a test that the rendered reminder has no `Bcc` header. `/check verify` sends one real reminder on dev (build task 5).

## Decision

**Chosen option**: Option 1: a worker sweep that queues each reminder when its booking crosses the 24 hour mark.

A "reminders" worker step queues one `send_email` job per due booking version (key `reminder:<booking id>:<version>`), and the existing handler sends it with a send time recheck; the lead time is the code constant `REMINDER_LEAD_MS`.

**Implementation skills**: `react-email` (`resend/react-email`, `.claude/skills/react-email/`) · `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model sketch** (no migration; everything exists since spec 0013):

| Table | Use | Key fields |
|---|---|---|
| `email_messages` | one row per reminder | `kind = 'reminder'` (allowed by `email_messages_kind_check`), `booking_id`, `booking_version` (the version it reminds about), `job_id`, `to_address`, `subject`, `details` (`BookingEmailDetails`), `status`, `last_error`, `created_at` |
| `jobs` | one `send_email` job per reminder | `idempotency_key = reminder:<booking id>:<version>` (unique), payload `{ emailMessageId }` |
| `bookings` | read only | `status`, `starts_at`, `version` |

- Unique: `email_messages_one_per_version_uq` on (`booking_id`, `kind`, `booking_version`) allows at most one reminder row per booking version; the job key does the same for jobs.
- Relationships: a booking has many email rows (1:N); a reminder row has exactly one job (1:1 through `job_id`).
- No new index: the due query filters confirmed bookings by `starts_at` inside a 23 hour window, a handful of rows at this scale.

**State transitions** (a reminder's `email_messages.status`):
- (no row) → `queued`: the sweep finds the booking due (AC-2 to AC-4).
- `queued` → `sent`: Gmail accepts it.
- `queued` → `suppressed`: the booking ended (0013 AC-18), changed, or starts in under an hour (AC-8), or a test address with no dev inbox (AC-9).
- `queued` → `failed`: Gmail refuses it, or attempts run out (0013 AC-8).
- A booking: `confirmed` → `cancelled` or a version bump never touches an existing reminder row; AC-8 handles it at send.

**API surface** (no HTTP or Server Action surface; worker and library functions only):

| Function | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `queueReminders(conn)` (`server/jobs/reminders.ts`) | worker step "reminders" | `conn: Kysely<DB>` | `{ queued: number }` (logged when > 0) | worker only | a row's failure is logged and skipped |
| `queueReminder(trx, bookingId, version)` (`server/jobs/booking-notice.ts`) | inside the sweep's transaction | booking id, locked version | `void` | worker only | key taken: no op |
| `runSendEmail` (`server/jobs/send-email.ts`, changed) | `send_email` handler | `{ emailMessageId }` | job outcome | worker only | AC-8 suppress, 0013 retry/final |
| `claimJob` (`server/jobs/runner.ts`, changed) | the claim statement | handled kinds | one job | worker only | AC-10 wait |
| `emailSubject`, `inviteFields`, `BookingEmailKind` (`lib/booking-email.ts`, changed) | pure | kind `reminder`, details | subject, invite fields | n/a | none |
| `renderBookingEmail("reminder", details)` (`server/email/compose.ts`, changed) | worker render | details | HTML, text | n/a | none |

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| sweep | "now" | SQL `now()` (the DB is the clock) |
| sweep | the 24 hour lead | `REMINDER_LEAD_MS` in `lib/slots.ts` (AC-1) |
| sweep | the 1 hour floor | `LEAD_MS` in `lib/slots.ts` |
| sweep | when the current version was made | `email_messages.created_at` of the version's notice row (`booked` or `rescheduled`); no row means never due (AC-3) |
| sweep | the step's time budget | 20 seconds, checked before each booking (AC-2) |
| sweep | already reminded | an `email_messages` row (booking, `reminder`, version) (AC-2.5) |
| queue | recipient | `users.email` at queue time |
| queue | time zone | `bookingZone(trx, bookingId, users.timezone)` (spec 0013 AC-11) |
| queue | learner name, lab type, testbed, start, end | the explicit read in `readDetails` (spec 0013 AC-11), from the locked booking |
| queue | links | `testbeds.portal_url`, `lms_url`, `testbed_clients` at queue time |
| queue | app links in the email | the notice row's `details.appUrl` (AC-5), never the worker's `appUrl()` |
| queue | job key | `reminderJobKey(bookingId, version)` = `reminder:<bookingId>:<version>` (AC-4) |
| send | subject time, card times | `formatEmailDateTime(details.startsAt, details.timezone)` (spec 0013 AC-14) |
| send | first name | `firstName(details.learnerName)` as in the booked email |
| send | whether the booking changed | `bookings.status`, `bookings.version` vs the row's `booking_version` (AC-8) |
| send | Bcc | none: `opsBcc: null` (AC-9) |
| send | invite UID, SEQUENCE | the booking id, the row's `booking_version` (spec 0013 AC-17) |
| console | Kind label | `reminder` maps to "Reminder" in `lib/email-log.ts`, already there (AC-13) |

**Key invariants**:
- At most one reminder row and one reminder job per booking version (unique index, unique key).
- A reminder is only queued for a `confirmed` booking whose current version was made at least 24 hours before its start, and only while the start is at least 1 hour away.
- A reminder is only sent while its booking is still `confirmed` at the same version and the start is at least 1 hour away; otherwise it is `suppressed` with a reason.
- A reminder never carries a Bcc and never a client's OS login.
- A reminder never goes out before a queued booked or rescheduled email of the same booking and version, and a queued reminder never holds back any other email.
- A confirmed booking always has a live testbed: deleting a testbed is blocked while it has live bookings (spec 0007), and deactivating a learner cancels theirs (spec 0008), so the sweep needs no testbed or user check.
- Every timing decision uses the DB clock (`now()`, `dbNow`).

**Security model**:
- No new public surface: only the worker reads bookings and writes reminder rows; learners and admins see reminders only as rows in the console's Emails section (admin only).
- The email carries the same lab links the booked email already sent to the same address (spec 0013); `readDetails` never selects OS logins, and `os_password` stays confined to `server/catalog/testbeds.ts` (the AGENTS.md scan).
- No Ops BCC, so lab links are not copied to a shared mailbox more than the booking emails already are.
- No PII beyond what the booking emails already hold; no new compliance scope.

**Configuration required**: none. No env vars or credentials; the existing `GOOGLE` API key sends reminders.

**Critical test scenarios**:
- Happy path: a booking confirmed 3 days ahead; when `now()` reaches 24 hours before its start the sweep queues one reminder, and the handler sends it with the reminder subject, heading, links, invite, and no Bcc, verifies **AC-2**, **AC-4**, **AC-6**, **AC-7**, **AC-9**.
- Late booking: a booking confirmed 3 hours before its start never gets a reminder; a booking rescheduled into its last 24 hours gets none for the new version, verifies **AC-3**.
- Stale: a reminder queued, then the booking cancelled (or rescheduled) before it sends, is `suppressed` "The booking changed before the reminder went out." and nothing goes to Gmail, verifies **AC-8**, **AC-11**.
- Outage: the worker is down past the 24 hour mark; on return a booking 5 hours out gets its reminder, one 30 minutes out gets no row, verifies **AC-12**.
- Order: a booked email and a reminder of the same version both queued (no Google key); once the key is back the booked email sends first, verifies **AC-10**.
- Idempotent: the sweep run twice in one tick queues one reminder, verifies **AC-4**.
- Access: a guest or learner never reaches any reminder surface; only the console's admin only Emails section shows the row, verifies **AC-13**.

## Build plan

Tracer Bullet: first one real reminder through every layer (constant, sweep, queue, handler, Gmail), then thicken it with the send time checks, ordering, the real template, the console label, and the tests.

1. **Tracer**: add `REMINDER_LEAD_MS`; add `reminder` to `BookingEmailKind` with its `emailSubject` branch; write `queueReminder` and `queueReminders` with the full due rules (AC-2 to AC-4); add the "reminders" step before "jobs" in `worker/index.ts`; let `runSendEmail` and `renderBookingEmail` accept `reminder`, rendering with the lab access template for now. On dev, send one real reminder to a `dev-` learner (a booking placed just over 24 hours ahead), satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**, **AC-6**.
2. **Send time checks**: the AC-8 changed booking and 1 hour floor suppress paths in `runSendEmail`, and `opsBcc: null` routing for reminders, satisfies **AC-8**, **AC-9**, **AC-11**, **AC-12**.
3. **Ordering**: replace the `claimJob` `not exists` clause with AC-10's, so reminders block nothing and wait for their own confirmation, satisfies **AC-10**.
4. **The real email**: widen `LabAccessEmail` with the reminder branch (title, preview, heading, intro, plain text) and the invite for `reminder`; add the reminder to the worker's start up render check and `server/email/sample.ts`, satisfies **AC-7**.
5. **Proof**: the AC-14 DB tests, handler tests, claim order test, and snapshots; `verify.md` with the manual steps (a real reminder on dev, iOS Mail and Gmail web as for spec 0013), satisfies **AC-14**.

## Consequences

**Positive**:
- Cancel and reschedule need no reminder code at all: nothing is queued until 24 hours out, and the version check catches the rest.
- The console never shows reminders sitting `Queued` for weeks, and an unsent reminder never blocks a later email.
- Reuses the whole spec 0013 pipeline (runner, breaker, routing, frame, invite); no migration, no new setting, no new credential.
- Links in the reminder are current at queue time, so an admin's fix to a portal URL reaches the reminder.

**Negative / tradeoffs**:
- A booking made or moved less than 24 hours before its start gets no reminder. The scope's done line ("each booking that is still active gets one reminder") reads narrower now: each booking made more than 24 hours ahead.
- Reminders depend on the worker running. A long outage that runs into the last hour before a start drops that reminder (by design, AC-12).
- One more step each tick: one small query every 30 seconds, plus a short transaction per due booking.
- Bookings made or rescheduled before spec 0013 shipped have no notice row, so they never get a reminder (AC-3).
- A learner can't turn reminders off; if that is ever wanted it needs a column and a setting.
- A second invite with the same UID and SEQUENCE is harmless in common clients, but a strict client might still show it as a fresh invite, and a learner who deleted or declined the event may see it offered again.

**Neutral**:
- `BookingEmailKind` widens to four kinds, so every `switch` on it (subject, template, invite) gets a `reminder` branch; the exhaustive `never` checks will point at each one.
- Purges, the breaker, and the 8 attempt cap apply to reminders unchanged.

## Follow-up

- [ ] `/scope`: reword feature 17's done line to "each booking made more than 24 hours ahead gets one reminder 24 hours before it starts; a cancelled or rescheduled booking never gets a stale reminder".
- [ ] When this is accepted, add a one line "amended by spec 0015 AC-10" note to spec 0013 AC-10, so a reader of 0013 finds the new claim rule.
- [ ] Spec 0001: its follow-up "decide where the reminder lead time is configured" is settled here (a code constant, AC-1); spec 0002's "confirm in that spec" is settled by AC-4.
- [ ] `/sync` after the build: `server/jobs/AGENTS.md` gains the reminders step, the `reminder:<booking>:<version>` key, and the AC-10 order rule; `server/worker/AGENTS.md` gains the "reminders" step before "jobs".
