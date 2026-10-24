# 0018. Testbed friendly name

**Date**: 2026-10-23
**Status**: Accepted

## Summary

Today a testbed has one name, and that name must equal an Authentik group, so learners see things like `NileWorkshop1Admin` in emails and invites. This spec adds a second field. The existing `name` column becomes the free text name learners see, and a new `group_name` column holds the Authentik group name that only admins see. Every place that talks to Authentik reads `group_name`; every place a learner can look reads `name`. Existing testbeds get their current name copied into both fields, so nothing changes until an admin edits one.

## Context

A testbed's `name` does two jobs at once (spec 0017). It is the exact name of the Authentik group that gates the lab (the reconciler adds and removes learners from that group), and it is also the label learners read in the booked, rescheduled, cancelled, and reminder emails, the Google Calendar invite, and the booking and reservation screens. Because the group name is chosen for Authentik, not for people, it reads badly to a learner, and it can never be changed after create, so a typo or a better label means deleting the testbed.

The code reads `testbeds.name` in two groups of places. Learner facing reads (`t.name` in `booking-notice.ts`, `calendar-sync.ts`, `lab-access.ts`, `availability.ts`, `guest-saga.ts`) only need a label. Group facing reads (`createTestbed`, the reconciler's stale check and `relinkByName`, the audit log's "access group" labels) need the real group name. Today both use the same column, so a rename cannot be done without splitting the jobs.

Dev and production share one database and the worker is one container, so a migration lands on live data the moment it runs. This is not a greenfield change: the column has live rows, live bookings point at those testbeds, and queued reminder emails will read the name when they send.

## Requirements

