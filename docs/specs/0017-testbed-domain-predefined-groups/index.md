# 0017. Testbed domain and predefined groups

**Date**: 2026-10-23
**Status**: In Progress

## Summary

Every testbed gets a mandatory Domain, one per Nile tenant, and the app stops making Authentik groups. An admin names the testbed exactly like a group the owner already made in Authentik, and the app refuses the testbed if that group does not exist or is not marked for testbeds. The app then only adds and removes learners in that group, and the HOL Labs gate trusts the same marker instead of the old `pod-` names. This replaces the app made `pod-<slug>` groups of specs 0003, 0004, and 0007, and it prepares feature 20 (a learner's Nile login per domain), which is a separate spec.

## Requirements

**User stories**:
- As an admin, I want to give each testbed the domain of its Nile tenant, so that learners booked on it can later sign in to that tenant (feature 20).
- As an admin, I want to point a testbed at an Authentik group that already exists by typing its name, so that the owner's own script stays the one place groups are made.
- As the owner, I want the app to add and remove learners only in groups I marked for testbeds, so that a typo or a wrong name can never put a learner in an admin group.

**Acceptance criteria**:
- **AC-1**: The add and edit forms have a required Domain field (label "Domain", placeholder `nile.global`). The server parses it with Zod: trimmed, lower cased, then checked against one pattern (`DOMAIN_PATTERN`): two or more dot separated labels, each 1 to 63 letters, digits, or inner hyphens, with a last label of 2 to 63 letters, and 253 characters at most. An empty value gives "Enter the domain."; a bad shape gives "Enter a domain name, like nile.global." Both are field errors on `domain`. `NileWorkshop-1.COM` is stored as `nileworkshop-1.com`. `nile`, `a..b.com`, `-a.com`, `a_b.com`, `nile.global.` (trailing dot), `nile.c0m`, and a value over 253 characters are refused. The database check (`testbeds_domain_format_check`) uses the same pattern.
- **AC-2**: Among live testbeds the name (ignoring case, the existing `testbeds_name_lower_uq`) and the domain (the new `testbeds_domain_uq`) are each unique. A create with a taken name gives "A testbed with this name already exists." on `name`; with a taken domain, "A testbed with this domain already exists." on `domain`. If both are taken, only the name error shows (the name is checked first). Nothing is written: no testbed row, no client rows, no audit row. Soft deleting (hiding the row with `deleted_at`) frees both the name and the domain for reuse. Create checks the name and then the domain with a plain database read before it calls Authentik, so a taken name shows its duplicate message even when Authentik is down. Two admins saving at the same moment get the same messages, never a thrown error (the unique indexes decide, and the insert's miss is told apart as in the module table).
- **AC-3**: Before inserting, create looks up the Authentik group whose name equals the typed Name exactly (trimmed, case sensitive). If it is found and usable, the row is inserted with `authentik_group_pk` set in the same transaction, and the testbed is bookable at once. Not found gives "No Authentik group with this name exists." on `name`. Found but unusable gives "That group isn't set up for testbeds. It needs the hol_testbed_group marker." on `name`; unusable means any of: `attributes.hol_testbed_group` is not the boolean `true` (the string "true" is refused); it is a superuser group (`isSuperuser`); it has a parent group (`parents`) or a role (`roles`), either of which could hand its members admin rights; or it is `hol-admins` (matched by pk, and by name ignoring case). Two or more groups with exactly that name are refused the same way, never the first one. A pk already used by another live testbed gives "Another testbed already uses that group." on `name`. Authentik unreachable, slow (the client's 10 second timeout), or answering anything but success (403, 5xx, a body that does not parse) gives the form level message "Couldn't check the Authentik group, try again." and logs the status. Every refusal writes nothing. The order is: Zod parse, the AC-2 database precheck, the Authentik lookup, then one transaction, so the Authentik read happens before the transaction opens. The stored name is the trimmed typed text, byte for byte equal to the group's name (`CatalogName` makes no other change). Group reads pass `includeUsers: false`, so a large tenant group does not return its members.
- **AC-4**: No app code creates, updates, or deletes an Authentik group; it only adds and removes members. In tests, the in memory Authentik records no group create, update, or delete across create, edit, delete, reconcile, and release. A source scan (`tests/group-writes-scan.test.ts`) fails when `coreGroupsCreate`, `coreGroupsUpdate`, `coreGroupsPartialUpdate`, or `coreGroupsDestroy` appears in `app/`, `lib/`, `server/`, or `worker/` (test files aside), and also on the raw path `core/groups` there (a direct fetch around the SDK). The `pod-` prefix, `createPodGroup`, `deletePodGroup`, the `hol_testbed_id` group attribute, the create undo, and `sweepTestbedCreates` are removed.
- **AC-5**: On create, the Name field shows the hint "Must be the exact name of an Authentik group the owner has set up for this lab." On edit, the Name is shown read only with the hint "The name is the Authentik group, so it can't change. To use another group, delete this testbed and add a new one." The update action never reads a posted `name`, so an edit cannot change a testbed's name or group (a forged `name` field is ignored). The read only "Access group" row of the edit dialog (spec 0007 AC-3) is removed.
- **AC-6**: Edit can change the Domain, along with type, IDP, URLs, and clients as before. In the same transaction, after locking the testbed `FOR UPDATE`, if the new domain differs from the stored one and `testbedBlockers` finds any Upcoming or Current reservation (`provisioning` or `confirmed` with `ends_at > now()`), the save is refused with "You can't change the domain while this testbed has Upcoming or Current reservations." on `domain`, and nothing is written. A taken domain gives AC-2's domain message. A save that changes nothing still writes nothing. Past bookings do not block. Update errors come in this order: `not_found`, `type_not_found`, `idp_not_found`, `domain_locked`, then `duplicate_domain`. A unique violation aborts the transaction, so it is mapped outside it, as `updateTestbed` does today.
- **AC-7**: `testbed.created` audit metadata is `{ slug, domain, groupPk, clients }` (clients is the count), and no `authentik_group.created` row is written any more. `testbed.updated` metadata `changedFields` run over `testbedTypeId`, `idpApiKeyId`, `portalUrl`, `lmsUrl`, and `domain` (`name` is gone); the `clients` and `accessChanged` rules of spec 0007 AC-5 stay. Two new audit actions, `authentik_group.released` (AC-9) and `testbed.group_relinked` (AC-10), are added to `lib/audit-actions.ts` and shown with labels in the audit log screen. No credential value is ever in audit metadata.
- **AC-8**: The Testbeds list columns are Name, Testbed type, Domain, IDP, Clients, Actions. Search ("Search by name, type, domain, or IDP…") runs over `<name> <type name> <domain> <IDP name>`, ignoring case. The `Not ready` badge, the disabled edit with "Still being set up", and the `not_ready` refusal of spec 0007 AC-1 and AC-4 are removed, because a live testbed always has a group pk (AC-11).
- **AC-9**: Delete runs as in spec 0007 AC-6 (blockers, soft delete, `testbed.deleted`) and touches no group. Each worker tick, right after the access reconciler, a release step takes each soft deleted testbed that has a group pk and no `authentik_group_deleted_at`. If a live testbed holds the same pk, the row is stamped at once with no Authentik call (reason `shared`). Otherwise it reads the group: not found stamps it (reason `gone`); no member tagged `hol_learner = true` stamps it (reason `drained`); any tagged member skips the row this tick with a warning that names the testbed id and the count (the reconciler removes them). It never deletes the group. A stamp is one transaction: `update testbeds set authentik_group_deleted_at = now() where id = $1 and authentik_group_deleted_at is null`, plus an `authentik_group.released` audit row (actor null, target type `authentik_group`, target id the group's uuid (its pk), summary "Testbed group released", metadata `{ testbedId, reason }`). One failing row is logged and the rest still run. The reconciler skips stamped rows.
- **AC-10**: The reconciler keeps its job: a learner whose confirmed booking is Current by the DB clock is added to the testbed's group, and removed after it ends (sessions ended, Cloudflare revoke as before). Four changes. (a) The reconciler works per distinct group pk. For each pk held by any unreleased testbed it reads the group once (without its users), and the learners wanted are the union over the live testbeds holding that pk; a soft deleted testbed adds no one. So a testbed deleted and added again under the same name never has its learners removed by the old row, and no order inside a tick matters. (b) Each membership write reads the group again first: an add is refused unless the fresh group is usable (AC-3's test); a removal is allowed on any group except `hol-admins`, so a group that lost its marker still lets ended learners out. Only members tagged `hol_learner = true` are ever removed; untagged members are never touched, and a tagged learner who sits in the group with no Current booking is removed on the first tick. (c) A stored pk is stale when it returns not found, or when the group's name differs from the live testbed's name. For a live testbed the reconciler then looks the group up by the testbed's name; if that group is usable and no other live testbed holds its pk, it stores the new pk (`update testbeds set authentik_group_pk = $new where id = $id and authentik_group_pk = $old and deleted_at is null`), writes `testbed.group_relinked` (actor null, target type `testbed`, summary "Testbed group found again by name", metadata `{ testbedId, from, to }`), and carries on with the new pk in the same run. If it is not found or unusable, it logs an error and skips that testbed, writing nothing to the stale group (the others still run). A soft deleted testbed's stale pk is never relinked and logs nothing; release stamps it as `gone`. (d) A not found answer on the fresh read just before a write skips that write and logs once; the next tick takes the relink path. Errors are logged once per testbed per tick, with the number of refused adds, not once per learner.
- **AC-11**: The migration `db/migrations/0013_testbed_domain.sql` first locks `testbeds` (`share row exclusive`), then raises "Delete every live testbed first (spec 0017)." if any testbed has `deleted_at is null`, and "Wait for every deleted testbed's group release first (spec 0017)." if any row has `deleted_at` set, a group pk, and `authentik_group_deleted_at` null. It then adds `testbeds.domain` (nullable text), `testbeds_domain_format_check`, `testbeds_domain_live_check` (a live row has a domain), `testbeds_live_group_check` (a live row has a group pk), the unique index `testbeds_domain_uq` on `domain` where `deleted_at is null`, and the unique index `testbeds_group_pk_uq` on `authentik_group_pk` where `deleted_at is null` (one live testbed per group). `mapConstraintError` maps `testbeds_domain_uq` to `duplicate_domain` and `testbeds_group_pk_uq` to `group_in_use`. `npm run db:codegen -- --verify` passes. The constraint and index names are a contract with `mapConstraintError`.
- **AC-12**: `labsAccessExpression` in `scripts/authentik-setup-plan.ts` still passes staff and admins (a user whose path is not `hol/learners`). A learner passes only while a member of a group whose attributes hold `hol_testbed_group = true`. No `pod-` string is left in the expression, its comments, the `PROVISIONING_PERMISSIONS` comment, or the setup plan tests. The change reaches Authentik only when the owner runs `npm run authentik:setup -- --apply` (the owner approves shared changes).
- **AC-13**: Create, update, delete check, delete remove, and load for edit all call `requireAdmin()`. A learner or anonymous caller gets the existing "not authorized" result and nothing is written. None is on the public allow list (spec 0007 AC-9 carried over).

## Decision

**Chosen option**: Option 3: replace the app made groups with predefined, marked groups, directly (no side by side period).

The app finds a testbed's group by its name, accepts it only if it carries the `hol_testbed_group` marker, stores its pk, and from then on only manages membership. The worker releases a deleted testbed's group instead of deleting it. The marker also drives the HOL Labs gate.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.claude/skills/vercel-react-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

One migration, `db/migrations/0013_testbed_domain.sql` (the last one is `0012_audit_keyset_index.sql`). No new table and no new relationship.

| Table | Change | Column or rule | Detail |
|---|---|---|---|
| `testbeds` | new column | `domain` text, nullable | Trimmed, stored lower case. Required while the row is live; null only on a row that was soft deleted before this migration. |
| `testbeds` | new check | `testbeds_domain_format_check` | `domain is null or (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' and length(domain) <= 253)`. Same pattern as `DOMAIN_PATTERN`. |
| `testbeds` | new check | `testbeds_domain_live_check` | `deleted_at is not null or domain is not null` |
| `testbeds` | new check | `testbeds_live_group_check` | `deleted_at is not null or authentik_group_pk is not null`. This is what lets the "Not ready" state go. |
| `testbeds` | new index | `testbeds_domain_uq` | Unique on `domain` where `deleted_at is null`. Lower case is guaranteed by the format check, so "ignoring case" holds. |
| `testbeds` | new index | `testbeds_group_pk_uq` | Unique on `authentik_group_pk` where `deleted_at is null`. One live testbed per group, so a renamed group cannot end up behind two testbeds. |
| `testbeds` | unchanged | `name` | `testbeds_name_lower_uq` as before. The name is now also the Authentik group name, and never changes after create. |
| `testbeds` | unchanged | `slug`, `authentik_group_pk`, `authentik_group_deleted_at` | The slug stays an immutable internal key and names nothing in Authentik. `authentik_group_deleted_at` keeps its name (renaming it would break a running worker during a deploy) and now means "the app is done with this group". |

Relationships are unchanged (spec 0002, spec 0007). The migration guard raises while a live testbed exists, or while a deleted testbed's release is still pending, so no backfill is needed: the owner deletes the live ones first, as the scope already says.

New audit actions: `authentik_group.released`, `testbed.group_relinked`. `authentik_group.created` and `authentik_group.deleted` stay in the enum so old audit rows still read.

### State transitions

**Testbed** (derived from columns):

| State | Columns | Bookable | Reconciled | Set by |
|---|---|---|---|---|
| Live | `deleted_at` null, group pk set, domain set | yes | yes | `createTestbed` (one insert) |
| Deleted, release pending | `deleted_at` set, group pk set, `authentik_group_deleted_at` null | no | yes with an empty desired set, unless a live testbed holds the same pk | `deleteTestbed` |
| Deleted, released | all three set | no | no | release step |

The old "Not ready" state and the "hard deleted by the create undo" state no longer exist. Booking states are unchanged (spec 0002).

### API surface

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/admin/testbeds` | Server Component | none | rows: `id, name, typeName, domain, idpName \| null, clientCount` | `requireAdmin()` | not authorized |
| `loadTestbedForEdit` | Server Action, called on dialog open | `id` (`z.uuid()`) | `Result<TestbedEditDefaults, 'not_found'>`; defaults gain `domain` and lose `groupName` | `requireAdmin()` | `not_found` |
| `createTestbedAction` | Server Action (`useActionState`) | `name`, `domain`, `testbedTypeId`, `idpApiKeyId` (opt), URLs, clients | `AdminFormState` | `requireAdmin()` | `invalid`, `duplicate_name`, `duplicate_domain`, `type_not_found`, `idp_not_found`, `group_not_found`, `group_not_testbed_group`, `group_in_use`, `authentik_unavailable` |
| `updateTestbedAction` | Server Action, id bound by the page | the create fields except `name` | `AdminFormState` | `requireAdmin()` | `invalid`, `duplicate_domain`, `domain_locked`, `not_found`, `type_not_found`, `idp_not_found` |
| `checkTestbedDelete`, `deleteTestbedAction` | unchanged | `id` | unchanged | `requireAdmin()` | unchanged |

Server modules:

| Module and function | Change |
|---|---|
| `lib/catalog-input.ts` | Adds `DOMAIN_PATTERN` and a `DomainInput` (trim, lower case, empty message, pattern message). `TestbedInput` gains `domain`. A `TestbedUpdateInput` is `TestbedInput` without `name`; the update action parses with it. |
| `lib/testbeds.ts` | `TESTBED_MESSAGES` drops `notReady` and `groupFailed`; adds `duplicateDomain`, `domainLocked`, `groupNotFound`, `groupNotTestbed`, `groupInUse`, `authentikUnavailable`. `TestbedEditDefaults` adds `domain`, drops `groupName`, and keeps `name` for the read only field. `testbedSearchText` takes the domain. `TESTBED_FIELDS` swaps `name` for `domain`. |
| `server/authentik/guard.ts` | `POD_GROUP_PREFIX` goes. Adds `TESTBED_GROUP_MARKER = "hol_testbed_group"`. `GroupRefusal` becomes `"not_testbed_group"`. `checkGroupWrite(group, purpose, adminGroupUuid)` is pure: `purpose` is `"add"` or `"remove"`; both refuse `hol-admins` (by pk, and by name ignoring case); `"add"` also refuses a superuser group, a group whose marker is not the boolean `true`, a group with any parent (`parents`), and a group with any role (`roles`). `guardGroupWrite(api, groupUuid, purpose)` reads the group again (with `includeUsers: false`), then applies the check and returns the fresh group. The admin group's pk comes from the cached lookup already in this module. |
| `server/authentik/groups.ts` | Removes `createPodGroup`, `deletePodGroup`, `findPodGroupByName`, `podGroupName`. Adds `findTestbedGroup(api, name)` returning `Result<TestbedGroup, 'not_found' \| 'not_testbed_group' \| AuthentikFailure>` (one `coreGroupsList({ name, includeUsers: false })`, then the exact `g.name === name` matches: none gives `not_found`, two or more give `not_testbed_group`, one goes to the `"add"` check; any failure other than a clean answer is `unavailable`, logged with its status). `PodGroup` becomes `TestbedGroup { pk, name }`. The membership functions are renamed `addToTestbedGroup`, `removeFromTestbedGroup`, `testbedGroupMembers` and pass `purpose` to the guard. |
| `server/catalog/testbeds.ts` | `createTestbed(api, conn, input, actorId)`: a plain read for a live testbed with the same name, then the same domain; then the lookup; then one transaction (type, IDP, insert with `domain` and `authentik_group_pk`, clients, `testbed.created`). `testbeds_group_pk_uq` maps to `group_in_use`. The insert's `ON CONFLICT DO NOTHING` miss is told apart in order: a live testbed of the same name, then a live testbed of the same domain, else a slug clash (next suffix). `updateTestbed(conn, id, input, actorId)`: no name, adds the domain lock (AC-6); errors `duplicate_domain`, `domain_locked`, `not_found`, `type_not_found`, `idp_not_found`. Removes `undoTestbedCreate` and its callers. `listTestbedsForAdmin` adds `domain`, drops `groupReady`. |
| `server/db/constraint-errors.ts` | `ConstraintError` gains `duplicate_domain` and `group_in_use`; `testbeds_domain_uq` and `testbeds_group_pk_uq` map to them. |
| `server/worker/release.ts` | New, replaces `teardown.ts`: `releaseDeletedTestbeds(api, conn)` (AC-9). |
| `server/worker/reconcile.ts` | AC-10: work per distinct pk (the union of the live testbeds' learners), purposes on the guard, the stale check and relink by name, and logging once per testbed per tick. The query also selects `name`. |
| `server/worker/sweep.ts`, `worker/index.ts` | `sweepTestbedCreates` and its step go; the "testbed teardown" step becomes "testbed release", still right after the access reconciler. |
| `scripts/authentik-setup-plan.ts` | `labsAccessExpression` last line becomes `return request.user.groups.filter(attributes__hol_testbed_group=True).exists()` (same manager as today; the e2e check proves it) and the comments lose `pod-`. |
| `lib/audit-actions.ts`, `lib/audit-log.ts` | The two new actions and their labels. |
| `server/authentik/testing.ts`, `server/db/testing.ts` | The fake group gains `is_superuser` and an exact `name` filter; the testbed seed helper gives each row a unique domain and a group pk. |
| `components/admin/testbed-fields.tsx`, `testbed-edit-dialog.tsx`, `app/admin/testbeds/page.tsx` | Domain field, Name hint, read only Name on edit, Domain column, no badge, no disabled edit. |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| create, update | `domain` | form `domain`, trimmed and lower cased by `DomainInput` |
| create | duplicate precheck | live testbeds by `lower(name)`, then by `domain` (plain reads before the Authentik call) |
| create | group pk | `findTestbedGroup(api, name)`: the pk of the Authentik group whose name equals the typed Name, read through the provisioning token (`view_group`) |
| create | is the group usable | that group's `attributes.hol_testbed_group`, `isSuperuser`, `parents`, `roles`, `pk`, and `name` |
| create | `slug` | `slugify(name)` with the first free suffix, unchanged |
| create, update | audit actor | `requireAdmin()` session user |
| create | `testbed.created` metadata | `slug`, the parsed `domain`, the stored group pk, the client count |
| update | stored domain, and the lock | the row read under `FOR UPDATE`; live bookings from `testbedBlockers(trx, id)` |
| update | name | not posted, not read; the row keeps its name |
| edit load | `domain` | `testbeds.domain` |
| list | `domain` | `testbeds.domain` |
| list | search text | `<name> <type name> <domain> <IDP name>` |
| reconcile | group to write to | `testbeds.authentik_group_pk`, read again from Authentik before each write |
| reconcile | name for the relink | `testbeds.name` |
| reconcile | new pk on relink | `findTestbedGroup(api, testbeds.name)` |
| reconcile | learners wanted in a group | the union, over live testbeds holding that pk, of learners with a confirmed booking Current by the DB clock; deleted rows add none |
| reconcile | is the stored pk stale | a not found answer, or the fresh group's `name` compared with `testbeds.name` |
| reconcile | who may be removed | members whose attributes carry `hol_learner = true`, from `testbedGroupMembers` |
| release | rows to process | `deleted_at is not null and authentik_group_pk is not null and authentik_group_deleted_at is null` |
| release | tagged members left | `testbedGroupMembers` flags `holLearner` |
| release | `authentik_group_deleted_at` | DB `now()`, only where it is still null |
| gate | is the group a testbed group | the group's `attributes.hol_testbed_group`, stamped by the owner's script |

### Key invariants

- A live testbed has a domain and a group pk (AC-11). A live testbed's domain is unique, lower case, and valid.
- A testbed's name never changes after create, so its group never changes either, except through the relink by the same name (AC-10).
- A live group pk belongs to one live testbed (`testbeds_group_pk_uq`), and the app writes to a group only while the group's name equals the testbed's name.
- The app writes only group membership. It never creates, updates, or deletes a group (AC-4).
- A membership add needs a group that is marked with the boolean `true`, has no parent and no role, is not a superuser group, and is not `hol-admins`, checked on a fresh read each time. A removal needs only that it is not `hol-admins`.
- Only the reconciler adds or removes members, and it removes only members tagged `hol_learner`. The relink writes only the database.
- A group's wanted members are the union over the live testbeds holding its pk. A soft deleted testbed adds none and is reconciled only until released.
- `authentik_group_deleted_at` is set once, only on a soft deleted row, and only after the group is gone, drained, or held by a live testbed.
- Edit, delete, and booking on one testbed still serialize: edit and delete take `FOR UPDATE`, booking takes `FOR SHARE` (spec 0002 AC-14). That is what keeps a domain change from racing a booking.

### Security model

- Every page and action here calls `requireAdmin()`. Authentik is only read at save time (list groups) and written for membership by the worker, both with the provisioning token and its guard.
- The admin now types a name that selects a group, so the guard is the boundary: the marker is the allow list, and superuser groups, groups with a parent or a role (either could hand its members admin rights), and `hol-admins` are refused even if someone marks them. The marker is only as trustworthy as whoever can create or edit groups in Authentik. The provisioning token holds `add_group`, so a holder of that token could create a group that already carries the marker. The app code never does (AC-4), but the guard cannot tell such a group from a real one. That is a residual risk, closed by removing `add_group` from the role (Follow-up).
- The two refusal messages tell an admin whether a named group exists. Admins are trusted staff, and the owner chose the clearer text (2026-10-23).
- The provisioning role keeps `add_group` and `delete_group` for now (changing it is a shared Authentik change the owner approves), so the code guard and the source scan are the proof that the app uses neither.
- Learners reach none of this. The domain appears in no learner facing page in this spec.
- Audit metadata holds ids, the domain, and counts, never a credential.

### Configuration required

None. No new env var, key, or Authentik right. Owner side steps are in the migration plan.

### Critical test scenarios

- Parse (unit): the valid and invalid domain samples of AC-1, lower casing, trimming; the same samples through the database check inside `inRollback` give the same verdicts. Verifies **AC-1**, **AC-11**.
- Create happy path (DB plus fake Authentik): a marked group gives a row with its domain and pk, a `testbed.created` row holding `domain` and `groupPk`, no `authentik_group.created` row, and no group write recorded. Verifies **AC-3**, **AC-4**, **AC-7**.
- Create refusals (DB plus fake): no such group; a group without the marker; a superuser group; `hol-admins`; Authentik down. Each returns its message and leaves no row and no audit row. Verifies **AC-3**.
- Exact match (fake): with `NileWorkshop1Admin`, `NileWorkshop1AdminX`, and `nileworkshop1admin` present, only the exact name is accepted; two groups with the same exact name are refused. Verifies **AC-3**.
- Guard (unit): the marker as the string "true" is refused; a group with a parent, a group with a role, a superuser group, and `hol-admins` (by pk, and as `HOL-Admins`) are refused for an add; a removal works on an unmarked group but not on `hol-admins`; a 403, a 500, and an unparsable body each give `authentik_unavailable`; every group read in the fake carries `include_users=false`. Verifies **AC-3**, **AC-10**.
- Order (DB plus fake): a taken name with Authentik down shows the duplicate message and makes no Authentik call; a group pk already used by a live testbed gives `group_in_use`. Verifies **AC-2**, **AC-3**.
- Duplicates (DB): same name in another case; same domain in another case; both taken shows the name error; after a soft delete both are reusable; a reused name still gets slug `-2`; two connections saving the same name or domain at once give the message, not an exception. Verifies **AC-2**.
- Edit (DB, rolled back): a posted `name` is ignored; a domain change with a Current or an Upcoming booking is refused and writes nothing; after the booking ends, or with only a Past booking, it saves; a no change save writes nothing; `changedFields` holds `domain`. Verifies **AC-5**, **AC-6**, **AC-7**.
- List: the Domain column, the search matching a domain, no badge, edit enabled. Verifies **AC-8**.
- Release (fake): a drained group is stamped with reason `drained` and no group write; a missing group is stamped `gone`; a tagged member skips the row with a warning; a live testbed with the same pk stamps the old row at once as `shared`; one failing row does not stop the next; a stamped row is skipped by the reconciler. Verifies **AC-9**.
- Reconciler (fake): a learner is added when Current and removed after; an add to a group without the marker is refused while a removal still works; a recreated group (new pk) is found by name, stored, audited, and the learner is added in the same run; a group the owner renamed (same pk, different name) is treated as stale, relinked by name or skipped, and never written to; an unusable or missing group is logged once for the testbed, with the count of refused adds, and skipped while another testbed still reconciles; a deleted testbed and a new live one with the same name do not fight, in either row order; an untagged member is never removed, and a tagged member with no Current booking is removed on the first tick; a deleted testbed whose pk returns not found is stamped `gone` with no relink and no error log; a not found answer on the read just before a write skips that write. Verifies **AC-10**, **AC-9**.
- Migration: it raises with a live testbed present, and with a deleted testbed whose release is pending; the checks refuse a bad domain, a live row without a domain, and a live row without a pk; the indexes refuse a second live domain and a second live testbed on one group pk; codegen verify passes. Verifies **AC-11**.
- Gate: a unit test that the expression holds the marker filter and no `pod-`. Playwright against the real Authentik: a learner passes HOL Labs while in a marked throwaway group and fails in an unmarked one; staff and admins pass. Verifies **AC-12**.
- Source scan: no group create, update, or delete call, and no raw `core/groups` path, in app code. Verifies **AC-4**.
- Auth: a learner session calling each action gets not authorized and writes nothing; the allow list test passes unchanged. Verifies **AC-13**.

At `/check verify`, two Authentik facts are confirmed on the real instance: the group list `name` filter is an exact match, and the `attributes__hol_testbed_group=True` lookup works on `request.user.groups` inside the gate policy.

## Build plan

Tracer Bullet (the project default): the first thread is one testbed created with a domain and a predefined group through every layer (migration, lookup, insert, form, list), then each strand thickens it.

Before task 1 (owner, see the migration plan): the predefined groups are marked and the live testbeds are deleted and released. DB tests, `db:codegen`, and the dev server all run on the shared database, so task 1 applies migration `0013` there, and the migration refuses until those two owner steps are done.

1. Foundation: migration `0013` (the lock, the two guards, the column, the checks, and both unique indexes), `db:codegen`, `DOMAIN_PATTERN` and `DomainInput` with the parity test, the `duplicate_domain` and `group_in_use` constraint mappings, the two audit actions and labels, and the seed helper change in `server/db/testing.ts`. Satisfies **AC-1**, **AC-2**, **AC-7**, **AC-11**
2. Guard and lookup: `checkGroupWrite(group, purpose, adminGroupUuid)`, the marker constant, `findTestbedGroup`, the membership renames, `includeUsers: false` on group reads, and the fake Authentik changes, with a unit test per refusal (marker type, parent, role, superuser, `hol-admins`, two matches, 403, 5xx). Satisfies **AC-3**, **AC-4**, **AC-10**
3. Create thread end to end: the new `createTestbed` (the database precheck, the lookup, one transaction, the three way miss check, audit), the action's error mapping and messages, the Domain field and Name hint, the list column and search; remove `createPodGroup`, `undoTestbedCreate`, the create sweeper and its step, and the `Not ready` badge. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-5**, **AC-7**, **AC-8**
4. Edit thread: `TestbedUpdateInput` without name, the read only Name, the domain edit with the booking lock, `testbedEditChange` with `domain`, `groupName` removed from the edit defaults and dialog. Satisfies **AC-5**, **AC-6**, **AC-7**
5. Delete and reconcile thread: `releaseDeletedTestbeds` (replacing `teardown.ts`), the reconciler per distinct pk with its guard purposes, stale check, relink by name, and logging once per testbed per tick, and the worker step list. Satisfies **AC-9**, **AC-10**
6. Gate and owner runbook: `labsAccessExpression`, its tests, and the README section for the owner steps below. The owner applies the gate after this task and before the deploy. Satisfies **AC-12**
7. Guards and end to end: `tests/group-writes-scan.test.ts`; the auth tests carried over; Playwright for testbeds, booking, and HOL Labs moved to throwaway groups that carry the marker (made and removed by the test with the provisioning token, named `dev-e2e-…`). Satisfies **AC-4**, **AC-12**, **AC-13**

## Migration plan

**Strategy**: no side by side period. The change is staged by owner steps because the migration refuses to run while live testbeds exist or a release is pending. Dev and prod share one database, so `/develop` applying `0013` is applying it to production; the order below makes that safe.
**Phases**:
1. Owner: make the predefined groups with the separate script, flat (no parent, no role), and have it stamp `hol_testbed_group = true` (the boolean) on each.
2. Owner: delete the two live testbeds in the console. Wait until the current worker has removed their `pod-` groups and stamped them. The migration checks this itself (no row with `deleted_at` set, a group pk, and `authentik_group_deleted_at` null).
3. `/develop` starts. Task 1 applies `0013` to the shared database. No live testbed exists, so the only effect is that the old production web cannot create a testbed until it is redeployed; the owner adds none in this window.
4. Owner, with approval, after build task 6 and before the deploy: run `npm run authentik:setup` as a dry run, then with `--apply`, to put the marker based `hol-labs-access` gate in place. This is safe now because no live testbed or learner needs the `pod-` rule. It also lets the real gate test (AC-12) pass before the deploy.
5. Deploy with `scripts/deploy.sh` (it dumps the database first, then runs `migrate`, `web`, `worker`). `migrate` finds `0013` already applied.
6. Owner: add the testbeds again with their Domain and group name; make each lab VM's Cloudflare Access rule use that same group name; check each tenant's SAML NameID (feature 20 uses it).

**Rollback**: before step 6, revert the deploy and run `alter table hol_app.testbeds drop constraint testbeds_live_group_check, drop constraint testbeds_domain_live_check;` (the old create inserts a row with no group pk first, which the new checks refuse), then re-apply the old gate with the previous `authentik:setup` if step 4 ran. The column and the other constraints can stay. After step 6 the only way is forward: the old code's guard refuses every group that is not named `pod-*`, so testbeds on predefined groups would stop working.
**Risks**:
- Between step 3 and the deploy, the old production web cannot create a testbed (the checks refuse its insert).
- If a deleted testbed's release were pending at migration time, it would later be stamped without its `pod-` group being deleted (the new worker deletes no group). The migration's own guard prevents it.
- Doing step 6 before step 4 would leave learners failing the gate (it would still want `pod-`). The order above rules it out.

## Consequences

**Positive**:
- Groups are made in one place, the owner's script. The app never needs to guess a group's shape or clean one up.
- The guard becomes an explicit allow list (the marker) instead of a name prefix, and the same marker drives the HOL Labs gate, so the two cannot drift apart.
- The half made testbed state disappears, with its undo, its sweeper, and its badge. Create is one insert.
- Each testbed carries the domain feature 20 needs.

**Negative / tradeoffs**:
- The name is coupled to a group in Authentik. A typo is caught at save, but a group that is renamed, deleted, or unmarked later is not: the worker only logs an error and a learner with a booking gets no access. The owner chose log only (2026-10-23); a visible signal is a follow up.
- A testbed cannot be pointed at another group. That means delete and add again, which is blocked while it has Upcoming or Current reservations.
- A domain cannot change while Upcoming or Current reservations exist.
- The owner must keep the order of the migration plan. Because dev and prod share one database, any `db:migrate` run anywhere applies the migration to production, which is why `/develop` cannot start before owner steps 1 and 2.
- The guard refuses groups with a parent or a role, so the owner's script must make flat groups. A tenant group that is nested or carries roles for another reason cannot back a testbed until that changes.
- Unmarking a group cuts a Current learner off at the HOL Labs gate at once, while the reconciler leaves them in the group until their booking ends. The owner should know the marker is live, not just a setup flag.
- The refusal text tells an admin whether a group exists. Accepted.
- Two groups that differ only in case cannot both back live testbeds, because testbed names are unique ignoring case while Authentik names are case sensitive.
- `authentik_group_deleted_at` now means "released", not "deleted", and the old worker's already stamped rows really did delete a group.
- The provisioning role still holds group create and delete rights the app no longer uses.

**Neutral**:
- `slug` stays but names nothing in Authentik.
- Old `authentik_group.created` and `.deleted` audit rows keep reading as they did.
- Learner pages, emails, and booking rules are unchanged by this spec.

## Follow-up

- [ ] `/sync`: note that this spec amends spec 0003 AC-4 (group writes need the marker, not the `pod-` prefix), spec 0004 AC-2, AC-11, and AC-12 (create saga, sweeper, reconciler group), spec 0007 AC-1 to AC-4, AC-7, and AC-8's group parts (Not ready, access group row, teardown), and spec 0012's `pod-` wording for the gate and the Cloudflare rules. Update `server/authentik/AGENTS.md`, `server/worker/AGENTS.md`, and the `pod-*` rules in root `AGENTS.md`.
- [ ] Owner runbook in the README's operations section: the migration plan above.
- [ ] Group missing visibility: today only the worker log. Consider an audit row once per outage, or a badge on the list (engineer call 2026-10-23).
- [ ] Least privilege, the proper fix for the marker's residual risk (Security model): remove `authentik_core.add_group` and `authentik_core.delete_group` from `PROVISIONING_PERMISSIONS` once the Playwright tests have their own credential (or owner made throwaway groups) for test groups. A shared Authentik change, owner approved.
- [ ] Later migration: rename `authentik_group_deleted_at` to a released name, and consider dropping `testbeds.slug`, once no old worker can run.
- [ ] Feature 20 (`/architect nile identity per domain`) builds on `testbeds.domain` and on the one group per testbed set here.
- [x] Scope row 19: linked to this spec, with the build milestones, on 2026-10-23. The least privilege, group missing signal, and column cleanup items above are also in the scope's Deferred list.
