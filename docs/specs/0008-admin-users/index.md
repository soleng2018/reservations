# 0008. Admin Users and User Detail

**Date**: 2026-10-10
**Status**: Accepted
**Amended**: 2026-10-17 by [spec 0014](../0014-set-password-welcome-email/index.md): an email change ends the learner's outstanding set password links in the same transaction, closing the known gap in Consequences; the email change job key becomes `welcome:<id>:email:<lower email>:<DB time ms>`.

## Summary

Admins get the Users screen from the mock: a searchable list of learners, a detail page with each learner's reservations, and dialogs to add and edit learners. Adding a learner creates (or reuses) their Authentik account and queues the set password email; editing pushes name and email changes to Authentik, and the email can change only until the learner first signs in. Deactivating signs the learner out, blocks sign in, and cancels their Upcoming and Current reservations, so their testbeds free up and lab access ends. There is no delete; admins can also cancel a single reservation, and every time in the console now shows in the admin's own timezone, learned once from their browser.

## Requirements

**User stories**:
- As an admin, I want to see every learner with their company, email, reservation count, and status, so that I can find anyone quickly.
- As an admin, I want to add a learner from the console, so that someone can sign in and book without going through the guest flow first.
- As an admin, I want to fix a learner's name, company, timezone, or a mistyped email, so that their account and emails are right.
- As an admin, I want to deactivate a learner and have their bookings and lab access end at once, so that someone who should not be in the labs is cut off.
- As an admin, I want to see and cancel a learner's reservations in my own timezone, so that I can free a testbed without asking the learner.

