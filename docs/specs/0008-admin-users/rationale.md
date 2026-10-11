# 0008. Admin Users and User Detail: rationale

## Context

Learners exist today only through the guest booking saga (spec 0003, spec 0004). Admins cannot see who has booked, fix a guest's typo, onboard someone ahead of a session, or cut someone off. Spec 0003 built `deactivateLearner` and `reactivateLearner` but left their console UI and booking side effects to this feature, and the scope's feature 10 asks for the mock's Users list, user detail page, and add and edit dialogs, with add, edit, and deactivate synced to Authentik.

Four forces shape it. First, Authentik is the source of credentials and shared with the owner: the app may only write tagged learners through the guard, the username is the lowercased email, and a set password link is bound to the account, not the address. Second, bookings and audit rows reference users with `RESTRICT`, and the mock's delete control conflicts with that history. Third, deactivation must actually end access: sign in, open sessions, future bookings, and lab group membership, while the reconciler stays the only code that touches `pod-*` members (spec 0001). Fourth, the console has no real admin timezone (admin rows are `UTC` from first sign in), yet the scope requires bookings shown in the admin's zone.

Not deciding leaves the console without user management and leaves `deactivateLearner` unable to free testbeds, so a deactivated learner's Upcoming booking would still hold the testbed and grant access when it starts.

## Options considered

### Option 1: Authentik first for each change, booking side effects in the status transaction

Add uses a row first saga (insert, Authentik, record pk) like the guest booking. Edit, deactivate, and reactivate lock the user row, call Authentik while holding the lock, and commit the app change only on success. Deactivation cancels live bookings in that same transaction; the reconciler then removes group membership.

**Pros**:
- The app never claims a state Authentik does not have: a deactivated row always means Authentik refuses sign in.
- Reuses the guest saga functions, the guard, and the reconciler unchanged in shape.
- Bookings and status change atomically, serialized with guest bookings by the user row lock.

**Cons**:
- An Authentik outage blocks these actions outright.
- A row lock is held across Authentik calls, so that learner's own sign in or booking can wait a few seconds.

### Option 2: App first with a sync job

Write the `users` row immediately and enqueue a job that pushes the change to Authentik with retries.

**Pros**:
- Works during an Authentik outage; the admin never waits on Authentik.

**Cons**:
- Deactivate would not block sign in until the job runs, which defeats its purpose.
- Two sources of truth that can disagree; needs a drift view and conflict rules.

### Option 3: Deactivate only flips status; bookings handled by hand

Keep `deactivateLearner` as is and make admins cancel bookings first (the delete blocker pattern).

**Pros**:
- Smallest change; no new side effects in `deactivateLearner`.

**Cons**:
- An extra manual step for the most urgent action; a forgotten booking still grants access when it starts.

## Rationale

Option 1 fits the forces. Deactivation is a security action, so it must take effect in Authentik before the app reports success, which rules out Option 2's eventual sync. Cancelling bookings inside the status transaction (under the same row lock the guest saga takes) closes the race Option 3 leaves open and frees testbeds at once. Leaving group removal to the reconciler keeps spec 0001's single writer rule, and the learner is already locked out by the inactive account and ended sessions, so the tick of delay does not reopen access.

Smaller calls, each the engineer's pick unless marked:
- No delete, deactivate only (runner up: delete only never booked users). History and `RESTRICT` keys make deactivate the safe off switch.
- Email editable only while `set_password_pending` (runner up: never editable). Fixes guest typos, the common case, without moving the login of someone who already set a password.
- Deactivate confirms with the list of bookings it will cancel, then cancels them all (runner up: block until cancelled by hand).
- Admin cancel covers Upcoming and Current (runner up: Upcoming only), matching the learner's own rule.
- A timezone picker in the add and edit dialog, default the admin's browser zone (runner up: silently use the admin's zone). The stored zone drives learner email times, and a guest rebooking keeps it.
- Admin timezone stored once from the browser while still `UTC` (runner up: a picker in the shell), the rule spec 0002 recommended.
- Company required, as in the guest form (runner up: optional, as in the mock).
- Name and email sync to Authentik; company stays in the app (runner up: also an Authentik attribute).
- No cancellation email until feature 15, which sends it for every cancel source in one place (runner up: queue jobs now).
- Console resend while the learner has not signed in (runner up: public resend only).
- Count Upcoming, Current, and Past (runner up: include cancelled). Detail lists cancelled rows with the source.
- Duplicate email shows a link to the existing learner; an Authentik only account is reused and tagged, as in the guest saga.
- Client side search over all learners, keeping the scope's deferred paging item (runner up: server paging now).
- Full workflow tier (runner up: Medium), like the other Authentik features.
- Authentik down: change nothing and say so (runner up: save and sync later).
- Deactivate during a guest saga: refuse and retry in a minute (runner up: let the saga fail).
- An old set password link after an email fix stays valid until it expires; feature 16 decides on revoking (runner up: grant token delete rights now).

Recommended by the architect (not asked):
- Hide learner rows with no `authentik_user_pk` and sweep them after 10 minutes (runner up: show a "Setting up" badge). They exist only for seconds unless a saga crashed.
- Lock first for edit, deactivate, and reactivate (runner up: Authentik first, then a write back to Authentik on a late app failure). Raised by the cross check and chosen by the engineer: the write back could overwrite a concurrent change or fail itself, and deactivate could leave Authentik inactive with the app row active. Holding one learner's row lock for a few seconds is the cheaper cost.
- A reused Authentik account that never logged in gets the set password flow (raised by the cross check): otherwise an orphan from a crashed saga is reused with no password and no way to get one.
- Add and guest sagas can meet on one pk null row; the pk store accepts only null or the same pk, and every cleanup delete rechecks "no bookings" in the statement (raised by the cross check).
- Guard refusals (an account moved to `hol-admins` or untagged in Authentik) get their own message, "This account can't be managed here. Check it in Authentik." (raised by the cross check).
- Authentik `not_found` on deactivate still deactivates in the app; on reactivate it refuses (runner up: refuse both). A missing account cannot sign in, so blocking deactivation would only leave bookings live.
- `reconcileAccess` also filters `status = 'active'` (runner up: rely on booking status alone). Cheap defense in depth.
- One `booking.cancelled` audit row per booking, also for deactivation (runner up: a count on `user.deactivated` only), so feature 18 can show each cancel.
- Admin cancel binds the booking `version` from the page (runner up: read it in the action), so the admin cancels what they saw.
- New `server/users/` area and `app/admin/users/actions.ts` (runner up: grow `app/admin/actions.ts`), since learners are not catalog and that file is already long.
- An index on `bookings (user_id, starts_at desc)` for the detail page and count.
