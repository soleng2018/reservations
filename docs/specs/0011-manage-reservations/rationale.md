# 0011. Manage reservations: rationale

The decision record for [index.md](index.md). `/develop` skips this file.

## Context

Learners can book (specs 0004, 0010) and sign in (spec 0003), but once signed in they land on a placeholder. The scope promises they can see their bookings, cancel an Upcoming or Current one (ending a Current one early), and reschedule through the same calendar, with three hard outcomes: a cancel frees the testbed at once, a reschedule succeeds whole or leaves the original untouched, and Past bookings never change. A learner holds at most one Upcoming or Current booking, so with a 90 day horizon (spec 0010) a learner who booked far out cannot book earlier until this feature exists.

The forces that shape the design:
- **Atomicity against a shared calendar.** Other guests book the same testbeds at the same time. The database already enforces no overlap per testbed (`bookings_no_overlap`) and one live booking per learner (`bookings_one_live_per_user`), and spec 0002 left a guarded `rescheduleBooking` and `cancelBooking` with a version check for exactly this feature.
- **Access follows bookings.** Lab access is Authentik group membership kept in step by one worker, the access reconciler, which already reacts to admin cancels and deactivation (spec 0008 AC-11).
- **Later features hang off this one.** Feature 15 needs a stable booking to update or cancel one calendar invite and a "Manage my reservation" link; feature 14 adds lab access to the same pages.
- **The mock.** The learner mock has the list, the cancel dialog, and a reschedule mode of the calendar and confirm screens (eyebrow "Reschedule", "Confirm your new time", a struck "Current time" row, "Updating your reservation" progress). Spec 0010 already built `TimeStep`, `ConfirmStep`, and `ProgressScreen` with plain props for reuse here.
- **Signed in booking.** The guest saga reuses an existing learner by email and ignores the posted name, company, and timezone for them, so a prefilled but editable `/book` would mislead a returning learner.

## Options considered

### Option 1: change the row in place under a lock, on its own reschedule page (chosen)

Learner Server Actions lock the learner's own booking `FOR UPDATE` at the version they saw and update that row: `cancelBooking` for cancel, `rescheduleBooking` for a new range and maybe a new testbed. Reschedule lives at `/reservations/[id]/reschedule`, loaded from the server, reusing the `/book` step components.

**Pros**:
- One transaction, one row, guarded by the existing constraints and version trigger; a failure leaves the original exactly as it was.
- The booking id is stable for feature 15's invite and link.
- The page is refresh safe and deep linkable, with no learner data in browser memory between visits.

**Cons**:
- An `UPDATE` cannot skip a conflicting candidate the way the saga's `INSERT ... ON CONFLICT DO NOTHING` does, so a rare race returns `slot_taken` instead of trying the next testbed.
- A second route and a second client reducer to keep in step with `/book`.

### Option 2: reschedule as cancel plus a new booking through the guest saga

Cancel the old booking, then run the existing saga for the new time.

**Pros**:
- Reuses the saga's testbed assignment, including its try the next testbed behavior under contention.

**Cons**:
- Two writes and an Authentik call: if the new booking fails after the cancel commits, the learner has nothing, which breaks "succeeds or leaves the original untouched". Doing both in one transaction fights `bookings_one_live_per_user` and the saga's separate commits.
- The booking id changes, splitting history and breaking feature 15's single calendar event.

### Option 3: in place update, but the reschedule flow inline in `/reservations`

Same server side as Option 1; the list page swaps to the calendar in client state, as the mock does.

**Pros**:
- One route, closest to the mock's single page behavior.

**Cons**:
- A refresh drops back to the list mid flow, there is no URL for feature 15's email to point at, and the list page grows a large client component.

## Rationale

