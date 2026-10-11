# 0007. Admin Testbeds

**Date**: 2026-10-10
**Status**: Accepted

## Summary

Admins get the full Testbeds screen from the mock: list, search, add, edit, and delete testbeds, each with a type, an optional IDP key, Nile Portal and LMS URLs, and up to 20 wired or wireless clients. Each client can carry an OS username and password that the learner later gets in the booking email. Deleting a testbed hides it at once, and the background worker then removes its Authentik access group within about 30 seconds. The owner still binds each group to the lab apps by hand (spec 0001), so this feature adds no new Authentik rights.

## Requirements

**User stories**:
- As an admin, I want to add, edit, and delete testbeds from the console, so that the bookable catalog matches the real labs.
- As an admin, I want to record each client's OS login on the testbed, so that learners get everything they need to use the lab in their booking email.
- As the owner, I want a deleted testbed's access group to disappear from Authentik on its own, so that no stale group grants access to anything.

**Acceptance criteria**:
- **AC-1**: `/admin/testbeds` lists live testbeds (not soft deleted) by `lower(name)` with the mock's columns: Name, Testbed type, IDP (the key's name, or `—` when none), Clients (`1 client`, `3 clients`, `0 clients`), and Actions (edit, delete). A testbed with no `authentik_group_pk` shows a `Not ready` badge beside its name. The "Access group" column is removed. Search ("Search by name, type, or IDP…") runs client side in `DataTable` over the row's `search` text, `<name> <type name> <IDP name>`, ignoring case; the `—` placeholder is not part of it. The list payload carries no client details (only the count), so no OS credential is sent until an edit dialog opens (AC-3).
- **AC-2**: "Add testbed" opens the form with: name, type (live types), IDP (live `IDP` keys by name, plus `None`, default `None`), Nile Portal URL, LMS URL, and client rows. Each client row has kind (`Wireless` or `Wired`, default `Wireless`), name, URL, OS username, and OS password (masked, with a show toggle), plus a remove button; "Add client" appends a row. Saving runs spec 0004 AC-2's row first group saga, and also stores `idp_api_key_id` and each client's OS username and password. One change to that saga: the step that stores the group pk also requires `deleted_at is null`, so a testbed an admin deleted while its create was running is treated as a failed create (the in line undo runs, the admin sees "Couldn't create the testbed's access group, try again", and `sweepTestbedCreates` finishes anything the undo could not). Inputs: spec 0004 AC-2's rules, plus at most 20 clients ("Use at most 20 clients."), OS username trimmed and 0 to 200 characters (empty means none), OS password kept exactly as typed and 0 to 200 characters (empty means none), and a password without a username is refused on `clients.N.osUsername` ("Enter the OS username for this password."). When an IDP is chosen, the save locks that key `FOR SHARE` and requires `type = 'IDP' and deleted_at is null`; otherwise it fails on `idpApiKeyId` with "That IDP key no longer exists." and writes nothing.
- **AC-3**: The edit button opens "Edit testbed". On open, the dialog calls `loadTestbedForEdit(id)` and shows a loading state until it returns; then it fills every field, including each client's OS username and password (masked, with a show toggle), and keeps those defaults for the life of the dialog (`useState`, the admin row edit rule). If the load finds the testbed gone, the dialog shows "This testbed no longer exists." and no form. If the saved IDP key is not among the live `IDP` options (soft deleted or changed to `AI` meanwhile), the select shows `None`. The dialog shows the access group name `pod-<slug>` read only, with the note "The owner binds this group to the lab's apps in Authentik." Saving, in one transaction: locks the testbed `FOR UPDATE`, requires it live and with a group pk, locks the chosen type `FOR SHARE` (live), locks the chosen IDP key as in AC-2, updates name, type, IDP, Portal URL, and LMS URL, then replaces the client rows as a set: delete all of the testbed's clients, then insert the form's rows with `position` from 0 in form order. The slug and the Authentik group never change, even on rename. A type change is allowed while the testbed has Upcoming or Current bookings; those bookings keep their own `testbed_type_id`, start, and end. A save that changes nothing (the five testbed fields equal, and the ordered client list equal in kind, name, URL, OS username, and OS password) writes nothing and still returns success. On success the action calls `revalidatePath("/admin", "layout")` and returns `{ kind: "saved", message: "Updated <name>." }`. Errors: a duplicate name gives the field error "A testbed with this name already exists." on `name`; a type deleted meanwhile gives "That type no longer exists." on `testbedTypeId`; a stale IDP id gives AC-2's `idpApiKeyId` error; a testbed deleted meanwhile gives the form level `message` "This testbed no longer exists." (and revalidates).
- **AC-4**: While a testbed is not ready (no group pk), its edit button is disabled with the tooltip "Still being set up", and the update action also refuses it with the form level `message` "This testbed is still being set up. Try again in a minute." Delete stays enabled for it.
- **AC-5**: An edit that changes something (any of the five testbed fields, or the client list alone) writes one `testbed.updated` audit row in the same transaction: target type `testbed`, target id the testbed id, summary "Testbed updated". Its metadata holds `changedFields` over `name`, `testbedTypeId`, `idpApiKeyId`, `portalUrl`, `lmsUrl`; plus `clients: { from: <count>, to: <count> }` when the client set differs in any kind, name, URL, OS username, or OS password; plus `accessChanged: true` when the Portal URL, the LMS URL, or the client set changed. No OS username or password value ever appears in audit metadata or a log line.
- **AC-6**: The delete button runs the delete flow (spec 0005). The check lists the testbed's live bookings (`provisioning` or `confirmed`) with `ends_at > now()`, ordered by start, each labelled `<learner name> — <phase> reservation` where phase is `Upcoming`, `Current`, or `Pending` from `bookingPhase` with `dbNow(trx)` read in the same transaction as the blocker query (the `ends_at > now()` filter stays in SQL). With any, the blocked dialog shows (spec 0005 copy, "Testbed has active reservations") and nothing changes. With none, the confirm dialog shows `Delete "<name>"? This can't be undone.` and the remove, in one transaction, runs `lockForDelete`, the blocker query again, sets `deleted_at = now()`, and writes `testbed.deleted` (target type `testbed`, summary "Testbed deleted", metadata `{ slug, groupPk }` with `groupPk` null for a not ready testbed). Both check and remove revalidate `/admin` as the layout. A booking made between check and remove shows the blocked dialog instead. After delete the testbed is gone from the list and is not bookable (spec 0002); its name is free for reuse, its slug is not.
- **AC-7**: Every worker tick, right after the access reconciler, a teardown step takes each testbed with `deleted_at` set, a group pk, and no `authentik_group_deleted_at`. For each, it first reads the group's members (`podGroupMembers`). If any member carries `hol_learner = true`, it logs a warning with the testbed id and that count and skips the row this tick (the reconciler removes them and ends their sessions first; a learner it cannot remove keeps the row pending, visibly in the log). Otherwise it calls `deletePodGroup(api, pk, testbedId)`, which rereads the group through the `pod-*` guard and refuses one whose `hol_testbed_id` is not this testbed's id; untagged members do not stop it. Outcomes: success, or `not_found` from either call (the group is already gone), stamps the row; `not_owned`, `not_pod_group`, and any Authentik failure log an error and leave the row for the next tick, never stamped. Stamping is one transaction: `update testbeds set authentik_group_deleted_at = now() where id = $1 and authentik_group_deleted_at is null`, plus an `authentik_group.deleted` audit row (target type `authentik_group`, target id the group pk, actor null, metadata `{ testbedId }`, summary "Access group of a deleted testbed removed", or "Access group of a deleted testbed was already gone" for `not_found`). A failure on one testbed is logged and the rest still run. The reconciler skips testbeds whose `authentik_group_deleted_at` is set.
- **AC-8**: The migration adds `testbeds.authentik_group_deleted_at` (with check `testbeds_group_deleted_after_delete_check`: null unless `deleted_at` is set) and `testbed_clients.os_username` and `os_password` (checks `testbed_clients_os_username_length_check` and `testbed_clients_os_password_length_check`: null or 1 to 200 characters; and `testbed_clients_password_needs_username_check`: a password needs a username). The names follow the repo's `_check` suffix and are a contract with `mapConstraintError`. `npm run db:codegen -- --verify` passes after it.
- **AC-9**: `loadTestbedForEdit`, `updateTestbedAction`, `checkTestbedDelete`, and `deleteTestbedAction` call `requireAdmin()`. A learner or anonymous caller gets the existing "not authorized" result and nothing is written. None of them is on the public allow list.
- **AC-10**: The string `os_password` appears in app code only in `server/catalog/testbeds.ts` (generated types and migrations aside), enforced by a source scan test like `tests/secret-column-scan.test.ts`. No learner facing page or public action selects it.

## Decision

**Chosen option**: Option 1: catalog CRUD on the existing saga, with group teardown owned by the worker.

The admin actions only touch the database (plus spec 0004's create saga). The worker tears down a deleted testbed's group after the reconciler empties it. The owner keeps binding groups to lab apps by hand, and client OS credentials are stored as plain text by the engineer's choice.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.claude/skills/vercel-react-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

One migration, `db/migrations/0006_testbed_admin.sql` (migration files number on their own; the last one is `0005_api_keys.sql`, so `0006` is right even though this spec is 0007). Everything else exists (spec 0002, spec 0006).

| Table | Change | Column | Type | Null | Rule |
|---|---|---|---|---|---|
| `testbeds` | new | `authentik_group_deleted_at` | timestamptz | yes | Set by the teardown step only. `testbeds_group_deleted_after_delete_check`: `authentik_group_deleted_at is null or deleted_at is not null` |
| `testbeds` | existing | `idp_api_key_id` | uuid | yes | FK `api_keys`. When set, names a live `IDP` key (checked under `FOR SHARE` in the action; spec 0006 AC-5 and AC-6 guard the key side) |
| `testbeds` | existing | `name`, `slug`, `testbed_type_id`, `portal_url`, `lms_url`, `authentik_group_pk`, `deleted_at` | | | Unchanged. Slug immutable (trigger), so the group name never changes |
| `testbed_clients` | new | `os_username` | text | yes | `testbed_clients_os_username_length_check`: null or `length between 1 and 200` |
| `testbed_clients` | new | `os_password` | text | yes | **Plain text.** `testbed_clients_os_password_length_check`: null or `length between 1 and 200`. `testbed_clients_password_needs_username_check`: `os_password is null or os_username is not null` |
| `testbed_clients` | existing | `kind`, `name`, `url`, `position` | | | Replaced as a set on every save (spec 0002). At most 20 per testbed (Zod only) |

Relationships are unchanged: `testbed_types` 1:N `testbeds` (RESTRICT) · `api_keys` 1:N `testbeds`, optional (RESTRICT) · `testbeds` 1:N `testbed_clients` (CASCADE) · `testbeds` 1:N `bookings` (RESTRICT).

No new index: the teardown query scans soft deleted testbeds, a handful of rows.

New audit actions in `lib/audit-actions.ts`: `testbed.updated`, `testbed.deleted`. Teardown reuses `authentik_group.deleted`.

### State transitions

**Testbed** (derived from columns):

| State | Columns | Bookable | Reconciled | Set by |
|---|---|---|---|---|
| Not ready | `deleted_at` null, group pk null | no | no | create saga insert |
| Ready | `deleted_at` null, group pk set | yes | yes | create saga stores the pk |
| Deleted, teardown pending | `deleted_at` set, group pk set, `authentik_group_deleted_at` null | no | yes, desired set empty | `deleteTestbed` |
| Deleted, torn down | all three set | no | no | teardown step |
| Hard deleted | row gone | | | create undo or `sweepTestbedCreates` (only ever with a null group pk, soft deleted or not) |

A not ready testbed that an admin soft deletes never gets its pk stored: the create saga's store step requires `deleted_at is null` (AC-2), so that create fails and undoes itself, and `sweepTestbedCreates` hard deletes whatever is left after 10 minutes (it keys on a null pk, soft deleted or not). A soft deleted row therefore has a group pk only if it was Ready when deleted.

Booking states are unchanged (spec 0002).

### API surface

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/admin/testbeds` | Server Component | none | rows per AC-1 (client count only, no client details), the type and IDP options | `requireAdmin()` | not authorized |
| `loadTestbedForEdit` (`app/admin/actions.ts`) | Server Action called by the edit dialog on open | `id`: uuid (checked with `z.uuid()`) | `Result<TestbedEditDefaults, 'not_found'>`: `name, slug, groupName, testbedTypeId, idpApiKeyId, portalUrl, lmsUrl, clients: readonly { kind, name, url, osUsername, osPassword }[]` | `requireAdmin()` | `not_found` for a bad id or a deleted testbed |
| `createTestbedAction` (`app/admin/actions.ts`, extended) | Server Action (`useActionState`) | spec 0004 inputs, plus `idpApiKeyId`: uuid or empty (opt), and per client `osUsername` (opt), `osPassword` (opt) | `AdminFormState` | `requireAdmin()` | `invalid`, `duplicate_name`, `type_not_found`, `idp_not_found`, `group_failed` |
| `updateTestbedAction` (`app/admin/actions.ts`) | Server Action, id bound by the page (`action.bind(null, id)`), checked with `z.uuid()` | same fields as create | `AdminFormState` | `requireAdmin()` | `invalid`, `duplicate_name`, `not_found`, `not_ready`, `type_not_found`, `idp_not_found` |
| `checkTestbedDelete` (`app/admin/actions.ts`) | `DeleteCheck` | `id` | `Result<readonly Blocker[], 'unavailable'>` | `requireAdmin()` | a bad id returns `[]` (the remove then reports gone) |
| `deleteTestbedAction` (`app/admin/actions.ts`) | `DeleteRemove` | `id` | `Result<void, DeleteRemoveError>` | `requireAdmin()` | `blocked` with blockers, `failed` "This testbed no longer exists." |

