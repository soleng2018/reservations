# 0015. Reminder email before a booking starts: rationale

## Context

Learners book a remote lab up to 90 days ahead, and as little as 1 hour ahead. Today they hear from the app when they book, reschedule, or cancel (spec 0013), and nothing after that until the session starts. A forgotten booking holds a testbed that someone else could have used, and a learner who can't find their links at start time loses part of a fixed length session.

Spec 0001 made timed work a core part of the design ("reminders must fire") and left open where the lead time lives. Spec 0002 already allows `kind = 'reminder'` on `email_messages` and sketched a job keyed `reminder:<booking id>:<version>`. Spec 0013 built the pipeline a reminder rides on: a database job queue claimed by the single worker, a Gmail sender with a breaker, test address routing, the lab access email template, and the calendar invite. It also set two rules that shape this decision. A booking's emails go out in version order, so a queued email for an older version blocks newer ones (AC-10). And the console shows every email row per learner, so a row's status is visible to admins.

A booking changes after it is made. A learner can reschedule (the version goes up) or cancel; an admin can cancel; deactivation cancels. The scope's done line asks that a cancelled or rescheduled booking never gets a stale reminder. The worker can also be down for a while (deploys, crashes, no Google key), and a reminder that arrives after the session started is worse than none. Dev and prod share one database and one worker, so whatever decides "due" must be safe to run from either.

## Options considered

### Option 1: Worker sweep each tick (chosen)

A "reminders" worker step, each tick, selects confirmed bookings that crossed their 24 hour mark, are still at least an hour away, were made before that mark, and have no reminder for their current version. It queues one `send_email` job and one email row per booking, in a transaction that locks the booking `FOR SHARE`. The handler checks the booking again at send.

**Pros**:
- Cancel and reschedule need no reminder code: a cancelled booking is never selected, and a new version is judged on its own.
- Nothing sits queued for weeks, so the console stays readable and no old reminder blocks a newer email under spec 0013 AC-10.
- Catch up after an outage falls out of the same query, with the 1 hour floor.
- The details snapshot (and the links) is built a day before the session, not weeks before.

**Cons**:
- One more query every tick, forever (bounded and small).
- "When was this version made" needs a source; the notice row's `created_at` serves, and bookings made before spec 0013 (no notice row) get no reminder.
- A reminder exists only once the worker has seen the booking cross its mark, so a stopped worker means no reminders (and the 1 hour floor then drops some).

### Option 2: Queue the reminder with the booking (spec 0002's sketch)

`queueBookingNotice` also inserts a `send_email` job with `run_at = starts_at - 24 hours` and a queued reminder row, inside the booking transaction.

**Pros**:
- No new worker step; the runner's existing `run_at <= now()` claim does the timing.
- The reminder exists from the moment the booking commits, visible on the console.

**Cons**:
- A queued reminder for version 1 blocks version 2's rescheduled email under spec 0013 AC-10 until its `run_at`, possibly weeks; every reschedule and cancel must suppress the old reminder in the same transaction, which spreads reminder logic into three booking functions.
- The console shows reminders as `Queued` for weeks, which reads as stuck.
- The links snapshot is taken at booking time, so an admin's later link fix never reaches the reminder.
- Late bookings still need a rule at queue time, and catch up needs the same send time checks as Option 1 anyway.

### Option 3: A database scheduler (pg_cron) or an external cron

A scheduled job in Postgres (or a host cron) inserts reminder jobs on a timer.

**Pros**:
- Timing lives outside the app process.

