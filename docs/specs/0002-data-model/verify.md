# Verify: Data model · spec 0002 · updated 2026-10-06
_Steps derived from spec 0002 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Every DB step runs inside a transaction that is rolled back (dev and prod share one database). Never commit test rows.

## Commands
- [x] `npm run db:migrate` → prints `nothing to apply` (0001_core already live) → AC-10
- [x] `npm run db:codegen -- --verify` → `Generated types are up-to-date` → AC-10
- [x] `npm test` → all suites pass, including `server/db/*.test.ts` (they skip when no DB is configured) → AC-1 to AC-14
- [x] `npm run typecheck && npm run lint` → clean → all
- [x] Query `hol_app` tables: `relrowsecurity` true on all 8, `role_table_grants` lists only `hol_app`, `pg_policies` empty → AC-10

## Database behavior (in a rolled back transaction)
- [x] Insert two `confirmed` bookings on one testbed, 24:00 to 26:00 and 25:00 to 27:00 → second fails on `bookings_no_overlap` (maps to `overlap`); 26:00 to 28:00 succeeds → AC-1
- [x] From a second connection with `lock_timeout = '300ms'`, insert an overlapping booking while the first transaction holds its row → `55P03` (it waits, it does not slip past) → AC-1
- [x] Give one user an ended `confirmed` booking, insert a second live one → `user_has_live_booking`; call `completeEndedForUser`, retry → succeeds, old row is `completed` with `version` still 1 → AC-2
- [x] A `cancelled` and a `completed` booking on the same slot block neither a new booking on that slot nor the same user → AC-3
- [x] `testbedTypeBlockers` on a type used by a live testbed returns it by name; `testbedBlockers` lists only live, not ended bookings (labelled by learner name); after soft deleting a testbed with only Past bookings, those bookings still join to testbed and type → AC-4
- [x] Insert type `Lab A` then `lab a` → `duplicate_name`; soft delete the first, retry → succeeds. Reuse a soft deleted testbed's slug → `duplicate_slug`. Update a slug → rejected (`testbeds_slug_immutable`) → AC-5
- [x] Insert users `Priya@x.test` then `priya@x.test` → `duplicate_email` → AC-6
- [x] Each of these fails with `23514`: `duration_value = 0`, unknown role/status/unit/kind/job kind, `ends_at <= starts_at`, start at :15, cancelled row without cancel fields, cancel fields on a confirmed row, `attempts = 9`, padded name, empty email → AC-9
- [x] `bookingPhase` at `now` = `starts_at` → Current, = `ends_at` → Past, `provisioning` → Pending (`lib/booking-phase.test.ts`) → AC-11
- [x] `rescheduleBooking` with a stale version, on a `completed` row, or on an ended `confirmed` row → `stale`; a good one → `version` 2; a direct `set version = 99` is ignored by the trigger; confirm and complete leave `version` unchanged → AC-12
- [x] Guest saga: crash after step 1 → compensation leaves no booking and no `users` row, retry by the same email succeeds; crash after step 2 with a created Authentik user → stub deletes that pk and the row; with a reused Authentik user → nothing deleted in Authentik, row kept; a stale own attempt older than 1 minute is replaced on retry → AC-13
- [x] `lockBookableTestbed` refuses a testbed with no `authentik_group_pk`, a soft deleted one, and one deleted under `lockForDelete` → `not_bookable` → AC-14

## Value sourcing
- [x] `ends_at` = `starts_at` + `durationMs(value, unit)`: `durationMs(3, 'days')` is 72 hours, so a booking across a DST change keeps its length
- [x] `version`: insert gives 1; only reschedule and cancel raise it, by exactly one
- [x] `authentik_pending_saga`: true only after `recordAuthentikUser(..., { created: true })`; false after confirm
- [x] Displayed phase uses the `now` passed in, never the row's status alone (a `confirmed` row past its `ends_at` shows Past)
- [x] Pod group name source: `testbeds.slug` never changes after insert
- [x] Blocking names come from `delete-blockers.ts` (testbed `name`, learner `name`)

## Not covered here (owned by later features)
- AC-7 (audit append only) lands with feature 18; AC-8 (secret columns) with features 8 and 15. Their tables are not in this migration.

## Acceptance-criteria coverage
- AC-1 overlap + wait steps · AC-2 one live step · AC-3 cancelled/completed step · AC-4 blockers step · AC-5 uniqueness step · AC-6 email step · AC-7 deferred (feature 18) · AC-8 deferred (features 8, 15) · AC-9 invalid values step · AC-10 commands · AC-11 phase step · AC-12 reschedule step · AC-13 saga step · AC-14 bookable step
