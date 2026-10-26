# Verify: cleanup gap between labs · spec 0020 · updated 2026-10-26
_Steps derived from spec 0020 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones. The build is proved on a throwaway Postgres 18.6 container (migration 0016 applied, full suite green); nothing is applied to the shared database until the deploy._

## UI / manual
- [x] With one testbed of a type, book a lab 8 am to 12 pm on /book, then open the picker for the same type → 12:00 is not offered, 12:30 is; with a second testbed of that type, 12:00 is offered again        → AC-2 · Value sourcing (picker)
- [x] Open the picker for a start whose lab would end 30 minutes or less before another live booking on the only testbed → that start is not offered; one that ends exactly 30 minutes before is        → AC-2, AC-6
- [x] Book as a guest, with testbed A inside a gap and testbed B free → the booking lands on B; with both inside a gap, the reply is "time no longer available"        → AC-3 · Value sourcing (saga insert)
- [x] Reschedule to a start inside another learner's gap (after and before it) → refused with the same reply as an overlap and nothing changes; reschedule to the slot right after your own old slot → allowed        → AC-4 · Value sourcing (reschedule clash)
- [x] Cancel a Current booking, then open the picker → its range and its 30 minutes are free at once        → AC-5
- [x] Read the book, reschedule, and manage screens, the booked and reschedule emails, and the calendar event → no new text, and every time still ends at `ends_at`        → AC-9
- [x] With a Current booking, watch lab access in Authentik → access is removed at `ends_at`, not 30 minutes later        → AC-9

_Reschedule refusal and the screens, emails, and calendar step: verified by the owner in the real app (2026-10-26)._

## Commands
- [x] Run the read only pre check from the migration plan on the shared database (the `do` block's `select count(*)`, as a plain select) → 0 pairs        → AC-7
- [x] `npm test` against the dev database → all green; the migration and AC-8 tests apply 0016 inside a rolled back transaction        → AC-1, AC-7, AC-8, AC-10
- [x] `npm run lint && npm run typecheck && npm run format:check` → clean        → all
- [x] After the deploy: `select pg_get_constraintdef(oid) from pg_constraint where conname = 'bookings_no_overlap'` → the definition holds `'00:30:00'::interval`        → AC-1, AC-7
- [x] After the deploy: `scripts/deploy.sh` leaves `migrate` exited 0 and `web` and `worker` up        → AC-7

## Acceptance-criteria coverage
- AC-1 · covered by the constraint test and the post deploy query · AC-2 · picker and `freeStarts` tests · AC-3 · saga test · AC-4 · reschedule tests · AC-5 · cancel tests and the manual step · AC-6 · `firstFreeTestbed` and `startsFor` tests · AC-7 · migration test and the pre check · AC-8 · millisecond test · AC-9 · the screen, email, and access steps · AC-10 · lead time test
