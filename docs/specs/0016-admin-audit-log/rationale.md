# 0016. Admin audit log: rationale

The decision record behind [index.md](index.md). `/develop` reads index.md; this file holds the why.

## Context

The scope's feature 18 asks that API key secret creation and replacement, catalog changes, testbed group changes in Authentik, user deactivation, and admin booking cancels each write an entry with actor, action, target, and time, that entries can't be edited from the app, and that admins can view the log.

Most of that already exists. Spec 0002 designed `audit_events` with the audit features in mind, and migration `0003` landed it with append only and no truncate triggers (spec 0002 AC-7). Every feature since has written its own rows through `audit()` inside the same transaction. A survey of the call sites on 2026-10-20 (below) shows every scoped action is already written. What's missing is any way for an admin to read them.

The forces on the read side:
- **Volume grows without a ceiling.** Every booking writes at least a grant and a revoke, every admin sign in writes a row, and entries are kept forever (spec 0002, owner choice). Spec 0005 deferred paging until a list passes about 200 rows. This one will pass that within weeks.
- **Entries store ids, not names.** Summaries are generic ("Testbed updated"), and `target_id` is a uuid (sometimes `authentik:<pk>`, a group pk, or `unknown`). The reader has to turn ids into names, and catalog rows are soft deleted, so most names still resolve.
- **Null actor is ambiguous.** The worker and the public booking saga (`bookAsGuest`, used by guests and signed in learners alike) both write `actor_user_id = null`.
- **Rows in one transaction share `created_at`**, because `now()` is fixed per transaction. Any ordering or paging on time alone is not total.
- **Dev and prod share one database**, so anything the change touches on the write side (a backfill, a new column) touches production rows.

### Audit write survey (2026-10-20)

| Scoped action | Written as | Where | Actor |
|---|---|---|---|
| API key secret created | `api_key.created` | `server/catalog/api-keys.ts` | admin |
| API key secret replaced | `api_key.secret_replaced` | `server/catalog/api-keys.ts` | admin |
| Catalog changes | `testbed_type.created/updated/deleted`, `testbed.created/updated/deleted`, `api_key.updated/deleted` | `server/catalog/*.ts` | admin |
| Testbed group changes in Authentik | `authentik_group.created` (testbed create), `authentik_group.deleted` (teardown, create undo), `access.granted`, `access.revoked` (reconciler) | `server/catalog/testbeds.ts`, `server/worker/teardown.ts`, `server/worker/reconcile.ts` | admin or system |
| User deactivation | `user.deactivated` | `server/authentik/learners.ts` | admin |
| Admin booking cancel | `booking.cancelled` | `server/users/learners.ts`, `server/authentik/learners.ts` (deactivation) | admin |

Also written, and shown by the log: admin sign ins and refusals, admin timezone set, learner add, edit, and reactivate, set password resends, booking form bookings and refusals, Authentik user create and tag, and learner cancel and reschedule.

## Options considered

### Option 1: Server pages over the existing table, names looked up at read time

A new admin page reads `audit_events` in keyset pages (50 rows, a cursor of `created_at` plus `id`), with every filter in the URL and applied in SQL. Target names are resolved by one batched lookup per page. Null actors are labelled by a pure mapping from the action. One index migration, `(created_at desc, id desc)`. No write path changes.

**Pros**:
- Reaches every entry ever written, at steady speed, however large the table grows.
- No backfill and no change to roughly 35 `audit()` call sites, so nothing on the shared production rows changes.
- Shareable, bookmarkable filtered views, which the History links reuse.

**Cons**:
- A renamed item shows its current name, not the one it had at the time.
- More code than reusing `DataTable`: a filter form, a cursor, and a target resolver.
- Free text search needs subqueries over five tables to match target names.

### Option 2: Latest N entries in the existing `DataTable`

Load the newest 500 entries on the server and hand them to `DataTable`, which already searches rows in the browser, as every other admin list does.

**Pros**:
- The least code, with the same look and behavior as the other lists.
- Instant search as you type.

**Cons**:
- Anything older than the newest 500 can't be reached, and grants and revokes push real admin actions out of the window fast.
- Filters can't be linked, so History links would need a separate path anyway.
- Sends 500 rows of PII to the browser on every view.

### Option 3: Snapshot names at write time, then server pages

Add `target_label` (and an actor label) to `audit_events`, fill them in every `audit()` call, fall back to a lookup for old rows, and page as in Option 1.

**Pros**:
- Shows names as they were when the action happened.
- Cheaper free text search (one column, open to a trigram index).

**Cons**:
- A migration plus edits to about 35 call sites, each needing the right name in hand inside its transaction.
- Two label sources forever (snapshot for new rows, lookup for old), and they disagree after a rename.
- The rename case it fixes is already covered: the rename entry's changed fields show the old name.

## Rationale

Option 1 fits the forces. The table grows without a ceiling and is kept forever, so anything that caps what can be reached (Option 2) fails the "admins can view the log" requirement within weeks. That's the failure spec 0005 deferred paging to avoid. Keyset paging on `(created_at, id)` is the one ordering that's both total and index friendly, given that one transaction shares a `created_at`. Carrying the cursor as microsecond text from SQL is what makes it exact.

Option 3 buys accuracy for one case, renames, that the existing metadata already records. It costs a write side change across every feature, plus two sources of truth for names on a database production shares. Reading names live works for every past row the day it ships. The "Deleted" badge covers soft deleted rows, and the fallbacks cover the non uuid ids the sign in check and the worker write.

Two smaller calls follow the same logic. The null actor label is a display mapping, not a stored field, so it's right for old rows and touches nothing. It reads "Booking form" rather than "Guest", because `bookAsGuest` serves signed in learners too, so "Guest" would mislabel their bookings. And the booking history shows only entries that target the booking. Linking revokes to bookings would mean a best guess lookup in the reconciler after the booking is gone, and a guess in an audit log is worse than a pointer to where the true entry lives.
