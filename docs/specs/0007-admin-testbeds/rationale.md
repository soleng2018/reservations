# 0007. Admin Testbeds: rationale

## Context

Feature 6 (spec 0004) shipped a create only testbed form with a row first saga that creates the Authentik group `pod-<slug>` and stores its pk. Feature 5 (spec 0005) moved that form into the admin shell. Admins still cannot fix a typo, change a URL, assign the IDP key that spec 0006 made possible, or remove a testbed. The scope's feature 9 asks for the full mock screen: list, search, add, edit, and delete, with client rows that can be added and removed.

Three forces shape it. First, Authentik: spec 0001 chose to give the app the least API rights (it creates and deletes `pod-*` groups; the owner binds them to the Nile tenant SAML app, Moodle, and Cloudflare Access by hand), while the scope's wording for this feature says the app "protects its URLs" and updates that protection on edit. Second, deletion: a testbed is soft deleted (spec 0002), yet its group must go away, its learners must be cut off, and a crash or an Authentik outage must not leave a half state. Spec 0002 named this "the testbed delete saga" and left it to feature 9. Third, the mock's client rows carry an OS username and password, which the scope text never listed. The engineer confirmed the learner needs them to use the lab PCs, and they travel to the learner in the booking email and calendar invite.

Also in play: the reconciler (spec 0004 AC-12) already empties the groups of soft deleted testbeds; the AGENTS.md rules on secrets at rest, audit, delete flows, and admin row edits; and the fact that dev and production share one host, one database, and one worker.

Getting this wrong means stale groups granting access to retired labs, edits that silently break bookings, or lab passwords leaking to places they should not go.

## Options considered

### Option 1: Catalog CRUD in the actions, group teardown in the worker (chosen)

Edit and delete touch only the database. A soft delete makes the testbed unbookable at once. A new worker step, run right after the reconciler, deletes the group once the reconciler has removed every tagged learner and ended their sessions, then stamps `authentik_group_deleted_at`. The owner keeps binding groups by hand.

**Pros**:
- One owner for group teardown and membership; failures retry every tick for free.
- The session cut off for any learner still in the group is the reconciler's existing, tested path.
- No new Authentik rights, no new credentials.

**Cons**:
- The group lingers up to about 30 seconds after delete, longer if the worker is down.
- Needs a new column to mark teardown done.

### Option 2: Inline group delete in the action, worker retries on failure

The delete action soft deletes, then deletes the group right away; a sweeper retries any failure.

**Pros**:
- The group is usually gone by the time the admin sees the toast.

**Cons**:
- Two code paths delete groups, and the inline one must also end sessions for stale members or it skips the cut off.
- An Authentik timeout makes the admin wait up to 10 seconds on a delete that already succeeded in the database.

### Option 3: The app binds groups to lab apps itself

The admin picks the testbed's Authentik applications and the app writes the policy bindings (and, in the fullest form, creates providers and Cloudflare Access apps).

**Pros**:
- Matches the scope's literal wording: the app protects the URLs and updates protection on URL edits.

**Cons**:
- Needs binding or provider write rights on the runtime token, widening what a stolen token can do, and it changes apps the owner manages (against the agreed write boundary).
- Each lab system protects access differently (SAML per Nile tenant, OIDC for Moodle, Cloudflare Access for VMs), so automation spans two vendors and a Cloudflare token.

### Option 4: Keep the group on delete

Soft delete only; the owner removes the empty group by hand.

**Pros**:
- Simplest; no worker change.

**Cons**:
- Contradicts the scope ("deleting the testbed removes the group") and leaves stale groups that the owner must remember.

## Rationale

Option 1 follows the shape the project already trusts: the database is the source of truth and the worker converges Authentik to it. Spec 0001 made the reconciler the only code that changes pod membership precisely so crashes and missed ticks heal by themselves; a teardown step that waits for the reconciler and then deletes the group extends that rule instead of creating a second path. The extra 30 seconds is harmless because the soft delete already makes the testbed unbookable, and the blocker check guarantees no Upcoming or Current booking exists.

The engineer kept spec 0001's hand binding (Option 3 rejected) because the app's token should not be able to change who reaches which lab app, and the lab systems span Authentik and Cloudflare. The scope wording is updated to match (see Follow-up in index.md).

On client OS credentials, the recommendation was to encrypt them and keep them write only, like API key secrets. The engineer chose plain text. That works here because these are shared lab VM logins that the booking email sends in clear to every learner of the testbed, so encryption at rest would mostly guard them from people who could read the emails anyway; it also lets admins see and fix them, and keeps replacing clients as a set simple. The cost the team accepts: anyone with database or backup access reads them, and moving to encryption later means a migration. To keep them from drifting toward learner browsers, logs, or audit rows, the spec adds a source scan on `os_password` and keeps credential values out of audit metadata.

Smaller calls made during the design, each with its runner up:
- Type change with live bookings is allowed (runner up: block it). Bookings copy their type at book time and the exclusion constraint works per testbed, so nothing breaks; blocking would leave a wrong type stuck until bookings end.
- IDP is optional (runner up: required as in the mock). Nothing uses it yet and an IDP key may not exist.
- Clients are replaced as a set (runner up: update in place by id). Nothing references client ids, and plain text passwords need no row matching.
- At most 20 clients (runner up: 50). Room to grow while the booking email stays readable.
- A not ready testbed can be deleted but not edited (runner up: allow both). The create sweeper may remove the row, losing an edit.
- Blocker labels use the mock wording with the phase from `bookingPhase` (runner up: add the start time). No admin timezone source exists yet.
- The teardown waits while a tagged learner remains, but deletes despite untagged members (runner up: wait for those too). The group is the testbed's own (its `hol_testbed_id` matches), so hand added members only lose a group that guards nothing.
- A group stamped for another testbed is never deleted; the row waits and logs each tick (runner up: stamp and move on). A loud stuck row is better than a silently forgotten stray group.
- `updateTestbed` refuses a no change save without writing (the feature 8 pattern), and concurrent admin edits are last write wins (features 7 and 8).
- `testbed.updated` carries `accessChanged` so feature 15 can send updated access emails from the same transaction, without a new column now.
- OS credentials load one testbed at a time when its edit dialog opens (`loadTestbedForEdit`), not with the list (runner up: send every testbed's clients with the page). Plain text storage was the engineer's call; this keeps every password from riding along on each list view. Raised by the cross check, applied 2026-10-10.
- A create whose row is soft deleted mid saga fails and undoes itself (`deleted_at is null` on the pk store), instead of reporting success for a deleted testbed and leaving teardown to clean up (runner up: accept that outcome). Raised by the cross check, applied 2026-10-10.
- The teardown reads members first and lets `deletePodGroup` do the ownership check, instead of a separate group read (runner up: a new `getPodGroup`). One fewer Authentik call per row, and the guard stays the single place that checks `hol_testbed_id`.
