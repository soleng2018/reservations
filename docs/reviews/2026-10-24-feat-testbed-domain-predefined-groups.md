# Review, feat/testbed-domain-predefined-groups, 2026-10-24

**Reviewed by**: claude-opus-5-5 (author on unknown, a separate session)
**Scope**: 57 files, branch vs main (merge base 5787ef7)
**Verdict**: Approve with nits

## Summary
The branch implements spec 0017. Testbeds get a required, lower cased, unique Domain. The app stops creating `pod-` groups: it finds an owner made group by exact name, accepts it only when it carries the boolean `hol_testbed_group` marker and is flat (no parent, no role, not a superuser group, not `hol-admins`), and from then on changes only membership. The reconciler now works per distinct group pk, using the union of the live testbeds' learners, and relinks a stale pk by name. The new release step replaces teardown and deletes no group. The guard, the migration, and the create, update, and delete paths are correct and closely follow the spec. The targeted Vitest run passes: 50 files, 939 tests, with DB tests run in rollback. The remaining issues are edge cases in the stale group path, one over broad catch, and context docs that are now stale.

## Minor

### 🟡 Ended learners stay in a renamed group that keeps its marker, `server/worker/reconcile.ts:189-216`, `:117`
**Problem**: When a live testbed's group is renamed (same pk, different name), `relinkStale` either moves the testbed to the newly named group or adds the old pk to `skippedPks`. In both cases nobody reconciles the old pk again, unless a deleted row happens to share it. Tagged learners in it at that moment are never removed, even after their bookings end.
**Why it matters**: `labsAccessExpression` passes any member of any marked group. If the renamed group still carries `hol_testbed_group = true`, those learners keep passing the HOL Labs gate indefinitely. The per VM Cloudflare rule (exact group name) limits the damage, but the gate is meant to follow the booking clock. Spec AC-10 (c) asks for exactly this behavior ("never written to"), so this is a spec level gap, not a deviation from the spec.
**Suggested fix**: Allow removals only (never adds) on a stale pk, since removal is already allowed on any group except `hol-admins`. Or log the tagged member count left behind, so the owner knows to clean up. Record the choice in spec 0017.

### 🟡 Relink with a deleted row on the old pk does write to the renamed group, `server/worker/reconcile.ts:210-215`
**Problem**: After a successful relink, a deleted row that still holds the old pk stays in `resolved` and is reconciled with an empty desired set. That empties the renamed group of tagged learners. Without such a deleted row, the renamed group is left untouched. So the same rename behaves differently depending on unrelated rows, and the test "writes nothing to the renamed group" only covers the case without a deleted row.
**Why it matters**: This is harmless in itself (removals only), but it contradicts the stated invariant and the test name, and it makes the previous finding nondeterministic.
**Suggested fix**: Choose one rule for a stale old pk (see above), apply it whether or not a deleted row exists, and test both shapes.

### 🟡 `unreadableIsUnavailable` turns any `TypeError` into `unavailable`, `server/authentik/groups.ts:99-111`
**Problem**: The wrapper covers the whole of `findTestbedGroup`, including `adminGroupUuid`, `filter`, and `checkGroupWrite`. Any `TypeError`, including a real bug such as reading a property of `undefined`, becomes "Couldn't check the Authentik group, try again." with a generic log line, and the stack is lost.
**Why it matters**: AGENTS.md says to throw for bugs. This hides them behind a retry message.
**Suggested fix**: Narrow the catch to the SDK response parse (the `call` around `coreGroupsList`), or at least log the caught error with its stack.

### 🟡 Nested AGENTS.md files now contradict the code, `server/authentik/AGENTS.md`, `server/worker/AGENTS.md`
**Problem**: They still describe the `pod-*` guard, `hol_testbed_id`, `createPodGroup`, `sweepTestbedCreates`, and `teardown.ts`. The spec's Follow-up hands this to `/sync`, but until then any agent working in these folders is told to enforce rules that no longer exist.
**Suggested fix**: Run `/sync` in the same PR, or before merge.

### 🟡 The "two admins at once" tests are simulated on one connection, `server/catalog/testbeds.test.ts:505-528`
**Problem**: The race is simulated by inserting the competing row on the same transaction between the precheck and the insert. That proves the miss is told apart correctly. It does not exercise a real second connection, where `ON CONFLICT DO NOTHING` waits on an uncommitted insert. The code is correct under READ COMMITTED (the follow up `duplicateOf` reads with a fresh snapshot), but AC-2 names two connections.
**Suggested fix**: Accept this as the limit of `inRollback` on a shared database, and say so in the test comment.

### 🟡 Operational: the old production worker owns the lock until the deploy
**Problem**: Migration 0013 is live on the shared database, but production still runs the pre 0017 worker. Because of the advisory lock, the new reconcile and release code cannot run anywhere until the deploy. Testbeds made in dev or e2e now are handled by the old guard, which refuses every group not named `pod-*`: no learner gets added, and deleted rows stay unstamped and log every tick. Nothing unsafe follows, since the old guard also blocks the old teardown's delete, but verifying spec 0017 against the live worker is not possible before step 5.
**Suggested fix**: Note it in the verify steps or the README runbook, and deploy soon after merge.

## Nits
- ⚪ `components/admin/testbed-edit-dialog.tsx:25`, the comment still says "A ready testbed's dialog". The ready state no longer exists.
- ⚪ `server/catalog/testbeds.ts:286` and `:363`, `domain ?? ""` silently hides a broken `testbeds_domain_live_check` invariant. Throwing, or a comment explaining why `""` is safe, would be clearer.

## Strengths
- The guard is a strict allow list. `isSuperuser`, `parents`, and `roles` that are `undefined` are refused for an add rather than read as "no", the marker must be the boolean `true`, and `hol-admins` is matched by pk and by name ignoring case. Every membership write re-reads the group with `includeUsers: false`.
- `createTestbed` follows AC-2 and AC-3 exactly: database precheck (name, then domain), then the Authentik read outside the transaction, then one transaction. The `ON CONFLICT DO NOTHING` miss is told apart in order (name, domain, group, slug). In `updateTestbed`, the lock comes first and the domain lock runs only on a real change, so an unchanged save writes nothing.
- The migration is safe on the shared database. It locks the table, checks both guards, and only then adds the nullable column, checks scoped to live rows, and partial unique indexes. Kysely's Migrator holds the lock in its transaction.
- Release and reconcile hand off cleanly: the reconciler drains a deleted row, then release stamps it (`shared`, `gone`, or `drained`), each row failing on its own. The union per pk makes a delete and re-add on the same group independent of row order, and tests cover both orders.
- `tests/group-writes-scan.test.ts` includes a self check that the scan catches both the SDK calls and the raw path. The fake's `groupWrites` and `groupReads` make AC-4 and `includeUsers: false` checkable in every test.

## Test coverage
Coverage is strong and matches the spec's critical scenarios:
- **Guard**: each refusal tested on its own.
- **Exact match and duplicate groups**: covered.
- **403, 5xx, unparsable body**: covered.
- **Create order and refusals**: covered.
- **Duplicates and soft delete reuse**: covered.
- **Domain lock**: Current, Upcoming, Past, cancelled, and the error order.
- **Release reasons**: each tested.
- **Reconciler**: marker loss, role, parent, superuser, recreate and relink, rename, no usable group, a taken group, a deleted row's missing group, both row orders, and not found at the fresh read.
- **Migration**: checks and indexes.
- **Gate expression and source scan**: covered.

Gaps: no test for a successful relink when a deleted row shares the old pk, and the concurrency tests use one connection, not two. The targeted suites pass: 50 files, 939 tests.
