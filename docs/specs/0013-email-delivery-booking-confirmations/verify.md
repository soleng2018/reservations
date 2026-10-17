# 0013 verify: mail client matrix (AC-17, AC-23)

Run once before the feature is `done`, after the owner setup in [index.md](index.md). Use a `dev-` learner, with the Dev inbox set to a mailbox you can open in each client below (one Workspace or Gmail mailbox added to every client works).

## Steps

1. Book a slot as the `dev-` learner. Wait for the email (about a minute).
2. Reschedule it to another day.
3. Cancel it.
4. Open the HOL bookings calendar and check that the event appeared with a `[dev] ` prefix, moved, and was removed.

If a client shows the invite with an Add button instead of adding it on its own (Gmail does this for senders it doesn't trust yet), click Add, then continue. That is expected and counts as a pass.

## Matrix

**Rerun from scratch after build plan task 14 (AC-15 amended 2026-10-16).** The rows below came from the old MIME tree, where the calendar alternative was last, and are kept as history. Record a new row per client below them, iOS Mail, the Gmail app, and Outlook first. In every client, check that the body shows and that exactly one `invite.ics` is attached (no `mime-attachment.ics`).

For each client, record pass or fail and a note. "Layout" means it matches the standalone file in `context/` side by side: logo shows, heading, details card, link list, button, footer, and no broken images.

| Client | Booked layout | Invite added (automatically, or with Add) | Rescheduled: event moved, no duplicate | Cancelled layout | Event removed | Notes |
|---|---|---|---|---|---|---|
| Gmail web | pass | | | pass | | 2026-10-16, booking `9fa0a659`: logo, heading, details card, links, password note, button match. Rescheduled email renders with its heading and the new time (11:00 PM to 1:00 AM GMT+0). Cancelled email matches the mock, footer included (the shared `NileFooter`). Invite, event move, and event removal not yet checked |
| Gmail Android or iOS | | | | | | |
| Outlook on the web | | | | | | |
| Outlook desktop (Windows) | | | | | | |
| Apple Mail (macOS or iOS) | **fail** | | | | | 2026-10-16, iOS Mail, booking `9fa0a659`: no body at all, only `mime-attachment.ics` (708 bytes) and `invite.ics` (727 bytes). The `text/calendar` alternative is the last part of `multipart/alternative`, so iOS shows it instead of the HTML |

Also check: the subject reads `[dev] Your Nile Hands-On Lab access - <start>` with the time in the learner's zone; the Ops BCC mailbox got no copy (rerouted mail is never Bcc'd); the learner's Emails section on `/admin/users/<id>` shows three Sent rows.

Recorded by: ____ on ____

# Verify: email delivery and booking confirmations · spec 0013 · updated 2026-10-15
_Steps derived from spec 0013 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual

- [ ] On `/admin/api-keys`, Add API key, Type `GOOGLE`: Base URL and Key value disappear; Key file, Sender mailbox, Calendar ID, Dev inbox, Ops BCC appear with their helper text → AC-1
- [x] Save with no file → "Choose the key file." on Key file; with a file that isn't JSON → "This isn't a Google service account key file (.json)."; with an OAuth client JSON → "This is an OAuth client file. Choose Google sign in as the sign in method, or use a service account key." (AC-26, amended 2026-10-16) → AC-1, AC-3, AC-26
- [ ] Save the real key file with the HOL mailbox, the HOL bookings Calendar ID, a `dev-` inbox you own, and the Ops BCC → "Created …"; the row shows a grey `GOOGLE` badge and the sender mailbox in the Base URL cell → AC-1, AC-2
- [ ] Add a second `GOOGLE` key → "Only one Google key can exist. Edit the existing one." on Type → AC-1
- [ ] Save a key whose client ID has no domain wide delegation entry → the message names that client ID and both scopes, and nothing is saved → AC-2
- [ ] Save with a Calendar ID the sender can't open → "<sender> can't open this calendar…" on Calendar ID → AC-2
- [ ] Edit the key: change only Dev inbox or Ops BCC with no file → saves; change Sender mailbox or Calendar ID with no file → "Upload the key file again to change the sender, calendar, or type." → AC-4
- [x] View page source and the network panel while editing: no private key, key id, or ciphertext ever comes back → AC-3, AC-5
- [ ] Book as a `dev-` learner with timezone `Asia/Kolkata`; within about a minute the dev inbox gets "[dev] Your Nile Hands-On Lab access - <start in India Time>" with the logo, the details card, the links, and the button to `<APP_URL>/reservations` → AC-6, AC-11, AC-12, AC-14, AC-16
- [ ] That message is not Bcc'd to the Ops BCC (rerouted) → AC-15, AC-16
- [ ] Reschedule it, then cancel it → "Updated: …" then "Cancelled: … reservation …" arrive in that order; the invite moves, then removes the event → AC-6, AC-10, AC-13, AC-17
- [ ] Cancel a learner's booking from the admin console, and deactivate a learner with a live booking → each sends one cancellation → AC-6, AC-13
- [ ] The HOL bookings calendar shows "[dev] <name> · <lab type> · <testbed>", moved after the reschedule and gone after the cancel → AC-19
- [x] `/admin/users/<that learner>`: Emails lists three Sent rows newest first, To shows the dev inbox → AC-21
- [ ] Delete the `GOOGLE` key, book again → the booking succeeds as before; the worker logs "jobs: no Google key, email and calendar jobs wait" once; the learner page shows "Email isn't set up yet. Add a Google key on API Keys." and a Queued row → AC-7, AC-9, AC-21
- [ ] Run the mail client matrix above → AC-17, AC-23
- [ ] In Gmail web, "Show original" on a booked email: `multipart/mixed` holds `multipart/alternative` (text, then `multipart/related` with the HTML and logo), then one `text/calendar; charset=utf-8; method=REQUEST` part with `Content-Disposition: attachment; filename="invite.ics"`. There is no `application/ics` part, and Gmail still shows its invite card → AC-15, AC-17
- [ ] Book as a new `dev-` learner: the booked email has the "Set your password" box, with no "Existing users…" sentence. Reschedule: the email reads "your reservation was moved. Here are the new details." and has no box. Book again later as that same learner: no box → AC-12

## Value sourcing

- [ ] Change the learner's timezone after booking, then reschedule: the new email uses the zone the learner has when it is queued, and the earlier email keeps its own times → AC-11, AC-14
- [ ] A returning `dev-` learner stored as `America/New_York`, signed out, books through the guest form picking `Asia/Kolkata`: the success screen and the booked email both show India Time; the learner's stored zone is still New York; a reschedule after signing in sends an email in ET → AC-6, AC-11
- [ ] Edit the testbed's client links after booking: the booked email that already went out is unchanged; the next reschedule email shows the new links in `position` order → AC-11
- [ ] A learner with a real (non test) address gets the email at their own address with the Ops BCC copy → AC-16
- [ ] A test address with Dev inbox blank → the row is Suppressed with "Test address and no dev inbox is set." and nothing is sent → AC-16
- [ ] An email queued for a booking that has already ended when the worker runs → Suppressed, "The booking had already ended." → AC-18
- [x] The invite's UID is `<booking id>@nile-hol-reservations` and SEQUENCE is the booking version (1, 2, 3 across book, reschedule, cancel) → AC-17

## Commands

- [x] `npm test` → all pass, including `server/jobs/jobs.test.ts`, `server/email/compose.test.ts` (snapshots), `tests/google-key-scan.test.ts`, `worker/server-only-hook.test.ts` → AC-5, AC-8 to AC-10, AC-15 to AC-19, AC-22, AC-23
- [x] `npx playwright test e2e/api-keys.spec.ts e2e/users.spec.ts` → pass → AC-1 to AC-3, AC-5, AC-21
- [x] `npm run calendar:backfill` → prints a dry run count and writes nothing; `-- --apply` queues them; a second `-- --apply` queues 0 → AC-20
- [x] `npm run db:codegen -- --verify` → no drift → AC-24
- [x] With `WORKER_ENABLED=true`, `npm run worker` starts (the render smoke check passes) → AC-22

