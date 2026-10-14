# Verify: Lab access & booking result screens · spec 0012 · updated 2026-10-14
_Steps derived from spec 0012 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Dev runs on `http://10.1.255.18:3000`. The VM used for the access steps is `https://nw4-mac1.nile.global` (testbed "Nile HOL 1", group `pod-nile-hol-1`).

## Before you start
- Test data, once, in the admin console: give `hol-test testbed` one client (any name, kind, and https URL), so the success card shows an active "<name> · <kind>" row; and add a second testbed of `hol-test type`, so a reschedule can land on a different testbed (AC-5).
- Rate limit: `book:email` allows 3 bookings an hour per email. `e2e/lab-access.spec.ts` and `e2e/reservations.spec.ts` both book as `hol-test-learner`, so run them in different hours, or run the guest steps below with `hol-test-Guest@Mixed.test` (password `~/secrets/hol-test-guest.pw`).
- Current booking: about an hour before you verify, book a slot for `hol-test-learner` on "Nile HOL 1", so the Current card, the Current note, and the access steps can all run in one pass when it starts.
- Worker: the access steps need the worker running (`WORKER_ENABLED=true npm run worker`, with the keyring env set). Dev and prod share one database, so only one worker may run.

Steps marked **(after task 6)** need the reconciler strand and the Cloudflare API key. Skip them until those land.

## UI / manual
- [ ] Sign in as `hol-test-learner` and book through `/book` (Booking as). Expect "Your lab access" under "View my reservations", with Nile Portal, LMS course, and one row per client as "<name> · <kind>", each "Open" opening a new tab → AC-2
- [ ] On that success card, inspect an "Open" link. Expect `target="_blank"` and `rel="noopener noreferrer"` → AC-2
- [ ] Sign out, then book as a guest using the email of an existing verified learner. Expect no lab access card, the line "Sign in with your existing credentials anytime to manage this reservation. Your lab access shows there once your lab starts." plus "Manage my reservations", and no portal, LMS, or client URL in the Server Action reply (DevTools, Network) → AC-3
- [ ] Book as a guest with a brand new email. Expect the "Set your password" box plus "After you set your password, sign in to Manage my reservation. Your lab access shows there once your lab starts.", and no card → AC-4
- [ ] As the signed in learner, reschedule a booking to a time when its testbed is taken (the second `hol-test type` testbed is then assigned). Expect the success card's links to be the newly assigned testbed's (compare with that testbed in the admin console) → AC-5
- [ ] On `/reservations`: an Upcoming card has no "View lab access"; a Current card shows Reschedule, View lab access, Cancel reservation in that order; a Past card shows only View lab access → AC-6
- [ ] Open `/reservations/<id>` for an Upcoming booking by URL. Expect "← All reservations", the testbed name as the heading with an Upcoming badge, Lab type, Starts, Ends, then "Lab access" with the start note, "Testbed assigned", and the link rows. The tab title is "Lab access" and the page source has `noindex` → AC-7
- [ ] Open `/reservations/<id>` for the Current booking. Expect the Current note ("Quote the testbed name below if you contact support. Access can take up to a minute to start after your start time.") and active links → AC-7
- [ ] Open `/reservations/<id>` with another learner's booking id, a cancelled booking's id, and `not-a-booking`. Expect a 404 each time. Signed out, expect a redirect to sign in → AC-7
- [ ] Open a Past booking's detail page. Expect the ended note, an "Ended" tag in place of every "Open", nothing focusable inside the card by Tab, no faded card, and none of the testbed's URLs in the page source or the RSC payload → AC-8