**Cons**:
- A new piece of infrastructure on the shared InsForge Postgres (an extension the app doesn't run today) or the host, with its own failure modes and no tests in the repo.
- Splits timed work between the worker and something else, against spec 0001's one worker design.

### Sub decisions

- **Lead time: 24 hours** (the engineer's pick). Time to plan the day and to reschedule; the runner ups were 1 hour (a show up nudge, no time to change plans) and per lab type (a column and a form for a need nobody has yet).
- **Late bookings: no reminder** (the engineer's pick). A booking made inside the 24 hours just got its booked email with every detail. Runner up: send right away, which doubles the email for no new information.
- **Where the lead time lives: a code constant** (the engineer's pick), beside `LEAD_MS` and `HORIZON_MS`, changed by a deploy like the other booking timings. Runners up: an env var (one more setting per process on a shared database) and an admin setting (a table, a form, and audit rows for one number).
- **Catch up floor: 1 hour** (the engineer's pick), the same floor as booking. Runners up: any time before the start (it can land after the learner joined) and only near the mark (an outage silently drops reminders).
- **Content: the full access card** (the engineer's pick), so one fresh email has everything. Runner up: a short nudge with a button to `/reservations`.
- **Invite: attach it again** (the engineer's pick; the recommendation was no invite). The same UID and SEQUENCE make it a no change update in common clients, so it helps a learner who ignored the first one at little risk. Accepted: a strict client may show it as a fresh invite.
- **No Ops BCC** (the engineer's pick): reminders change nothing, so copies would only double Ops's mail; the console still lists them.
- **No opt out** (the engineer's pick): a transactional email about the learner's own booking, one per version.
- **Subject and heading** (the engineer's picks): "Reminder: Your Nile Hands-On Lab starts <time>" and "Your lab starts soon", both true for a catch up send.
- **"When the version was made" source (amended after the cross check)**: the `created_at` of the version's booked or rescheduled notice row, which also supplies the app link (`details.appUrl`). With no notice row the version is never due. The first draft fell back to `bookings.created_at`, which is wrong for any version after the first, and took the link from the worker's `appUrl()`, which would give prod learners a dev link whenever a dev started worker serves them (one worker serves both). `bookings.updated_at` was rejected because the worker's `calendar_event_id` write also bumps it. A new `version_changed_at` column was rejected: a migration and a trigger change for a value the notice rows already hold. Accepted: bookings made before spec 0013 shipped get no reminder.
- **Lock**: the sweep locks only the booking `FOR SHARE` and reads the user without a lock, so it waits behind a reschedule or cancel (user `FOR SHARE`, then booking `FOR UPDATE`) and never holds a lock they need first. Its inserts touch only new `jobs` and `email_messages` rows, which nothing else locks.
- **Time budget, oldest start first (amended after the cross check)**: the step queues until none are due or 20 seconds have passed, as the jobs step budgets itself, instead of a fixed 50 per tick, so a booking that keeps failing can't crowd out the rest. Anything left over is picked up next tick (30 seconds later).
- **Claim order (amended after the cross check)**: queued reminders never hold back another email. Under spec 0013's rule as written, a reminder for version 1 stuck in retry backoff or waiting on the Google key would have delayed the version 2 rescheduled or cancelled email by up to an hour. The send time check suppresses that stale reminder anyway, so letting it block bought nothing.
- **Unlocked read at send (accepted race)**: the handler reads the booking without a lock, because holding one across the Gmail call would block cancels. A cancel that commits mid send lets that reminder out, and the cancelled email follows.
- **No new index**: the window holds a handful of confirmed bookings; an index can come if a measured query says so.

## Rationale

The scope's hardest line is "a cancelled or rescheduled booking never gets a stale reminder", and spec 0013's version order rule makes any long lived queued email expensive. Option 1 answers both by not creating the reminder until it is about to send: the booking's state on the day decides, and the send time recheck covers the moments (or a Google outage) between queue and send. Option 2 would have to undo work on every change, in three booking functions, and its weeks long queued rows would block newer emails. Option 3 adds infrastructure the team doesn't run, for a timer the worker already provides.

Option 1's costs are small and visible: a bounded query each tick, and a "made at" rule for late bookings that the existing notice rows already answer. Its dependency on a running worker is shared by every other email and by lab access itself, so it adds no new failure mode, and the 1 hour floor makes an outage fail quiet instead of confusing.