## Acceptance-criteria coverage

- AC-1 to AC-4: UI steps 1 to 7 · AC-5: step 8, the scan · AC-6: steps 9, 11, 12, value sourcing 2 · AC-7: step 15 · AC-8 to AC-10: tests, step 11, step 15 · AC-11: step 9, value sourcing 1 to 3 · AC-12, AC-13: steps 9, 11, 18 · AC-14: step 9, value sourcing 1 · AC-15, AC-16: steps 9, 10, 17, value sourcing 4 and 5, the MIME tree test · AC-17: steps 11, 17, value sourcing 7 · AC-18: value sourcing 6 · AC-19: step 13 · AC-20: backfill command · AC-21: steps 14, 15 · AC-22: worker command · AC-23: matrix · AC-24: codegen verify

# Verify: Google sign in (amended 2026-10-16) · spec 0013 · updated 2026-10-16
_Steps derived from spec 0013 AC-25 to AC-34 and the amended Value sourcing rows. The UI steps need the owner's Google sign in setup in [index.md](index.md) (a Desktop app OAuth client, the consent screen In production, and the Gmail account's HOL bookings calendar). `/check verify` runs these; `/test` locks the durable ones._

## UI / manual

- [x] Add API key, Type `GOOGLE`: "Sign in method" shows with Service account (Workspace) selected. Choose Google sign in (personal Gmail, for testing): Key file and Sender mailbox go away; OAuth client file, Calendar ID, Dev inbox, Ops BCC, and Sign in with Google appear → AC-25
- [ ] Sign in with Google with a Web application client file, a service account key, and a file that isn't JSON → each gives its own message on OAuth client file, and no `hol_google_sign_in` cookie is set (DevTools, Application) → AC-26
- [ ] With the Desktop app client file, click Sign in with Google → the button spins and Save is off while it runs, then "Open Google sign in" (opens a new tab) and "Google sign in address" appear. The cookie is HttpOnly, SameSite Lax, path `/admin`, 10 minutes, not Secure on the http dev URL, and holds only `v1:` ciphertext → AC-27
- [ ] Open the link, sign in as the Gmail account, click through the unverified app warning, keep both permissions, copy the `http://127.0.0.1:47613/?state=…&code=…` address of the page that won't load, paste it, and Save → "Created …"; the row shows `GOOGLE`, "Google sign in" under it, and the Gmail address in the Base URL cell → AC-28, AC-32
- [ ] Start a sign in, paste the address, and wait over 10 minutes before Save → "This sign in expired or belongs to another attempt. Sign in with Google again." on the address → AC-28
- [ ] Sign in again but untick Calendar on Google's screen → "Allow both sending email and Calendar events…", and the address field and the link go away (start over) → AC-28
- [ ] Paste the same address a second time after a failed save that spent it → "Google didn't accept this sign in (it may have been used already)…" → AC-28
- [ ] Start a sign in and paste the address, then cut the dev machine off from `oauth2.googleapis.com` (unplug the network, or point it at `0.0.0.0` in `/etc/hosts`) and Save → "Couldn't reach Google to check the key. Try again.", and the address field and the link stay. Reconnect and Save again with nothing changed → "Created …" (task 13) → AC-28
- [ ] Book as a `dev-` learner → within about a minute the dev inbox gets the booked email from the Gmail address, and the HOL bookings calendar of that Gmail account shows the `[dev] ` event → AC-30
- [ ] Edit the key: the dialog opens on Google sign in with "Signed in as <gmail>". Change Ops BCC only → saves with no Google sign in. Change Calendar ID with no sign in → "Sign in with Google again to change the calendar." Switch to Service account with no key file → "Upload the key file to switch to Service account." → AC-29
- [ ] In the Gmail account, remove this app under Third party apps and services, then book again → within a tick the worker logs "jobs: Google rejected the Google sign in, jobs wait 5 minutes" once, the learner's Emails row shows "Google sign in stopped working (…)", and API Keys shows an accent "Needs attention" badge with "Since <today>: Google sign in stopped working. Edit the key and sign in again." → AC-31, AC-32
- [ ] Edit the key and sign in with Google again → the badge clears on save, and the waiting email sends within about 5 minutes → AC-29, AC-31
- [x] Under Service account, upload the OAuth client file as the key file → "This is an OAuth client file. Choose Google sign in as the sign in method, or use a service account key." → AC-26
- [ ] Moving to production (when the Workspace setup exists): edit the key, choose Service account, upload the key file with the Workspace sender → saves, the row shows "Service account", and the next email comes from the Workspace mailbox → AC-29, AC-30