Server modules:

| Module / function | Signature | Notes |
|---|---|---|
| `lib/catalog-input.ts` `TestbedClientInput`, `TestbedInput` | adds `osUsername` (trimmed, empty to null, max 200), `osPassword` (not trimmed, empty to null, max 200, refined: needs `osUsername`), `idpApiKeyId` (`z.uuid()` or empty to null), `clients` `.max(20)` | Used by create and update. Field errors keyed `clients.N.osUsername` and so on through `fieldErrors`. |
| `server/catalog/testbeds.ts` `listTestbedsForAdmin` | `(conn) => Promise<readonly AdminTestbedRow[]>` | Replaces `listTestbeds` and `TestbedListRow` (their only users are the Testbeds page and `server/catalog/testbeds.test.ts`, whose `listTestbeds` tests move to it). One query: testbeds joined to type, left joined to the IDP key, with a client count subquery. Row: `id, name, typeName, idpName \| null, clientCount, groupReady`. No client details. |
| `server/catalog/testbeds.ts` `getTestbedForEdit` | `(conn, id) => Promise<Result<TestbedEditDefaults, 'not_found'>>` | The live testbed plus its clients by `position`, including OS credentials. Used only by `loadTestbedForEdit`. |
| `server/catalog/testbeds.ts` `createTestbed` | unchanged signature, error union gains `idp_not_found` | Adds the IDP lock and check inside `insertTestbedRow`, writes `idp_api_key_id`, `os_username`, `os_password`, and adds `.where("deleted_at", "is", null)` to the pk store update (AC-2). |
| `server/catalog/testbeds.ts` `updateTestbed` | `(conn, id, input, actorId) => Promise<Result<void, 'duplicate_name' \| 'not_found' \| 'not_ready' \| 'type_not_found' \| 'idp_not_found'>>` | AC-3 and AC-5 in one transaction. Compares before and after (the five testbed fields and the ordered client list) to skip a no change save. Client replace is delete all, then insert, so `testbed_clients_position_uq` never trips. Maps `testbeds_name_lower_uq` through `mapConstraintError`. |
| `server/catalog/testbeds.ts` `deleteTestbed` | `(conn, id, actorId) => Promise<Result<void, { kind: 'blocked'; blockers } \| { kind: 'not_found' }>>` | AC-6, the Testbed Types pattern. |
| `server/catalog/api-keys.ts` `listIdpKeyOptions` | `(conn) => Promise<readonly { id, name }[]>` | Live `IDP` keys by `lower(name)`. Never selects the secret. |
| `server/db/delete-blockers.ts` `testbedBlockers` | unchanged signature | Selects status, starts, ends, and the learner name (the `ends_at > now()` filter stays in SQL), reads `dbNow(trx)` in the same transaction, and labels each row with `bookingPhase` (AC-6). |
| `server/worker/teardown.ts` `teardownDeletedTestbeds` | `(api, conn) => Promise<void>` | AC-7, using the existing `podGroupMembers` and `deletePodGroup` (which already rereads the group and refuses `not_owned`). Per row try and log. |
| `server/worker/reconcile.ts` `reconcileAccess` | unchanged | Adds `.where("authentik_group_deleted_at", "is", null)`. |
| `worker/index.ts` | | Adds the step `{ name: "testbed teardown", run: () => teardownDeletedTestbeds(api, conn) }` right after the access reconciler. |
| `components/admin/testbed-fields.tsx` | `({ types, idps, defaults? })` | Adds the IDP select (a `defaults.idpApiKeyId` missing from `idps` shows `None`), the OS username and password inputs (password with a show toggle button, `aria-pressed`, `autocomplete="off"`), and the read only group name in edit mode. Kind options ordered `Wireless`, `Wired` (mock). The edit wrapper calls `loadTestbedForEdit` on open, shows a loading state, then mounts the fields with the result held in `useState`. |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| list | type name | `testbed_types.name` by `testbed_type_id` |
| list | IDP name or `—` | `api_keys.name` by `idp_api_key_id` (left join; a set key is always live, spec 0006 AC-6) |
| list | client count label | count of the row's `testbed_clients`, pluralized like Testbed Types' usage label |
| list | `Not ready` badge, edit disabled | `testbeds.authentik_group_pk is null` |
| list | search text | `<name> <type name> <IDP name>` built per row for `DataTable` (client side); the `—` placeholder is left out |
| add, edit | type options | `listTestbedTypes` (live types) |
| add, edit | IDP options | `listIdpKeyOptions` plus `None` |
| edit | prefilled fields and clients | `loadTestbedForEdit(id)` on dialog open, held in `useState` |
| edit | IDP shown when the saved key went stale | `None` (the saved id is not among `listIdpKeyOptions`) |
| edit | group name shown | `pod-<slug>` via `podGroupName(testbeds.slug)` |
| create, update | `idp_api_key_id` | form `idpApiKeyId`, empty to null, rechecked under `FOR SHARE` |
| create, update | `os_username`, `os_password` | form, per client row, empty to null |
| create, update | client `position` | form row order from 0 |
| update | success message | `Updated <parsed name>.` |
| update | `testbed.updated` metadata | before row and clients read under the `FOR UPDATE` lock vs the parsed input (AC-5) |
| delete check, remove | blocker label phase | `bookingPhase({ status, startsAt, endsAt }, await dbNow(trx))`, same transaction |
| delete | `testbed.deleted` metadata | `{ slug, groupPk: authentik_group_pk }` read under the `FOR UPDATE` lock |
| delete | `deleted_at` | DB `now()` |
| teardown | rows to process | `deleted_at is not null and authentik_group_pk is not null and authentik_group_deleted_at is null` |
| teardown | group owner check | `deletePodGroup`'s own reread of `attributes.hol_testbed_id` vs `testbeds.id` (`not_owned`) |
| teardown | tagged members left | `podGroupMembers` `holLearner` flags |
| teardown | `authentik_group_deleted_at` | DB `now()`, only `where authentik_group_deleted_at is null` |
| teardown | audit summary | removed, or already gone (`not_found`), per AC-7 |
| audit rows | actor | `requireAdmin()` session user; null for the worker |