## Lab access (real Authentik and Cloudflare)
- [ ] Signed out, open the VM URL. Expect Cloudflare's login page offering only "Reservations HOL Labs" (its link carries the HOL Labs `client_id`, `kl9m0qxH…`) → AC-9
- [ ] As a learner in no `pod-*` group, sign in there. Expect Authentik's "Permission denied" (the `hol-labs-access` policy), with no Cloudflare session → AC-9
- [ ] With `hol-test-learner` in `pod-nile-hol-1` (its booking Current, or added by hand for this check and removed after), sign in. Expect the VM page, and `https://nw4-mac1.nile.global/cdn-cgi/access/get-identity` showing `groups` with `pod-nile-hol-1` → AC-9
- [ ] As a learner in a different `pod-*` group only, open the VM. Expect Cloudflare's "That account does not have access" → AC-9
- [ ] As `hol-test-learner`, open `cloudflare-integration` (any app still on the old login). Expect Authentik's "Permission denied" (spec 0003 AC-17 still holds) → AC-9
- [ ] For every VM Access app: login methods are only "Reservations HOL Labs", "Accept all available identity providers" is off, and the Allow policy requires `groups` = that testbed's `pod-<slug>` (the testbed's "Access group" field) → AC-9
- [ ] **(after task 6)** Let the Current booking start. Within about 30 seconds the learner is in `pod-nile-hol-1` in Authentik and the VM opens → AC-9
- [ ] **(after task 6)** With the VM tab open, cancel that booking. Within a tick the membership is gone; within about a minute the open VM tab stops updating and a reload lands on the Access login; the `access.revoked` audit row shows `sessionsEnded: true` and `vmRevoke: 'done'`. The detail page then shows the Past state → AC-8, AC-9, AC-10, AC-12
- [ ] **(after task 6)** Delete the `CLOUDFLARE` API key and wait a tick. Expect "Cloudflare VM revoke is off" once in the worker log and `vmRevoke: 'off'` on the next removal's audit row; add it back and expect "is on" once → AC-11, AC-12
- [ ] **(after task 6)** Start the worker without `APP_ENCRYPTION_KEYS_FILE` while the key exists. Expect "is broken" once, "Cloudflare revoke key can't be read" once per run, and `vmRevoke: 'failed'` with no Cloudflare call → AC-11

## Admin: the Cloudflare API key
- [ ] **(after task 5)** Add an API key of type Cloudflare with base URL `https://api.cloudflare.com/client/v4/accounts/<account id>` and the real token. Expect "Created <name>.", the masked value, and a neutral badge → AC-11
- [ ] **(after task 5)** Add it with a wrong token, then with the right token and a wrong account id. Expect "Cloudflare didn't accept this token for this account." each time and nothing saved → AC-11
- [ ] **(after task 5)** Add a second Cloudflare key. Expect the "only one Cloudflare key" field error on type → AC-11
- [ ] **(after task 5)** Edit the key's base URL with the key value blank. Expect "Enter the key again to change its type or account."; with the token typed, the save works. Rename it with the key blank: it saves with no Cloudflare call → AC-11

