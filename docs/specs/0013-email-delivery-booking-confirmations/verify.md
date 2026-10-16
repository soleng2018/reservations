# 0013 verify: mail client matrix (AC-17, AC-23)

Run once before the feature is `done`, after the owner setup in [index.md](index.md). Use a `dev-` learner, with the Dev inbox set to a mailbox you can open in each client below (one Workspace or Gmail mailbox added to every client works).

## Steps

1. Book a slot as the `dev-` learner. Wait for the email (about a minute).
2. Reschedule it to another day.
3. Cancel it.
4. Open the HOL bookings calendar and check that the event appeared with a `[dev] ` prefix, moved, and was removed.

If a client shows the invite with an Add button instead of adding it on its own (Gmail does this for senders it doesn't trust yet), click Add, then continue. That is expected and counts as a pass.

## Matrix

For each client, record pass or fail and a note. "Layout" means it matches the standalone file in `context/` side by side: logo shows, heading, details card, link list, button, footer, and no broken images.

| Client | Booked layout | Invite added (automatically, or with Add) | Rescheduled: event moved, no duplicate | Cancelled layout | Event removed | Notes |
|---|---|---|---|---|---|---|
| Gmail web | | | | | | |
| Gmail Android or iOS | | | | | | |
| Outlook on the web | | | | | | |
| Outlook desktop (Windows) | | | | | | |
| Apple Mail (macOS or iOS) | | | | | | |

Also check: the subject reads `[dev] Your Nile Hands-On Lab access - <start>` with the time in the learner's zone; the Ops BCC mailbox got no copy (rerouted mail is never Bcc'd); the learner's Emails section on `/admin/users/<id>` shows three Sent rows.

Recorded by: ____ on ____

# Verify: email delivery and booking confirmations · spec 0013 · updated 2026-10-15
_Steps derived from spec 0013 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual

- [ ] On `/admin/api-keys`, Add API key, Type `GOOGLE`: Base URL and Key value disappear; Key file, Sender mailbox, Calendar ID, Dev inbox, Ops BCC appear with their helper text → AC-1
- [ ] Save with no file → "Choose the key file." on Key file; with an OAuth client JSON → "This isn't a Google service account key file (.json)." → AC-1, AC-3
- [ ] Save the real key file with the HOL mailbox, the HOL bookings Calendar ID, a `dev-` inbox you own, and the Ops BCC → "Created …"; the row shows a grey `GOOGLE` badge and the sender mailbox in the Base URL cell → AC-1, AC-2
- [ ] Add a second `GOOGLE` key → "Only one Google key can exist. Edit the existing one." on Type → AC-1
- [ ] Save a key whose client ID has no domain wide delegation entry → the message names that client ID and both scopes, and nothing is saved → AC-2
- [ ] Save with a Calendar ID the sender can't open → "<sender> can't open this calendar…" on Calendar ID → AC-2
- [ ] Edit the key: change only Dev inbox or Ops BCC with no file → saves; change Sender mailbox or Calendar ID with no file → "Upload the key file again to change the sender, calendar, or type." → AC-4
- [ ] View page source and the network panel while editing: no private key, key id, or ciphertext ever comes back → AC-3, AC-5
- [ ] Book as a `dev-` learner with timezone `Asia/Kolkata`; within about a minute the dev inbox gets "[dev] Your Nile Hands-On Lab access - <start in India Time>" with the logo, the details card, the links, and the button to `<APP_URL>/reservations` → AC-6, AC-11, AC-12, AC-14, AC-16
- [ ] That message is not Bcc'd to the Ops BCC (rerouted) → AC-15, AC-16
- [ ] Reschedule it, then cancel it → "Updated: …" then "Cancelled: … reservation …" arrive in that order; the invite moves, then removes the event → AC-6, AC-10, AC-13, AC-17
- [ ] Cancel a learner's booking from the admin console, and deactivate a learner with a live booking → each sends one cancellation → AC-6, AC-13
- [ ] The HOL bookings calendar shows "[dev] <name> · <lab type> · <testbed>", moved after the reschedule and gone after the cancel → AC-19
- [ ] `/admin/users/<that learner>`: Emails lists three Sent rows newest first, To shows the dev inbox → AC-21
- [ ] Delete the `GOOGLE` key, book again → the booking succeeds as before; the worker logs "jobs: no Google key, email and calendar jobs wait" once; the learner page shows "Email isn't set up yet. Add a Google key on API Keys." and a Queued row → AC-7, AC-9, AC-21
- [ ] Run the mail client matrix above → AC-17, AC-23

## Value sourcing

- [ ] Change the learner's timezone after booking, then reschedule: the new email uses the zone the learner has when it is queued, and the earlier email keeps its own times → AC-11, AC-14
- [ ] Edit the testbed's client links after booking: the booked email that already went out is unchanged; the next reschedule email shows the new links in `position` order → AC-11
- [ ] A learner with a real (non test) address gets the email at their own address with the Ops BCC copy → AC-16
- [ ] A test address with Dev inbox blank → the row is Suppressed with "Test address and no dev inbox is set." and nothing is sent → AC-16
- [ ] An email queued for a booking that has already ended when the worker runs → Suppressed, "The booking had already ended." → AC-18
- [ ] The invite's UID is `<booking id>@nile-hol-reservations` and SEQUENCE is the booking version (1, 2, 3 across book, reschedule, cancel) → AC-17

## Commands

- [ ] `npm test` → all pass, including `server/jobs/jobs.test.ts`, `server/email/compose.test.ts` (snapshots), `tests/google-key-scan.test.ts`, `worker/server-only-hook.test.ts` → AC-5, AC-8 to AC-10, AC-15 to AC-19, AC-22, AC-23
- [ ] `npx playwright test e2e/api-keys.spec.ts e2e/users.spec.ts` → pass → AC-1 to AC-3, AC-5, AC-21
- [ ] `npm run calendar:backfill` → prints a dry run count and writes nothing; `-- --apply` queues them; a second `-- --apply` queues 0 → AC-20
- [ ] `npm run db:codegen -- --verify` → no drift → AC-24
- [ ] With `WORKER_ENABLED=true`, `npm run worker` starts (the render smoke check passes) → AC-22

## Acceptance-criteria coverage

- AC-1 to AC-4: UI steps 1 to 7 · AC-5: step 8, the scan · AC-6: steps 9, 11, 12 · AC-7: step 15 · AC-8 to AC-10: tests, step 11, step 15 · AC-11: step 9, value sourcing 1 and 2 · AC-12, AC-13: steps 9, 11 · AC-14: step 9, value sourcing 1 · AC-15, AC-16: steps 9, 10, value sourcing 3 and 4 · AC-17: step 11, value sourcing 6 · AC-18: value sourcing 5 · AC-19: step 13 · AC-20: backfill command · AC-21: steps 14, 15 · AC-22: worker command · AC-23: matrix · AC-24: codegen verify
