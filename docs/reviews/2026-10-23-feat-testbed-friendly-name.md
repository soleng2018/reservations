# Review, feat/testbed-friendly-name, 2026-10-23

**Reviewed by**: claude-opus-5-5 (fresh review context; author on the /develop session)
**Scope**: 30 files, branch vs origin/main (merge base a001fb2)
**Verdict**: Changes requested

## Summary
The branch splits `testbeds.name` into the learner facing Name and a new `group_name` that holds the Authentik group, following spec 0018 Option 1: an additive migration with backfill, a new constraint mapping, group facing code (create lookup, slug, reconciler stale check and relink, audit "access group" labels) moved to `group_name`, an editable Name on update with prechecks in the specified order, and a source scan that keeps `group_name` out of learner code. The code is careful and matches the ACs closely; typecheck, lint, `db:codegen --verify`, and the 40 touched test files (812 tests) all pass. The one major issue is rollout, not code: migration 0014 is already applied to the shared database while production still runs the pre-0018 image, which is the window the spec's migration plan says must not stay open. The rest are test gaps and a stale AGENTS.md rule.

## Major

### 🟠 Migration 0014 is live on the shared DB while production runs the old image, `db/migrations/0014_testbed_group_name.sql:1`
**Problem**: `hol_app.kysely_migration` shows `0014_testbed_group_name` applied at 2026-10-24T06:11Z, and the production containers (`reservations-web-1`, `reservations-worker-1`) run `reservations:sha-9e82391`, created before that and before this branch. Spec 0018's migration plan says the owner runs `db:migrate` and `scripts/deploy.sh` together, because of what can happen in between. Right now: (a) production's create testbed path inserts without `group_name`, so it fails `not null` (an admin facing thrown error); (b) the dev server on this branch lets an admin edit a live testbed's Name, and the old production worker still compares the Authentik group's name to `testbeds.name`. It would mark that testbed stale every tick, fail the relink, and stop adding learners with Current bookings to the group, so they lose lab access with no visible error. Today the only row with `name <> group_name` is a soft deleted, already released e2e testbed (`dev-e2e-fn-61f584`), so nothing is broken yet.
**Why it matters**: One rename of a real testbed from dev, an easy test to run once this lands, silently cuts lab access for learners in production.
**Suggested fix**: Close the window. Merge and run `scripts/deploy.sh` (spec 0017 owner steps first, per the spec) as soon as possible. Until then, do not edit any live testbed's Name from dev, and tell the owner the migration is already applied. Record the actual order of operations in the testbed domain rollout note.

## Minor

### 🟡 The learner surface and rename scenarios in the spec are mostly untested, `server/jobs/jobs.test.ts:235`
**Problem**: The spec's critical scenarios list checks that are not here: the calendar event title, the lab access read, and the availability preview with distinct Name and Group Name; a reminder queued after a rename storing the new name in `details` and the subject; the sent (rendered) email text and subject never containing the group name; and a rename reordering which testbed `bookableTestbedsOfType` assigns first (AC-6 keeps this on purpose). The new jobs test covers only the booked email row and "an unsent row keeps its old name". `makeTestbed` now gives `name` and `group_name` different values, which helps catch a leak by accident, but only where a test asserts on the name.
**Why it matters**: AC-5 and AC-6 are the user facing contract of this feature. The scan test guards against new `group_name` reads, but nothing pins the assignment order behavior or the queue time naming of a reminder.
**Suggested fix**: Add the reminder after rename case and the assignment order case, and add one assertion each to the existing calendar sync and lab access tests that the title or label equals `testbed.name` and does not contain `testbed.group_name`.

### 🟡 Audit search by group name and the migration backfill are not exercised on their own, `server/audit-log.test.ts:494`
**Problem**: The q filter test sets `name: Pod ${tag}` and `group_name: Group ${tag}` and searches by `tag`, which both columns contain. The new `or like("group_name")` branch for a testbed target, and the switch from `name` to `group_name` for an `authentik_group` target, would still pass if they were reverted. There is also no test for the migration's backfill (the spec's "every row ends with name = group_name"). The live database has 1 row out of 22 where they differ, and it comes from a later rename, so the backfill itself looks right.
**Why it matters**: A regression in the audit search for the group name would go unnoticed.
**Suggested fix**: Search with a string only the group name holds, and expect the testbed and `authentik_group` rows to match. Searching for the Name should not match the `authentik_group` row.

### 🟡 The AGENTS.md Authentik rule now names the wrong column, `AGENTS.md:71`
**Problem**: The rule this branch's history adds says "A testbed's name must equal a group that carries the `hol_testbed_group` marker". After this change it is `group_name`. The spec's Follow-up lists this, but unlike the stale spec 0007 and 0017 text, AGENTS.md is the canonical context every agent reads, and it is wrong from the moment this merges.
**Suggested fix**: Change the rule to say `testbeds.group_name`, and name `tests/group-name-scan.test.ts` as its enforcement, in this branch or in the planned `/sync` before merge.

## Nits
- ⚪ `lib/testbeds.ts:314`: "No Authentik group with this group name exists." repeats "group" and differs from spec 0017 AC-3's message; "No Authentik group has this name." reads better. If you change it, update spec 0018 so the two specs agree.
- ⚪ `tests/group-name-scan.test.ts:11`: the allow list differs from AC-5 (adds `server/db/constraint-errors.ts`, which is justified in a comment, and leaves out `lib/audit-log.ts`). Fine, but record the difference in the spec so the two stay in step.
- ⚪ `server/catalog/testbeds.ts:468`: `liveByName` runs on every edit, even when the Name has not changed. It is harmless (it leaves out the row itself), but guarding it with `input.name !== before.name`, as the domain check is guarded, would make the two read alike.

## Strengths
- The update path follows AC-4 exactly: the order is `domain_locked`, then `duplicate_name`, then `duplicate_domain`; the plain reads leave out the row itself, so a rename that changes only case is allowed; the constraint mapping stays as the race fallback; and `TestbedUpdateInput` omits `groupName`, so a forged field is dropped (tested at the parse and action levels).
- Renaming `GroupRow.name` to `groupName` makes the compiler find every group facing read. The stored `group_name` comes from the found group (`group.value.name`), not the typed text, and the create checks run in order (name, group name, domain) with Authentik down, plus an insert race test.
- The migration is the safe shape: additive, `set local lock_timeout` (it does take effect, because Kysely's Migrator wraps each run in a transaction), backfill before `not null`, and a partial unique index. `db:codegen --verify` passes.

## Test coverage
Covered: parsing (empty and forged fields), the create duplicate order with Authentik down, the race on the group name unique index, the trim check and unique index in the DB, rename with Upcoming and Current bookings (no Authentik call, no job, `changedFields` holds `name`), duplicate and case only rename, action field mapping onto `groupName`, list search text, the audit target label `Name (group GroupName)` and the access group label, the reconciler fixtures moved to `group_name` (with `makeTestbed` now giving different values, so a stray `name` read would fail them), and the source scan. Not covered: the calendar, lab access, and availability surfaces with distinct names; a reminder after a rename; the change to assignment order; a group name only audit search; and the migration backfill (see Minor).
