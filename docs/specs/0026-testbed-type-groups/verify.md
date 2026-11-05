# Verify: testbed type groups · spec 0026 · updated 2026-11-04
_Steps derived from spec 0026 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones. Steps that touch the shared Authentik need the owner present, and use a throwaway type name._

## UI / manual
- [x] Add a Testbed Type named `ZZ verify <date>` → saved; Authentik has a group with exactly that name, attributes `hol_type_group` and `hol_type_id`, and no `hol_testbed_group` → AC-1, AC-13
- [x] In Authentik make a plain group `ZZ reuse <date>`, then add a type with that name → saved, no change to the group, no write in the audit log except `authentik_group.linked` → AC-2
- [x] Add a type named like a testbed group, or `hol-admins` → refused on the name field with "can't be used for a type", nothing saved → AC-3
- [ ] Block Authentik (wrong token or network) and add a type → "Couldn't reach Authentik, so nothing was saved", and the type is not in the list → AC-4
- [x] Rename the verify type → the group's name follows; edit only its duration → no Authentik write → AC-5
- [x] Rename it to the name of another existing group → refused with "A group with this name already exists in Authentik", name unchanged → AC-6
- [x] Rename the reused type → saved, toast says the group keeps its old name, the owner's group is unchanged → AC-7
- [x] Remove the marker from the verify type's group in Authentik, then rename → refused with "changed outside the app" → AC-8
- [x] Delete the verify type (with one member added to its group) → type and group gone, the member's user still exists, audit shows `authentik_group.deleted` with `memberCount: 1` → AC-9
- [ ] Bind the verify group to an Authentik policy, then delete the type → type deleted, group left, toast says it was left in place, audit shows `reason: bound` → AC-10
- [x] Open the add testbed dialog → no type group is listed among the groups → AC-13
- [x] Read the audit log screen → the linked and renamed rows have labels → AC-18

## Commands
- [x] `npm test` → all green, including `tests/group-writes-scan.test.ts` → AC-11, AC-12
- [x] `npm run db:codegen -- --verify` → up to date → AC-16
- [x] `npm run typegroups:backfill` → a dry run: lists `would create` or `would link` per type, writes nothing → AC-14
- [ ] `npm run typegroups:backfill -- --apply` (owner present) → every live type has a group; run again → nothing to do → AC-14, AC-15
- [ ] `npm run authentik:setup` (dry run) → shows `authentik_core.change_group` and `authentik_policies.view_policybinding` to add; `-- --apply` after the owner approves → AC-17

## Acceptance-criteria coverage
- AC-1 · AC-13 first manual step · AC-2 · AC-3 · AC-4 (two steps) · AC-5 · AC-6 · AC-7 · AC-8 · AC-9 · AC-10 · AC-11, AC-12 `npm test` · AC-14, AC-15 backfill · AC-16 codegen · AC-17 setup · AC-18 audit log
- [ ] While a rename waits on a slow Authentik, book that type in another tab → the booking goes through without waiting → AC-19
