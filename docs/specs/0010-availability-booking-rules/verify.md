# Verify: Availability and booking rules · spec 0010 · updated 2026-10-12
_Steps derived from spec 0010 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Run against the dev server on the LAN IP (`http://10.1.255.18:3000`). In dev every caller shares the per IP buckets (Step 1: 20 per 10 minutes, booking: 5 per 10 minutes), so space out manual runs. Use `dev-` emails on `nile-test.invalid`.

## UI / manual
- [x] Open `/book` → "Step 1 of 3", "Tell us about you", fields Full name, Company name, Email address, Lab type, Your timezone, then Back (to `/`) and Continue → AC-1
- [x] Open Lab type → only types with a bookable testbed, each labelled `<name> · <duration>` (for example "Basic · 4 hours") → AC-1
- [x] Your timezone is preset to the browser's zone with its offset ("America/New York (GMT-4)"); in a browser set to Asia/Kolkata it reads "Asia/Kolkata (GMT+5:30)", not "Asia/Calcutta" → AC-1
- [x] Type "york", "gmt-4", and "kolkata" in Your timezone → each filters to matching labels; "zzz" shows "No timezone matches that." → AC-1
- [ ] With no bookable type in the database, the card reads "No labs are open for booking right now. Please check back soon." → AC-1
- [x] Continue with every field empty → errors under each field, focus on Full name, URL stays `/book` → AC-2, AC-3
- [x] Continue with the email of a learner who has a confirmed booking that has not ended → the panel "You already have an active reservation", "Sign in to manage it.", and "Manage my reservations" to `/reservations`; no name or time on it; editing the email clears it → AC-3
- [x] Continue with an admin's email → "This email can't be used for booking." in the alert; with a deactivated learner's email → "We couldn't complete this booking." → AC-2, AC-3
- [x] Delete the chosen type in the admin console, then Continue → the list refreshes, the type is deselected, "That lab type is no longer available. Please pick another." under Lab type, other inputs kept → AC-3
- [x] Continue with valid details → URL `/book?step=2`, "Step 2 of 3", "Choose a time", "<type> · <duration>", no day picked, "Select a date to see available start times." → AC-4
- [x] Days before today, and days with no free start, are greyed and cannot be picked; the grid starts on Sunday → AC-4
- [x] Page forward with the next month arrow → it stops at the month holding now plus 90 days (four months when today is late in a month) and the previous arrow stops at this month → AC-4
- [x] A type whose every start is booked for 90 days → "No free times in the next 90 days. Try another lab type." and only Back → AC-4
- [x] Pick a day → its label ("Tuesday, October 13") takes focus, the hint names the duration, 48 starts in rows by hour; taken starts are greyed and disabled → AC-5
- [ ] Set the browser to America/New_York and open 2026-11-01 → 50 starts, the 1 AM hour split into "1 AM EDT" and "1 AM EST"; open 2026-03-08 → 46 starts, no 2 AM row → AC-5
- [x] Set the browser to Asia/Kathmandu → rows read 9:15 and 9:45 under "9 AM" → AC-5
- [x] Pick a start → every half hour inside the duration turns Nile Blue and the bar reads "<duration> reservation: <start> to <end>"; Continue enables → AC-5
- [x] At 390px wide → the calendar sits above the panel, the panel appears only after a day is picked, all seven columns fit → AC-5, AC-14
- [x] Leave Step 2 open over 5 minutes in another tab, come back → the starts reload; if the picked start was taken meanwhile, "That time is no longer available. Please pick another." and the pick clears → AC-6
- [x] Block the starts action (DevTools offline) and enter Step 2 → "Please try again in a little while." with Retry; the pick stays → AC-6
- [x] Continue → URL `/book?step=3`, Name, Company, Email, Lab type, Timezone (offset at the picked start), Starts, Ends, Testbed assigned naming a real testbed → AC-7
- [x] Book the only testbed for that time in another tab, then enter Step 3 → back on Step 2 with the AC-6 message and the time gone → AC-7
- [ ] Confirm reservation stays disabled until the Turnstile widget passes → AC-7
- [x] Confirm → "Setting up your reservation" with three items; the first two tick near 750 ms and 1500 ms, the last on success → AC-8
- [x] Success → "You're all set, <first name>!", "Your reservation is confirmed for <email>.", Testbed, Lab type, Starts, Ends in the chosen zone, the "Set your password" box for a new email, Done to `/`; URL replaced with `/book` → AC-10, AC-11
- [x] Book again later with an email that already has an Authentik account (after its booking ended) → "Sign in with your existing credentials anytime to manage this reservation." with a link to `/reservations` → AC-10
- [x] Browser Back from Step 3 → Step 2 with the pick kept; Back again → Step 1 with details kept; Forward twice → Step 3 → AC-11
- [x] Reload on `/book?step=3`, or open `/book?step=2` in a new tab → URL `/book`, empty Step 1 → AC-11
- [x] Go back to Step 1, change the lab type or timezone, Continue → no day and no start picked → AC-11
- [ ] Two browsers on a type with one testbed reach Step 3 for the same start and confirm together → exactly one succeeds, the other lands on Step 2 with the AC-6 message; with two testbeds both succeed → AC-12
- [x] View the page source of each screen → no link to the admin entry path; `/book` has `noindex, nofollow` → AC-13
- [x] Book with the keyboard only (Tab, arrows, Enter, Space) from Step 1 to success → AC-14

