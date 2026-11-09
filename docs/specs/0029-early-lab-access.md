# 0029. Early lab access

**Date**: 2026-11-09
**Status**: In Progress (built and reviewed twice 2026-11-09, verified live in part; amended after the first review with AC-7 and AC-8; amends spec 0023 AC-3, AC-4, AC-6 and AC-14, spec 0021 AC-2, spec 0020 AC-9, and the lab access wording of specs 0012, 0013, 0015)

## Summary

A learner gets into the Nile Portal, the lab guide (LMS), and the lab clients 5 minutes before their booked start, not at it. The Portal reset keeps working in the 30 minute gap between labs, but now has to be finished 6 minutes before the next start (the 5 minute lead plus a 1 minute safety margin), a 19 minute window, which its real run times allow. One constant (`ACCESS_LEAD_MS`) drives both sides, so they cannot drift apart. The review of the first build (2026-11-09) found two things the first draft missed, now AC-7 and AC-8: a cancel or move inside the early window must still queue the reset and the cleanup hook, and the reset needs a small safety margin before access opens.

## Context

Spec 0020 puts a 30 minute gap after every lab. Spec 0023 uses it: the reset starts 5 minutes after a lab ends and aimed to finish by lab end plus 25 minutes (now 24, see AC-4). Access opens exactly at `starts_at`, so a learner who wants a few minutes to sign in and find their way loses that time from the lab.

The owner asked for access 5 minutes early (2026-11-09). The reset must not overlap an open lab, so its window shrinks from 20 to 19 minutes (25 to 24 minutes after the lab ends; the first draft used 20, the review added a 1 minute safety margin). Live data from 2 to 9 November (16 completed runs on Workshops 1, 2 and 4) shows a run takes 1.2 to 1.7 minutes, about 6.2 to 6.7 minutes from lab end to done. A 19 minute window leaves more than ten times the measured need.

## Requirements

**User stories**:
- As a learner, I want my lab links to work 5 minutes before my start so that I can sign in and settle before the clock starts.
- As the owner, I want the reset to finish before the next learner is let in so that nobody sees a half cleaned tenant.

**Acceptance criteria**:
- **AC-1**: The access reconciler treats a confirmed booking as Current for access when `starts_at <= now() + ACCESS_LEAD_MS` and `ends_at > now()`, by the database clock. `ACCESS_LEAD_MS` is 5 minutes (named like `REMINDER_LEAD_MS` and `LEAD_MS`). This covers the testbed group, the type group (spec 0028), and every other membership the reconciler computes from Current bookings.
- **AC-2**: Access still ends at `ends_at`. Nothing else about a booking changes: its start, end, status, the booking list phase (Upcoming or Current), and the calendar event all keep `starts_at` and `ends_at`. The cancel and move side effects are the one thing that follows the lead: see AC-7.
- **AC-3**: The reset stop check (spec 0023 AC-6) and the held run check (AC-14) abort with `lab_started` when a confirmed booking on the testbed is Current or starts within `START_MARGIN`. `START_MARGIN` is `ACCESS_LEAD_MS` plus `RESET_SAFETY_MS` (AC-8), built from those two values, never typed twice.
- **AC-4**: With back to back labs, the reset therefore has from `lab_ended_at + 5 minutes` to the next `starts_at - START_MARGIN`, which is 19 minutes. `TARGET` becomes `lab_ended_at + 24 minutes`, the same moment as that boundary. `HARD_CAP` stays 2 hours: with no next booking nothing needs the tenant, and with one the stop check ends the run first.
- **AC-5**: Learner wording that says links start "at your start time" says they start about 5 minutes before it: the success and detail notes, the "Lab links work only during your window" banner (`lib/two-logins-notice.ts`, shown on the reservation page and in the three emails: "They turn on about 5 minutes before it starts and off when it ends"), and the booked, rescheduled, and reminder emails. The Current note still says access can take up to a minute to start. The calendar event text is unchanged (it carries no access claim).
- **AC-6**: A booking that is early access but not yet started has its lab links in the learner's reservation card as before (the card already shows them while Upcoming). Nothing new is shown.
- **AC-7** (added after review): A confirmed booking cancelled or moved when `starts_at <= now() + ACCESS_LEAD_MS` counts as Current for the side effects that exist to clean up after a learner who had access: the portal reset run of spec 0023 AC-3 (event `ended_early` for a cancel, `moved` for a move) and the cleanup notice of spec 0021. `cancelBooking` and `rescheduleBooking` in `server/db/bookings.ts` compute `was_current` with the lead. Which phase the learner sees (Upcoming or Current) and the cancel dialog's "Your lab access ends within a minute" sentence keep `starts_at`; the reconciler removes the early learner on its next tick either way.
- **AC-8** (added after review): The reset stops a safety margin before access opens, so a write already in flight cannot overlap the next learner. `RESET_SAFETY_MS` is 1 minute. The longest call is bounded by `CALL_TIMEOUT` (20 seconds), so the margin covers one call that began just before the stop check passed.