### Key invariants

- The slug and the Authentik group of a testbed never change after create; a rename changes only `name`.
- Only the reconciler adds or removes `pod-*` members (spec 0001). The teardown step deletes the whole group, and only after no `hol_learner` member is left.
- The teardown never deletes a group whose `hol_testbed_id` is not the testbed's id.
- `authentik_group_deleted_at` is set only on a soft deleted row, only once, and only after Authentik confirmed the group is gone (deleted or 404).
- A create whose row was soft deleted mid saga never stores its group pk (AC-2).
- A testbed's `idp_api_key_id`, when set, names a live `IDP` key (the action's `FOR SHARE` recheck plus spec 0006's blockers close the race both ways).
- Edit, delete, and booking on one testbed serialize: edit and delete take `FOR UPDATE`, booking takes `FOR SHARE` (spec 0002 AC-14).
- OS credentials never reach a learner's browser, an audit row, or a log line. They leave the server only in the admin console and, later, in the learner's booking email (feature 15).

### Security model

- Every page and action here calls `requireAdmin()`; Authentik writes (create saga, teardown) use the provisioning token through the `pod-*` guard. No new Authentik rights.
- Admins can read every client's OS username and password in the edit dialog (they enter them; plain text by the engineer's choice). They are sent only by `loadTestbedForEdit`, one testbed at a time, when an admin opens its edit dialog; the list page never carries them.
- Client OS credentials are stored as **plain text**: a deliberate exception to the AGENTS.md "secrets at rest" rule, because they are shared lab VM logins that the booking email sends in clear to every learner of that testbed. Anyone who can read the database or a `pg_dump` can read them (accepted).
- AC-10's source scan keeps `os_password` out of every module but `server/catalog/testbeds.ts`, so a learner read path cannot pick it up by accident. Feature 15's email builder will be added to that scan's allow list on purpose.
- Audit metadata holds field names, ids, URLs, and counts, never credential values.