## Value sourcing
- [ ] Lab type label: rename a type's duration in the admin console, reload `/book` → the label follows `formatDuration` → value sourcing (type label)
- [x] Default timezone: open `/book` with the browser in Europe/Kyiv, then in UTC → "Europe/Kyiv (GMT+3)" and "UTC (GMT)" → value sourcing (default timezone, option labels)
- [x] Step 1 refusals come from `users.role`, `users.status`, and `bookings` by `lower(email)`: repeat the active booking check with the email in capitals → same panel → value sourcing (admin, deactivated, live booking)
- [ ] Pending attempt: a provisioning booking under 1 minute old refuses with "Your booking is still being set up"; one over 1 minute old passes → value sourcing (pending attempt)
- [ ] Fail open: the 11th check for one email within an hour answers ok even for an email with a live booking → value sourcing (fail open)
- [x] `now` and "today": set the machine clock or browser zone so the browser date differs from the DB date → today's underline and the past day greying follow DB `now()` in the chosen zone, not the browser clock → value sourcing (`now`, the calendar's today)
- [ ] Enabled days in a far zone: with the browser in Pacific/Kiritimati or Asia/Tokyo, a start at 23:30 UTC shows on the next local day → value sourcing (enabled days)
- [ ] Duration: a 1 day type highlights every half hour of the picked day from the start and the summary end is 24 hours later → value sourcing (highlight and summary end)
- [x] Preview end: Ends on Step 3 equals start plus the type duration, and the testbed is the first free one in name order → value sourcing (testbed name, endsAt)
- [x] Timezone row: pick a start after a DST change → the Timezone row shows that day's offset, not today's → value sourcing (Timezone row)
- [x] Success data: the testbed, type, and times come from the booking reply; the first name is the first word of the trimmed name → value sourcing (success)
- [ ] Submit id: confirm, then trigger a second submit from failure with Try again → only the last reply changes the screen → value sourcing (which reply applies)

## Commands
- [x] `npm run typecheck && npm run lint && npm run format:check` → clean → all
- [x] `npm test` → all pass, including `lib/calendar-days.test.ts`, `lib/booking-flow.test.ts`, `server/booking/details-check.test.ts`, `app/book/actions.test.ts` → AC-2, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-11
- [x] `npx vitest run tests/server-actions-require.test.ts` → `checkDetailsAction` and `previewTestbedAction` listed as public → AC-13
- [x] `npx playwright test e2e/booking.spec.ts` → six tests pass (creates one type, one testbed, three bookings) → AC-1, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12
- [x] `npx playwright test e2e/a11y.spec.ts -g "book|keyboard"` → no serious axe violations on six screens at 1280 and 390 px; the keyboard booking passes → AC-14
- [x] `npx playwright test e2e/screenshots.spec.ts -g "book"` → twelve shots in `e2e/screenshots/` (`<width>-book-<n>-<screen>.png`) to compare with the mock → AC-14

## Acceptance-criteria coverage
- AC-1 … Step 1 fields, labels, timezone search, no type message; `e2e/booking.spec.ts` happy path
- AC-2 … field errors, refusals, buckets, fail open, writes nothing; `details-check.test.ts`, `actions.test.ts`
- AC-3 … the panel, alerts, type refresh, focus; e2e "same email"
- AC-4 … greyed days, month limits, empty type; `calendar-days.test.ts`, e2e happy path
- AC-5 … day panel, DST and offset rows, highlight, mobile; `calendar-days.test.ts`, e2e happy path
- AC-6 … refocus reload, dropped pick, Retry; `booking-flow.test.ts`, e2e race
- AC-7 … preview, taken, fallback, Turnstile gating; `availability.test.ts`, `actions.test.ts`, e2e happy path
- AC-8 … progress ticks; `booking-flow.test.ts`, e2e happy path
- AC-9 … every reply's landing, both failure copies, Try again; `booking-flow.test.ts`, e2e failure
- AC-10 … success card; `booking-success.test.ts`, e2e happy path
- AC-11 … history, refresh, clearing; `booking-flow.test.ts`, e2e history
- AC-12 … the race; e2e race
- AC-13 … allow list, no leaks, noindex; `actions.test.ts`, `server-actions-require.test.ts`
- AC-14 … axe, keyboard, screenshots; `e2e/a11y.spec.ts`, `e2e/screenshots.spec.ts`