## Options considered

### Option 1: One shared lead, 19 minute reset window with a safety margin (chosen)

Open access at start minus 5 and stop the reset at start minus 6: the same lead plus a 1 minute safety margin.

**Pros**: Small change, one constant, matches measured run times.

**Cons**: A reset that runs past 19 minutes on a back to back lab ends `lab_started` and leaves the tenant partly reset (emailed, as today).

### Option 2: Early access only when the testbed is idle

Skip early access while a reset is queued or running.

**Pros**: Never collides with a reset.

**Cons**: Learners get early access only sometimes, and the copy cannot promise it.

### Option 3: Stop the reset at the access boundary with no margin (first draft, rejected after review)

`START_MARGIN` equal to `ACCESS_LEAD_MS`, 20 minute window.

**Pros**: One value, the full 20 minutes.

**Cons**: Reset stop and access open at the same instant, so one write in flight can overlap the next learner. The old margin (2 minutes) was a real buffer; this one would have no buffer at all.

## Decision

**Chosen option**: Option 1: One shared lead, 19 minute reset window with a safety margin.

`ACCESS_LEAD_MS` lives in `lib/lab-access.ts` (safe on both sides; the worker bundle imports only a number from it). The reconciler, `START_MARGIN`, and the `was_current` reads in `server/db/bookings.ts` all use it. `RESET_SAFETY_MS` (1 minute) lives in `lib/portal-reset/timing.ts`.

## Rationale

The data says the reset needs about 2 minutes against 19 available, so the shared lead costs nothing in practice. Option 2 makes the promise to learners unreliable for no measured gain. The failure path (a slow reset aborts and is emailed) already exists and is tested.

## Feature design

**Value sourcing**:

| Value | Source |
|---|---|
| Access opens | `bookings.starts_at - ACCESS_LEAD_MS`, compared with SQL `now()` in `currentLearners` |
| Reset stop boundary | `bookings.starts_at - START_MARGIN` (`ACCESS_LEAD_MS + RESET_SAFETY_MS`) in `stopCheck` and `settleHeldRuns` |
| Was the booking early access (for the reset and cleanup hook on a cancel or move) | `bookings.starts_at <= now() + ACCESS_LEAD_MS`, SQL `now()`, in `cancelBooking` and `rescheduleBooking` |

No schema change, no migration, no new env.

## Build plan

1. Add `ACCESS_LEAD_MS` to `lib/lab-access.ts`; in `lib/portal-reset/timing.ts` add `RESET_SAFETY_MS` (1 minute), set `START_MARGIN = ACCESS_LEAD_MS + RESET_SAFETY_MS` and `TARGET` to 24 minutes, satisfies **AC-3, AC-4, AC-8**. (Built 2026-11-09 after the review.)
2. Change `currentLearners` in `server/worker/reconcile.ts`, satisfies **AC-1, AC-2**.
3. Update the learner notes in `lib/lab-access.ts` and the three email intros in `server/email/templates/lab-access-email.tsx`, satisfies **AC-5**.
4. Tests: reconcile (a booking 4 minutes ahead is desired, 6 minutes ahead is not, an ended one is not), stop check (a start 5.5 minutes away aborts, 7 minutes away does not, which tells the 6 minute margin from 5), timing constants, copy, satisfies **AC-1 to AC-5, AC-8**.
5. Amend spec 0023 AC-6, AC-14, and its constants line to point here (done, at the 6 minute margin and the 24 minute `TARGET`).
6. Compute `was_current` with the lead in `cancelBooking` and `rescheduleBooking` (`server/db/bookings.ts`), satisfies **AC-7**. Tests: a cancel and a move at 4 minutes before the start queue one reset run (`ended_early`, `moved`) and one cleanup notice; at 7 minutes they queue nothing. The half hour rule is dropped inside `inRollbackDdl`, as in step 4.
7. Review minors: a `dropHalfHourRule(trx)` helper in `server/db/testing.ts` registered in `DDL_HELPERS` of `tests/ddl-lock-scan.test.ts`; a true handover test (first booking ended 26 minutes ago, the tightest the 30 minute gap allows, next starts in 4 minutes); update the "Current by the DB clock" wording in `server/worker/reconcile.ts` and, through `/sync`, `server/worker/AGENTS.md`; assert the full new sentence in the two copy tests.

**Critical test scenarios**:
- A learner whose booking starts in 4 minutes is added to the testbed group and type group; one starting in 6 is not.
- Two back to back labs: the first learner is removed at `ends_at`, the second added 5 minutes before their start, 25 minutes after the first one ended.
- A run still working at start minus 6 minutes aborts `lab_started`, and one at start minus 7 minutes does not.
- A cancel at 4 minutes before the start queues a reset run and a cleanup notice; at 6 minutes it queues neither (AC-7).
- A move at 4 minutes before the start queues a `moved` reset run for the old testbed (AC-7).

