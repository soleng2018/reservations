# 0020. Cleanup gap between labs

**Date**: 2026-10-26
**Status**: Accepted

## Summary

After a lab ends, the testbed needs 30 minutes for the cleanup automation to reset it. This spec holds a testbed for 30 minutes after each live booking ends, so a lab booked 8 am to 12 pm means the next lab on that testbed cannot start before 12:30 pm. The rule is enforced in the database (so no code path can skip it) and mirrored in the time picker and the reschedule check (so learners never see a time that would be refused). The gap length is a fixed 30 minutes in code.

## Requirements

**User stories**:
- As a lab owner, I want a 30 minute gap after every lab on a testbed so that the cleanup automation can run before the next learner starts.
- As a learner, I want the time picker to show only starts I can actually book, so that I never pick a time and then get refused.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: The database refuses a live booking on a testbed when its start is before the end of another live booking on the same testbed plus 30 minutes, and the other way round (a booking that would end within 30 minutes before another live booking's start). A start exactly 30 minutes after the other booking ends is allowed. The refusal keeps the constraint name `bookings_no_overlap`, so `mapConstraintError` still returns `overlap`.
- **AC-2**: The picker (`freeStarts`) offers no start on a testbed that is within the gap of a live booking on that testbed, on either side. A type with several bookable testbeds still offers a start while at least one testbed is free with its gap respected.
- **AC-3**: The server recheck at confirm refuses a start inside the gap. For the guest saga this is the constraint: it moves on to the next testbed of the type, and when none is left the reply is the existing `slot_taken`. A signed in learner booking follows the same path.
- **AC-4**: A reschedule applies the gap too. Its clash query counts a live booking as a clash when it comes within 30 minutes of the new range, ignores the booking being moved (so a learner can move next to their own old slot), and the constraint stays the last word.
- **AC-5**: Cancelled and completed bookings hold nothing. Cancelling a booking, including a Current one cancelled early, frees the testbed and its gap at once. Rescheduling a Current booking frees its old range at once in the same way. The owner accepts both (early end, no cleanup hold).
- **AC-6**: `busyRanges` reads every live booking that could affect the requested window, including one that ended up to 30 minutes before the window starts and one that starts up to 30 minutes after it ends.
- **AC-7**: Migration `0016_booking_cleanup_gap.sql` replaces `bookings_no_overlap` with the padded rule under the same name. It first locks `bookings` (`share row exclusive`, so no booking can land mid migration), then counts live booking pairs already inside a gap, using the constraint's own predicate: same testbed, both live, `a.id < b.id`, and the padded ranges overlap, with no `ends_at > now()` filter because ended rows not yet swept are still live. When the count is above zero it raises an exception that names the count, the whole migration rolls back, and the old constraint stays. With none, it applies.
- **AC-8**: The gap length lives in one place in code, `GAP_MS` in `lib/slots.ts`, with a comment tying it to the interval in the migration. A database test proves the constraint and the constant agree to the millisecond: with an earlier booking whose `ends_at` is off grid, a start at `ends_at + GAP_MS - 1 ms` is refused and a start at `ends_at + GAP_MS` is accepted (the schema only puts `starts_at` on the half hour grid).
- **AC-9**: Nothing the learner sees changes: no new text on the booking or reschedule screens, and the emails, calendar events, and lab access window keep ending at `ends_at`. The gap is invisible except that some starts are no longer offered. Admin copy and code comments that say back to back labs are allowed are updated.
- **AC-10**: `LEAD_MS` is at least `GAP_MS`, so no start can be booked inside a gap that has already begun (the guarantee that remains once the worker marks a booking `completed`). A unit test asserts it.

## Decision

**Chosen option**: Option 1: Pad the end inside the exclusion constraint, mirror it in the code

A live booking holds its testbed from `starts_at` to `ends_at` plus 30 minutes; the gap is a fixed 30 minutes (`GAP_MS`), and cancelled or completed bookings hold nothing.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`)

## Feature design

**Data model sketch**:
No new table or column. Only the constraint changes:

```sql
alter table hol_app.bookings drop constraint bookings_no_overlap;
alter table hol_app.bookings add constraint bookings_no_overlap exclude using gist (
  testbed_id with =,
  tstzrange(
    starts_at,
    ((ends_at at time zone 'UTC') + interval '30 minutes') at time zone 'UTC',
    '[)'
  ) with &&
) where (status in ('provisioning', 'confirmed'));
```

The padded end is computed on a `timestamp` in UTC because `timestamptz + interval` is not immutable and cannot sit in an index expression. A fixed 30 minutes has no daylight saving effect, so the result is the same instant.

**State transitions**: none. Status rules are unchanged; only `provisioning` and `confirmed` hold a testbed.

**API surface**: no new endpoint or action. Existing actions keep their inputs and outputs, and a start inside the gap gets the same errors as an overlap (`slot_taken` on book and reschedule).

**Value sourcing**:
| Action | Value produced / displayed | Source |
|---|---|---|
| Picker, `freeStarts` | Whether a start is offered | busy ranges from `busyRanges`, the duration from the testbed type, and `GAP_MS` in `lib/slots.ts` |
| Picker, `busyRanges` | The live bookings that can affect the window | `bookings` rows with a live status, read with the strict comparisons `starts_at < to + GAP_MS` and `ends_at > from - GAP_MS` (the padding is in the bounds, so callers pass the plain window). `startsFor` passes `[now, now + HORIZON_MS + length]`; `firstFreeTestbed` passes `[startsAt, endsAt]` |
| Reschedule clash query | Whether a candidate testbed is free | `bookings` rows of that testbed, live, with `starts_at < endsAt + GAP_MS` and `ends_at + GAP_MS > input.startsAt`, the booking being moved excluded by id |
| Guest saga insert | Refusal when inside the gap | the `bookings_no_overlap` constraint, mapped to `overlap` by `mapConstraintError` |
| Migration pre-check | Count of live pairs already inside a gap | a self join on `bookings`: both live, same testbed, `a.id < b.id`, padded ranges overlap, the same expression as the constraint |

**Key invariants**:
- Two live bookings on one testbed never come within 30 minutes of each other (database constraint). A booking that has ended and been marked `completed` no longer holds its gap; the lead time covers that (next line).
- `LEAD_MS >= GAP_MS` (AC-10 test).
- `GAP_MS` equals the interval in the constraint (AC-8 test).
- Lab access still ends at `ends_at`; the gap never extends access.

**Security model**: no new data and no new role. The rule applies to every booking path alike. No compliance scope applies.

**Configuration required**: none.

**Critical test scenarios** (each maps to an acceptance criterion in ## Requirements):
- Constraint, boundary: book 8:00 to 12:00, then insert a start at 12:00 (refused) and at 12:30 (accepted); also the reverse order, insert 12:30 first then 8:00 to 12:00 (accepted) and 8:30 to 12:30 (refused), verifies **AC-1**, **AC-8**
- Picker: with a busy range ending at 12:00 on the only testbed, 12:00 is not offered and 12:30 is; with a second free testbed, 12:00 is offered, verifies **AC-2**, **AC-6**
- Saga: the first testbed is inside a gap, the second is free, the booking lands on the second; when both are inside a gap the reply is `slot_taken`, verifies **AC-3**
- Reschedule: moving to a start inside another learner's gap is refused; moving next to its own old slot is allowed, verifies **AC-4**
- Cancel: cancelling a Current booking frees its gap at once, verifies **AC-5**
- Migration: with a live pair inside a gap the migration stops with the count and the old constraint stays; with none it applies, verifies **AC-7**
- Learner surfaces: no copy changed on the picker and reschedule screens; the reconciler still removes access at `ends_at`, verifies **AC-9**

## Build plan

Build approach: Tracer Bullet. First prove one real thread (the database rule and one picker read), then thicken it.

1. Write migration `0016_booking_cleanup_gap.sql`: `lock table hol_app.bookings in share row exclusive mode`, then a `DO` block that raises an exception with the pair count, then the drop and re-add of `bookings_no_overlap` with the padded range. Prove it on a throwaway copy of the database, never on the shared database before deploy, satisfies **AC-1**, **AC-7**
2. Add `GAP_MS` to `lib/slots.ts` and teach `freeStarts` to keep a start only when each busy range ends at least `GAP_MS` before it or starts at least `GAP_MS` after the booking ends; update its comment, satisfies **AC-2**, **AC-8**, **AC-9**
3. Pad the `busyRanges` bounds as in the Value sourcing table (strict `<` and `>` kept, padding in the bounds), satisfies **AC-2**, **AC-6**
4. Pad the reschedule clash query in `server/booking/manage.ts` with `GAP_MS` and keep the exclusion of the booking being moved, satisfies **AC-4**
5. Update tests. First grep every test that inserts bookings (about 19 files, including `manage`, `guest-saga`, `sweep`, `reminders`, `lab-access`, `reconcile`, `delete-blockers`) and fix any that places two bookings back to back on one testbed. Then change `lib/slots.test.ts`, `server/booking/availability.test.ts`, and `server/db/bookings.test.ts` to the gap rule, and add the AC-8 millisecond test, the AC-10 lead time test, and the saga, reschedule, cancel, and migration scenarios, satisfies **AC-1** to **AC-8**, **AC-10**
6. Scan the learner screens, admin copy, and emails for any change or any "back to back" wording, and confirm the reconciler test still ends access at `ends_at`, satisfies **AC-9**

## Consequences

**Positive**:
- Cleanup automation gets a guaranteed 30 minutes on every testbed between two labs, with no path that can skip it.
- No new tables, settings, or learner text; the change is small and contained.

**Negative / tradeoffs**:
- Capacity drops: a testbed type with one testbed loses a half hour after every lab, and a four hour lab now takes four and a half hours of testbed time.
- The gap is written in two places, held together only by the AC-8 test.
- An early cancel, or moving a Current booking, frees the testbed at once, so the next learner may start soon after a lab that was in use. The owner chose this; the cleanup automation must trigger on those events itself if it needs to.
- Once the worker marks a booking `completed`, the database no longer holds its gap; only the lead time keeps the gap safe (AC-10).
- Changing the gap length later needs a migration.

**Neutral**:
- Migration 0016 adds a constraint check on every booking insert and update, a small cost on a small table. The gist index is replaced by one on the padded expression.

## Migration plan

**Strategy**: one migration, applied by the deploy before the new code starts.
**Phases**:
1. Just before the deploy, the owner runs the pre-check query read only (it is in the migration) to see whether any live pair sits inside a gap.
2. Run `0016` with the deploy (`scripts/deploy.sh` runs `migrate` first, and in `docker/compose.yaml` the `web` and `worker` services wait for it to complete). New code therefore never runs against the old constraint. While `migrate` runs, the old web container may still offer a back to back start, and an insert for it is then refused and mapped to `slot_taken`, a graceful reply.
**Rollback**: re-add the old constraint (`tstzrange(starts_at, ends_at, '[)')`), which cannot fail because it is looser than the new one. Revert the code.
**Risks**: if a live pair sits inside a gap at deploy time (for example a booking made by the old code after the owner's check), the migration stops with an error naming the count, the deploy does not start `web`, and the site stays on the old containers or is down until the owner moves or cancels one booking of each pair and deploys again. That is why the read only check comes first. The drop and re add rebuilds the gist index under a brief exclusive lock; on a small table this is short, and the migration test takes the same lock on the shared development database, so the dev server may stall for a moment.

## Follow-up

- [x] Deploy: the one deploy carried migration 0016, applied to the shared database 2026-10-26; redeployed from main at b9148a5 the same day
- [ ] The cleanup automation should trigger on the cancel and reschedule events as well as on `ends_at`, since an early cancel or a moved Current booking frees the testbed at once (owner side)
- [ ] If a different gap per lab type is ever wanted, revisit Option 4 in a new spec
