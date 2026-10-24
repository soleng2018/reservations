# Review, feat/testbed-friendly-name, 2026-10-24

**Reviewed by**: claude-opus-5-5 (fresh review context; author on claude-sonnet-5-5 per commit trailers)
**Scope**: 37 files, branch vs origin/main (merge base a001fb2), committed plus uncommitted test and scope changes
**Verdict**: Changes requested

## Summary
The branch splits `testbeds.name` into the learner facing Name and a new `group_name` for the Authentik group (spec 0018 Option 1). The code is correct and closely follows the ACs. The fixes from the 2026-10-23 review held: the AGENTS.md rule now names `group_name` and the scan test; the audit search has a test that only the group name can match; the update skips the name check when the Name is unchanged; the update error order is tested; and the learner surface tests (calendar title, lab access, availability preview, reminder after a rename, assignment order) are now written. Typecheck, Prettier, and 1228 related Vitest tests pass, with the DB tests running. The remaining Major is the rollout risk the last review warned about, and it has now happened. On the shared database, two live testbeds have a Name that differs from their group name, and the production worker (old image `sha-9e82391`) logs them as stale every tick. One of them has 2 live bookings. Only e2e throwaway testbeds are affected so far.

## Major

### 🟠 The old production worker now skips renamed testbeds every tick, `db/migrations/0014_testbed_group_name.sql:1`
**Problem**: Migration 0014 was applied at 2026-10-24T06:11Z, and `reservations-web-1` and `reservations-worker-1` still run `reservations:sha-9e82391`. Two live testbeds have `name <> group_name`: `9dae032c…` ("Bench 65a72e81", group `dev-e2e-bench-65a72e81`) and `e1b27d92…` ("Bench 77998529 renamed", group `dev-e2e-bench-77998529`, renamed at 14:03Z, 2 confirmed bookings that have not ended). The production worker logs `reconciler: testbed … is stale and no usable group has the testbed's name (not_found), skipped` for both, every tick. That is the failure the spec's Risks paragraph describes: the old worker looks the group up by `name`, fails, and never adds those bookings' learners to the group. Both rows come from the e2e booking spec or manual verify runs on this branch, and the bench rename broke the spec's rule "Do not edit a live testbed's Name … until the new worker is running".
**Why it matters**: Today only e2e learners are hit. But the scope now marks Verify done, and the next natural steps are to merge and to try a rename on a real testbed. Any rename of a real testbed before `scripts/deploy.sh` runs cuts lab access for its Current learners, and the only sign is a log line.
**Suggested fix**: Close the window: run the spec 0017 owner steps and then `scripts/deploy.sh` as soon as the branch merges, and check the worker log after the deploy. Until then, soft delete the two stray e2e testbeds (cancel their bookings first) or set their Name back to their group name, so the production log is clean and a real stale warning stands out. Record in the testbed domain rollout note that 0014 is applied and that renames are not safe yet. Do not run `e2e/booking.spec.ts` or any rename verify against the shared DB before the deploy.

## Minor

### 🟡 The README's testbed runbook still says Name is the group name, `README.md:310`
**Problem**: "Adding a testbed" says "**Name:** exactly the name of the group … The name cannot change later". Line 315 quotes the old message "No Authentik group with this name exists." under the Name field (it is now under Group Name, and the text changed). Step 6 at line 328 and the troubleshooting row at line 454 ("a marked group with exactly the testbed's name") also describe the old model. The owner follows this section during the one deploy that carries both 0013 and 0014.
**Why it matters**: An owner who follows the runbook could type the group name into Name, or misread a stale warning. The form's hints help, but the README is the operations guide.
**Suggested fix**: Describe the two fields: Name is free text that learners see and can be edited; Group Name is the exact Authentik group and is read only after create. Update the quoted messages, step 6, and the troubleshooting row so they say group name. Add a line that migration 0014 is part of the same deploy.

### 🟡 The booking e2e spec leaves a live testbed with a renamed Name on the shared DB, `e2e/booking.spec.ts:41`
**Problem**: The spec creates a live testbed (`Bench <id>` on group `dev-e2e-bench-<id>`) and never deletes it. This was already true before (four `dev-e2e-bench-*` testbeds are live now), but each run now leaves a row whose Name differs from its group name. That row is what the old production worker trips on, see the Major above.
**Why it matters**: Live test rows accumulate in production data, and every run before the deploy adds one more stale testbed to the production log.
**Suggested fix**: Add an `afterAll` that cancels the spec's bookings and deletes its testbed and type, as `e2e/testbeds.spec.ts` does with `deleteRow`. If cleanup is not possible while bookings exist, record why in a comment.

## Nits
- ⚪ `server/booking/availability.test.ts:145`: `expect(JSON.stringify(a)).toContain(a.group_name)` always passes. It is meant to show that the fixture's names differ, so `expect(a.name).not.toBe(a.group_name)` says that directly, as `lab-access.test.ts` does.
- ⚪ The learner surface tests, the e2e updates, and the scope ticks are uncommitted. Commit them with the branch, because they close most of the prior review's coverage finding.
- ⚪ `db/migrations/0014_testbed_group_name.sql`: the backfill still has no test (carried over). The live data shows it is correct (every row from before 06:11Z has `name = group_name`), and the migration is already applied, so a test now would add little. Fine to drop.
- ⚪ `app/admin/actions.ts:895`: the header comment still cites "spec 0017 AC-5, AC-6" only. Add spec 0018 AC-4, since that is what now governs the Name edit.
- ⚪ `docs/specs/0018-testbed-friendly-name.md`: the status is still "In Progress", and the Follow-up items for AGENTS.md (lines 189 and 192) are done in this branch but not ticked. Leave them for `/sync` if you prefer.

## Strengths
- The migration is the safe shape for a shared database: additive, `set local lock_timeout`, backfill before `not null`, a partial unique index whose name matches the new `mapConstraintError` entry. The live schema matches it (`testbeds_group_name_lower_uq` is present and every pre-existing row is backfilled).
- The learner boundary is enforced, not just followed. Every learner read still selects `t.name`; the scan test fails on any `group_name` or `groupName` outside the allow list. Renaming `GroupRow.name` to `groupName` forces every group facing read through the compiler. Cloudflare, `release.ts`, the guard, and `findTestbedGroup` are unchanged, and the stored `group_name` comes from the found group.
- The update path is in the specified order (`domain_locked`, then `duplicate_name`, then `duplicate_domain`). The name check is skipped when the Name is unchanged, and the constraint mapping is the fallback for a race. The forged `groupName` is dropped at parse time. `changedFields` lists `name` and leaves out `groupName`. A rename makes no Authentik call and queues no job.

## Test coverage
Covered: parsing, the create duplicate order with Authentik down, insert races on both unique indexes, a rename while Upcoming and Current bookings exist, the update error order, a case only rename, the action field mapping, list search, audit labels, `testbed.created` metadata, and the audit search by group name only (new in 0dc1244). The reconciler fixtures now give distinct names. The scan test is in place. The new uncommitted tests cover the calendar title, the lab access read, and the availability preview with distinct names, a reminder queued after a rename storing the new Name, and the assignment order following the Name (AC-5, AC-6). Still not covered: the migration backfill (see Nits; the live data shows it is correct) and rendering a sent email's text against the group name (the stored `details` and subject are covered, and the templates read only `details.testbedName`).
