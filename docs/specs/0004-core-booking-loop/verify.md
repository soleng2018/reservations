# Verify: Core booking loop · spec 0004 · updated 2026-10-08
_Steps derived from spec 0004 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Dev and prod share one database and one Authentik. Use `e2e ` names and `dev-` emails for anything you create, and note them for cleanup. Dev runs on `http://10.1.255.18:3000`.

## UI / manual
- [ ] Sign in at `/l0gin` as `hol-test-admin` → lands on `/admin` with both create forms and both lists, no edit or delete controls → AC-1, AC-13
- [ ] Create a type with an empty name, then duration `0` → field errors "Enter a name." and "Use at least 1." → AC-1
- [ ] Create a type whose name matches an existing one in another case → "A testbed type with this name already exists." → AC-1
- [ ] Create a testbed with an `http:` portal URL, and a client with an empty name → field errors on those fields, nothing saved → AC-2
- [ ] Create a testbed `e2e …` → the list shows `pod-<slug>`; in Authentik the group exists with attribute `hol_testbed_id` = the testbed's id → AC-2
- [ ] Create a second testbed whose name slugifies the same (`e2e-x` after `e2e x`) → its slug gets `-2` → AC-2 (slug value source)
- [ ] With an Authentik group `pod-<slug>` already present (made by hand), create a testbed of that name → "Couldn't create the testbed's access group, try again", no row, the existing group untouched → AC-2
- [ ] Open `/book` → Step 1 form, page source has `noindex`, no link to `/l0gin` anywhere → AC-3, AC-13
- [ ] Lab type lists only types with at least one testbed whose group is ready → AC-3 (bookable types source)
- [ ] With the browser zone set to `Asia/Kolkata`, the timezone defaults to `Asia/Calcutta` (an alias), and starts read as `:00` and `:30` local; switch to `America/St_Johns` → starts read as `:30` / `:00` local, the list reformats without reloading → AC-3 (default timezone and display sources)
- [ ] Pick a type → starts begin at least 1 hour from now, end within 14 days, grouped by day in the chosen zone, 7 days shown, "Show more days" reveals the rest → AC-3 (lead and horizon constants, DB now)
- [ ] Pick a type whose only testbed is fully booked → "No free times in the next 14 days." → AC-3
- [ ] Book with a new `dev-` email → confirmation shows type, testbed, start and end in the chosen zone, "Check your email for a link to set your password.", and no lab links → AC-5, AC-6 (testbed and end time come from the server, `newUser` from saga step 2)
- [ ] Book again with an email that already has an Authentik user and no live booking → confirmation says "Sign in to manage your reservation" with a `/reservations` link → AC-6
- [ ] Book again with the same email while the first booking is Upcoming → "You already have an active booking. Sign in to manage it." with a link → AC-8
- [ ] Use an admin's email → "This email can't be used for booking." → AC-8
- [ ] Leave the page open until a listed start is less than 1 hour away, then confirm it → "That time was just taken. Please pick another.", the fields keep their values, the list reloads without that time → AC-7
- [ ] Two browsers, one free testbed, same start, confirm both at once → exactly one booking, the other sees the AC-7 message; with two testbeds both succeed on different testbeds → AC-10
- [ ] Submit 6 times within 10 minutes from one IP (prod, `TRUST_PROXY_HEADERS=true`) → the 6th shows "Please try again in a little while." with no Turnstile call → AC-4 (IP source)
- [ ] In dev (`TRUST_PROXY_HEADERS=false`), confirm the `rate_limits` rows use the key `book:ip:untrusted` → AC-4 (IP source)
- [ ] After a failed submit the Turnstile widget resets (a new token) → AC-4

## Worker and access
- [ ] `WORKER_ENABLED=false npm run worker` → logs that it is not starting and exits 0 → AC-11
- [ ] `WORKER_ENABLED=true npm run worker` in two shells → the second logs "another worker holds the lock" and exits → AC-11
- [ ] With the worker running, when a `dev-` booking's start passes, within about 30 seconds the learner is in `pod-<slug>` in Authentik and an `access.granted` audit row exists → AC-12 (desired members by DB clock)
- [ ] When that booking's end passes, the learner leaves the group, their Authentik sessions are gone, `access.revoked` is audited, and the booking is `completed` → AC-11, AC-12
- [ ] Add an untagged user to that pod group by hand → the reconciler leaves them in → AC-12
- [ ] Stop the worker with SIGTERM mid run → it logs "finishing the current step" and exits 0 → AC-11

## Commands
- [ ] `npm test` → all pass (DB suites run against `.env.local`, always rolled back) → AC-1 to AC-13
- [ ] `npm run test:e2e -- booking` → passes; it commits an `e2e type …`, `e2e bench …` (plus its pod group), a `dev-guest-…` learner, and a booking, so clean those up after → AC-1, AC-2, AC-3, AC-5, AC-6
- [ ] `npm run lint && npm run typecheck && npm run format:check` → clean

## Acceptance-criteria coverage
- AC-1: admin steps 1 to 3, `app/admin/actions.test.ts`, `server/catalog/testbeds.test.ts`, e2e
- AC-2: admin steps 4 to 7, `server/catalog/testbeds.test.ts`, `server/authentik/groups.test.ts`, e2e
- AC-3: `/book` steps 1 to 5, `lib/slots.test.ts`, `lib/timezones.test.ts`, `server/booking/availability.test.ts`, `app/book/actions.test.ts`
- AC-4: rate limit and Turnstile steps, `app/book/actions.test.ts`, `server/request-ip.test.ts`
- AC-5: booking step, `server/db/guest-saga.test.ts`, e2e
- AC-6: both confirmation steps, `app/book/actions.test.ts`, e2e
- AC-7: lead time step, `server/db/guest-saga.test.ts`, `app/book/actions.test.ts`
- AC-8: live booking and admin email steps, `server/booking/guest-booking.test.ts`
- AC-9: `server/booking/guest-booking.test.ts` (Authentik timeout, step 1 rollback, no membership writes)
- AC-10: the two browser step (manual); sequential assignment in `server/db/guest-saga.test.ts`. The two connection DB race test is not built (see the build report).
- AC-11: worker steps, `server/worker/loop.test.ts`, `server/worker/lock.test.ts`, `server/worker/sweep.test.ts`
- AC-12: access steps, `lib/reconcile.test.ts`, `server/worker/reconcile.test.ts`
- AC-13: admin step 1, `app/admin/actions.test.ts`, `tests/server-actions-require.test.ts`
