# 0026. Testbed type groups: rationale

The decision record for [spec 0026](index.md).

## Context

The LMS decides who may open a lab guide by Authentik group membership. Today the app has no group per testbed type, so the owner would have to make and name one by hand each time an admin adds a type, and keep it in step when the type is renamed or deleted. Spec 0017 stopped the app from creating, updating, or deleting any Authentik group, enforced by `tests/group-writes-scan.test.ts` and by the write guard in `server/authentik/guard.ts`, because a wrong write on a shared Authentik can hand a learner admin rights.

Two things make this case different. A type group is not a testbed group: nobody is added to it by this feature, and it carries no `hol_testbed_group` marker, so it can never open the HOL Labs gate or appear in the testbed group list. And the app already holds `authentik_core.add_group` and `authentik_core.delete_group` on its provisioning token (`PROVISIONING_PERMISSIONS`), while Authentik permissions cannot say "only this kind of group", so containment has to live in the app's guard again.

The hard parts are ownership (a delete must never remove a group the owner made, even one with the same name), atomicity (Authentik and Postgres cannot share a transaction), and keeping the testbed group rule intact. Existing types have no group, so they need a one time backfill. Dev and production share one Authentik and one database, so a mistake reaches the real groups.

## Options considered

### Option 1: Marker on the group plus a database origin flag, inside the transaction

The type row stores the group pk and an origin (`created` or `reused`). The group the app makes carries `hol_type_group` and `hol_type_id`. Authentik is called inside the database transaction, so a failure rolls the save back.

**Pros**:
- Two independent checks before any rename or delete (the flag and the live marker), so a stale pk or an edited group never gets hit.
- The save is all or nothing from the admin's view, as the owner asked.
- No new infrastructure: it uses the existing guard, `Refusal`, and audit patterns.

**Cons**:
- A row lock is held while Authentik answers (up to about 30 seconds in the worst case), though only one admin edits types at a time.
- If the database commit fails after Authentik succeeded, a group is left over (a safe orphan the next add reuses).

### Option 2: Database origin flag only

Store pk and origin, no attributes on the group.

**Pros**:
- Simpler groups and one less thing to check.

**Cons**:
- If the group is replaced or edited in Authentik, the app cannot tell, and a stored pk could point at the wrong group.
- An orphan after a failed commit cannot be told from an owner made group.

### Option 3: Queue the group change for the worker

Save the type at once and let the worker create, rename, or delete the group later.

**Pros**:
- No lock held during Authentik calls; retries come free.

**Cons**:
- Breaks the owner's rule that a failed Authentik step leaves the type unchanged.
- Adds a job type, a state column, and a window where the type exists with no group, which the LMS would show as a missing lab guide.

## Rationale

The owner's two hard rules decide this: a failed Authentik step must leave the type unchanged, and the app must never touch a group it did not make. The first rules out the worker queue (Option 3), because a queue saves first and fixes later. The second needs more than a stored pk, because the shared Authentik can change under the app, and because the same name rule means the app will sometimes hold a pk for a group the owner made. Checking the stored origin and the live marker together is cheap (one read before each write) and fails safe: on any doubt the app leaves the group alone.

Holding a row lock during Authentik calls was the first design's price of atomicity. A review on 2026-11-04 found it could hold a booking for about 90 seconds, because bookings take the type `FOR SHARE`. The owner chose (2026-11-04) to move the long Authentik calls under a per type advisory lock and keep the row lock for the row write (AC-19). Capping the booking wait was rejected as the only fix because it leaves the admin side blocking, and moving Authentik out of the transaction was rejected because it breaks AC-4.

Original reasoning: It is the same pattern `deactivateLearner` already uses, the load is a handful of admin edits a month, and the client timeout is 10 seconds per call, so the worst case is acceptable. The runner up was Option 2, rejected because an unmarked group cannot be told apart from an owner made one after any drift.

The type group deliberately carries its own markers and never `hol_testbed_group`. That one choice keeps the testbed dropdown, the reconciler, and the HOL Labs gate exactly as spec 0017 left them, so the exception stays inside `server/authentik/type-groups.ts`.

