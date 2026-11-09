# Review, feat/type-group-membership, 2026-11-09

**Reviewed by**: claude-opus-5-5 (fresh review context; author model not stated)
**Scope**: 9 files, branch vs main (merge base 3310cd5)
**Verdict**: Changes requested

## Summary
The change adds a second pass to `reconcileAccess` that keeps each live Testbed Type's Authentik group in step with Current bookings of that type. It reuses `reconcileGroup` and adds the guard purpose `add_type`. The add side is sound: the guard re-reads the group and refuses the admin group (by pk or name), superuser, parent, role, unknown, and any group with the `hol_testbed_group` key. Only tagged learners can be written, and the testbed path behaves as before. The main gap is the removal side. A type pass removal needs only "not the admin group", so a type group pk that is also a testbed's group strips Current learners out of that testbed group on every tick. A few smaller edges and test gaps follow.

## Major

### 🟠 A type pass removal can strip testbed access when a type group is also a testbed group, `server/worker/reconcile.ts:403` (with `server/authentik/groups.ts:102`)
**Problem**: In the type pass, the desired set is the learners with a Current booking of *that type*. A removal goes through `removeFromTestbedGroup` with purpose `remove`, which `checkGroupWrite` allows on any group except the admin one. Spec 0026 AC-3 stops a marked group from being linked to a type when the link is made. Nothing stops the owner from adding `hol_testbed_group: true` to the group later, and then a testbed can take the same pk through `findTestbedGroup` or a relink. Nothing in the DB ties `testbeds.authentik_group_pk` to `testbed_types.authentik_group_pk`. When the pks match, each run goes like this. The testbed pass adds learner L, who has a Current booking on testbed X. The type pass for type B, which X is not, then sees L as a tagged member who is not desired and removes L. That removal skips sessions and Cloudflare, so the HOL Labs gate refuses L until the next tick re-adds them. Every tick then writes a pair of `access.granted` and `access.revoked` rows. The second new test ("never writes a type group that is a testbed group") has no member in the marked type group, so it never reaches this path.
**Why it matters**: A learner loses lab access in the middle of a Current booking on the shared production Authentik, and the audit log fills with noise. The brief names this exact case, a type group pk shared with a testbed group pk.
**Suggested fix**: In the type pass, before any write, skip the group (one log line per type) when the read group carries the `hol_testbed_group` key, or when its pk equals any testbed row's pk from `unreleasedTestbeds`. Do the same check again on removal, through a `remove_type` guard purpose that refuses marked groups. Add a test where a marked type group already holds a Current learner of another testbed, and assert that no `remove_user` is recorded.

## Minor

### 🟡 Members can be left behind in a group the type pass no longer visits, `server/worker/reconcile.ts:153`
**Problem**: The query keeps only `deleted_at is null` types that have a pk. A soft deleted type with a `reused` group, or a `created` group left in place (`bound`, `has_children`, `not_ours`), is never visited again. If a learner is still a member when the type is deleted, they stay a member for good. That can happen when the last booking ended in the same tick window, or after a failed removal. The testbed path handles the same case with the deleted row plus release stamping. Nothing does that here.
**Why it matters**: The learner keeps lasting LMS access to that lab guide. The impact is low, but it breaks the line "access ends with the booking".
**Suggested fix**: Keep visiting deleted types with a non null pk and treat them as having no desired members. Removal only, never add. Or record in the spec that this case is accepted.

### 🟡 Learners the owner added by hand to a reused group are removed on the first run, `server/worker/reconcile.ts:367`
**Problem**: The spec says the owner has been adding learners to type groups by hand. On its first run after deploy, the reconciler removes every `hol_learner` tagged member with no Current booking of the type. This matches AC-1, but it is a behaviour change on production.
**Why it matters**: A learner who still uses the LMS after their booking has ended loses access with no warning.
**Suggested fix**: Add a rollout note: tell the owner before deploying, or do a dry run listing the members it would remove.

### 🟡 Type pass logs say "testbed", `server/worker/reconcile.ts:356` and `:363`
**Problem**: When `reconcileGroup` cannot read the group or its members, it logs `reconciler: testbed <typeId> ...` for both kinds. A type group the owner deleted in Authentik (`not_found`) logs this mislabelled line on every tick. AC-5 asks for logs per type and kind.
**Suggested fix**: Use `kind` in those two messages, as `logFailures` already does.

### 🟡 AC-4 (no sessions ended, no Cloudflare call on a type removal) is untested, `server/worker/reconcile.test.ts:1004`
**Problem**: Both new tests run with `OFF`, so a type removal that called `revoke` or `endAuthentikSessions` would still pass. The tests also leave these unchecked: the audit rows (`kind: "type"`, `typeId`), the skip for a type with no pk or a soft deleted type (AC-2), and a learner whose testbed's type changed.
**Suggested fix**: Add a test with an `on` revoke stub and a removal from a type group only. Assert that the stub is not called, that the fake records no session delete for that pk, and what the audit row contains.

## Nits
- ⚪ `server/authentik/guard.ts:86`, `isUsableTypeGroup` repeats the `safe` expression in `checkTypeGroupWrite`. Pull out one `isSafeTypeGroup` so spec 0026 AC-3 and spec 0028 AC-3 cannot drift apart.
- ⚪ `server/authentik/guard.ts:87`, the `isAdminGroup` check inside `isUsableTypeGroup` repeats the one at line 99.
- ⚪ `server/authentik/groups.ts:86`, `addToTestbedGroup` now also adds to type groups. A neutral name such as `addToGroup` would read better.
- ⚪ `server/worker/reconcile.ts:392`, testbed `access.granted` rows now carry `kind`, but testbed `access.revoked` rows do not. Add `kind: "testbed"` there too.
- ⚪ `server/worker/reconcile.ts:150`, `revoke` is passed to the type pass but never used there.

## Strengths
- The add guard is strict. It refuses admin by pk and by name, superuser, unknown superuser, parents, roles, and the testbed marker key whatever its value. It also re-reads the group before every add, and `guard.test.ts` lists each refusal case.
- The testbed path is unchanged by the refactor: `desired` is built the same way from live row ids before it is passed in. A learner with overlapping bookings is handled by the pk `Set` in `membershipDiff`, and the type comes from the testbed at read time, so a type change moves the learner on the next tick. Untagged members are left alone (the test covers this with `TP + 4`).

## Test coverage
Covered: add for a Current learner, no add for an upcoming one, removal for one whose booking ended, untagged member kept, no group create/update/delete, and a marked type group refused for adds. Each `add_type` guard refusal has a unit test.
Not covered: removal from a type group that is also a testbed group (the Major), AC-4 (no session end or revoke), audit row contents, AC-2 skips (no pk, soft deleted type), the failure log for a type group read error.
