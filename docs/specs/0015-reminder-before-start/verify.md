# Verify: Reminder before start · spec 0015 · updated 2026-10-20
_Steps derived from spec 0015 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual

The real send (AC-14, build task 5). Dev and prod share one database, so the worker you start here IS the production worker while it runs: make sure no other worker is meant to be running, and stop it when you are done.

- [ ] With the `GOOGLE` key live and a dev inbox set, sign in as a `dev-` learner (or book as a guest with a `dev-` address) and book a slot that starts just over 24 hours from now (for example at 10:05, the 10:30 slot tomorrow) → the booked email arrives as usual → AC-3 (its notice row is made more than 24 hours before the start)
- [ ] Before the 24 hour mark, edit that testbed's Nile Portal URL on the admin Testbeds page → the reminder will show the new URL (links are read at queue time) → AC-5
- [ ] Start the worker with `WORKER_ENABLED=true npm run worker` → the log shows `worker: started` and no renderer failure (it renders the sample reminder at start up) → AC-7
- [ ] When the booking crosses its 24 hour mark → within one tick (about 30 seconds) the log shows `reminders: queued 1`, and the email goes out in the same tick → AC-2, AC-4
- [ ] The dev inbox gets `[dev] Reminder: Your Nile Hands-On Lab starts <start>`, with the start in the zone the booked email used → AC-6, AC-5
- [ ] The email shows the heading "Your lab starts soon", the intro "Hi <first name>, this is a reminder that your reservation starts <start>. ...", and the same details card, links (with the new portal URL), Manage button, and footer as the booked email → AC-7
- [ ] It carries one `invite.ics` (`METHOD:REQUEST`, the booking's UID, `SEQUENCE` = its version); the calendar event is unchanged, not duplicated → AC-7
- [ ] Gmail web's "Show original" has no `Bcc` line → AC-9
- [ ] It renders well in iOS Mail and Gmail web, as the spec 0013 emails do → AC-7
- [ ] On the admin learner detail page, Emails lists it with Kind "Reminder" and Status "Sent" → AC-13
- [ ] Stop the worker (Ctrl+C) → the log shows `worker: stopped`

Optional, the stale paths by hand (the DB tests already cover them):

- [ ] Stop the worker, delete or disable the `GOOGLE` key, and book a second `dev-` slot just over 24 hours out; start the worker past the mark → the reminder row is Queued and waits ("no Google key"); cancel the booking, restore the key → the reminder ends Suppressed "The booking changed before the reminder went out." and only the cancelled email is sent → AC-8, AC-11, AC-12
- [ ] A booking made less than 24 hours before its start never gets a reminder row → AC-3

## Commands

- [ ] `npx vitest run server/jobs/reminders.test.ts` → 19 pass (due rules at the exact 24 hour and 1 hour edges, catch up, made inside the window, reschedule in and out, cancelled, no notice row, run twice, the row and its job, a bad appUrl logged, the time budget, the send, no Bcc, each suppress path, the claim order both ways, the console row) → AC-2 to AC-5, AC-8 to AC-14
- [ ] `npx vitest run server/email/compose.test.ts` → reminder HTML, text, and `.ics` snapshots for New York and Kolkata, and the first name intro → AC-6, AC-7, AC-14
- [ ] `grep -rn "REMINDER_LEAD_MS" lib server worker` → defined only in `lib/slots.ts`; no env var or setting → AC-1
- [ ] `npm run lint && npm run typecheck && npm test` → all green

## Value sourcing (one check per source)

- [ ] "now" is the DB clock: the sweep uses `now()` and the handler `dbNow`; no `Date.now()` in a due or suppress decision (the process clock is only the 20 second budget) → AC-2, AC-8
- [ ] The 24 hour lead comes from `REMINDER_LEAD_MS`: exactly at the mark is due, 1 ms before is not (test) → AC-1, AC-2
- [ ] The 1 hour floor comes from `LEAD_MS`: exactly 1 hour out is due, 1 ms later is not; at send, under an hour is suppressed and exactly an hour sends (tests) → AC-2, AC-8
- [ ] When the version was made comes from its notice row's `created_at`: a booking made 23 hours ahead gets none, 24 hours ahead gets one; a reschedule is judged by the rescheduled row (tests) → AC-3
- [ ] The time budget is 20 seconds, checked before each booking: a clock already at 20 seconds queues nothing (test) → AC-2
- [ ] "Already reminded" is an `email_messages` row for (booking, `reminder`, version): a second run queues nothing (test) → AC-2, AC-4
- [ ] The recipient is `users.email` at queue time: change the learner's email before the mark → the reminder goes to the new address → AC-4
- [ ] The time zone is the booked email's (`bookingZone`): booked from a Kolkata screen by a New York learner → the reminder speaks India Time (test) → AC-5
- [ ] Name, lab type, testbed, start, end come from the locked booking's explicit read; no OS login in `details` (test) → AC-5
- [ ] Links are read at queue time: the portal URL edit above shows up in the reminder → AC-5
- [ ] App links come from the notice row's `details.appUrl`, never the worker's `appUrl()`: a notice with another app's URL is copied as is (test) → AC-5
- [ ] The job key is `reminder:<booking id>:<version>` (test) → AC-4
- [ ] Subject and card times come from `formatEmailDateTime(startsAt, timezone)` (snapshots) → AC-6, AC-7
- [ ] The greeting uses `firstName(learnerName)`: "Priya Raman" is greeted "Hi Priya" (test) → AC-7
- [ ] "Booking changed" compares `bookings.status` and `version` with the row's `booking_version`: cancelled and moved both suppress (tests) → AC-8
- [ ] No Bcc: a real address's reminder has none while its booked email has the Ops Bcc (tests) → AC-9
- [ ] Invite UID and SEQUENCE come from the booking id and the row's `booking_version` (test, snapshot) → AC-7
- [ ] The console label "Reminder" comes from `lib/email-log.ts` (test) → AC-13

## Acceptance-criteria coverage

- AC-1: the `grep` command, Value sourcing lead check
- AC-2: the worker log steps, the reminders tests (edges, budget, run twice)
- AC-3: the first manual step, the made inside window and reschedule tests
- AC-4: the log step, the row and job test, run twice, the bad appUrl test
- AC-5: the portal URL and zone steps, the row test
- AC-6: the dev inbox subject step, snapshots
- AC-7: the email content, invite, and client rendering steps, snapshots, the start up render
- AC-8: the suppress tests, the optional stale path
- AC-9: "Show original" step, the no Bcc and contrast tests
- AC-10: the two claim order tests
- AC-11: the cancelled and moved tests, the optional stale path
- AC-12: the catch up test, the optional no key path
- AC-13: the learner detail step, the console test
- AC-14: the Commands section and the real send above