### Configuration required

None. Existing settings only (`DATABASE_*`, `AUTHENTIK_*` provisioning token, `WORKER_ENABLED`).

### Critical test scenarios

- Happy path (Playwright, `dev-` names): add a testbed with an IDP and two clients (one with OS credentials), see it in the list with the mock columns; edit it (rename, remove a client, change a password); delete it; it leaves the list. Verifies **AC-1**, **AC-2**, **AC-3**, **AC-6**.
- Search: filters by name, type, and IDP name, ignoring case. Verifies **AC-1**.
- Parse (unit): 21 clients refused; a password without a username refused on `clients.N.osUsername`; empty username and password stored as null; a password with spaces kept as typed; an empty IDP becomes null. Verifies **AC-2**.
- IDP race (DB, rolled back): an IDP key soft deleted, or changed to `AI`, before the save gives `idp_not_found` and writes nothing. Verifies **AC-2**, **AC-3**.
- Edit load: `loadTestbedForEdit` returns the clients with credentials for a live testbed and `not_found` for a deleted one; the list page payload holds no `osPassword`; a stale IDP shows `None`. Verifies **AC-1**, **AC-3**.
- Create vs delete race (DB plus fake Authentik): soft delete the row between insert and pk store; the create returns `group_failed`, no pk is stored, and the undo or sweeper removes the group and row. Verifies **AC-2**.
- Update (DB, rolled back): rename keeps slug and group pk; a clients only change is saved and audited; a type change with a Current booking succeeds and the booking keeps its type and times; a duplicate name maps to the field error; a deleted testbed gives `not_found`; a not ready testbed gives `not_ready`; a no change save writes no row and no audit. Verifies **AC-3**, **AC-4**.
- Audit (DB, rolled back): a client password change writes `clients` counts and `accessChanged: true` and no credential value anywhere in the row; a name only change has no `accessChanged`. Verifies **AC-5**.
- Delete (DB, rolled back): a Current and an Upcoming booking block it with labels `<name> — Current reservation` and `<name> — Upcoming reservation`; a Past booking does not block; after delete the testbed is not bookable and its name can be reused. Verifies **AC-6**.
- Teardown (fake Authentik): a deleted testbed whose group still has a tagged learner is skipped and logged with the count; after the reconciler removes them, it is deleted and stamped once; a 404 on the member read or on delete is stamped as already gone; `not_owned` (another `hol_testbed_id`) and `not_pod_group` are left unstamped and logged; an untagged member does not stop the delete; one failing row does not stop the next; the reconciler ignores a stamped row. Verifies **AC-7**.
- Migration: the four checks refuse bad rows; codegen verify passes. Verifies **AC-8**.
- Auth: a learner session calling each new action gets not authorized and writes nothing; the allow list test passes unchanged. Verifies **AC-9**.
- Source scan: `os_password` appears only in `server/catalog/testbeds.ts` among app files. Verifies **AC-10**.

