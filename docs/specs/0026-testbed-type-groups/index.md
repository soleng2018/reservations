# 0026. Testbed type groups

**Date**: 2026-11-04
**Status**: Accepted

## Summary

Every Testbed Type gets an Authentik group with exactly the type's name, so the LMS can give learners access to that lab guide. The app creates the group when the type is added, renames it when the type is renamed, and deletes it when the type is deleted, but only a group the app made itself. A group the owner already made with the same name is linked and never changed. Each save is all or nothing: if Authentik fails, the type is left as it was. This is a narrow exception to spec 0017's rule that the owner owns every group, and testbed groups stay the owner's.

## Requirements

**User stories**:
- As an admin, I want adding a Testbed Type to create its Authentik group, so that the LMS can grant access to that lab guide without anyone making a group by hand.
- As an admin, I want renaming or deleting a type to rename or delete its group, so that the two never drift apart.
- As the owner, I want the app to change only a group it made itself, and never a testbed group, an admin group, or a group I made, so that this exception cannot hurt anything I manage.
- As the owner, I want a failed Authentik step to leave the type exactly as it was, so that there is no half saved type.
- As the owner, I want a one time backfill that gives every current type its group, so that I don't create them by hand.

**Acceptance criteria**:
- **AC-1** (add creates the group): Adding a type inserts the row, then looks up Authentik groups by the exact type name (case sensitive, trimmed, `includeUsers: false`). If none exists, the app creates one named exactly the type's name, with `isSuperuser: false`, no parents, no roles, and attributes `hol_type_group: true` and `hol_type_id: <the type's id>`. The type row is updated with `authentik_group_pk` and `authentik_group_origin = 'created'`. An `authentik_group.created` audit row (metadata `{ groupPk }`) is written in the same transaction as the row insert and update.
- **AC-2** (a same name group is reused): If a group with exactly that name already exists and is safe to reuse (AC-3), the app links it: `authentik_group_origin = 'reused'`, an `authentik_group.linked` audit row (metadata `{ groupPk }`), and no Authentik write at all. A group the app made earlier whose type save then failed to commit (it carries `hol_type_group` for an id that has no live type) is reused the same way, as `reused`, and is never deleted by the app.
- **AC-3** (an unsafe same name group refuses the save): A same name group is unsafe, and the add is refused with "A group with this name already exists in Authentik and can't be used for a type. Ask the owner." on `name`, nothing saved, when any of these hold: it is the admin group (by uuid or by name, ignoring case, as `isAdminGroup` does); it is a superuser group; it has a parent or a role, or Authentik did not say; it has the key `hol_testbed_group` in its attributes (any value); two groups carry the name. If another live type already holds the group's pk, the add is refused with "Another testbed type already uses the Authentik group with this name." on `name`. The database check runs first; `testbed_types_group_pk_uq` is the backstop.
- **AC-4** (a failed Authentik step changes nothing): If any Authentik call in an add, a rename, or a delete fails (unreachable, timeout, a permission refusal, an unexpected reply), the whole save rolls back and the admin sees "Couldn't reach Authentik, so nothing was saved. Try again in a moment." (delete: "Couldn't reach Authentik, so the type was not deleted. Try again in a moment."). The row, its audit rows, and the name stay as they were. Authentik is called inside the transaction, under the per type advisory lock (AC-19) and never under the type row lock except for the delete's last two calls, and the failure is a `Refusal` so every write rolls back (the lock first pattern). A pure classifier of the reply status decides what counts as a failure: network errors, timeouts, 5xx, and 403 are `unavailable`. A 400 on a group create or rename is not: the app lists groups by the exact name again and runs AC-2 and AC-3 (add) or AC-6 (rename), so a group the owner made a moment earlier gives the right message instead of "Couldn't reach Authentik". A 400 that names the `name` field with no clashing group is `group_bad_name`, shown on `name` as "Authentik doesn't accept this name for a group. Use a shorter or simpler name." (Authentik accepted a 115 character name in the live check, so a 400 on the name is rare, but any such 400 with no clash gets this message and the backfill reports such a type as skipped.)
- **AC-5** (rename renames the app made group): Saving a type with a changed name, where origin is `created`, re-reads the group by pk through the guard (AC-11), then changes its `name` and nothing else, and writes `authentik_group.renamed` (metadata `{ groupPk }`). A save that changes only the duration touches Authentik not at all.
- **AC-6** (a rename into a taken name is refused): If another group (a different pk) already holds the new name in Authentik, the rename is refused with "A group with this name already exists in Authentik. Nothing was saved." on `name`. The app never merges groups and never deletes the other one. The database unique name check (`duplicate_name`) still comes first.
- **AC-7** (rename of a reused or unlinked type): Origin `reused`: the rename saves, no Authentik call is made, the link stays, and the toast says "Saved. The linked Authentik group keeps its old name because the owner made it." Origin and pk both null (not backfilled yet): the rename saves with no Authentik call, and the backfill later gives the type its group under its current name. A reused group keeps its old name, so that old name stays taken: no new type can be named like it while the link lasts (it is refused as `group_in_use`). This is accepted.
- **AC-8** (drift on rename): If the linked app made group is gone (not found), the rename creates a fresh one under the new name, relinks it as `created`, and writes `authentik_group.created`. If it is found, marked for this type, and safe, but its name differs from the type's new name, it is renamed to the new name (this also repairs a rename that timed out yet landed, and makes a rename that only changes letter case a real change). If it exists but no longer carries `hol_type_group: true` with `hol_type_id` equal to this type's id, or is no longer safe (AC-3), the rename is refused with "The Authentik group for this type was changed outside the app. Ask the owner." on `name`, nothing saved.
- **AC-9** (delete removes the app made group): After the blocker check and the soft delete, if origin is `created` and the live group still carries this type's marker and is safe, and no policy binding targets the group and no group lists it as a parent (AC-10), the app counts its members, deletes the group, and writes `authentik_group.deleted` (metadata `{ groupPk, memberCount }`). Members lose that group only; no user is touched. A group that has members is deleted anyway (owner's choice, 2026-11-04).
- **AC-10** (delete leaves other groups alone): Origin `reused`, or both columns null: no Authentik call. Origin `created` but the group is gone: the delete goes on. Origin `created` but the group lost its marker, is no longer safe, has a policy binding pointing at it (the app reads the bindings list, `policiesBindingsList`, and looks for the group; Authentik's own `used_by` answers 500 for the provisioning token, found in the live check 2026-11-05), or is the parent of another group (the retrieved group's `children` is not empty): the type is deleted, the group is left in place, the audit row `testbed_type.deleted` carries `groupLeft: true`, and the toast says "Deleted. Its Authentik group was left in place because it isn't the one the app made, or the owner uses it elsewhere." The reason (`not_ours`, `bound`, `has_children`) goes in the audit metadata. A group with bindings is never destroyed because removing a binding can leave an Authentik app open to every user. An Authentik failure refuses the delete (AC-4).
- **AC-11** (the guard): A new pure check `checkTypeGroupWrite` in `server/authentik/guard.ts`, and `guardTypeGroupWrite`, which re-reads the group from Authentik before every rename and delete. Create is allowed only after AC-3 passes. Rename and delete are allowed only for a group that is not the admin group, not a superuser group, flat, free of `hol_testbed_group`, and carries `hol_type_group: true` with `hol_type_id` equal to the type's id. The delete adds two more reads, bindings and child groups, in `type-groups.ts` before `coreGroupsDestroy`; the PATCH body is built from one constant shape with the key `name` only (never `attributes`, `parents`, `roles`, `isSuperuser`, or `users`), and the scan test rejects a `coreGroupsPartialUpdate` call in that file whose body has any other key. Every refusal logs one `console.warn` with the group pk and reason, never the group's attributes.
- **AC-12** (the scan narrows, it does not go away): Only `server/authentik/type-groups.ts` may name `coreGroupsCreate`, `coreGroupsPartialUpdate`, and `coreGroupsDestroy`. `coreGroupsUpdate` (the full PUT) and the raw path `core/groups` stay forbidden everywhere. `tests/group-writes-scan.test.ts` asserts this, and also that `type-groups.ts` never contains `TESTBED_GROUP_MARKER` as a written attribute, `coreGroupsAddUser`, or `coreGroupsRemoveUser`. In the in memory Authentik, across every flow in this spec, each recorded group write targets a group carrying `hol_type_group`, never a testbed group, never `hol-admins`.
- **AC-13** (type groups stay out of testbeds): A created group has no `hol_testbed_group` attribute, so `listTestbedGroupChoices` never lists it, the reconciler never reads it, and the HOL Labs gate does not pass its members. No learner is added to a type group by this feature: the fake records no `add_user` or `remove_user` from any flow here.
- **AC-14** (backfill): `npm run typegroups:backfill` (`scripts/type-groups-backfill.ts`) is a dry run by default and `-- --apply` writes. It takes every live type with null `authentik_group_pk` and, per type, in its own transaction holding the row lock, runs AC-1 to AC-3. The dry run makes read calls only and prints one line per type: `would create`, `would link`, or `skipped (<reason>)`. Apply writes the same audit rows with `actorUserId: null` (the system actor, as `server/audit.ts` already uses). Each type's transaction takes the per type advisory lock (AC-19), then locks the row `FOR UPDATE` and checks again that its pk is still null before the row is written, so an admin edit made at the same moment is never overwritten. The backfill is a script, so holding the row lock across its Authentik calls is fine; only the advisory lock is required.
- **AC-15** (backfill is safe to rerun): A second run finds no type with a null pk and changes nothing. A type that is skipped (unsafe name, pk already used) is reported and does not stop the others. If Authentik is unreachable the run stops, every finished type stays saved, and the exit code is 1. Skipped types are printed in the report and do not change the exit code (0), so reruns stay quiet.
- **AC-16** (schema): Migration `db/migrations/0020_testbed_type_groups.sql` adds `testbed_types.authentik_group_pk` (uuid, null) and `authentik_group_origin` (text, null), `testbed_types_group_origin_check` (`in ('created','reused')`), `testbed_types_group_pair_check` (both null or both set), and the partial unique index `testbed_types_group_pk_uq` over live rows. `TypeGroupOrigin` is a Zod enum in `lib/db-enums.ts` registered in `checkLists` as `testbed_types.authentik_group_origin`. `testbed_types_group_pk_uq` maps to `group_in_use` in `server/db/constraint-errors.ts`. `server/db/types.ts` is regenerated by `npm run db:codegen`.
- **AC-17** (permission): `PROVISIONING_PERMISSIONS` in `scripts/authentik-setup-plan.ts` gains `authentik_core.change_group` and `authentik_policies.view_policybinding` (read only, for the delete check) and nothing else; its plan test is updated. The change reaches Authentik only when the owner runs `npm run authentik:setup -- --apply`.
- **AC-18** (authorization and audit): The add, edit, delete check, and delete remove actions still call `requireAdmin()` first (spec 0002); the backfill is a command line script, not a route. The new audit actions `authentik_group.linked` and `authentik_group.renamed` are added to `lib/audit-actions.ts`, listed with labels in the audit log screen, and covered by `server/audit-coverage.test.ts`; `authentik_group.created` and `authentik_group.deleted` are reused. No audit row, log line, or error contains a group's attributes or a member's name or email.
- **AC-19** (a type edit never holds up a booking): Rename and delete take a per type advisory lock first (`pg_advisory_xact_lock` over a hash of the type id, one helper in `server/db/`), which keeps two admin edits of the same type apart and blocks no booking. A booking (`lockBookableTestbed`, which takes the type row `FOR SHARE`) can wait on the type row only for the row write itself, never for an Authentik call, with one bounded exception: the delete's guard re-read and destroy (at most two calls, about 20 seconds worst case). The booking code is not changed. Rename order: advisory lock → read the row with no row lock → check the new name is not a live type's name (`duplicate_name`) → Authentik calls (AC-5, AC-6, AC-8) → lock the row `FOR UPDATE`, check the name, pk, and origin are what was read (else `unavailable`, nothing saved) → write the row and audit → commit. Delete order: advisory lock → read pk and origin with no row lock → Authentik reads (retrieve with children, bindings, member count) and the decision (AC-9, AC-10) → `lockForDelete`, blockers, soft delete → guard re-read, then destroy only if the decision was destroy and the guard still passes → audit → commit. A binding added in the seconds between the bindings read and the destroy is not seen; this window is accepted. If the row save fails after a rename landed in Authentik (a duplicate name that appeared in between, or a commit failure), the group keeps the new name and the type the old one, and AC-8 repairs it on the next rename.

## Decision

**Chosen option**: Option 1: marker on the group plus a database origin flag, inside the transaction.

The app makes, renames, and deletes only groups it created, proven by both the stored origin and the live marker, and links same name groups without changing them.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model**:

| Table | Column | Type | Rule |
|---|---|---|---|
| `testbed_types` | `authentik_group_pk` | uuid, null | Null until created, linked, or backfilled. Unique among live rows (`testbed_types_group_pk_uq`). Kept on a soft deleted row. |
| `testbed_types` | `authentik_group_origin` | text, null | `created` or `reused`. Both columns null together or set together. |

On the Authentik group (not in Postgres): `name` equals the type name; attributes `hol_type_group: true`, `hol_type_id: <testbed_types.id>`; not superuser; no parents; no roles; never `hol_testbed_group`.

**Flow, add** (`createTestbedType`, inside `refusable` and one transaction): insert row (duplicate name returns `duplicate_name` as today) → `ensureTypeGroup(api, { typeId, name })` → on success update the row's two columns and audit → commit. `ensureTypeGroup` lists by exact name, applies AC-3, then links (AC-2) or creates (AC-1).

**Flow, rename** (`updateTestbedType`): advisory lock → read the row, no row lock → if the name changed, check `duplicate_name` → by origin: `created` runs AC-5, AC-6, AC-8; `reused` and null do nothing → lock the row `FOR UPDATE`, confirm it is unchanged, write it and audit → commit (full order in AC-19).

**Flow, delete** (`deleteTestbedType`): advisory lock → by origin: `created` reads and decides (AC-9, AC-10); others do nothing → `lockForDelete` → blockers → soft delete → guard re-read and destroy if decided → commit (full order in AC-19).

**API surface** (existing Server Actions keep their names; only their result unions grow):

| Action | New result kinds | Field or place |
|---|---|---|
| `createTestbedTypeAction` | `group_unusable`, `group_in_use`, `group_bad_name`, `unavailable` | message on `name` |
| `updateTestbedTypeAction` | `group_clash`, `group_changed`, `group_bad_name`, `unavailable`; success carries `note: "group_kept"` for AC-7 | message on `name`; toast |
| `deleteTestbedTypeAction` | `unavailable`; success carries `note: "group_left"` for AC-10 | dialog error; toast |
| `checkTestbedTypeDelete` | none | unchanged |

**Value sourcing**:

| Action | Value produced or displayed | Source |
|---|---|---|
| Add | group name | the trimmed `name` from `TestbedTypeInput` |
| Add | `hol_type_id` | the id the insert returns (`testbed_types.id`) |
| Add, rename, delete | the admin group uuid | `adminGroupUuid(api)` in `server/authentik/guard.ts` (cached) |
| Add, rename | the group pk and origin | Authentik's reply (create or list) and the AC-1 or AC-2 branch; stored in the two new columns |
| Rename, delete | which group to act on | `testbed_types.authentik_group_pk`, re-read through the guard |
| Delete | whether a binding or child group blocks the destroy | `policiesBindingsList` (up to five pages of 100, more counts as bound) and the retrieved group's `children`, any match blocks |
| Delete | member count for audit | `coreUsersList({ groupsByPk: [pk], pageSize: 1 })`, its `pagination.count` |
| Audit rows | actor | the signed in admin (`user.id`); `null` for the backfill |
| Toast notes (AC-7, AC-10) | whether to show a note | the branch taken, returned as `note` by the catalog function |
| Backfill | the list of types | `testbed_types` where `deleted_at is null and authentik_group_pk is null` |

**Key invariants**:
- The app never writes a group that is not marked `hol_type_group` for the type in hand, except to create a new one.
- No group the app writes ever carries `hol_testbed_group`, is the admin group, or is a superuser group.
- A type row has a pk exactly when it has an origin.
- Each save is atomic for the admin: an Authentik failure rolls the row back. The one gap is a commit failing after Authentik succeeded; the leftover is always safe (an orphan the next add reuses, a rename that self heals through AC-8, a delete that finds the group gone).

**Order of Authentik calls** (each has the client's 10 second timeout): add: `adminGroupUuid` (cold cache only), list by name, then create or nothing; the new row is not visible to bookings until commit, so no lock matters. Rename: `adminGroupUuid`, retrieve by pk, list by the new name, then PATCH, all before the row lock is taken. Delete: `adminGroupUuid`, retrieve by pk (with children), bindings list (one to five pages), members count, all before the row lock; then, under the row lock, the guard re-read and the destroy. A booking therefore waits at most for the destroy path (about 20 seconds worst case) on a delete, and for a few milliseconds on a rename. The advisory lock is held through all calls, and only another admin edit of the same type waits on it.

**Security model**: Only an admin (`requireAdmin()`) triggers a change; the backfill runs from a shell with the app's provisioning token and no master token (runtime code never reads the master token). The containment is the guard, because Authentik's own permissions cannot scope group writes. The learner is never added to a type group. No secret, member name, or email is logged or audited.

**Configuration required**: none. The owner runs `npm run authentik:setup -- --apply` once to add `authentik_core.change_group` (AC-17).

**Critical test scenarios** (run in `inRollback` with the in memory Authentik from `server/authentik/testing.ts`, which needs a `PATCH /core/groups/<uuid>/` handler and a failure switch added):
- Happy path: add a type, see one `POST` with exact name and both markers, row linked as `created`, audit row present, verifies **AC-1**
- Reuse: a plain same name group is linked as `reused` with zero group writes, verifies **AC-2**
- Unsafe name: admin, superuser, parent, role, `hol_testbed_group`, duplicate names, pk already used each refuse and save nothing, verifies **AC-3**
- Failure: the fake fails the create, the rename, and the destroy in turn; the row, name, and audit rows are unchanged each time, verifies **AC-4**
- Rename: created group renamed once and the duration only edit makes no call; a taken new name is refused; a reused link keeps its name and shows the note; a missing group is recreated; an unmarked one refuses, verifies **AC-5**, **AC-6**, **AC-7**, **AC-8**
- Delete: created group removed with the member count audited; reused, null, gone, and unmarked cases make the right call or none; Authentik down refuses the delete, verifies **AC-9**, **AC-10**
- Guard and scan: pure `checkTypeGroupWrite` table test; the scan passes today's tree and fails on a planted `coreGroupsDestroy` in another file; every recorded write in all flows targets a marked type group, verifies **AC-11**, **AC-12**, **AC-13**
- PATCH body: the fake asserts the body's keys are exactly `["name"]`; a rename that only changes letter case sends a real PATCH; a 400 for an existing name is classified by re-listing, not as `unavailable`, verifies **AC-4**, **AC-5**
- Delete safety: a binding on the group, or a child group, leaves the group in place with the matching audit reason, verifies **AC-10**
- Backfill: dry run writes nothing; apply links or creates per type; second run changes nothing; one skipped type does not stop the rest; Authentik down stops with exit 1, verifies **AC-14**, **AC-15**
- Schema: the parity test for `checkLists`, the pair check, the unique index mapping to `group_in_use`, verifies **AC-16**
- Permission plan: the plan test lists `authentik_core.change_group` once, verifies **AC-17**
- Authorization and audit: each action refuses a learner and an anonymous caller; the audit coverage test sees the two new actions, verifies **AC-18**

## Build plan

Approach: Tracer Bullet (from `AGENTS.md`). The thin thread is the add path through every layer, then rename, delete, and backfill thicken it.

1. [x] Migration `0020_testbed_type_groups.sql`, `npm run db:codegen`, `TypeGroupOrigin` enum and `checkLists` entry, the `testbed_types_group_pk_uq` mapping in `constraint-errors.ts`, and `authentik_core.change_group` in `PROVISIONING_PERMISSIONS` with its plan test, satisfies **AC-16**, **AC-17**
2. [x] In `guard.ts`, the pure `checkTypeGroupWrite` and `guardTypeGroupWrite`; in the fake Authentik, a `PATCH` handler for groups and a failure switch; the scan narrowed as in AC-12 (its new assertions written first, red), satisfies **AC-11**, **AC-12**
3. [x] `server/authentik/type-groups.ts` with `ensureTypeGroup`, then the add path end to end: `createTestbedType` calls it inside the transaction, the new result kinds reach `createTestbedTypeAction` and the add dialog's `name` error, with the audit actions registered, satisfies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-13**, **AC-18**
4. [x] Rename: `renameTypeGroup` in `type-groups.ts`, wired into `updateTestbedType`, its messages, and the toast note, satisfies **AC-5**, **AC-6**, **AC-7**, **AC-8**
5. [x] Delete: `deleteTypeGroup` in `type-groups.ts`, wired into `deleteTestbedType`, its message, and the toast note, satisfies **AC-9**, **AC-10**
6. [x] `scripts/type-groups-backfill.ts`, the `typegroups:backfill` npm script, and its tests, satisfies **AC-14**, **AC-15**
7. [x] Authorization and audit pass: action tests for `requireAdmin()` refusals, audit labels in the audit log screen, `audit-coverage` green, satisfies **AC-18**
8. [x] Live check on the shared Authentik (owner present): apply the permission change, add a throwaway type, rename it, delete it, and run the backfill dry run before `--apply`, satisfies **AC-1**, **AC-5**, **AC-9**, **AC-14**
9. [x] Shrink the lock (AC-19): a per type advisory lock helper beside `lockForDelete`; reorder `updateTestbedType` and `deleteTestbedType` as AC-19 says; the backfill takes the advisory lock; tests with a second connection (`inRollbackNested`) that a booking's `lockBookableTestbed` is not blocked while a rename waits on a slow fake Authentik, and is blocked only for the destroy on a delete; the failed row save after a landed rename heals through AC-8, satisfies **AC-19**, **AC-4**, **AC-14**

## Consequences

**Positive**:
- The LMS gets a group per lab guide with no manual step, and the group follows the type's name.
- The owner's groups and every testbed group stay untouched, proven by a guard, a scan, and a test over every recorded write.
- A failed Authentik step never leaves a half saved type.

**Negative / tradeoffs**:
- The repo now has a second place that writes groups. The scan is narrowed to one file instead of banned everywhere, so a reviewer must keep that file small.
- A type save can take as long as six Authentik calls, with the per type advisory lock held (a second admin edit of that type waits). The row lock is held only for the row write, or on a delete for the guard re-read and destroy.
- A reused group's name can drift from its type's name after a rename; the admin only sees a toast note.
- A group left over after a failed commit is never cleaned up by the app, only reused by a later add.
- A type group the owner wired into the LMS stays in Authentik after its type is deleted, so the owner removes it by hand.
- A rename that lands in Authentik but whose row save then fails leaves the group with the new name and the type with the old one (AC-19); AC-8 repairs it on the next rename.
- A write that times out in Authentik but lands anyway (the row rolled back) leaves drift: a rename is repaired the next time the type is renamed (AC-8); a delete leaves a type with no group until a rename recreates it. A backfill repair mode is deferred (Follow-up).
- The provisioning token gains `change_group` and `view_policybinding`, a broader permission than the app needs, contained only by the guard.

**Neutral**:
- Spec 0017 AC-4 and the `AGENTS.md` rule "Authentik groups are the owner's" need an amendment line pointing here (the first is done with this spec; the second is for `/sync`).
- Deployment order matters (Migration plan).

## Migration plan

**Strategy**: no migration needed for data beyond two nullable columns; types stay valid with null columns until the backfill.
**Phases**:
1. Owner runs `npm run authentik:setup -- --apply` to add `change_group` and `view_policybinding`. Until then a rename or delete on an app made group fails as `unavailable` and nothing is saved.
2. Deploy with `scripts/deploy.sh` (it runs the migration). New types get groups at once; old types stay null and still save, rename, and delete as before, without Authentik.
3. Run `npm run typegroups:backfill`, read the dry run, then `-- --apply`.
**Rollback**: revert the deploy; the columns stay and do no harm. Groups the app made remain in Authentik, marked, and a later redeploy reuses them.
**Risks**: dev and production share one Authentik, so a dev add creates a real group; use throwaway names and delete them. A same name owner group that is unsafe stops that type's backfill, not the rest.

## Follow-up

- [ ] Deferred: a backfill repair mode that checks `created` links (group exists, has the marker, has the right name) and fixes drift after a timed out write.
- [ ] `/sync` should amend the `AGENTS.md` rule "Authentik groups are the owner's (spec 0017)" and the `server/authentik/AGENTS.md` groups line to name this exception, and list `type-groups.ts`.
- [ ] Spec 0017 AC-4 carries an amendment line pointing to this spec (done with this spec).
- [ ] Admins can't see a type's group or origin in the console. If that is wanted, add a read only line to the type edit dialog (not in this spec).
- [ ] The scope row's "Needs `/architect`" note can be cleared once this spec is confirmed.
