# Review, feat/admin-testbeds, 2026-10-10

**Reviewed by**: Sonnet 5.5 (author on a different model)
**Scope**: 36 files, branch vs main
**Verdict**: Approve with nits

## Summary
Feature 9 adds the full admin Testbeds screen (list, add, edit, delete), plain text client OS logins, IDP keys, and a worker step that tears down a deleted testbed's `pod-*` group. The change follows spec 0007 closely. I found no blockers or majors in the four high-stakes areas: OS password exposure, Authentik create and teardown failure paths, edit and delete concurrency, and blocker phase labels. The findings below are minor.

## Minor
### 🟡 Teardown reads the group twice per row, `server/worker/teardown.ts:58`
**Problem**: `teardownGroup` calls `guardGroupWrite` to tell "already gone" from a failure, then `deletePodGroup` rereads the same group through the same guard. The spec's order was members first, then `deletePodGroup`. The code is arguably better, because a missing group gives a 400 on the member list, but the cost is one extra Authentik GET per pending row per tick.
**Why it matters**: Low. A handful of rows, 30s ticks, and a row stays pending only while a learner is still in the group.
**Suggested fix**: Optional. Keep the pre-read, and note the deviation from the spec order in the spec or a comment. Alternatively, accept the double read and move on.

### 🟡 Blocker phase and filter use transaction start time, `server/db/delete-blockers.ts:83`
**Problem**: `dbNow(trx)` and SQL `now()` both return the transaction start. In `deleteTestbed` the transaction starts before `lockForDelete`, which can wait on a booking's `FOR SHARE`. After a long wait, a booking that has just ended still blocks, and a phase label can be a few seconds stale.
**Why it matters**: The error is conservative, so a delete is refused when it could have gone ahead. The two clocks agree with each other, so there is no inconsistency. Real impact is negligible.
**Suggested fix**: Optional. Document that the clock is the transaction start, or read `clock_timestamp()` after the lock if exact timing ever matters.

## Nits
- ⚪ `server/worker/teardown.ts:23`, returns `Promise<number>` where the spec table says `Promise<void>`. The worker AGENTS.md already documents the count, so update the spec table.
- ⚪ `server/catalog/testbeds.ts:457`, `deleteTestbed` returns `not_found` for a testbed that is already soft deleted. The action reports "no longer exists", which is right.
- ⚪ `components/admin/testbed-edit-dialog.tsx`, the `failed` load state has no retry button. Closing and reopening the dialog works.

## Strengths
- OS credentials are tightly contained. The list payload carries only a count. `os_password` appears in one app file, enforced by a scan test. Audit metadata holds counts and field names only. Zod messages are fixed strings. The dialog drops the loaded defaults on close.
- The lock discipline is sound. Edit and delete take `FOR UPDATE`, and type and IDP checks take `FOR SHARE`. Delete re-checks blockers under the lock.
- The create saga is hardened against a mid-saga delete (the pk store requires `deleted_at is null`, followed by the undo).
- Teardown is idempotent and safe to retry:
  - The group is deleted before the row is stamped, so a failed stamp becomes `already_gone` on the next tick.
  - The stamp is guarded by `authentik_group_deleted_at is null`.
  - A failing row does not stop the others.
  - Tagged learners, foreign `hol_testbed_id`, and non-pod groups leave the row unstamped.
- Migration constraint names follow the repo contract.

## Test coverage
Broad: pure edit-change logic, catalog DB tests (IDP race, create vs delete, update edge cases, audit contents, blocker labels), teardown with the fake Authentik (skip, 404, not_owned, one failing row), schema checks, the action auth tests, the `os_password` scan, and a Playwright flow. I did not execute the suite. No untested branching logic stood out.
