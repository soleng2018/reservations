# Verify: Admin Users and User Detail · spec 0008 · updated 2026-10-11
_Steps derived from spec 0008 acceptance criteria and its Value sourcing table. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual
- [x] Open `/admin/users` → header "Users", subtitle `Everyone with hands-on lab access.`, "Add user"; only learners with an Authentik pk are listed (no admin rows, no rows still being added), sorted by name → AC-1
- [x] A learner with one cancelled and one past booking → the list shows `1 reservation` (cancelled and provisioning never count) → AC-1
- [x] Search `CONCORDIA` → matches by company, ignoring case; a search with no match → `No users match your search.` → AC-1
- [x] Open a learner by the name link and by the arrow → title is the name, subtitle `<company> · <email>`, initials (`Priya Shah` → `PS`, a one word name → one letter), status badge → AC-2
- [x] The detail Reservations table → newest `starts_at` first; a cancelled row shows `by admin`, `by learner`, or `by deactivation`; a soft deleted testbed or type still shows its name; no reservations → `No reservations yet.` → AC-2
- [x] Set your admin row's timezone to `Asia/Tokyo` and reload the detail page → Start, End, and `Times in Asia/Tokyo.` all follow it → AC-2, AC-3
- [x] `/admin/users/not-a-uuid`, an admin's id, and a learner row with no pk → each renders the 404 page → AC-2
- [x] An admin row on `UTC`, browser in `Europe/Paris` → one console load stores `Europe/Paris` with one `admin.timezone_set` audit row; later loads change nothing; a learner id never changes → AC-3
- [x] Add user → timezone defaults to the browser's zone; empty name, company, a bad email, or an unknown zone show the AC-4 messages under their fields → AC-4
- [x] Add a valid new learner → toast `Added <name>.`; the row has a pk and `set_password_pending = true`; a `welcome:<id>` job exists; audits `user.created` and `user.created_in_authentik` → AC-4, AC-13
- [x] Add an email an Authentik learner already uses who has signed in before → no pending flag and no welcome job; one who never signed in → both → AC-4
- [x] Add a known email (any case) → `A user with this email already exists.` plus a "View user" link to that learner → AC-5
- [x] Add an admin's email, a disabled Authentik account's email, or an email that is another Authentik user's username → each gives its AC-5 message and leaves no `users` row → AC-5
- [x] Edit a learner who has signed in → the email field is disabled with `<first name> has signed in, so their email can't change here.` → AC-6
- [x] Edit a learner still pending: change the email → Authentik email and username (lowercased) both change, a `welcome:<id>:email:<email>` job appears, and `user.updated` has `authentikSynced: true` → AC-6, AC-13
- [x] Edit only the company and timezone → no Authentik call; saving with no change → toast `Updated <name>.` and no audit row → AC-6
- [x] Resend shows only for an active learner with `set_password_pending`; two clicks within the hour → one job, two `set_password.resent` rows, toast `Set password email queued for <email>.` → AC-7
- [x] Deactivate a learner with an Upcoming booking → the confirm lists `<testbed> — Upcoming reservation, <start in your zone>`; toast `Deactivated <name> and cancelled 1 reservation.`; Authentik `is_active = false`; their sign in is refused → AC-8
- [x] Deactivate a learner whose booking is still provisioning → `A booking for this user is being set up. Try again in a minute.` and nothing changes → AC-8
- [x] Reactivate → toast `Reactivated <name>.`; Authentik active again; the cancelled booking stays cancelled → AC-9
- [x] Cancel an Upcoming and a Current booking from the detail page → the confirm text (Current adds ` The learner's lab access ends within a minute.`, spec 0012 AC-14), toast `Reservation cancelled.`, the row shows `Cancelled` `by admin`; the same Cancel from a stale second tab → `This reservation already changed. The page has been refreshed.` → AC-10
- [x] With the worker running, deactivate (or cancel) a learner with a Current booking → within about 30 seconds they leave the testbed's `pod-*` group and their Authentik sessions end → AC-11

## Commands
- [x] `npm test` → passes, including `server/worker/sweep.test.ts` (unlinked learner sweeper), `server/users/*.test.ts`, `server/authentik/learner-status.test.ts`, and `app/admin/users/actions.test.ts` → AC-3 to AC-14
- [x] `npm run db:codegen -- --verify` → types up to date, and `bookings_user_id_starts_at_idx` exists → AC-15
- [x] `npx playwright test e2e/users.spec.ts` (dev server on the LAN IP, test secrets present) → passes → AC-1, AC-2, AC-4, AC-6, AC-8, AC-9

## Acceptance-criteria coverage
- AC-1 list, count, search · AC-2 detail, phases, 404s · AC-3 admin timezone · AC-4 add and welcome · AC-5 add refusals · AC-6 edit and email lock · AC-7 resend · AC-8 deactivate · AC-9 reactivate · AC-10 admin cancel · AC-11 reconciler · AC-12 sweeper (command) · AC-13 audit rows (within AC-4, 6, 8, 10 steps) · AC-14 auth guards (command) · AC-15 migration (command)
