# Review, feat/testbed-type-groups, 2026-11-04

**Reviewed by**: claude-opus-5-5 (fresh review agent; author on the main session model)
**Scope**: 34 files, feat/testbed-type-groups vs main (merge base 2fcdca7)
**Verdict**: Changes requested

## Summary
The branch gives each Testbed Type its own Authentik group (spec 0026). It adds a migration with a pair check and a partial unique index, a pure `checkTypeGroupWrite` guard, the one write file `server/authentik/type-groups.ts`, wiring inside the existing `refusable` transactions for add, rename, and delete, a locked per type backfill, and a narrowed scan test. The safety design is sound. A group is changed only when the DB origin is `created` and a fresh re-read shows the marker for this type id. The guard fails closed when Authentik leaves out `isSuperuser`, `parents`, or `roles`. Bound groups and groups with children are left in place. No audit row or log line carries attributes or member data. The main gap is that the binding scan's pagination is untested. That loop is the only thing stopping the app from destroying a bound group. Two smaller safety edges fail open where the rest of the guard fails closed. No blockers.

## Major

### 🟠 Binding scan pagination is untested, `server/authentik/type-groups.ts:222`
**Problem**: `groupHasBinding` walks up to five pages of `policiesBindingsList` and treats more than five pages as bound. Every test seeds at most one binding (`usedBy: ["g1"]`), so only page 1 is ever exercised. No test covers a binding on page 2 or later, the `next === 0` stop, or the cap at five pages counting as bound.
**Why it matters**: AC-10 makes this the control that stops the app from destroying a group that a policy binding targets. Destroying such a group can leave an Authentik app open to every user. A regression in the recursion would not fail any test. Examples: an off by one on `page >= BINDING_MAX_PAGES`, a misread of `pagination.next`, or the recursion dropping results. This is branching, security relevant logic, so the guide rates the gap Major.
**Suggested fix**: The fake's `page()` helper already paginates by `page_size`. Add `deleteTypeGroup` tests that seed 101 or more bindings with the target's binding on page 2 (expect `left/bound`). Seed 501 or more unrelated bindings (expect `left/bound` from the cap and no DELETE). Seed exactly 100 unrelated bindings (expect `deleted`).

## Minor

### 🟡 Missing `children` reads as "no children" (fails open), `server/authentik/type-groups.ts:238`
**Problem**: `hasChildren` uses `g.children ?? []`. If Authentik leaves `children` out (a version change, or `include_children` ignored), the group counts as childless and is destroyed. The same guard treats a missing `parents` or `roles` as unsafe.
**Why it matters**: The guard is inconsistent. A future Authentik upgrade could silently remove the child check.
**Suggested fix**: Treat `children === undefined` as `has_children` (leave the group in place), as `checkTypeGroupWrite` does for parents and roles.

### 🟡 The binding check trusts that the list is complete, `server/authentik/type-groups.ts:227`
**Problem**: An empty or partial bindings list reads as "not bound". If the token loses `view_policybinding`, or holds only object level view on some bindings, the list may come back filtered rather than with a 403, depending on Authentik's `ObjectFilter` behavior for the token's user type. The app would then destroy a bound group. Phase 1 of the migration plan, `authentik:setup --apply` before deploy, is the only thing that ensures the permission.
**Why it matters**: This is the same safety control as above, and it depends on configuration outside the code.
**Suggested fix**: Add a cheap sanity check. A real Authentik always has bindings, so treat a page 1 count of 0 as `unavailable`, or as `bound`. Otherwise, document the dependency in `server/authentik/AGENTS.md`.

### 🟡 No `lock_timeout` while Authentik calls hold the type row lock, `server/catalog/testbed-types.ts:171`, `:279`
**Problem**: The spec says "a waiting writer uses a `lock_timeout` and sees `unavailable`", but nothing sets one. Rename holds `FOR UPDATE` across up to 4 calls. Delete holds it across up to 9: admin lookup, retrieve, 5 binding pages, the member count, and destroy, each with a 10 s budget. Meanwhile `server/db/bookings.ts:78` takes the type `FOR SHARE` for every booking on any testbed of that type.
**Why it matters**: When Authentik is slow, learner bookings for that type stall for tens of seconds up to about a minute and a half, with no clean error.
**Suggested fix**: Either `set local lock_timeout` in the booking path's type lock and map 55P03 to a retryable message, or correct the spec text. The spec also undercounts the delete at "six calls".

### 🟡 TOCTOU between the delete checks and the destroy, `server/authentik/type-groups.ts:251-284`
**Problem**: The guard, children, and binding checks run on one read, and the destroy follows several seconds and up to 7 calls later. A binding or child added in that window is cascaded away by the destroy. Rename has the same gap, but its PATCH body is only `{ name }`, so the harm there is small.
**Why it matters**: The window is narrow, but it sits on the one irreversible write. Authentik offers no conditional delete, so this can only be narrowed, not closed.
**Suggested fix**: Re-read the group (with children) and run the binding page 1 check immediately before `coreGroupsDestroy`, and run the member count earlier. Or accept the window in the spec's tradeoffs.

