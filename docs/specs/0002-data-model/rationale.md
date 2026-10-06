# 0002. Data model: rationale

## Context

Every later feature (the admin catalog, booking, lab access, emails, audit) reads and writes the same core data, and the data model is the costliest thing to redo once rows exist. The database is shared by dev and production (spec 0001), so a reshaping migration later lands on real data.

The rules that matter most are about time and concurrency: a testbed must never be double booked, a learner may hold only one Upcoming or Current booking, and two learners racing for the last slot must not both win. "Current" depends on the clock, so it cannot go straight into a unique index (`now()` is not allowed in an index predicate).

The admin console deletes catalog items, but the scope only blocks deletes while something is in use (a type with testbeds, a key on a testbed, a testbed with Upcoming or Current bookings). Past bookings must still show the testbed and type they used. Secrets must be write only and encrypted, and the audit log must not be editable from the app.

The project builds by Tracer Bullet, so slice 1 needs only the booking thread's tables, but nothing added later may force a breaking change.

## Options considered

### Option 1: Normalized model, DB enforced invariants, soft deleted catalog (chosen)

One `users` table for both roles, separate catalog tables, a `bookings` table with a stored lifecycle status, an exclusion constraint, and a partial unique index; catalog rows get `deleted_at`.

**Pros**:
- The race prone rules are enforced by Postgres, not by hope.
- History stays joinable with no duplicated data.

**Cons**:
- Every catalog query must filter soft deleted rows.
- Needs a `completed` status kept current by the worker and the booking transaction.

### Option 2: Snapshot history, hard delete catalog

Bookings copy the testbed name, type name, and URLs at booking time; catalog rows are really deleted and booking FKs become `SET NULL`.

**Pros**:
- No soft delete filters; catalog tables stay clean.

**Cons**:
- Duplicated data that drifts (a renamed testbed shows the old name forever), and a nullable FK weakens every booking join.

### Option 3: App enforced rules with row locks

No exclusion or partial unique constraints; each booking transaction locks the user row and the testbed row (`SELECT ... FOR UPDATE`) and checks in code.

**Pros**:
- Simplest schema and status set; no `completed` state.

**Cons**:
- One missed lock in any code path (reschedule, admin edit, a future feature) silently allows a double booking. The rule exists only in code.

## Rationale

The scope's "done when" for this feature is that no overlap and one live booking hold, with no breaking migration later; only database constraints make those hold for every future code path, including races that tests rarely catch. The exclusion constraint was already chosen in spec 0001; the partial unique index on live statuses is the clock free version of "one Upcoming or Current" that spec 0001's follow up asked for, and completing stale rows inside the booking transaction removes the only downside (a 30 second wait).

Soft delete is usually a smell (ghost rows, broken unique constraints), but here the alternative is copying catalog data into bookings, which drifts. Partial unique indexes on non deleted rows answer the unique constraint problem, and the slug stays unique across all rows so a `pod-<slug>` Authentik group name is never reused.

One `users` table holds admins too, because the admin timezone and the audit actor need a home in `hol_app`, and guest booking must create a learner before any Better Auth row exists. Status values use `text` + `CHECK` because forward only SQL migrations change a `CHECK` easily inside a transaction, while Postgres enums can never drop a value. `uuid` keys keep booking ids unguessable in URLs and the ICS `UID`. Landing tables per slice follows the Tracer Bullet approach without risk, since every later table is fully designed here and only ever added.
