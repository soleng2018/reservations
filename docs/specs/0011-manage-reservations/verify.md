# Verify: Manage reservations · spec 0011 · updated 2026-10-12
_Steps derived from spec 0011 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones._

Run against the dev server on the LAN IP (`http://10.1.255.18:3000`), signed in as `hol-test-learner@example.test` (account zone UTC) unless a step says otherwise. Dev and prod share one database: cancel every booking you make before you finish. `npx playwright test e2e/reservations.spec.ts` runs the journey, the deactivated check, axe, keyboard, and screenshots in one go (one real booking, cancelled at the end).

## UI / manual
- [x] Open `/reservations` signed out → the sign in card and the resend set password form; signed in as `hol-test-admin` → redirected to `/admin` → AC-3
- [x] Sign in as the learner → "Welcome back, HOL" (the first word of "HOL Test Learner"), "Here's everything on your account.", then the link or the note → AC-1
- [ ] Rename the learner in the admin console to "  Ada   Lovelace " → the heading reads "Welcome back, Ada"; rename back → AC-1 (first name source)
- [x] With no live booking → "Reserve another lab →" links to `/book`; with a confirmed booking not yet ended → "You have an active reservation. Finish it before booking another." and no link → AC-2
- [ ] Book as a guest with the learner's email and abort the confirm reply (DevTools offline right after Confirm) so a `provisioning` row is under a minute old → the note shows; after a minute it is a crashed attempt and the link returns → AC-2 (Reserve another source)
- [x] Cards show only `confirmed` and `completed` bookings: a cancelled booking never shows → AC-1
- [x] Order: Current first, then Upcoming soonest first, then Past latest first (use the UI gallery's "Reservation cards" for Current and Upcoming together) → AC-1
- [x] Each card: testbed name, phase badge (Upcoming blue, Current green, Past grey), lab type, "<start> → <end>", each time with its own zone abbreviation → AC-1
- [ ] Change the learner's zone to America/New_York in the admin console → card times read EDT or EST per card, and the note reads "Times in America/New York." with no offset → AC-1 (start, end, and "Times in" sources)
- [ ] Soft delete a Past card's testbed (one with no live booking) → the card still shows its name → AC-1
- [x] Upcoming and Current cards show "Reschedule" and "Cancel reservation"; Past cards show no action → AC-1
- [ ] Remove the last bookable testbed of a live booking's type (or soft delete the type) → the card shows only Cancel and "This lab type can't be rescheduled right now." → AC-1, AC-6 (reschedulable source)
- [ ] Reloading `/reservations` writes nothing: an ended confirmed booking shows as Past and stays `confirmed` in the database → AC-1
- [x] "Cancel reservation" → "Cancel this reservation?", "This will free up <testbed> on <start>.", "Keep it" focused, "Cancel reservation" → AC-4
- [ ] On a Current booking the dialog also says "Your lab access ends within a minute. Close any open lab tabs." (spec 0012 AC-13) → AC-4 (Current note source)
- [x] Confirm → toast "Reservation cancelled.", the card goes, the Reserve another link returns; the row is `cancelled`, `cancel_source = 'learner'`, `cancelled_by_user_id` the learner, `ends_at` unchanged → AC-4
- [ ] Cancel an Upcoming booking that starts in under an hour → it cancels → AC-4
- [x] Open the dialog in two tabs; confirm in one, then the other → "This reservation already changed. The list has been refreshed." and nothing changes → AC-5
- [ ] DevTools offline, then confirm a cancel → "Something went wrong. Try again." and the card stays → AC-4
- [x] "Reschedule" → URL `/reservations/<id>/reschedule?step=2`, eyebrow "Reschedule", "Choose a time", "<type> · <duration>" with the type's current duration → AC-6, AC-7
- [x] `/reservations/not-a-uuid/reschedule`, a random uuid, and another learner's booking id → 404 → AC-6
- [x] The cancelled booking's id → "This reservation can't be rescheduled any more." and "Back to your reservations" → AC-6
- [x] The calendar opens on the current start's month, no day picked, "Select a date to see available start times." → AC-7 (opening month source)
- [x] On the current start's day, that slot reads "Current" and cannot be picked; slots inside the booking's own range are free → AC-7 ("Current" slot and excluded range)
- [x] Back on Step 2 → `/reservations` → AC-7
- [x] Pick a start, Continue → `?step=3`, eyebrow "Reschedule", "Confirm your new time", Email, Lab type, Timezone ("UTC (GMT)" style, offset at the picked start), "Current time" struck through, then Starts, Ends, Testbed assigned → AC-8
- [ ] In America/New_York, pick a start across the DST change from the current one → the Timezone row shows the picked start's offset, and "Current time" keeps its own EDT or EST → AC-8 (Timezone and Current time sources)
- [ ] Testbed assigned is the booking's own testbed when free at the new time; book that testbed at the new time as another guest first → the next free testbed in name order → AC-8 (preview testbed source)
- [ ] Change the type's duration in the admin console while on Step 2, then Continue → Ends follows the new duration → AC-8 (Ends source)
- [ ] Take the picked slot on every testbed in another tab, then enter Step 3 → back on Step 2 with "That time is no longer available. Please pick another." and the list reloaded → AC-7, AC-8
- [ ] On a Current booking, Step 3 shows "Your current lab session ends when you confirm." → AC-8
- [x] Browser Back and Forward move between Step 2 and Step 3; load `?step=3` fresh → it lands on `?step=2` → AC-12
- [ ] "Confirm new time" → "Updating your reservation" with "Updating your reservation", "Reassigning your testbed", "Confirming your new time"; the last ticks only on success → AC-10
- [x] Success → check icon, "Your reservation has been rescheduled.", Testbed, Lab type, Starts, Ends in the account zone, Done to `/reservations`; no calendar line or lab links → AC-11
- [x] The card now shows the new time; the booking id is unchanged and `version` rose by one; one `booking.rescheduled` audit row with `fromStartsAt`, `toStartsAt`, `fromTestbedId`, `toTestbedId`, `phase` → AC-9, AC-17
- [ ] Pick the booking's own start by crafting the post (or after a reload that lost the "Current" mark) → "That's already your reservation time. Please pick another." on Step 2 → AC-10
- [ ] Block the reschedule reply (DevTools offline after Confirm) → "We couldn't confirm the change. Check your reservations to see your current time." with a link; Try again at the same version after the first try committed → success, not "already changed" → AC-9, AC-10
- [x] Reschedule in two tabs from the same page load; confirm one, then the other → `/reservations` with the AC-5 toast → AC-9, AC-10
- [x] Sign out in another tab, then Confirm → the app navigates to the sign in, never the failure screen → AC-10
- [x] Signed in, open `/book` → "Booking as <name>", Company (hidden when the account has none), Email, Timezone read only, Lab type the only input → AC-13
- [x] Book from there → Step 3 shows Name, Company (when set), Email, and the account zone; success shows "View my reservations", Done to `/reservations` → AC-13
- [ ] Edit the post to carry another email (DevTools) → the booking still goes to the account's own email → AC-13 (identity source)
- [x] Sign out in another tab, then Continue on the account summary → "You were signed out. Sign in again to book." with a Sign in link; nothing booked → AC-13 (`signed_out` source)
- [x] Deactivate the learner in the console, then try to sign in → Authentik refuses the inactive account (the learner never reaches a signed in page); reactivate after → AC-3
- [ ] Cancel or reschedule a Current booking with the worker running → within about a minute the learner leaves the testbed's `pod-*` group and their Authentik sessions end, but `/reservations` stays signed in → AC-16
- [ ] The list, cancel dialog, both reschedule steps, progress, failure, success, the "can't be rescheduled" card, signed in `/book` Step 1, and the gallery's card states match the mock at 1280 and 390, within design.md's allowed differences → AC-18
- [x] A keyboard alone completes a cancel and a reschedule → AC-18
- [x] Every new page is `noindex` → AC-18

## Commands
- [x] `npx vitest run server/booking/manage.test.ts` → list, ownership, cancel, every reschedule outcome, and the race halves pass → AC-1, AC-2, AC-4, AC-5, AC-6, AC-9, AC-15, AC-17
- [x] `npx vitest run server/booking/availability.test.ts` → the excluded own range and the preferred testbed pass, `/book` output unchanged → AC-7, AC-8
- [x] `npx vitest run lib/reschedule-flow.test.ts lib/manage-reservations.test.ts lib/booking-flow.test.ts` → every transition table row, card helpers, `signed_out` → AC-1, AC-10, AC-12, AC-13
- [x] `npx vitest run app/reservations app/book/actions.test.ts` → buckets (21st reschedule, 61st load, 61st preview), ownership replies, signed in `/book` override, null company, `signed_out` → AC-9, AC-13, AC-14, AC-15
- [x] `npx vitest run server/worker/reconcile.test.ts` → cancel and reschedule of a Current booking converge group membership; app sessions untouched → AC-16
- [x] `npx vitest run tests/server-actions-require.test.ts` → none of the new actions is on the public allow list → AC-15
- [x] `npx playwright test e2e/reservations.spec.ts` → the journey and the deactivated check pass; shots land in `e2e/screenshots/*-manage-*.png` → AC-1 to AC-13, AC-18
- [x] `npx playwright test e2e/screenshots.spec.ts -g "admin shots"` → `e2e/screenshots/*-reservation-cards.png` → AC-18
- [x] `npm run db:codegen -- --verify` → clean (no migration in this feature)

## Acceptance-criteria coverage
- AC-1 list, order, labels, zone note · AC-2 Reserve another rule · AC-3 sign in branches and deactivated · AC-4 cancel dialog and write · AC-5 stale cancel · AC-6 reschedule page load · AC-7 Step 2 · AC-8 Step 3 and preview · AC-9 the reschedule transaction · AC-10 reply routing · AC-11 success · AC-12 step history · AC-13 signed in `/book` · AC-14 buckets · AC-15 auth and ownership · AC-16 reconciler · AC-17 audit rows · AC-18 mock match, axe, keyboard, screenshots, noindex