### 🟡 Rename's recreate path skips the AC-4 re-list on a 400, `server/authentik/type-groups.ts:171`
**Problem**: When the group is gone and the create returns 400, the code returns `name_invalid` without listing by name again. AC-4 says a 400 on create re-lists and runs the clash check. The second PATCH failure branch (lines 197-201) also maps a 404 (group vanished between retrieve and PATCH) to `name_invalid`.
**Why it matters**: Only in a race, and then the admin sees "Authentik doesn't accept this name" when the real answer is a clash or a vanished group. Nothing unsafe is written.
**Suggested fix**: On `rejected`, call `taken()` and return `name_taken` on a clash. On a PATCH `not_found`, return `unavailable` (or recreate).

### 🟡 Refusal logs leave out the reason, `server/authentik/type-groups.ts:86`, `:181`, `:267`
**Problem**: AC-11 says every refusal logs one `console.warn` with the group pk and the reason. The warns carry the pk only, and the `has_children` and `bound` cases (lines 270-275) log nothing.
**Suggested fix**: Add `allowed.error` (`unsafe_group` or `not_ours`) and log the left reasons.

### 🟡 Gaps in action level and cross flow coverage, `app/admin/actions.test.ts:284`
**Problem**: Only the create action's `unavailable` mapping is tested at the action level. Not covered: the update action's `group_clash`, `group_changed`, and `group_bad_name` messages, the `group_kept` toast text, and the delete action's `unavailable` message and `group_left` note. AC-12's "across every flow, each recorded group write targets a group carrying `hol_type_group`" has no single assertion over all flows. The backfill's `group_in_use` and `already_done` skip branches are also untested.
**Suggested fix**: Add one action test per new message or note. Add an all flows check over the fake's `writes` and `groups`. Add backfill cases for a pk held by another live type and for a row linked between the list and the lock.

## Nits
- ⚪ `server/authentik/type-groups.ts:285`: when the destroy answers 404 (someone else deleted the group), the code still reports `deleted`, and an `authentik_group.deleted` audit row records a member count. `gone` would be more accurate.
- ⚪ `server/catalog/type-groups-backfill.ts:83`: the report uses the listed `t.name`, but the group is made under the locked `row.name`. After a concurrent rename the line shows the old name.
- ⚪ `server/catalog/type-groups-backfill.ts:116`: a `testbed_types_group_pk_uq` violation (a race past `holder`) throws out of `applyOne` and crashes the run with exit 1. Mapping it to `skipped (group_in_use)` would match AC-15.
- ⚪ `AGENTS.md` (Rules, "Authentik groups are the owner's") and `server/authentik/AGENTS.md:10` ("The app never creates, renames, or deletes a group") now contradict the code. This is tracked as a `/sync` follow-up, but it should land with the merge.
- ⚪ `server/authentik/type-groups.ts:96-107` and `:159-170`: the create request body is duplicated. One `createBody(typeId, name)` constant shape, like `renameBody`, would keep the two in step and let the scan pin it.

## Strengths
- The guard fails closed when Authentik leaves fields out (`parents?.length === 0`, `isSuperuser === false`), and a group with the `hol_testbed_group` key is refused whatever its value. Changes require both the DB origin `created` and the live `hol_type_id` to equal the type's id.
- The `PATCH` body is a single constant shape (`renameBody`) pinned by the source scan. The fake records `writeBodies`, so tests check that the body is exactly `["name"]`.
- Rollback semantics are right. Every Authentik step runs inside `refusable` after the row lock. Writes are never retried (`withTimeoutAndRetry`), so a timed out create cannot double fire. The commit failure leftovers (orphan, drift, gone) all resolve safely through AC-2, AC-8, and the `gone` branch.
- The `policiesApi` fix that carries the client on the core client under `Symbol.for` is correct for the globalThis cached client. It has a regression test for a client made by another copy of the module.
- Backfill locking matches AC-14: one transaction per type, `FOR UPDATE`, the pk checked again under the lock, a system actor, a dry run that only reads, and an outage that stops the run with exit 1.
- The audit metadata holds only `groupPk`, `memberCount`, `groupLeft`, and `reason`. Logs hold only the call label, the status, and the pk. No attributes, names, or emails appear.

## Test coverage
Coverage is good for the core flows. It includes the pure guard table, `classifyStatus`, the create, link, reuse orphan, 400 race, bad name, and outage paths of `ensureTypeGroup`, and rename (body shape, a letter case only change, no op, clash, unmarked, recreate, outage). Delete covers deleted with a member count, bound, children, not ours, gone, outage, and the testbed and admin groups. The catalog level AC-1 to AC-10 cases run in `inRollback`, and the backfill covers dry run, apply, rerun, and outage. Still untested: binding pagination (Major above), a missing `children` field, the update and delete action level messages and notes, the backfill's `group_in_use` and `already_done` branches, and an all flows AC-12 write assertion.