The real teardown against Authentik runs in the production worker (one host), so `/check verify` confirms it by deleting a `dev-` testbed and watching its `pod-<slug>` group disappear and the row get stamped within a tick or two.

## Build plan

Tracer Bullet: thicken the existing create thread into full CRUD one strand at a time (data and add, then edit, then delete, then the worker teardown), each strand working end to end before the next.

1. [x] Migration `0006_testbed_admin.sql` (four named checks, two client columns, the teardown column), `db:codegen`, and the new audit actions. Satisfies **AC-8**
2. [x] Add strand: extend `TestbedInput` (OS credentials, IDP, at most 20 clients), `createTestbed` (IDP lock, new columns, the `deleted_at is null` pk store), `listIdpKeyOptions`, `listTestbedsForAdmin` (moving the `listTestbeds` tests), the add form fields (IDP select, OS inputs with show toggle, kind order), and the mock list columns with the `Not ready` badge and search. Satisfies **AC-1**, **AC-2**
3. [x] Edit strand: `getTestbedForEdit` and `loadTestbedForEdit`; `updateTestbed` with locks, no change skip, and the AC-5 audit; `updateTestbedAction`; the edit dialog that loads on open, the read only group name, and the disabled edit for not ready rows. Satisfies **AC-3**, **AC-4**, **AC-5**, **AC-9**
4. [x] Delete strand: `testbedBlockers` with phase labels, `deleteTestbed`, `checkTestbedDelete`, `deleteTestbedAction`, and the delete flow wiring on the page. Satisfies **AC-6**, **AC-9**
5. [x] Teardown strand: `server/worker/teardown.ts` (on the existing `podGroupMembers` and `deletePodGroup`), the reconciler filter, and the worker step, with fake Authentik tests. Satisfies **AC-7**
6. [x] Guards and end to end: the `os_password` source scan, the auth tests for the new actions, and the Playwright happy path. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-6**, **AC-9**, **AC-10**