Option 1 is the only one that meets the scope's "succeeds atomically or leaves the original untouched" without new machinery: spec 0002 already built the guarded in place update and the constraints that make it safe, so the reschedule is one locked transaction that either commits the new range or rolls back. Option 2 cannot give that guarantee across a saga with its own commits and an Authentik call, and it throws away the stable booking id feature 15 needs. Between Options 1 and 3 the server side is the same; the own page wins on refresh safety and on giving the email a deep link, at the cost of one more route.

Calls made inside the decision (each with its runner up):
- **Candidate choice by reading first, then updating.** For each candidate testbed, a plain read checks for an overlapping live booking (ignoring this one), and the first clear one is updated; a concurrent commit that still collides raises `bookings_no_overlap`, mapped to `slot_taken`, as are a deadlock and a serialization failure. Simple and uses the existing transaction style. A two learner swap deadlock cannot form here, because the read skips any testbed whose committed booking overlaps the new range; the mapping is insurance. Runners up: (a) raw `savepoint` statements per candidate, which would retry the next testbed under a race, but Kysely 0.29 offers savepoints only on `startTransaction()`, not the `transaction().execute()` callback this codebase uses, so it would mean hand written SQL around every attempt for a race that is rare at this scale; (b) locking every candidate testbed `FOR NO KEY UPDATE` in name order before choosing (raised by the cross check), which removes the race but conflicts with the saga's `FOR SHARE`, so every reschedule would stall guest bookings of the whole type.
- **Lock the learner row first.** Both writes take the `users` row `FOR SHARE` with `status = 'active'` before the booking, the lock first pattern from `server/users/`. Deactivation holds that row `FOR UPDATE`, so a deactivation and a learner change run one after the other: no change slips past a deactivation, and deactivation's cancels never meet a version bumped under them.
- **Idempotent Try again.** A lost reply after a commit would otherwise turn Try again into a `stale` error; recognizing "already at the requested start, one version on" returns the success instead.
- **Keep Turnstile on signed in `/book`.** Booking calls Authentik and runs the saga, so it keeps one guarded path; reschedule skips Turnstile because it makes no Authentik call and is bucketed per user. Runner up: skip Turnstile for a learner session and rely on per user buckets, saving a challenge at the cost of a second branch in `bookAction`.
- **Identity from the session row, not the parser.** A stored row may hold a null company (rows created outside the guest form) or values an admin edited, which `BookInput` could refuse; the row is already trusted data, so only the type and start are parsed for a learner session.
- **Keep the learner's testbed when free** (engineer's call): fewer group changes and the same lab they knew; otherwise the `/book` name order.
- **Access by the reconciler** (engineer's call): keeps `reconcileAccess` the only writer of `pod-*` groups, as spec 0008 chose for admin cancels, accepting up to one tick of lag.
- **Same type, the type's current duration** (engineer's calls): the calendar, preview, and write all read one value, and the mock has no type picker for reschedule.
- **Account zone, read only** (engineer's call): `users.timezone` is the one zone the console and future emails use; no new write path now.
- **Signed in `/book` as an account summary** (engineer's call), with the server taking identity from the session: the saga ignores those fields for an existing learner anyway, and the override closes booking under another email.
- **No bucket on cancel.** A cancel needs a live booking and a learner holds one, so it cannot be churned; a refused cancel writes nothing. Runner up: a 10 per hour bucket for symmetry, which would only add a write per click.
- **Own current start disabled and labelled "Current"**: choosing it would change nothing. Runner up: let the server answer `same_time`, which it still does as a backstop.
- **A recent provisioning row counts as live for "Reserve another"**: otherwise the link leads straight into the `booking_pending` refusal. Only rows inside `STALE_OWN_ATTEMPT` count, matching the Step 1 check, so a crashed attempt does not hide the link.
- **No fallback for an empty first name**: the `users_name_trimmed` CHECK guarantees a non empty name, so its first word always exists (a cross check point not adopted).
- **Stale goes back to the list with a toast**: the list is the truth after any change by an admin, another tab, or the clock.
- **No pagination**: one live booking at a time keeps each learner's list short (see Consequences).