## Value sourcing
- [ ] Ownership: open the detail page for a booking of another learner's that you can see in the admin console. Expect 404, never their links → `ownLabAccess` ownership
- [ ] Verified gate: clear `email_verified_at` on a test learner (rolled back DB test, or a throwaway `dev-` user), then open their booking. Expect 404 → `ownLabAccess` verified gate
- [ ] Testbed URLs: change a testbed's portal URL in the admin console, then reload a detail page on it. Expect the new URL. Soft delete a testbed with a Past booking; its detail page still shows the name → testbed name, portal, LMS
- [ ] Clients: reorder a testbed's clients in the admin console. Expect the detail page rows to follow `position` → clients
- [ ] Lab type: the Lab type row matches the type shown on `/reservations` → lab type name
- [ ] Phase: the badge and the note change as the booking moves Upcoming to Current to Past (by the DB clock, not the browser's) → phase, badge tone
- [ ] Zone: change the learner's account timezone; Starts and Ends on the detail page follow `users.timezone`, not the browser zone → Starts, Ends
- [ ] Note and link state: Current and Upcoming show links, Past shows "Ended" → `labAccessView`
- [ ] View lab access: shown on Current and Past cards only → `cardActions(...).viewAccess`
- [ ] `bookAction` access: a signed in learner booking for themselves gets links; a guest gets none even with a learner's email → `account.id === booked.userId`
- [ ] Success copy: new user, reused guest, and signed in learner each get their own line → `booked.newUser` plus `access`
- [ ] `rescheduleAction` access: read after the move commits, so it is the new testbed's links → `ownLabAccess` after `rescheduleOwnBooking`
- [ ] Success note: always the Upcoming start note (a start is at least an hour ahead) → success cards' note
- [ ] **(after task 6)** Revoke email is `users.email` looked up by the Authentik pk; a pk with no users row records `failed` with no call → reconciler email
- [ ] **(after task 6)** `sessionsEnded` and `vmRevoke` in the audit metadata match what happened → reconciler outcome
- [ ] **(after task 6)** The base URL and token come from the live `CLOUDFLARE` API key, read once per run; nothing reads a `CLOUDFLARE_*` env var → `cloudflareRevokeConfig`

## Commands
- [ ] `npm test` → all pass, including `server/booking/lab-access.test.ts`, `app/reservations/[id]/page.test.ts`, `server/cloudflare/access.test.ts`, the `cloudflareRevokeConfig` DB tests, and the reconciler tests → AC-1, AC-2, AC-3, AC-5, AC-7, AC-8, AC-10, AC-11, AC-12
- [ ] `npx playwright test e2e/lab-access.spec.ts` → passes with axe at 1280 and 390, screenshots in `e2e/screenshots/*-lab-*.png` → AC-2, AC-6, AC-7
- [ ] `npx vitest run tests/design-contrast.test.ts tests/os-password-scan.test.ts tests/secret-column-scan.test.ts` → the Ended tag pair is AA, `os_password` still appears only in `server/catalog/testbeds.ts`, and `secret_ciphertext` only in `server/catalog/api-keys.ts` → AC-1, AC-8, AC-11
- [ ] `npm run authentik:setup` (dry run) → reports the HOL Labs objects as present with no changes, and no warning for `hol-lab-authorization` → AC-9
- [ ] The same dry run needs `CLOUDFLARE_TEAM_DOMAIN=soleng2018.cloudflareaccess.com` (plus `AUTHENTIK_URL`, `AUTHENTIK_MASTER_TOKEN_FILE`, and `APP_URLS`); without it, expect it to stop with "CLOUDFLARE_TEAM_DOMAIN is missing" and read nothing → AC-9
- [ ] `npx playwright test e2e/hol-labs.spec.ts e2e/isolation.spec.ts` → a learner passes HOL Labs only while in a `pod-*` group (its own throwaway `pod-hol-test-e2e-labs`, deleted after), with that group in the `groups` claim; `cloudflare-integration` stays denied meanwhile; an admin passes with no group; no code ever reaches Cloudflare → AC-9 (spec 0003 AC-17, AC-19)
- [ ] With the worker off, read `cloudflareRevokeConfig` once against the real database (a throwaway `tsx --conditions=react-server` script that prints only the kind) → `off` until the owner adds the `CLOUDFLARE` key, then `on`; never the token → AC-11

## Acceptance-criteria coverage
- AC-1: DB tests in `server/booking/lab-access.test.ts`, Value sourcing ownership and verified gate steps
- AC-2: success card steps, `components/book/booking-success.test.ts`, `app/book/actions.test.ts`, Playwright
- AC-3: guest step, `app/book/actions.test.ts`, `components/book/booking-success.test.ts`
- AC-4: new user step, `components/book/booking-success.test.ts`
- AC-5: reschedule step, `app/reservations/[id]/reschedule/actions.test.ts`, `components/reservations/reschedule-success.test.ts`
- AC-6: list step, `lib/manage-reservations.test.ts`, Playwright, UI gallery
- AC-7: detail page steps, `app/reservations/[id]/page.test.ts`, Playwright
- AC-8: Past step, `components/reservations/lab-access-card.test.ts`, `app/reservations/[id]/page.test.ts`, contrast test
- AC-9: Lab access steps (most already passed in spike 3 on 2026-10-14), setup script dry run
- AC-10, AC-12: the (after task 6) steps; AC-10 units already in `server/cloudflare/access.test.ts`
- AC-11: the admin key steps, the off and broken steps, the `cloudflareRevokeConfig` DB tests
