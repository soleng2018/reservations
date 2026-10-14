# Verify: Lab access & booking result screens · spec 0012 · updated 2026-10-14
_Steps derived from spec 0012 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Dev runs on `http://10.1.255.18:3000`. The `hol-test-learner` account books at most 3 times an hour (`book:email`), so space out runs that book.

Steps marked **(after task 5)** need the reconciler strand, which waits on spike 3. Skip them until that lands.

## UI / manual
- [ ] Sign in as `hol-test-learner` and book through `/book` (Booking as). Expect "Your lab access" under "View my reservations", with Nile Portal, LMS course, and one row per client as "<name> · <kind>", each "Open" opening a new tab → AC-2
- [ ] On that success card, inspect an "Open" link. Expect `target="_blank"` and `rel="noopener noreferrer"` → AC-2
- [ ] Sign out, then book as a guest using the email of an existing verified learner. Expect no lab access card, the line "Sign in with your existing credentials anytime to manage this reservation. Your lab access shows there once your lab starts." plus "Manage my reservations", and no portal, LMS, or client URL in the Server Action reply (DevTools, Network) → AC-3
- [ ] Book as a guest with a brand new email. Expect the "Set your password" box plus "After you set your password, sign in to Manage my reservation. Your lab access shows there once your lab starts.", and no card → AC-4
- [ ] As the signed in learner, reschedule a booking to a time when its testbed is taken. Expect the success card's links to be the newly assigned testbed's (compare with that testbed in the admin console) → AC-5
- [ ] On `/reservations`: an Upcoming card has no "View lab access"; a Current card shows Reschedule, View lab access, Cancel reservation in that order; a Past card shows only View lab access → AC-6
- [ ] Open `/reservations/<id>` for an Upcoming booking by URL. Expect "← All reservations", the testbed name as the heading with an Upcoming badge, Lab type, Starts, Ends, then "Lab access" with the start note, "Testbed assigned", and the link rows. The tab title is "Lab access" and the page source has `noindex` → AC-7
- [ ] Open `/reservations/<id>` with another learner's booking id, a cancelled booking's id, and `not-a-booking`. Expect a 404 each time. Signed out, expect a redirect to sign in → AC-7
- [ ] Open a Past booking's detail page. Expect the ended note, an "Ended" tag in place of every "Open", nothing focusable inside the card by Tab, no faded card, and none of the testbed's URLs in the page source or the RSC payload → AC-8
- [ ] **(after task 5)** Let a `dev-` booking become Current. Within about 30 seconds the learner is in `pod-<slug>` in Authentik and the links open → AC-9
- [ ] **(after task 5)** With a VM tab open, cancel that booking. Within a tick the membership is gone, the open VM tab is cut off, and the `access.revoked` audit row shows `sessionsEnded: true` and `vmRevoke: 'done'`. The detail page then shows the Past state → AC-8, AC-9, AC-10, AC-12
- [ ] **(after task 5)** Start the worker with both Cloudflare variables unset. Expect "Cloudflare VM revoke is off" once in the log, and `vmRevoke: 'off'` on the next removal's audit row → AC-11, AC-12

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
- [ ] **(after task 5)** Revoke email is `users.email` looked up by the Authentik pk; a pk with no users row records `failed` with no call → reconciler email
- [ ] **(after task 5)** `sessionsEnded` and `vmRevoke` in the audit metadata match what happened → reconciler outcome
- [ ] **(after task 5)** The worker reads `CLOUDFLARE_ACCOUNT_ID` and the token file at start; the web process never does → `cloudflareEnv()`

## Commands
- [ ] `npm test` → all pass, including `server/booking/lab-access.test.ts`, `app/reservations/[id]/page.test.ts`, `server/cloudflare/access.test.ts`, `server/env.test.ts` → AC-1, AC-2, AC-3, AC-5, AC-7, AC-8, AC-10, AC-11
- [ ] `npx playwright test e2e/lab-access.spec.ts` → passes with axe at 1280 and 390, screenshots in `e2e/screenshots/*-lab-*.png` → AC-2, AC-6, AC-7
- [ ] `npx vitest run tests/design-contrast.test.ts tests/os-password-scan.test.ts` → the Ended tag pair is AA, and `os_password` still appears only in `server/catalog/testbeds.ts` → AC-1, AC-8

## Acceptance-criteria coverage
- AC-1: DB tests in `server/booking/lab-access.test.ts`, Value sourcing ownership and verified gate steps
- AC-2: success card steps, `components/book/booking-success.test.ts`, `app/book/actions.test.ts`, Playwright
- AC-3: guest step, `app/book/actions.test.ts`, `components/book/booking-success.test.ts`
- AC-4: new user step, `components/book/booking-success.test.ts`
- AC-5: reschedule step, `app/reservations/[id]/reschedule/actions.test.ts`, `components/reservations/reschedule-success.test.ts`
- AC-6: list step, `lib/manage-reservations.test.ts`, Playwright, UI gallery
- AC-7: detail page steps, `app/reservations/[id]/page.test.ts`, Playwright
- AC-8: Past step, `components/reservations/lab-access-card.test.ts`, `app/reservations/[id]/page.test.ts`, contrast test
- AC-9, AC-10, AC-11, AC-12: the steps marked (after task 5); AC-10 and AC-11 units already in `server/cloudflare/access.test.ts` and `server/env.test.ts`