## Value sourcing

- [ ] `sender_email` is the `id_token` email: sign in as the Gmail account while the Calendar ID belongs to a calendar shared from another account → the row's sender is still the account that signed in → AC-28 step 7
- [ ] `issuedAt` and the 10 minute check come from the DB clock (`dbNow()`), not the browser's clock: change the browser machine's clock and the expiry still follows the database → AC-27, AC-28 step 4
- [ ] The cookie is bound to the admin who started it: a second admin who pastes your address gets "This sign in expired or belongs to another attempt…" → AC-28 step 4
- [ ] The client secret comes from the file uploaded again with the Save, and must match the cookie's client id: start with one Desktop client, Save with another → the expired message, and no exchange → AC-28 step 4
- [ ] The worker's access token comes from the refresh grant (`refreshAccessToken`) with the decrypted `{ clientId, clientSecret, refreshToken }`; the Gmail Sent folder of the signed in account holds each email → AC-30
- [ ] `google_rejected_at` is set by the breaker and cleared by a successful call or a save with a new secret; a breaker from a secret older than the stored one never sets it → AC-31
- [ ] The method label and Needs attention line come from `google_auth` and `google_rejected_at`; the day is in the admin's timezone → AC-32

## Commands

- [x] `npm test` → all pass, including `lib/google-sign-in.test.ts`, `server/google/token.test.ts`, `server/google/verify.test.ts`, `app/admin/actions.test.ts` (Google sign in, including "keeps the cookie when Google can't be reached at the exchange, so the same save then succeeds"), `server/catalog/api-keys.test.ts`, `server/jobs/jobs.test.ts` (the marker), `tests/google-key-scan.test.ts`, `tests/google-refresh-token-scan.test.ts` → AC-25 to AC-31, AC-33, AC-34
- [x] `npx playwright test e2e/api-keys.spec.ts` → passes, including "Google sign in swaps the fields, starts a sign in, and refuses a wrong address" with axe, and no client secret in any reply or the page → AC-25, AC-27, AC-28, AC-33
- [x] `npm run db:codegen -- --verify` → no drift; `server/db/db-enums.test.ts` covers `api_keys.google_auth` → AC-34

## Acceptance-criteria coverage

- AC-25: UI step 1, Playwright · AC-26: UI steps 2 and 13, `lib/google-sign-in.test.ts`, action tests · AC-27: UI step 3, value sourcing 2, action tests · AC-28: UI steps 4 to 8, value sourcing 1 to 4, action and `verify.test.ts` tests · AC-29: UI steps 10, 12, 14, catalog tests · AC-30: UI step 9, value sourcing 5, token and jobs tests · AC-31: UI steps 11 and 12, value sourcing 6, jobs tests · AC-32: UI steps 4 and 11, value sourcing 7, catalog list test · AC-33: the refresh token scan, canary checks in the action, jobs, and Playwright tests · AC-34: codegen verify, the parity test, the check constraint tests