## Consequences

- A learner can open the Portal 5 minutes early, and the lab clock still runs from the booked start.
- The previous learner is gone from the group at `ends_at`, so access for two learners never overlaps.
- A reset that takes over 19 minutes on a back to back lab will abort. At today's 1.2 to 1.7 minutes this is not expected; watch the `portal_reset_runs` durations.
- A cancel or move in the 5 minutes before the start now triggers a reset, though the booking still shows as Upcoming to the learner. The reset is idempotent, so a reset of an untouched tenant is harmless.

## Follow-up

- Review findings: [first review](../reviews/2026-11-09-main.md) (all fixed, except the nits below) and [second review](../reviews/2026-11-09-main-recheck.md) (approve with nits). Open nits: the `oneWaitStep` test helper is copied in two engine test files; the DDL scan does not match a raw `alter table`; some inline `moveTo` code repeats `startBookingIn`; a cancel or move with a live cleanup key is not tested on the move path.
- The cleanup receiver now gets `booking.ended_early` for a lab inside the early window that has not yet started: tell the owner before they build the receiver.
- Old wording still says "at your start time" in `context/Nile HOL Lab Access Email Standalone.html` (the design reference) and in specs 0012, 0013 AC-12 and 0015 AC-7 (flagged for `/architect`).
- Spec 0020 AC-9 ("access window keeps ending at `ends_at`") still holds; spec 0021 AC-2 and AC-3 and spec 0023 AC-3 now read `was_current` with the lead (AC-7 here).
- Re-check run durations after a month, and on any tenant a learner heavily customised.
- Workshops 3 and 5 have no live runs yet.

## Rationale pointer

Live run times were read from `hol_app.portal_reset_runs` on 2026-11-09 (18 runs, 16 done, 2 aborted in the 2 Nov rollout for reasons unrelated to speed).

## Amendment log

- 2026-11-09: written and built (access lead, stop margin of 5 minutes, copy). Live run times from `portal_reset_runs` (16 completed runs, 1.2 to 1.7 minutes) justified a 20 minute window.
- 2026-11-09: reviewed by a second model (opus). One major (a cancel or move inside the early window queued no reset or cleanup hook, now AC-7), and one minor that became a decision (zero buffer between the reset stop and access opening, now AC-8 with a 1 minute margin and a 19 minute window). The other minors and nits are in the review file.
- Test fixes made while verifying the first build, not spec changes: the engine tests `discovery-run` and `sign-in-flow` now set their own step list (the live list enables the Users step, which the fake portal cannot satisfy), and the test MIME reader decodes quoted printable.
- 2026-11-09: review fixes built. AC-7 (`wasCurrent()` with the lead in `server/db/bookings.ts`, tests for a cancel and a move at 4 and 7 minutes, and for the cleanup notice), AC-8 (`RESET_SAFETY_MS`, `START_MARGIN` 6 minutes, `TARGET` 24 minutes; the stop tests use 5.5 minutes, which only the 6 minute margin catches), the `dropHalfHourRule` and `startBookingIn` helpers registered in the DDL scan, a true handover test (first lab ended 26 minutes ago, next starts in 4), the Current note shortened to "Access can take up to a minute to start.", and the reconciler comment. Left: `/sync` for `server/worker/AGENTS.md`, `/check verify`, a second `/check review`.
- 2026-11-09: `/check verify` found the banner copy "They turn on when it starts" on the live reservation page, which contradicted early access and was missed by the unit tests (they asserted the old banner). Fixed in `lib/two-logins-notice.ts`, with a test. Booking success screen text "Your lab access shows there once your lab starts" (`components/book/booking-success.tsx`) is about where the card appears, not when links work, and was left as is.
- 2026-11-09: `/check verify`, live, with the owner's go ahead (scratch group, type, testbed and learner `dev-e2e-early-access`, all removed afterwards). Observed: AC-1 (the real `reconcileAccess` left the learner out of the group 58.6 and 10.5 minutes before the start, and added them 3.95 minutes before it, read from Authentik); AC-5 and AC-6 (the reservation page showed the new note and the banner, and the three emails render the new wording); AC-7 (a cancel 2.96 minutes before the start queued one `ended_early` reset run, mode live). Not observed live: AC-2's removal at `ends_at` (the production worker, on old code, removed the scratch learner within the minute), AC-3, AC-4 and AC-8 (a real reset next to a real next booking; DB tests only), the Portal actually opening (the scratch group has no tenant), and the cleanup notice (no `CLEANUP` key exists). The verify also found the banner copy miss noted above.
- 2026-11-09: second review (opus, [docs/reviews/2026-11-09-main-recheck.md](../reviews/2026-11-09-main-recheck.md)): approve with nits, no blocker or major, all first review findings fixed correctly. Its documentation findings (this spec still describing the rejected 5 minute margin in Summary, Context, Option 1, Decision and Rationale; stale lines in specs 0021 and 0023) were fixed the same day.