## Consequences

**Positive**:
- The catalog becomes fully manageable from the console, matching the mock.
- Group teardown has one owner (the worker), retries by itself every tick, and reuses the reconciler's session cut off, so no deleted testbed leaves a learner in the lab.
- No new Authentik rights or credentials: the provisioning token already creates and deletes `pod-*` groups.
- The IDP key relation is now enforced from both sides (spec 0006 follow up closed).

**Negative / tradeoffs**:
- Client OS passwords sit in plain text in the database and in every `pg_dump`. Anyone with database or backup access can read them. Moving to encryption later needs a migration and either a backfill or admins entering them again.
- An open edit dialog holds that testbed's OS passwords in the admin's browser (masked on screen only), and opening it costs one extra server round trip.
- The owner must still bind each new group to the Nile tenant SAML app, Moodle, and the Cloudflare Access apps by hand, and unbind or remove those apps when a testbed is deleted. Until bound, a ready testbed can be booked but its URLs do not let the learner in.
- A URL edit does not change any Authentik or Cloudflare setup; the owner updates those by hand.
- A deleted testbed's group lingers until the worker runs (up to about 30 seconds, longer if the worker is down). Nothing can be booked on it meanwhile.
- A type change leaves existing bookings on the old type's duration. Availability stays correct (busy ranges are per testbed), but the admin may see mixed types on one testbed's bookings.
- Until feature 15 ships, an edit to URLs or credentials only records `accessChanged`; learners who already booked are not told.
- Concurrent edits by two admins are last write wins (as in features 7 and 8).