**User stories**:
- As a learner, I want to see a plain testbed name in my emails, calendar invite, and screens so that I know which lab I booked.
- As an admin, I want to keep the Authentik group name on the admin side and choose the learner facing name myself, and to change that name later without recreating the testbed.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: Migration `db/migrations/0014_testbed_group_name.sql` adds `testbeds.group_name`, copies `name` into it for every row (live and soft deleted), then makes it `not null`. It adds `testbeds_group_name_trimmed` (`group_name = btrim(group_name) and group_name <> ''`) and the unique index `testbeds_group_name_lower_uq` on `lower(group_name)` where `deleted_at is null`. It does not require the table to be empty (unlike 0013), and starts with `set local lock_timeout = '5s'` so the `alter table` never queues behind a long booking transaction. After it runs, every existing row has `name = group_name`. `mapConstraintError` maps `testbeds_group_name_lower_uq` to `duplicate_group_name`. `testbeds_name_lower_uq` stays and still maps to `duplicate_name`. `npm run db:codegen -- --verify` passes. The constraint and index names are a contract with `mapConstraintError`.
- **AC-2**: The add form shows two required fields, in this order: **Name** (hint "What learners see in emails, invites, and on screens.") and **Group Name** (hint "Must be the exact name of an Authentik group the owner has set up for this lab."). Both use the `CatalogName` rule (trimmed, 1 to 200 characters); Group Name is a `GroupName` schema in `lib/catalog-input.ts` that overrides the empty message. An empty Name gives "Enter a name." on `name`; an empty Group Name gives "Enter the group name." on `groupName`. A testbed cannot be saved without a Name. The edit dialog shows Name as an editable field and Group Name read only with the hint "The group name can't change. To use another group, delete this testbed and add a new one."
- **AC-3**: On create, the duplicate checks run in this order, each a plain database read among live testbeds ignoring case, all before Authentik is called: Name ("A testbed with this name already exists." on `name`), then Group Name ("A testbed with this group name already exists." on `groupName`), then Domain (spec 0017 AC-2, unchanged). The first miss is the only message shown, and nothing is written. The Authentik lookup (`findTestbedGroup`) then uses the typed Group Name, and its refusals (spec 0017 AC-3: not found, no marker, unusable, group in use) now show on `groupName`, not `name`. Soft deleting a testbed frees both names. Two admins saving at the same moment get the same messages, never a thrown error (the unique indexes decide, and an insert miss is told apart in the same order: name, group name, domain, group pk, else a slug clash).
- **AC-4**: Edit can change Name. The update action never reads a posted `groupName` (a forged field is dropped by `TestbedUpdateInput` omitting it). Editing Name needs no booking lock, calls no Authentik API, and is allowed while Upcoming or Current reservations exist. A taken Name gives "A testbed with this name already exists." on `name`. Update errors come in this order: `not_found`, `type_not_found`, `idp_not_found`, `domain_locked`, `duplicate_name`, `duplicate_domain`. The two duplicate checks are plain reads inside the transaction, after `domain_locked`, each excluding the row itself (`id <> $id`), so a case only rename ("lab 1" to "Lab 1") is allowed; the constraint mapping stays as the race fallback for both. The saved message uses the new name (`input.name`), and the update action handles a `duplicate_name` case. A save that changes nothing writes nothing. The existing `idp_not_found`, `type_not_found`, and client rules are unchanged.
- **AC-5**: A learner never sees the group name. Every learner facing read keeps using `testbeds.name`, which is now the friendly name: the booked, rescheduled, cancelled, and reminder emails (the "Testbed" row and any plain text copy), the lab access email, the Google Calendar event title, the booking preview and success screens, the reschedule preview and success screens, the reservations list and detail, the "Testbed assigned" row of the lab access card, and the cannot reschedule screen. A source scan (`tests/group-name-scan.test.ts`) fails when `group_name` or `groupName` appears under `app/`, `components/`, `lib/`, `server/`, `worker/`, or `scripts/` outside an allow list: `server/catalog/testbeds.ts`, `server/worker/reconcile.ts`, `lib/reconcile.ts`, `server/audit-log.ts`, `lib/testbeds.ts`, `lib/catalog-input.ts`, `lib/audit-log.ts`, the testbed admin components, `app/admin/testbeds/`, `app/admin/actions.ts`, `server/db/testing.ts`, and the generated `server/db/types.ts`. Test files are exempt.
- **AC-6**: A rename affects only what is read after it. An email takes the name it has when it is queued (the booking notice and reminder jobs store `details` and the subject then), so an email queued before the rename and not yet sent keeps the old name; unsent rows are not rewritten. The calendar event takes the name it has when its job runs. Emails and events already sent are not changed, and a rename queues no calendar or email job (owner choice 2026-10-23). A rename also changes which testbed is assigned first, because `bookableTestbedsOfType` orders by `lower(name)`; this is kept on purpose, so an admin can steer assignment with the friendly name.
- **AC-7**: Everything that talks to an Authentik group reads `group_name`, and behavior is otherwise unchanged. `createTestbed` looks the group up by Group Name. The reconciler's `unreleasedTestbeds` selects `group_name`, `GroupRow.name` in `lib/reconcile.ts` is renamed `groupName` (so no alias can hide a read of the friendly name), `isStalePk` compares it; a stored pk is stale when it returns not found or when the group's name differs from the testbed's `group_name`; `relinkByName` looks up `group_name`. The audit log's "<name> access group" labels use `group_name`. The stored `group_name` is the found group's name (`group.value.name`), not the typed text. Reconciler log lines, the `testbed.group_relinked` summary, and the comments in `scripts/authentik-setup-plan.ts`, `updateTestbedAction`, and `lib/testbeds.ts` that call the testbed's name the group are reworded to say group name. The slug is derived from the Group Name at create (`slugify(input.groupName)`), so every existing slug and every new slug is built from the same text as before. Cloudflare and the rest of Authentik behavior do not change, and the in memory fake Authentik records no group create, update, or delete (spec 0017 AC-4 still holds).
- **AC-8**: The admin Testbeds list columns are Name, Group Name, Testbed type, Domain, IDP, Clients, Actions. Search ("Search by name, group name, type, domain, or IDP…") runs over `<name> <group name> <type name> <domain> <IDP name>`, ignoring case. The audit log shows both: the `testbed.created` metadata is `{ slug, name, groupName, domain, groupPk, clients }`; `testbed.updated` `changedFields` run over `name`, `testbedTypeId`, `idpApiKeyId`, `portalUrl`, `lmsUrl`, and `domain` (`groupName` is not listed, it cannot change); a testbed target label reads `Name (group GroupName)`, or just `Name` when the two are equal; and the audit log's free text target search matches either name for a testbed (`name` or `group_name`) and `group_name` for an `authentik_group` target. The "access group" label read selects `group_name`, and the testbed label gets its own read (it is not the shared `namedRows`). The admin list sorts by `lower(name)`, and the create message "Created X." uses the Name. Audit rows written before this change are not rewritten.
- **AC-9**: Create, update, load for edit, delete check, and delete remove all call `requireAdmin()`; a learner or anonymous caller gets the existing "not authorized" result and nothing is written (spec 0007 AC-9 carried over).

## Decision

**Chosen option**: Option 1: Keep `name` as the learner facing name and add `group_name` for Authentik.

