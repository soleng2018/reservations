# 0020 rationale: cleanup gap between labs

The build spec is [index.md](index.md). This file is the decision record: why, and what else was weighed.

## Context

Spec 0004 and spec 0010 set the booking rule: a testbed never has two overlapping bookings, enforced by the exclusion constraint `bookings_no_overlap` (a database rule that refuses two rows whose time ranges overlap). Ranges are half open, so a booking that starts at the exact minute the last one ends is allowed. Cleanup automation, which the owner runs outside this app, needs time between two labs, so back to back starts are now too tight.

Three places reason about overlap today. The database constraint is the last word. `freeStarts` in `lib/slots.ts`, fed by `busyRanges` in `server/booking/availability.ts`, decides which starts the picker offers. The reschedule in `server/booking/manage.ts` runs its own clash query before it moves a booking. The guest booking saga has no query of its own: it inserts and lets the constraint refuse a testbed that is taken, then tries the next candidate.

Only live bookings (status `provisioning` or `confirmed`) hold a testbed. A cancelled booking keeps its `ends_at` but frees the testbed at once, including a Current booking cancelled early. The access reconciler (spec 0017) ends lab access at `ends_at`, and that must stay true: the gap is cleanup time on the testbed, not extra access time for the learner.

The worker marks a booking `completed` as soon as its `ends_at` passes (`completeEnded`), and a completed booking no longer holds the testbed. So the constraint holds the 30 minutes only while the booking is still live. After that, the gap survives only because the booking lead time (`LEAD_MS`, 1 hour) is longer than the gap: no start can be booked less than an hour out, so no start can fall inside a gap that has already begun.

A learner may also reschedule a Current booking. Moving it frees its old range at once, the same way an early cancel does.

The database is shared with the running production containers. No live bookings sit inside a 30 minute gap of another today.

## Options considered

### Option 1: Pad the end inside the exclusion constraint, mirror it in the code

Change `bookings_no_overlap` so each live booking holds its testbed until `ends_at` plus 30 minutes, and make `freeStarts`, `busyRanges`, and the reschedule clash query use the same padding.

**Pros**:
- The database stays the last word, so the guest saga, a reschedule race, and any future code path cannot skip the gap.
- No new table, column, or setting; the constraint name and error mapping are unchanged.

**Cons**:
- The gap is written twice (the migration interval and `GAP_MS`), so a test must keep them in step.
- Changing the gap later needs a migration, not an admin click.

### Option 2: Enforce the gap only in application code

Pad `freeStarts` and the reschedule clash query, and leave the constraint as it is.

**Pros**:
- No migration, nothing to apply on the shared database.

**Cons**:
- Two concurrent bookings, or any path that inserts without the check, can still land back to back. The guest saga relies on the constraint to choose a testbed, so it would not apply the gap at all.

### Option 3: Store a cleanup booking row after every booking

Insert a hidden "cleanup" booking for the 30 minutes after each lab, and let the existing overlap rule block it.

**Pros**:
- Needs no change to the constraint.

**Cons**:
- Every booking, reschedule, and cancel must create, move, and delete a second row in the same transaction. The rows pollute lists, counts, and delete blockers. The most fragile of the three.

### Option 4: A gap setting an admin can change

Keep the gap in a settings row or a testbed type column and enforce it with a trigger.

**Pros**:
- Adjustable without a deploy, and could differ per lab type.

**Cons**:
- An exclusion constraint cannot read a setting, so overlap moves into a trigger that must lock and query on every insert. No one asked for a different length per lab.

## Rationale

The forces in Context are that the constraint is the last word on overlap and that the guest saga depends on it to pick a testbed. Only a change to the constraint covers every path, including a race between two learners, so Option 2 cannot meet the goal. Option 3 turns one rule into a second set of rows to keep in step. Option 4 buys flexibility nobody asked for at the price of a trigger, and a trigger gives up the guarantee a constraint gives for free.

Option 1 costs one migration and one constant written twice. The test in AC-8 makes that duplication safe, because a drift between the two fails the build. The gap is padded on the end of each range rather than checked both ways, because two padded ranges overlap exactly when the later one starts before the earlier one ends plus 30 minutes, which gives the same gap on both sides.