**Neutral**:
- `listTestbeds` and `TestbedListRow` are removed in favor of `listTestbedsForAdmin`; only the Testbeds page and its tests used them.
- Client rows are replaced on every save, so their ids change (nothing references them).
- A teardown stuck on a foreign `hol_testbed_id` logs an error every tick until the owner fixes the group.

## Follow-up

- [ ] Scope row 9 (`/scope`): reword "protects its URLs with it; editing the URLs updates that protection" and the done line "its URLs are reachable only by members of that group" to "creates its Authentik group, which the owner binds to the lab's apps by hand (spec 0001)"; note the client OS username and password.
- [ ] Feature 15: the booking email and calendar invite include each client's OS username and password (built server side, never in a browser), and a `testbed.updated` with `accessChanged: true` sends an updated access email to learners with Upcoming or Current bookings on that testbed. Add the email builder to the `os_password` scan allow list.
- [ ] Feature 14: the lab access screens list clients (name, kind, URL) but never OS credentials (engineer call 2026-10-10).
- [ ] Spec 0002: its follow ups "testbed delete saga that removes the Authentik group" and "create saga sets `authentik_group_pk`" are settled here and in spec 0004; its `testbeds` and `testbed_clients` tables gain the columns above.
- [ ] Spec 0006 follow up (IDP select lists live `IDP` keys; save locks the key `FOR SHARE` and rechecks) is built here.
- [ ] `/sync`: record in AGENTS.md that client OS credentials are plain text by design (the exception to "secrets at rest") and guarded by the `os_password` source scan, and that the worker owns pod group teardown.
- [ ] Owner runbook: when a testbed is added, bind `pod-<slug>` to its Nile tenant SAML app, Moodle, and its VM Cloudflare Access apps; when deleted, remove those bindings or apps.