**Acceptance criteria**:
- **AC-1**: `/admin/users` shows the shell header from spec 0005 (title "Users", subtitle `Everyone with hands-on lab access.` (the mock's text), action "Add user") and a `DataTable` of learners: `role = 'learner'` with `authentik_user_pk is not null` (a row still being added or booked is hidden), any status, ordered by `lower(name)`. Columns: Full name (a link to `/admin/users/<id>`), Company, Email, Reservations (`0 reservations`, `1 reservation`, `3 reservations`, counting every booking except `cancelled` and `provisioning`, so the Upcoming, Current, and Past rows of the detail page; a `confirmed` booking past its end that the worker has not completed yet counts, as `bookingPhase` shows it as Past), Status (`Active` badge tone `success`, or `Deactivated` tone `neutral`), and Actions (view, an arrow link to the detail page; edit). There is no delete control anywhere. Search ("Search by name, company, or email…") runs client side over `<name> <company> <email>`, ignoring case. Empty states use the shared `DataTable` copy: `No users yet. Add one to get started.` and `No users match your search.` Admin rows never appear.
- **AC-2**: `/admin/users/[id]` shows, for a learner as defined in AC-1: the shell header (title the learner's name, subtitle `<company> · <email>`, action "← All users" linking to `/admin/users`), a card with the initials avatar (first letters of the first and last words of the name, uppercased), the status badge, and the buttons Edit, Deactivate user or Reactivate user, and Resend set password email (AC-7). Below it, a "Reservations" table of every booking of that user, newest `starts_at` first, with columns Status, Testbed, Type, Start, End, Actions. Status is the `bookingPhase` label (`Upcoming`, `Current`, `Past`, `Cancelled`, `Pending`) computed with `dbNow`; a cancelled row adds `by learner`, `by admin`, or `by deactivation` from `cancel_source` under the badge. Testbed and type show their names even when soft deleted. Start and End use `formatDateTime(<time>, admin.timezone)`, and a note under the table reads `Times in <admin timezone>.` Only Upcoming and Current rows have a Cancel action (AC-10). With no bookings the table shows `No reservations yet.` A malformed id, an unknown id, an admin row, or a learner with no `authentik_user_pk` renders Next.js `notFound()`. Neither page writes anything (no `completeEndedForUser` on read).
- **AC-3**: The admin console learns the admin's timezone once. The admin layout passes the session user's `timezone` to a client component; on mount, if it is `UTC` and `browserTimeZone()` returns a zone other than `UTC`, it calls `setAdminTimezoneAction(zone)` once and then `router.refresh()`. The action parses the zone with `Timezone`, runs `update users set timezone = $zone where id = <admin id> and role = 'admin' and timezone = 'UTC'`, and writes `admin.timezone_set` (metadata `{ to }`) only when a row changed. After that, every console time (API Keys "Changed" dates and this feature's reservations) uses the stored zone. A failed call changes nothing and shows no error (the next load tries again).
- **AC-4**: "Add user" opens the form dialog (title "Add User") with Full name (placeholder "e.g. Priya Shah"), Company name ("e.g. Concordia University"), Email address ("name@company.com"), and Timezone (the `/book` picker over `timezoneOptions`, default `browserTimeZone()`). Inputs, parsed on the server with `LearnerInput` in `lib/learner-input.ts` and returned as field errors through `fieldErrors`: name trimmed, 1 to 200 characters ("Enter the full name."); company trimmed, 1 to 200 ("Enter the company name."); email trimmed, at most 254, a valid email ("Enter a valid email address."); timezone `Timezone` ("Choose a timezone from the list."). A valid save runs the add saga (*State transitions*): insert the `users` row (role `learner`, `authentik_user_pk` null) and commit; call `findOrCreateLearner` with that row id; then in one transaction store the pk, set `set_password_pending = true` and enqueue `send_welcome` with `welcomeKey(id)` only when Authentik created the user, and write the audit rows (AC-13). The dialog closes with the toast `Added <name>.` and the list revalidates. A reused Authentik account (a known non admin user, tagged per spec 0003 AC-5) that has logged in before (`lastLogin` set) gets no welcome job, since it has credentials. A reused account that has never logged in (`lastLogin` null, for example an orphan from a crashed saga) is treated like a created one: `set_password_pending = true` and the `welcomeKey(id)` job, so it is never left without a way to set a password. `findOrCreateLearner`'s `LearnerRef` gains `neverLoggedIn: boolean` for this.
- **AC-5**: Add refusals, none of which leaves a `users` row or an Authentik user this saga created: an email already in `users` (ignoring case) as a learner with a pk, active or deactivated, gives the field error `A user with this email already exists.` on `email` plus a "View user" link to that learner's detail page (where a deactivated one can be reactivated); one with no pk yet (another add or a guest booking in flight) gives `A user with this email is being set up. Try again in a minute.` with no link; an email on an admin row, or an Authentik user in `hol-admins`, gives `This email can't be used for a learner account.` on `email`; Authentik `username_taken` or `duplicate_email` gives `This email matches another Authentik account. Ask the owner to fix it in Authentik.` on `email`; `refused` (the Authentik account is inactive) gives `This email's Authentik account is disabled. Ask the owner to enable it in Authentik.` on `email`; `unavailable` gives the form message `Authentik is unavailable. Nothing was changed, try again.` A unique violation on `users_email_lower_uq` at insert (two admins adding the same email at once) maps through `mapConstraintError` to the duplicate error. If the final transaction fails, the action deletes the row and then, only if the row was deleted and this saga created the Authentik user, that user (`deleteSagaLearner`), and shows the unavailable message. Every delete of the saga's row rechecks "no bookings" inside the delete statement (the `HAS_NO_BOOKINGS` condition), so a row a guest booking attached to meanwhile is kept, along with its Authentik user.
- **AC-6**: The edit button (list and detail) opens "Edit User" with name, company, email, and timezone filled in from the page's row data (read once on open with `useState`, the admin row edit rule). The email field is editable only while `set_password_pending = true`; otherwise it is disabled with the helper `<first name> has signed in, so their email can't change here.` Saving (id bound by the page, checked with `z.uuid()`, same `LearnerInput`) follows the lock first pattern (*State transitions*), in one transaction: lock the row `FOR UPDATE`; require a learner with a pk (else the form message `This user no longer exists.`); compare against the locked row; for an email change require `set_password_pending = true` (else `This email can't change after the learner signs in.` on `email`) and no other `users` row with that email ignoring case (else the AC-5 duplicate error); if name or email changed, call `updateLearnerIdentity` (guarded `"learner"` write: `name`, and for an email change `email` plus `username` = the new email lowercased), which first checks that no Authentik user other than this pk has that email or username (the `candidates` lookup filtered by `pk !== own pk`; a hit gives the AC-5 Authentik account error; a case only change is allowed and rewrites the username to the same value); then update the changed columns, enqueue `send_welcome` with the key `welcome:<id>:email:<new email lowercased>` on an email change, write `user.updated` (AC-13), and commit. Any refusal or Authentik failure rolls back, so the app row is unchanged. A `users_email_lower_uq` violation at the update maps to the duplicate error; Authentik then already holds the new email, which is harmless because a save of the same values later converges (the conflict check ignores the learner's own pk). A company or timezone only edit makes no Authentik call. A save that changes nothing writes nothing and still shows `Updated <name>.` Authentik unavailable gives the AC-5 unavailable message. A guard refusal (the account is now in `hol-admins` or lost its `hol_learner` tag) gives the form message `This account can't be managed here. Check it in Authentik.` Deactivated learners can be edited; a name edit also renames a reused Authentik account (accepted: it is a tagged learner). Sign in still matches by `authentik_user_pk`, so a changed email does not break it; `hol_auth.user.email` keeps the old address, which nothing reads.
- **AC-7**: The detail page shows "Resend set password email" only for an active learner with `set_password_pending = true`. The action (id bound, `z.uuid()`) rechecks those conditions, enqueues `send_welcome` with `resendKey(id, now)` (at most one job per hour), writes `set_password.resent` with the admin as actor, and returns the toast `Set password email queued for <email>.` (also on a repeat inside the same hour, where the job already exists and nothing new is queued). A learner no longer eligible gets `This learner has already set a password, or is deactivated.` and nothing is queued.
- **AC-8**: "Deactivate user" first calls `checkDeactivate(id)`, which lists the learner's `confirmed` bookings with `ends_at > now()`, oldest start first, each labelled `<testbed name> — <Upcoming | Current> reservation, <start in admin timezone>`. A confirm dialog then shows `Deactivate <name>?`, the text `They'll be signed out and can't sign in until reactivated.`, and, when the list is not empty, `These reservations will be cancelled:` with the list. Confirming runs `deactivateLearner`, lock first, in one transaction: (1) lock the user row `FOR UPDATE` and require a learner with an `authentik_user_pk` (a row with no pk, still being added or booked, returns the app row `not_found` and changes nothing, per the key invariants; an already deactivated one returns success with `cancelled: 0` and writes nothing); (2) if the user has a `provisioning` booking, refuse with `A booking for this user is being set up. Try again in a minute.`; (3) set the Authentik user `is_active = false` and end their Authentik sessions (spec 0003 AC-9); Authentik `not_found` from either call is logged as a warning and the app side still proceeds (a missing account cannot sign in), unavailable rolls back with the AC-5 unavailable message, and a guard refusal rolls back with `This account can't be managed here. Check it in Authentik.`; (4) set `status = 'deactivated'`, `deactivated_at = now()`, cancel every `confirmed` booking with `ends_at > now()` through `cancelBooking` (`source = 'deactivation'`, `byUserId` the admin, each version read under the lock), delete the user's `hol_auth.session` rows, write the audit rows (AC-13), and commit. A commit failure after step 3 leaves the Authentik account inactive with the app row active; a retry converges (step 3 is idempotent). The toast reads `Deactivated <name>.` or `Deactivated <name> and cancelled N reservations.` (`1 reservation` singular). An app row `not_found` (unknown id, or no pk) gives the toast `This user no longer exists.` The function's result becomes `Result<{ cancelled: number }, StatusChangeError | 'booking_pending'>`.
- **AC-9**: "Reactivate user" runs `reactivateLearner` with no confirm, lock first in one transaction: lock the row `FOR UPDATE` and require a deactivated learner with an `authentik_user_pk` (a row with no pk returns the app row `not_found` and changes nothing; an active one returns success and writes nothing); set Authentik `is_active = true`; then `status = 'active'`, `deactivated_at = null`, `user.reactivated`, commit. Cancelled bookings stay cancelled. Toast: `Reactivated <name>.` An app row `not_found` (unknown id, or no pk) gives the toast `This user no longer exists.` The function returns `not_found` for both a missing app row and a missing Authentik account, so after the refusal the action reads the row again (a learner with a pk, `isConsoleLearner`) to tell them apart; a pk stored in between could show the Authentik message instead, accepted. Authentik `not_found` gives the message `This learner's Authentik account no longer exists. Ask the owner to restore it.`; unavailable gives the AC-5 unavailable message; a guard refusal gives `This account can't be managed here. Check it in Authentik.`; each rolls back, so the app row is unchanged. Audit rows for deactivate and reactivate are written only when the status actually changed.
- **AC-10**: The Cancel action on an Upcoming or Current row opens a confirm dialog: `Cancel this reservation?`, the text `<testbed>, <start> to <end>. The testbed is freed at once.` plus ` The learner's lab access ends within a minute.` for a Current one (was "ends now"; changed by spec 0012 AC-14 on 2026-10-15), buttons "Keep it" and "Cancel reservation". The action (`booking id` and `version` bound by the page, the id checked with `z.uuid()`) runs `cancelBooking` with `source = 'admin'`, `byUserId` the admin, and that version, in one transaction with `booking.cancelled` (AC-13). It cancels whichever booking the id names (an admin may cancel any learner's booking), then revalidates `/admin/users` and `/admin/users/[id]`, as every action in this feature does. Toast: `Reservation cancelled.` A stale version, or a booking that ended or was cancelled meanwhile, gives `This reservation already changed. The page has been refreshed.` and revalidates. A Current booking keeps its `ends_at` (spec 0002); access ends because the status is no longer live. No email is sent yet (feature 15).
- **AC-11**: After a deactivation or an admin cancel, the access reconciler removes the learner from the testbed's `pod-*` group and ends their Authentik sessions on its next tick (spec 0004 AC-12), because the booking is no longer `confirmed`. As a second guard, `reconcileAccess` adds `where u.status = 'active'` to its Current bookings query, so a deactivated learner is never a desired member even if a confirmed booking slipped through.
- **AC-12**: A new worker step, `sweepUnlinkedLearners`, runs after `sweepGuestSagas` and deletes `users` rows with `role = 'learner'`, `authentik_user_pk is null`, no bookings, and `created_at` older than 10 minutes (an add saga that crashed before storing its pk). The "no bookings" and "pk is null" conditions are rechecked inside each delete statement, so a row a guest booking picked up meanwhile is kept. It handles rows one by one, logs a failed row and continues, and returns the count.
- **AC-13**: Audit rows, each in the same transaction as its change, with the admin as actor and target type `user` unless noted: `user.created` (summary "Learner added", metadata `{ reusedAuthentikUser: boolean }`), plus spec 0003's `user.created_in_authentik` or `user.tagged_in_authentik`; `user.updated` (summary "Learner updated", metadata `changedFields` over `name`, `company`, `email`, `timezone`, plus `{ authentikSynced: true }` when Authentik was called); `user.deactivated` (metadata `{ cancelledBookings: <count> }`); `user.reactivated`; `set_password.resent`; `booking.cancelled` (target type `booking`, target id the booking id, summary "Reservation cancelled", metadata `{ source, userId, testbedId, phase }`, one row per booking, for both admin cancels and deactivation); `admin.timezone_set` (target the admin's own row, metadata `{ to }`). New names go in `lib/audit-actions.ts`: `user.created`, `user.updated`, `booking.cancelled`, `admin.timezone_set`.
- **AC-14**: Every page and action here calls `requireAdmin()`: the two pages, `createLearnerAction`, `updateLearnerAction`, `resendSetPasswordAdminAction`, `checkDeactivate`, `deactivateLearnerAction`, `reactivateLearnerAction`, `cancelBookingAdminAction`, and `setAdminTimezoneAction`. A learner or anonymous caller gets the existing "not authorized" result and nothing is written; none is on the public allow list. Every Authentik user write goes through `guardUserWrite`, so no path here creates, changes, or deactivates an admin, and every server function refuses a `users` row whose role is `admin`.
- **AC-15**: Migration `0007_admin_users.sql` adds `create index bookings_user_id_starts_at_idx on hol_app.bookings (user_id, starts_at desc)`. `npm run db:codegen -- --verify` passes after it.

## Decision

**Chosen option**: Option 1: Authentik first saga for every learner change, with booking side effects in the same transaction as the status change.

Add uses a row first saga like the guest booking; edit, deactivate, and reactivate lock the user row, call Authentik, and commit the app change only on success; deactivation cancels live bookings itself and leaves group membership to the reconciler.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.claude/skills/vercel-react-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

One migration, `db/migrations/0007_admin_users.sql` (migration files number on their own; the last one is `0006_testbed_admin.sql`). Every column used here already exists (specs 0002, 0003).

| Table | Change | Column / object | Rule |
|---|---|---|---|
| `bookings` | new index | `bookings_user_id_starts_at_idx (user_id, starts_at desc)` | Serves the detail table and the list's per user count. Today only the partial unique `bookings_one_live_per_user` covers `user_id` |
| `users` | existing | `name`, `company`, `email`, `timezone` | Edited here. `company` stays nullable in the DB (older rows), but `LearnerInput` requires it |
| `users` | existing | `status`, `deactivated_at` | `active` ⇄ `deactivated`, admin only (spec 0002) |
| `users` | existing | `set_password_pending` | Gates resend (AC-7) and the email edit (AC-6). Set true only when the add saga created the Authentik user |
| `users` | existing | `authentik_user_pk` | Null only mid saga; such rows are hidden (AC-1, AC-2) and swept (AC-12) |
| `bookings` | existing | `status`, `version`, `cancelled_at`, `cancel_source`, `cancelled_by_user_id` | Set by `cancelBooking` (spec 0002) with `cancel_source` `admin` or `deactivation` |
| `jobs` | existing | `send_welcome` rows | Keys: `welcomeKey(id)` on add, `resendKey(id, now)` on resend, `welcome:<id>:email:<email>` on email change |

Relationships are unchanged: `users` 1:N `bookings` (RESTRICT, which is one reason there is no delete) · `users` 1:N `bookings.cancelled_by_user_id` (RESTRICT) · `testbeds` and `testbed_types` 1:N `bookings`.

New audit actions (code only, no migration): `user.created`, `user.updated`, `booking.cancelled`, `admin.timezone_set`.

### State transitions

**Learner row** (`role = 'learner'`):

| State | Columns | Listed | Set by |
|---|---|---|---|
| Being added | `authentik_user_pk` null, no bookings | no | add saga insert |
| Active, password pending | pk set, `status = 'active'`, `set_password_pending = true` | yes | add saga (created) or guest saga |
| Active | pk set, `status = 'active'`, `set_password_pending = false` | yes | first sign in, or add saga (reused account) |
| Deactivated | `status = 'deactivated'`, `deactivated_at` set | yes | `deactivateLearner` |
| Gone | row deleted | | add saga failure, or `sweepUnlinkedLearners` (only while no pk and no bookings) |

Transitions: Active ⇄ Deactivated (admin). Deactivate and reactivate refuse a Being added row as `not_found`. Reactivate returns to Active or Active, password pending, whichever `set_password_pending` says.

**Add saga** (`createLearner`):
1. Transaction: refuse an existing email (AC-5) by `lower(email)`; insert the row with pk null; commit.
2. `findOrCreateLearner(api, { email, name, holUserId: row id })`. On error: delete the row (`where authentik_user_pk is null` and no bookings, in the statement), return the AC-5 error.
3. Transaction: lock the row `FOR UPDATE`; set `authentik_user_pk` only where it is null or already equals this pk (a guest saga for the same email may have stored the same pk, since Authentik dedups by email; a different pk is a broken invariant and throws); when created or `neverLoggedIn`, set `set_password_pending = true` and enqueue `send_welcome` (`welcomeKey`); write audit rows. On failure: delete the row with the same in statement recheck, and only if it was deleted and Authentik created the user, `deleteSagaLearner`; return `unavailable`.
4. A crash between steps leaves a pk null row; `sweepUnlinkedLearners` deletes it after 10 minutes. An Authentik user created just before such a crash stays orphaned (tagged `hol_learner`, `hol_user_id` of a deleted row), the same accepted gap as the guest saga; a later add or guest booking for that email reuses it.

**Lock first pattern** (edit, deactivate, reactivate): one transaction locks the `users` row `FOR UPDATE`, rechecks every precondition against the locked row, calls Authentik while holding the lock (10 second timeout per call, spec 0003 client), then writes the app side and commits. Any refusal or Authentik failure rolls back. No write back to Authentik is ever needed. A guest saga or a first sign in for the same learner waits on the lock meanwhile (at most the Authentik timeouts); other learners are unaffected.

**Booking**: `confirmed` → `cancelled` by admin (`cancel_source = 'admin'`) or deactivation (`'deactivation'`), guard `status = 'confirmed' and ends_at > now() and version = $v` (spec 0002, unchanged).

### API surface

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/admin/users` | Server Component | none | rows per AC-1, each with edit defaults `{ name, company, email, timezone, emailEditable }` | `requireAdmin()` | not authorized |
| `/admin/users/[id]` | Server Component | `params.id` | header per AC-2; booking rows with finished time strings, phase, cancel source, `version`; `canResend` | `requireAdmin()` | `notFound()` |
| `createLearnerAction` (`app/admin/users/actions.ts`) | Server Action (`useActionState`) | `name`, `company`, `email`, `timezone` | `AdminFormState` | `requireAdmin()` | `invalid`, `duplicate` (with link), `setting_up`, `admin_email`, `authentik_conflict`, `authentik_disabled`, `unavailable` |
| `updateLearnerAction` | Server Action, id bound (`z.uuid()`) | same fields (`email` ignored when locked) | `AdminFormState` | `requireAdmin()` | `invalid`, `duplicate`, `authentik_conflict`, `email_locked`, `not_found`, `refused`, `unavailable` |
| `resendSetPasswordAdminAction` | Server Action, id bound | none | `Result<string, 'not_eligible'>` (the toast text) | `requireAdmin()` | `not_eligible` |
| `checkDeactivate` | Server Action | `id` | `Result<readonly Blocker[], 'unavailable'>` (the bookings to cancel, reusing `Blocker` from `lib/delete-flow.ts`) | `requireAdmin()` | a bad id returns `[]` |
| `deactivateLearnerAction` | Server Action | `id` | `Result<{ cancelled: number }, 'booking_pending' \| 'refused' \| 'unavailable' \| 'not_found'>` | `requireAdmin()` | `booking_pending`, `refused`, `unavailable` (AC-8 messages); `not_found` → `This user no longer exists.` |
| `reactivateLearnerAction` | Server Action | `id` | `Result<void, 'authentik_missing' \| 'refused' \| 'unavailable' \| 'not_found'>` | `requireAdmin()` | `authentik_missing`, `refused`, `unavailable` (AC-9 messages); `not_found` → `This user no longer exists.` |
| `cancelBookingAdminAction` | Server Action, `id` and `version` bound | none | `Result<void, 'stale'>` | `requireAdmin()` | `stale` |
| `setAdminTimezoneAction` | Server Action | `zone` | `void` | `requireAdmin()` | invalid zone ignored |

`AdminFormState`'s `error` variant gains an optional `link?: { readonly href: string; readonly label: string }`, rendered under the field errors by `FormDialog` (used only by the duplicate email error).

Server modules:

| Module / function | Signature | Notes |
|---|---|---|
| `lib/learner-input.ts` `LearnerInput` | Zod object `{ name, company, email, timezone }` | AC-4 rules. `email` normalized only by trim; comparisons use `lower()` |
| `lib/initials.ts` `initials` | `(name) => string` | Pure, AC-2 |
| `server/users/learners.ts` `listLearnersForAdmin` | `(conn) => Promise<readonly AdminLearnerRow[]>` | One query with a count subquery over `confirmed`, `completed`. Row: `id, name, company, email, timezone, status, reservationCount, emailEditable` |
| `server/users/learners.ts` `getLearnerDetail` | `(conn, id) => Promise<Result<LearnerDetail, 'not_found'>>` | The learner plus bookings joined to testbeds and testbed types (no `deleted_at` filter), newest first, and `dbNow(conn)` for the phases |
| `server/users/learners.ts` `createLearner` | `(api, conn, input, actorId) => Promise<Result<{ id }, CreateLearnerError>>` | The add saga |
| `server/users/learners.ts` `updateLearner` | `(api, conn, id, input, actorId) => Promise<Result<void, UpdateLearnerError>>` | AC-6, lock first pattern |
| `server/users/learners.ts` `deactivationPreview` | `(conn, id, timezone) => Promise<readonly Blocker[]>` | AC-8 labels. No pk filter needed: a row with no pk has no `confirmed` booking, so its list is empty, and its page is unreachable anyway |
| `server/users/learners.ts` `resendSetPasswordByAdmin` | `(conn, id, actorId) => Promise<Result<{ email }, 'not_eligible'>>` | AC-7 |
| `server/users/learners.ts` `cancelBookingByAdmin` | `(conn, bookingId, version, actorId) => Promise<Result<void, 'stale'>>` | AC-10, reads `user_id`, `testbed_id`, the phase under the guard for the audit |
| `server/authentik/learners.ts` `deactivateLearner` | `(api, conn, usersId, actorId) => Promise<Result<{ cancelled: number }, StatusChangeError \| 'booking_pending'>>` (result changes from `void`) | AC-8, lock first; a row with no pk is refused as `not_found` under the lock; `not_found` from Authentik no longer aborts; audits only on a real change (the "Feature 10 adds the booking side effects" comment is fulfilled). Its existing tests move to the new shape |
| `server/authentik/learners.ts` `reactivateLearner` | signature unchanged | AC-9, lock first; a row with no pk is refused as `not_found` under the lock; audits only on a real change |
| `server/authentik/learners.ts` `findOrCreateLearner` | `LearnerRef` gains `neverLoggedIn` | `true` when created, or when the reused user's `lastLogin` is null. The guest saga ignores it (its behavior is unchanged) |
| `server/authentik/learners.ts` `updateLearnerIdentity` | `(api, pk, change: { name?, email? }) => Promise<Result<void, UserRefusal \| AuthentikFailure \| 'taken'>>` | Guarded; `taken` when `candidates` returns a user whose pk is not `pk` |
| `server/worker/sweep.ts` `sweepUnlinkedLearners` | `(conn) => Promise<number>` | AC-12; `worker/index.ts` adds the step after `sweepGuestSagas` |
| `server/worker/reconcile.ts` `reconcileAccess` | unchanged | AC-11 status filter |
| `components/admin/learner-fields.tsx` | `({ defaults? })` | Name, company, email (disabled with helper when locked), timezone picker shared with `/book` |
| `components/admin/admin-timezone-sync.tsx` | client, `({ timezone })` | AC-3; rendered in `app/admin/layout.tsx` |
| `components/admin/learner-status-actions.tsx`, `booking-cancel-button.tsx` | client | Confirm dialogs (shadcn `AlertDialog`) for AC-8 and AC-10, reactivate and resend buttons with toasts |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| list | rows | `users` where `role = 'learner'` and `authentik_user_pk is not null` |
| list | reservation count | count of the user's `bookings` with `status not in ('cancelled', 'provisioning')` |
| list, detail | status badge | `users.status` mapped to `Active` / `Deactivated`, tone via `toneFor` (add `deactivated: "neutral"`) |
| list | search text | `<name> <company> <email>` per row |
| list, detail | edit defaults | the row's `name`, `company`, `email`, `timezone`; `emailEditable = set_password_pending` |
| detail | initials | `initials(users.name)` |
| detail | phase | `bookingPhase({ status, startsAt, endsAt }, await dbNow(conn))` |
| detail | cancelled by | `bookings.cancel_source` |
| detail | testbed, type names | `testbeds.name` by `bookings.testbed_id`, `testbed_types.name` by `bookings.testbed_type_id` (soft deleted included) |
| detail | Start, End, timezone note | `formatDateTime(starts_at / ends_at, admin.timezone)`, `admin` from `requireAdmin()` |
| detail | Cancel shown | phase is `Upcoming` or `Current` |
| detail | cancel version | `bookings.version` bound into the action |
| detail | Resend shown | `status = 'active' and set_password_pending` |
| admin timezone | zone | `browserTimeZone()` in the admin's browser, stored once while the row is `UTC` |
| add | timezone default | `browserTimeZone()` in the dialog |
| add | `holUserId` | the inserted `users.id` |
| add | welcome job, `set_password_pending` | when `findOrCreateLearner` returns `neverLoggedIn: true` (created, or reused with Authentik `lastLogin` null) |
| add | duplicate link | the existing row's `id` when it has a pk; no pk gives the `setting_up` message |
| edit | Authentik username on email change | the new email lowercased (spec 0003 AC-5 rule) |
| edit | email change allowed | `set_password_pending` read under `FOR UPDATE` |
| edit | `user.updated` metadata | `changedFields` over the row read under the lock vs the parsed input |
| deactivate | bookings to cancel | `confirmed` with `ends_at > now()`, read under the user lock, each with its own `version` |
| deactivate preview | labels | testbed name, phase (`dbNow`), `formatDateTime(starts_at, admin.timezone)` |
| deactivate, cancel | `cancelled_by_user_id` | the admin's `users.id` from `requireAdmin()` |
| resend | job key | `resendKey(id, new Date())` (hour bucket, matching the public resend) |
| sweeper | age | `created_at < now() - interval '10 minutes'` (DB clock) |

### Key invariants

- No code path creates, edits, deactivates, or reactivates an admin: server functions refuse `role = 'admin'`, and every Authentik write passes `guardUserWrite` (which refuses `hol-admins` and untagged users).
- A learner's email changes only while `set_password_pending = true`, and the Authentik username always equals the lowercased email.
- After `deactivateLearner` succeeds, the learner has no `confirmed` booking with `ends_at > now()`, no app session, no Authentik session, and `is_active = false` in Authentik.
- Deactivation and a guest booking for the same learner serialize on the `users` row lock (`FOR UPDATE` in both), so a booking cannot slip in after the cancels. Any later learner write path (feature 13's cancel and reschedule) must take the same lock and check `status = 'active'`.
- Edit, deactivate, and reactivate change Authentik only inside the transaction that holds the user row lock (lock first pattern); the app row changes only if Authentik succeeded.
- Saga cleanup and the sweeper delete a learner row only when the delete statement itself still finds no bookings and no pk.
- The reconciler stays the only code that adds or removes `pod-*` members; it never treats a deactivated learner as a desired member.
- Booking state changes use the DB clock and the `version` guard (spec 0002).
- Rows with no `authentik_user_pk` are never shown, edited, deactivated, reactivated, or resent from the console.

### Security model

- Admin only: every page and action calls `requireAdmin()` (AC-14). The pages show learner PII (name, company, email) to admins only; the admin layout is already `noindex`.
- Authentik writes use the provisioning token, guarded per spec 0003. No new Authentik rights.
- Learners can no longer reach the console or these actions; a deactivated learner loses app and Authentik sessions at once and lab access by the next reconciler tick (about 30 seconds).
- Audit rows hold ids, field names, counts, and the new email in `changedFields` (the admin entered it); never a recovery link.
- Known gap, accepted: after an email fix, a set password link already sent to the old address stays valid until it expires (72 hours). No link is sent today (feature 16 sends them); feature 16 decides on revoking.

### Configuration required

None. Existing settings only (`DATABASE_*`, `AUTHENTIK_*` provisioning token, `WORKER_ENABLED`).

### Critical test scenarios

- Happy path (Playwright, real Authentik, email `dev-learner-<run id>@nile-test.invalid`): add a learner, see them in the list and search them; open the detail page; edit company and timezone; deactivate (Authentik user inactive via the read only API helper); reactivate. The run leaves the learner deactivated. Verifies **AC-1**, **AC-2**, **AC-4**, **AC-6**, **AC-8**, **AC-9**.
- Parse (unit): each `LearnerInput` rule and message; `initials` for one word, two words, and extra spaces. Verifies **AC-2**, **AC-4**.
- Add saga (DB plus fake Authentik): created user gets pending flag, welcome job, and both audit rows; a reused account that logged in gets neither flag nor job; a reused account with `lastLogin` null gets both; each refusal leaves no row and no created Authentik user; a failing final transaction deletes the row and then the Authentik user it created; a row a guest booking attached to is kept with its Authentik user; a duplicate email returns the existing id, a pk null duplicate returns `setting_up`. Verifies **AC-4**, **AC-5**, **AC-13**.
- Edit (DB plus fake Authentik): name change syncs Authentik; email change while pending updates email and username and enqueues the keyed welcome job; a case only email change passes the conflict check; email change after sign in is refused with no Authentik write; Authentik unavailable leaves the row unchanged; a guard refusal gives `refused`; company only edit records no Authentik write; no change writes nothing. Verifies **AC-6**, **AC-13**.
- Deactivate (DB plus fake Authentik): Upcoming and Current bookings are cancelled with `deactivation` and the admin as `cancelled_by_user_id`, Past ones untouched; app sessions deleted; a `provisioning` booking refuses with no Authentik write and nothing changed; Authentik unavailable changes nothing; Authentik `not_found` still deactivates; a guard refusal changes nothing; a repeat is a no op with no audit row; a row with no pk returns `not_found` with no Authentik write and nothing changed. Reactivate: same refusals, including a row with no pk; a repeat writes no audit row. Verifies **AC-8**, **AC-9**, **AC-13**.
- Reconciler (DB plus fake Authentik): a deactivated learner with a confirmed Current booking (forced in the test) is removed from the group. Verifies **AC-11**.
- Admin cancel (DB): Upcoming and Current cancel with `source = 'admin'`; a wrong version, a Past, or an already cancelled booking returns `stale`. Verifies **AC-10**.
- Detail data (DB): phases, cancel source, soft deleted testbed names, newest first, `notFound` cases (admin id, pk null, bad uuid). Verifies **AC-2**.
- Timezone (DB): only a `UTC` admin row changes, once; a learner id changes nothing. Verifies **AC-3**.
- Resend (DB): eligible learner gets one job per hour bucket; ineligible gets `not_eligible`. Verifies **AC-7**.
- Sweeper (DB): an old pk null learner row with no bookings is deleted; a young one, one with a booking, and an admin row stay. Verifies **AC-12**.
- Auth: a learner session calling each new action gets not authorized and writes nothing; the allow list is unchanged. Verifies **AC-14**.
- Migration: index exists; codegen verify passes. Verifies **AC-15**.

## Build plan

Tracer Bullet: first a read only thread from the database to both pages in the admin's timezone, then add, edit, and the status and cancel strands, each working end to end before the next.

1. Read thread: migration `0007_admin_users.sql`, the new audit actions, `setAdminTimezoneAction` with `AdminTimezoneSync` in the admin layout, `listLearnersForAdmin`, `getLearnerDetail`, `initials`, the `deactivated` tone, the Users list page (mock columns, search, view links) and the read only detail page (header, reservations table, times note). Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-15**
2. Add strand: `LearnerInput`, `neverLoggedIn` on `findOrCreateLearner`, `createLearner` saga, `createLearnerAction`, the `link` on `AdminFormState` and in `FormDialog`, `learner-fields.tsx` with the timezone picker, "Add user" wiring, and `sweepUnlinkedLearners` in the worker. Satisfies **AC-4**, **AC-5**, **AC-12**, **AC-13**
3. Edit strand: `updateLearnerIdentity`, `updateLearner` on the lock first pattern, `updateLearnerAction`, the edit dialog on list and detail with the email lock, and the resend button and action. Satisfies **AC-6**, **AC-7**, **AC-13**
4. Status and cancel strand: `deactivationPreview` and `checkDeactivate`, `deactivateLearner` and `reactivateLearner` reworked onto the lock first pattern (booking side effects, new result type, audit only on change), `reactivateLearnerAction`, the reconciler status filter, `cancelBookingByAdmin` and its action, and the confirm dialogs. Satisfies **AC-8**, **AC-9**, **AC-10**, **AC-11**, **AC-13**
5. Guards and end to end: auth tests for every new action, the Playwright happy path. Satisfies **AC-1**, **AC-2**, **AC-4**, **AC-6**, **AC-8**, **AC-9**, **AC-14**

## Consequences

**Positive**:
- Admins can onboard, fix, and cut off learners without touching Authentik themselves, and every change is audited.
- Deactivation is complete in one action: sign in, sessions, bookings, and (within a tick) lab access.
- Console times are finally in the admin's zone, which also fixes the API Keys dates.
- Reuses the guest saga's Authentik functions, the guard, and the reconciler; no new Authentik rights or settings.

**Negative / tradeoffs**:
- No delete: test and mistaken learners stay in the list (deactivated), and the Playwright runs add one each time. A privacy erase would be a new decision.
- An Authentik outage blocks add, name or email edits, deactivate, and reactivate; nothing queues for later.
- Admin cancels and deactivation send no email until feature 15, so learners are not told; the console says nothing about an email.
- Resend and email change queue jobs that sit unsent until feature 16.
- The admin timezone is set once from the first browser that loads the console; an admin who travels or uses a server in UTC has no way to change it yet.
- Lab group removal waits for the next reconciler tick (about 30 seconds); Authentik sign in and sessions end at once.
- The lock first pattern holds a user row lock across Authentik calls, so a guest booking or sign in for that one learner can wait up to the Authentik timeouts while an admin edits or deactivates them. A database commit failure right after an Authentik write leaves Authentik ahead of the app until the admin retries.
- The list loads every learner (client side search); past a few hundred rows it needs paging (the scope's deferred item).
- An add saga that crashes after creating the Authentik user leaves an orphaned Authentik account (same gap as the guest saga).

**Neutral**:
- `deactivateLearner` gains booking side effects and a new error; spec 0003's AC-9 note that feature 10 adds them is fulfilled here.
- A new `server/users/` area holds learner admin logic; `app/admin/users/actions.ts` holds its actions (picked up by the existing Server Action scan).
- One more worker step (`sweepUnlinkedLearners`).

## Follow-up

- [ ] Feature 15: send the cancellation email for `cancel_source` `admin` and `deactivation`, as well as `learner`, from one place (scope decision: one message per cancel).
- [ ] Feature 16: decide whether an email change revokes outstanding Authentik recovery tokens (needs token delete rights, owner approval); send the welcome jobs queued by add, resend, and email change, at most one per user at a time (an unsent original plus an email change job must not send twice).
- [ ] Feature 13: learner cancel and reschedule lock the `users` row `FOR UPDATE` and check `status = 'active'`, so they serialize with deactivation.
- [ ] Feature 18: the audit log view lists the new actions `user.created`, `user.updated`, `booking.cancelled`, `admin.timezone_set`.
- [ ] A way for an admin to change their own timezone after it is set (small setting in the shell), if the owner wants it.
- [ ] Spec 0003 follow up "Feature 10 uses `deactivateLearner` / `reactivateLearner` and adds the console resend button" is built here.
- [ ] Scope row 10 (`/scope`): note "no delete, deactivate only" and the timezone field in the add and edit dialog.
- [ ] `/test`: deactivate an already deactivated row with no pk (proves the pk refusal comes before the no op), and check `reactivateLearnerAction` returns `not_found`, not `authentik_missing`, for a row with no pk (from the AC-8/AC-9 amendment cross check).
- [ ] `/sync`: record the `server/users/` area, the learner email lock rule, and that deactivation owns booking cancels.