`testbeds.name` becomes the friendly name with no change to its column or its index, a new `testbeds.group_name` holds the Authentik group name, and only the group facing code moves to the new column.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`)

## Options considered

### Option 1: Keep `name` as the friendly name, add `group_name`

The old column keeps its meaning to every learner facing query and its unique index; the new column takes the Authentik meaning. Only the few group facing places change.

**Pros**:
- A learner facing read that is missed or written later shows the friendly name, never the group name. The risky mistake fails safe.
- No column rename on a table shared by dev and production, and the existing queries in emails, the calendar, and screens stay as they are.
- `testbeds_name_lower_uq` and its `duplicate_name` mapping keep their meaning, so the form's duplicate message stays correct.

**Cons**:
- The column called `name` no longer matches the group it used to hold, so a reader of old specs (0007, 0017) must know the meaning moved. A scan test and a Follow-up note cover this.
- A group facing read that is missed would quietly use the friendly name; the reconciler tests cover that.

### Option 2: Rename `name` to `group_name`, add a new `name`

Matches the form labels one to one and keeps `name` meaning "the label" in a fresh column.

**Pros**:
- The column names read the same as the form after the change.

**Cons**:
- Every existing learner facing query that selects `t.name` would silently keep returning the group name until each is edited, so a missed place leaks the group name to a learner.
- Renaming a live column on a shared database breaks the old production code at once, and the old worker would read the new column's values.

### Option 3: Store the friendly name in a separate table or JSON attribute

A `testbed_labels` table or a JSON column keyed by testbed.

**Pros**:
- No change to the `testbeds` columns.

**Cons**:
- Adds a join to every learner facing query for one text field, and loses the simple unique index. It is more moving parts than the problem needs.

## Rationale

Option 1 fits the forces in Context. The learner facing reads are the many and spread out places (emails, the calendar, six screens), and the group facing reads are the few and concentrated ones (create, the reconciler, the audit labels). Moving the few is safer than moving the many, and a missed spot fails toward the harmless label. On a database that dev and production share, adding a column is also the migration shape that old code survives best. Option 2 reads nicer but a single missed query would show `NileWorkshop1Admin` to a learner, which is the exact problem this feature exists to fix.

The engineer chose: Name unique among live testbeds, like Group Name (so two benches never look the same to a learner); a rename leaves sent invites alone; the admin list shows Name and Group Name as two columns. The slug is derived from the Group Name (the stable, never changing field) and not the Name, because the slug never changes and the Name can. The Name keeps the existing 200 character rule so one rule serves both fields.

## Feature design

**Data model**:

| Table | Column | Type | Rule |
|---|---|---|---|
| `testbeds` | `name` | text, not null | The learner facing name. Existing `testbeds_name_trimmed` check. Unique among live rows ignoring case (`testbeds_name_lower_uq`). Editable. |
| `testbeds` | `group_name` (new) | text, not null | The exact Authentik group name. Trimmed, not empty (`testbeds_group_name_trimmed`). Unique among live rows ignoring case (`testbeds_group_name_lower_uq`). Never changes after create. |

Nothing else changes in the schema. `slug`, `domain`, `authentik_group_pk`, and the client table are untouched.

**API surface**:

| Surface | Kind | Inputs | Outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `createTestbedAction` | Server Action | `name`, `groupName`, `domain`, `testbedTypeId`, `idpApiKeyId`, `portalUrl`, `lmsUrl`, `clients` | `AdminFormState` | `requireAdmin()` | `invalid`, `duplicate_name`, `duplicate_group_name`, `duplicate_domain`, `group_not_found`, `group_not_testbed_group`, `group_in_use`, `authentik_unavailable`, `type_not_found`, `idp_not_found` |
| `updateTestbedAction` | Server Action, id bound by the page | `name` and the create fields except `groupName` | `AdminFormState` | `requireAdmin()` | `invalid`, `duplicate_name`, `duplicate_domain`, `domain_locked`, `not_found`, `type_not_found`, `idp_not_found` |
| `loadTestbedForEdit` | Server Action, on dialog open | `id` (`z.uuid()`) | `TestbedEditDefaults` gains `groupName` | `requireAdmin()` | `not_found` |
| `/admin/testbeds` | Server Component | none | rows gain `groupName` | `requireAdmin()` | not authorized |

Group Name refusals from Authentik map to the `groupName` field (`TESTBED_FIELDS` gains `groupName`). Delete check and delete remove are unchanged and show `name`.

**Value sourcing**:

| Action | Value produced or displayed | Source |
|---|---|---|
| Create | stored `name` | input `name`, trimmed by `CatalogName` |
| Create | stored `group_name` | input `groupName`, trimmed by `CatalogName`, equal to the found group's name |
| Create | `slug` | `slugify(input.groupName)` with the existing `slugCandidate` suffix |
| Create | `authentik_group_pk` | `findTestbedGroup(api, input.groupName)` |
| Update | new `name` | input `name` |
| Update | Group Name shown read only | `group_name` column, loaded by `loadTestbedForEdit` |
| Emails, invite, learner screens | "Testbed" label | `testbeds.name` column (joined, as today) |
| Reconciler stale check and relink | group name to compare and look up | `testbeds.group_name` column |
| Audit log testbed label | `Name (group GroupName)` | `testbeds.name` and `testbeds.group_name` columns |
| Audit log "access group" label | `<GroupName> access group` | `testbeds.group_name` column |
| `testbed.created` metadata | `name`, `groupName` | the stored values |
| `testbed.updated` metadata | changed `name` | `changedFields` over the listed keys |

**Key invariants**:
- A live testbed has a unique Name and a unique Group Name (ignoring case), enforced by the two partial unique indexes.
- Group Name never changes after create, except that the row's `authentik_group_pk` may be relinked by the same group name (spec 0017 AC-10).
- No learner facing code path reads `group_name`.
- Only group facing code reads `group_name`: create, the reconciler, the audit log, and the admin forms and list.

**Security model**: Admin only for every testbed action (`requireAdmin()`). The group name is internal: it never reaches a learner, an email, an invite, or a learner page, and the scan test (AC-5) makes a new leak a failing test. It is not a secret, so it may appear in admin screens and audit metadata. Authentik group rules from spec 0017 (marker, no write to groups) are unchanged.

**Configuration required**: none.

**Critical test scenarios**:
- Migration (DB, rolled back): with live and deleted testbeds present, every row ends with `name = group_name`; the not null, trim check, and unique index refuse bad values; codegen verify passes. Verifies **AC-1**.
- Parse (unit): empty and whitespace Name and Group Name give their messages; a forged `groupName` on update is dropped; 200 and 201 characters. Verifies **AC-2**, **AC-4**.
- Create order (DB plus fake Authentik): a taken name wins over a taken group name, which wins over a taken domain, each with Authentik down and no Authentik call; the lookup uses `groupName`, and each refusal lands on `groupName`; two connections saving the same name or group name give the message, not an exception. Verifies **AC-3**.
- Edit (DB, rolled back): a Name change saves with an Upcoming and a Current booking present; a taken Name is refused; a no change save writes nothing; `changedFields` holds `name`; no Authentik call. Verifies **AC-4**, **AC-8**.
- Learner surfaces (DB): a testbed with Name "Lab 1" and Group Name "NileWorkshop1Admin" shows only "Lab 1" in the booking notice details, the calendar event title, the lab access read, and the availability preview; the sent email text and subject never contain the group name; a rename followed by a queued reminder gives the new name in its stored `details` and subject, a booked email already sent is unchanged, an unsent queued row keeps its old name, and the rename queues no job; a rename reorders which testbed is assigned first. Verifies **AC-5**, **AC-6**.
- Scan: `tests/group-name-scan.test.ts` fails on a `group_name` read in a learner facing file. Verifies **AC-5**.
- Fixtures: every test that inserts into `testbeds` directly (not through `makeTestbed`) sets `group_name`.
- Reconciler (fake): a group renamed in Authentik is stale against `group_name` (not `name`), relinked by `group_name`, and a changed friendly Name causes no stale or relink. Verifies **AC-7**.
- Admin list and audit (DB): both columns, search by either name, the target label, and the `testbed.created` metadata. Verifies **AC-8**.
- Auth: a learner and an anonymous caller are refused for every testbed action. Verifies **AC-9**.

## Build plan

Approach: Tracer Bullet (project default). The first slice proves one real thread, from the database to a learner's email, and later slices thicken it.

1. Migration `0014_testbed_group_name.sql` (add, backfill, not null, trim check, unique index), `npm run db:codegen`, the `testbeds_group_name_lower_uq` entry in `mapConstraintError`, and `group_name` in `makeTestbed` (`server/db/testing.ts`), satisfies **AC-1**.
2. Thin thread: `TestbedInput` gains `groupName`, `TestbedUpdateInput` omits it; `createTestbed` takes it for the lookup and the insert and derives the slug from it; the add form gets both fields; verify through to the booked email showing only `name`, satisfies **AC-2**, **AC-3** (create happy path), **AC-5** (email), **AC-7** (create lookup and slug).
3. Create duplicate order and error mapping: `duplicateOf` checks name, group name, domain; the insert miss path; Group Name refusals move to the `groupName` field; new `duplicate_group_name` message, satisfies **AC-3**.
4. Edit: `updateTestbed` reads and writes `name`, `duplicate_name` mapping, no booking lock, `changedFields` over `name`; the edit dialog shows an editable Name and a read only Group Name with its hint; `loadTestbedForEdit` returns `groupName`, satisfies **AC-4**, **AC-2**.
5. Group facing code: reconciler `unreleasedTestbeds`, `lib/reconcile.ts` (`GroupRow.groupName`, `isStalePk`), the stale check, and `relinkByName` use `group_name`, and the group wording in logs, summaries, and comments is fixed; audit log "access group" labels use `group_name`, satisfies **AC-7**.
6. Admin list and audit: the Group Name column, search over both, audit target label and search, `testbed.created` metadata, satisfies **AC-8**.
7. Learner surfaces check and scan test: confirm every surface in AC-5 reads `name` only, add `tests/group-name-scan.test.ts`, and a rename test that proves no job is queued and a reminder reads the new name, satisfies **AC-5**, **AC-6**.
8. Auth and test pass: `requireAdmin` coverage on the touched actions, the critical scenarios above, `npm run lint && npm run typecheck && npm test`, satisfies **AC-9**.

## Migration plan

**Strategy**: add a column, backfill, then constrain, in one migration run inside one transaction (the table is small and the lock is brief). The old column stays and keeps its index.
**Phases**:
1. Run `npm run db:migrate`, which adds `group_name` as nullable, sets `group_name = name` for every row, then sets it not null and adds the trim check and the unique index.
2. Deploy the new web and worker with `scripts/deploy.sh` right after, so the running code and the schema agree. Production has not been redeployed since before spec 0017, so this one deploy carries both 0013 and 0014, and the owner steps of spec 0017 come first. Check the worker log once after the deploy, before any rename.
**Rollback**: the migration alone is additive. Drop the new index, the check, and the column to revert it, and redeploy the previous image.
**Risks**: dev and production share the database and production is not redeployed automatically (see the testbed domain rollout). Between the migration and the deploy, the old code cannot create a testbed (its insert has no `group_name`, so it fails not null; admin only, and a thrown error, not a data change). Do not edit a live testbed's Name (from dev or production) until the new worker is running: an old worker treats `name` as the group name, finds a stale group, and skips that testbed every tick, so learners with a current booking are never added to the group and lose lab access. The owner runs the migration and the deploy together, and approves the shared change.

## Consequences

**Positive**:
- Learners see a readable name in every email, invite, and screen, and admins can fix or improve it later without recreating the testbed.
- A missed learner facing read fails safe, and a scan test catches a new leak.
- No existing slug, booking, or group link changes, and existing testbeds look the same until edited.

**Negative / tradeoffs**:
- Two similar fields mean an admin can mix them up on the form. The hints and the read only Group Name on edit reduce that.
- The column `name` now means something different from what specs 0007 and 0017 describe, so those specs are partly stale until synced.
- Invites already sent keep the old name after a rename (the engineer's choice). A learner can see a stale name in a calendar until the booking is rescheduled.
- The new migration needs a coordinated deploy because of the shared database.
- Renaming a testbed can change which one is assigned first (assignment orders by `lower(name)`), and an email queued but not yet sent keeps the old name.
- A group renamed in Authentik leaves its testbed stale for good, because Group Name cannot be edited. The remedy is to rename the group back in Authentik (same as under spec 0017).

**Neutral**:
- Two more fields in the add form, one more column in the admin list, and a new constraint name that `mapConstraintError` must know.
- Editing a Name writes a `testbed.updated` audit row like any other edit.

## Follow-up

- [ ] Run `/sync` after the build to update spec 0017 (AC-3, AC-5, AC-8, AC-10 say the Name is the Authentik group) and spec 0007's testbed text, and the AGENTS.md rule that names `testbeds.name`
- [ ] The owner runs `npm run db:migrate` and `scripts/deploy.sh` together (shared database)
- [ ] Revisit syncing calendar events on a rename if learners report stale invites
- [ ] Rename the `name` column in the AGENTS.md "Authentik groups" rule so it points at `group_name` once built
