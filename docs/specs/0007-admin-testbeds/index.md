# 0007. Admin Testbeds

**Date**: 2026-10-10
**Status**: Accepted

## Summary

Admins get the full Testbeds screen from the mock: list, search, add, edit, and delete testbeds, each with a type, an optional IDP key, Nile Portal and LMS URLs, and up to 20 wired or wireless clients. Each client can carry an OS username and password that the learner later gets in the booking email. Deleting a testbed hides it at once, and the background worker then releases its Authentik group (it never deletes it). The groups belong to the owner, who makes and marks them in Authentik; the app only checks the name and adds or removes learners (spec 0017). This feature adds no new Authentik rights.

**Amended 2026-10-24** to match what shipped under spec 0017 (testbed domain and predefined groups) and spec 0018 (testbed friendly name). Where those specs and this one disagree, they win. The reasoning in `rationale.md` is the original record and is not rewritten. The `Not ready` state, the `pod-<slug>` group, the create saga with its undo and sweeper, and the group teardown no longer exist.

## Requirements

**User stories**:
- As an admin, I want to add, edit, and delete testbeds from the console, so that the bookable catalog matches the real labs.
- As an admin, I want to record each client's OS login on the testbed, so that learners get everything they need to use the lab in their booking email.
- As the owner, I want a deleted testbed's access group to disappear from Authentik on its own, so that no stale group grants access to anything.

**Acceptance criteria**:
- **AC-1**: `/admin/testbeds` lists live testbeds (not soft deleted) by `lower(name)` with the columns Name, Group Name, Testbed type, Domain, IDP (the key's name, or `—` when none), Clients (`1 client`, `3 clients`, `0 clients`), and Actions (edit, delete) (amended 2026-10-24, spec 0017 AC-8 and spec 0018 AC-8). There is no `Not ready` badge and no access group column. Search ("Search by name, group name, type, domain, or IDP…") runs client side in `DataTable` over the row's `search` text, `<name> <group name> <type name> <domain> <IDP name>`, ignoring case; the `—` placeholder is not part of it. The list payload carries no client details (only the count), so no OS credential is sent until an edit dialog opens (AC-3).
- **AC-2**: "Add testbed" opens the form with: Name, Group Name, Domain, type (live types), IDP (live `IDP` keys by name, plus `None`, default `None`), Nile Portal URL, LMS URL, and client rows. Each client row has kind (`Wireless` or `Wired`, default `Wireless`), name, URL, OS username, and OS password (masked, with a show toggle), plus a remove button; "Add client" appends a row. Saving follows spec 0017 AC-2 and AC-3 and spec 0018 AC-3 (amended 2026-10-24): the duplicate checks run first (Name, then Group Name, then Domain), then one lookup of the owner's Authentik group by Group Name, then one transaction that inserts the testbed with its group pk and its clients, and also stores `idp_api_key_id` and each client's OS username and password. The old row first group saga, its in line undo, and `sweepTestbedCreates` are gone. Inputs: spec 0004 AC-2's rules, plus at most 20 clients ("Use at most 20 clients."), OS username trimmed and 0 to 200 characters (empty means none), OS password kept exactly as typed and 0 to 200 characters (empty means none), and a password without a username is refused on `clients.N.osUsername` ("Enter the OS username for this password."). When an IDP is chosen, the save locks that key `FOR SHARE` and requires `type = 'IDP' and deleted_at is null`; otherwise it fails on `idpApiKeyId` with "That IDP key no longer exists." and writes nothing.
- **AC-3**: The edit button opens "Edit testbed". On open, the dialog calls `loadTestbedForEdit(id)` and shows a loading state until it returns; then it fills every field, including each client's OS username and password (masked, with a show toggle), and keeps those defaults for the life of the dialog (`useState`, the admin row edit rule). If the load finds the testbed gone, the dialog shows "This testbed no longer exists." and no form. If the saved IDP key is not among the live `IDP` options (soft deleted or changed to `AI` meanwhile), the select shows `None`. The dialog shows Name as an editable field and Group Name read only, with the note "The group name can't change. To use another group, delete this testbed and add a new one." (spec 0018 AC-2) Saving, in one transaction: locks the testbed `FOR UPDATE`, requires it live, locks the chosen type `FOR SHARE` (live), locks the chosen IDP key as in AC-2, updates name, type, IDP, domain, Portal URL, and LMS URL, then replaces the client rows as a set: delete all of the testbed's clients, then insert the form's rows with `position` from 0 in form order. The slug and the Group Name never change; a rename changes only the learner facing Name (spec 0018 AC-4). A type change is allowed while the testbed has Upcoming or Current bookings; those bookings keep their own `testbed_type_id`, start, and end. A save that changes nothing (the six testbed fields equal, and the ordered client list equal in kind, name, URL, OS username, and OS password) writes nothing and still returns success. On success the action calls `revalidatePath("/admin", "layout")` and returns `{ kind: "saved", message: "Updated <name>." }`. Errors: a duplicate name gives the field error "A testbed with this name already exists." on `name`; a type deleted meanwhile gives "That type no longer exists." on `testbedTypeId`; a stale IDP id gives AC-2's `idpApiKeyId` error; a testbed deleted meanwhile gives the form level `message` "This testbed no longer exists." (and revalidates). Amended 2026-10-24: the error order and the domain messages (`domain_locked`, `duplicate_domain`) are those of spec 0017 AC-6 and spec 0018 AC-4.
- **AC-4** (removed 2026-10-24, spec 0017 AC-8): a live testbed always has a group pk (the database check `testbeds_live_group_check`), so there is no Not ready state, no disabled edit button, and no `not_ready` refusal.
- **AC-5**: An edit that changes something (any of the six testbed fields, or the client list alone) writes one `testbed.updated` audit row in the same transaction: target type `testbed`, target id the testbed id, summary "Testbed updated". Its metadata holds `changedFields` over `name`, `testbedTypeId`, `idpApiKeyId`, `portalUrl`, `lmsUrl`, `domain` (`groupName` cannot change, so it is not listed); plus `clients: { from: <count>, to: <count> }` when the client set differs in any kind, name, URL, OS username, or OS password; plus `accessChanged: true` when the Portal URL, the LMS URL, or the client set changed. No OS username or password value ever appears in audit metadata or a log line.
- **AC-6**: The delete button runs the delete flow (spec 0005). The check lists the testbed's live bookings (`provisioning` or `confirmed`) with `ends_at > now()`, ordered by start, each labelled `<learner name> — <phase> reservation` where phase is `Upcoming`, `Current`, or `Pending` from `bookingPhase` with `dbNow(trx)` read in the same transaction as the blocker query (the `ends_at > now()` filter stays in SQL). With any, the blocked dialog shows (spec 0005 copy, "Testbed has active reservations") and nothing changes. With none, the confirm dialog shows `Delete "<name>"? This can't be undone.` and the remove, in one transaction, runs `lockForDelete`, the blocker query again, sets `deleted_at = now()`, and writes `testbed.deleted` (target type `testbed`, summary "Testbed deleted", metadata `{ slug, groupPk }` with `groupPk` null for a not ready testbed). Both check and remove revalidate `/admin` as the layout. A booking made between check and remove shows the blocked dialog instead. After delete the testbed is gone from the list and is not bookable (spec 0002); its name is free for reuse, its slug is not.
- **AC-7** (amended 2026-10-24, spec 0017 AC-9, built as `server/worker/release.ts`): every worker tick, right after the access reconciler, a release step takes each soft deleted testbed that has a group pk and no `authentik_group_deleted_at`. It never deletes the group. It stamps the row when the group is gone, has no member tagged `hol_learner`, or is held by a live testbed with the same pk; a tagged member skips the row with a warning until the reconciler removes them. Each stamp is one transaction with an `authentik_group.released` audit row. The full rules are in spec 0017 AC-9. The old teardown (`teardown.ts`, `deletePodGroup`, the `hol_testbed_id` check) is removed.
- **AC-8**: The migration adds `testbeds.authentik_group_deleted_at` (with check `testbeds_group_deleted_after_delete_check`: null unless `deleted_at` is set) and `testbed_clients.os_username` and `os_password` (checks `testbed_clients_os_username_length_check` and `testbed_clients_os_password_length_check`: null or 1 to 200 characters; and `testbed_clients_password_needs_username_check`: a password needs a username). The names follow the repo's `_check` suffix and are a contract with `mapConstraintError`. `npm run db:codegen -- --verify` passes after it. Amended 2026-10-24: `authentik_group_deleted_at` now means the app is done with the group (released), not that the group was deleted (spec 0017).
- **AC-9**: `loadTestbedForEdit`, `updateTestbedAction`, `checkTestbedDelete`, and `deleteTestbedAction` call `requireAdmin()`. A learner or anonymous caller gets the existing "not authorized" result and nothing is written. None of them is on the public allow list.
- **AC-10**: The string `os_password` appears in app code only in `server/catalog/testbeds.ts` (generated types and migrations aside), enforced by the source scan `tests/os-password-scan.test.ts` (modelled on `tests/secret-column-scan.test.ts`). No learner facing page or public action selects it.
- **AC-11** (amended 2026-10-20, built with feature 15's email): the booked, rescheduled, and reminder emails show each client's OS login under that client's link: "Username: <os_username>" and, when one is set, "Password: <os_password>" (no Password line when it is null), in the HTML (values in a monospace span) and the plain text parts. Only client rows carry a login, never the Nile Portal or LMS rows; a client with no username shows no login lines. The reminder carries the logins to the learner like the booked email, and never has a Bcc (spec 0015 AC-9). A cancellation shows none: the email kind decides it, so the logins are not even read. The worker reads the logins at send time with `clientLoginsForBooking(conn, bookingId)` in `server/catalog/testbeds.ts` (the booking's testbed's clients with a username, by `position`), inside the send job's transaction, and hands them only to the renderer. They are never written to `email_messages.details`, `jobs.payload`, `last_error`, a log line, or audit metadata, so the queued snapshot (spec 0013 AC-11, spec 0015 AC-5) still holds none. A login shows under a snapshot client only when its name and URL both equal the snapshot's exactly (plain string equality, no trimming or case folding; if two clients of a testbed share both, the first by `position` wins). So a client edited after the email was queued shows no login rather than another client's, and an email still queued when a reschedule moved its booking to another testbed shows no logins at all (its links name the old testbed; the rescheduled email carries the new testbed's links and logins). Each send attempt reads the logins again; a failed attempt's `last_error` holds only the Gmail status. The read ignores `testbeds.deleted_at` on purpose: a testbed with live bookings cannot be deleted (AC-6), and an email whose booking has ended is suppressed (spec 0013 AC-18). The calendar invite (`.ics`) carries no login. The AC-10 allow list stays this one file.

## Decision

**Chosen option**: Option 1: catalog CRUD, with group release owned by the worker (amended 2026-10-24: the create saga and the teardown were replaced by specs 0017 and 0018).

The admin actions touch the database, plus one read of the owner's Authentik group at create (spec 0017). The worker releases a deleted testbed's group after the reconciler empties it, and never deletes it. The owner makes the groups and binds them to lab apps by hand, and client OS credentials are stored as plain text by the engineer's choice.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.claude/skills/vercel-react-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

### Data model sketch

One migration, `db/migrations/0006_testbed_admin.sql` (migration files number on their own; the last one is `0005_api_keys.sql`, so `0006` is right even though this spec is 0007). Everything else exists (spec 0002, spec 0006).

| Table | Change | Column | Type | Null | Rule |
|---|---|---|---|---|---|
| `testbeds` | new | `authentik_group_deleted_at` | timestamptz | yes | Set by the release step only (spec 0017; it means the app is done with the group). `testbeds_group_deleted_after_delete_check`: `authentik_group_deleted_at is null or deleted_at is not null` |
| `testbeds` | existing | `idp_api_key_id` | uuid | yes | FK `api_keys`. When set, names a live `IDP` key (checked under `FOR SHARE` in the action; spec 0006 AC-5 and AC-6 guard the key side) |
| `testbeds` | existing | `name`, `slug`, `testbed_type_id`, `portal_url`, `lms_url`, `authentik_group_pk`, `deleted_at` | | | Unchanged by this spec. Later: `name` is the editable learner facing name and `group_name` holds the Authentik group (spec 0018), `domain` is new (spec 0017). Slug immutable (trigger) |
| `testbed_clients` | new | `os_username` | text | yes | `testbed_clients_os_username_length_check`: null or `length between 1 and 200` |
| `testbed_clients` | new | `os_password` | text | yes | **Plain text.** `testbed_clients_os_password_length_check`: null or `length between 1 and 200`. `testbed_clients_password_needs_username_check`: `os_password is null or os_username is not null` |
| `testbed_clients` | existing | `kind`, `name`, `url`, `position` | | | Replaced as a set on every save (spec 0002). At most 20 per testbed (Zod only) |

Relationships are unchanged: `testbed_types` 1:N `testbeds` (RESTRICT) · `api_keys` 1:N `testbeds`, optional (RESTRICT) · `testbeds` 1:N `testbed_clients` (CASCADE) · `testbeds` 1:N `bookings` (RESTRICT).

No new index: the release query scans soft deleted testbeds, a handful of rows.

New audit actions in `lib/audit-actions.ts`: `testbed.updated`, `testbed.deleted`. Release writes `authentik_group.released` (spec 0017); `authentik_group.deleted` stays in the enum so old rows read.

### State transitions

**Testbed** (derived from columns):

| State | Columns | Bookable | Reconciled | Set by |
|---|---|---|---|---|
| Live | `deleted_at` null, group pk set, domain set | yes | yes | `createTestbed` (one insert, spec 0017) |
| Deleted, release pending | `deleted_at` set, group pk set, `authentik_group_deleted_at` null | no | yes, desired set empty (unless a live testbed holds the same pk) | `deleteTestbed` |
| Deleted, released | all three set | no | no | release step |

Amended 2026-10-24: the Not ready state and the hard delete by the create undo no longer exist (spec 0017). A soft deleted row always has a group pk.

Booking states are unchanged (spec 0002).

### API surface

| Surface | Kind | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/admin/testbeds` | Server Component | none | rows per AC-1 (client count only, no client details), the type and IDP options | `requireAdmin()` | not authorized |
| `loadTestbedForEdit` (`app/admin/actions.ts`) | Server Action called by the edit dialog on open | `id`: uuid (checked with `z.uuid()`) | `Result<TestbedEditDefaults, 'not_found'>`: `name, slug, groupName, domain, testbedTypeId, idpApiKeyId, portalUrl, lmsUrl, clients: readonly { kind, name, url, osUsername, osPassword }[]` | `requireAdmin()` | `not_found` for a bad id or a deleted testbed |
| `createTestbedAction` (`app/admin/actions.ts`, extended) | Server Action (`useActionState`) | spec 0004 inputs, plus `groupName`, `domain`, `idpApiKeyId`: uuid or empty (opt), and per client `osUsername` (opt), `osPassword` (opt) | `AdminFormState` | `requireAdmin()` | `invalid`, `duplicate_name`, `duplicate_group_name`, `duplicate_domain`, `group_not_found`, `group_not_testbed_group`, `group_in_use`, `authentik_unavailable`, `type_not_found`, `idp_not_found` |
| `updateTestbedAction` (`app/admin/actions.ts`) | Server Action, id bound by the page (`action.bind(null, id)`), checked with `z.uuid()` | the create fields except `groupName` | `AdminFormState` | `requireAdmin()` | `invalid`, `duplicate_name`, `duplicate_domain`, `domain_locked`, `not_found`, `type_not_found`, `idp_not_found` |
| `checkTestbedDelete` (`app/admin/actions.ts`) | `DeleteCheck` | `id` | `Result<readonly Blocker[], 'unavailable'>` | `requireAdmin()` | a bad id returns `[]` (the remove then reports gone) |
| `deleteTestbedAction` (`app/admin/actions.ts`) | `DeleteRemove` | `id` | `Result<void, DeleteRemoveError>` | `requireAdmin()` | `blocked` with blockers, `failed` "This testbed no longer exists." |

Server modules:

| Module / function | Signature | Notes |
|---|---|---|
| `lib/catalog-input.ts` `TestbedClientInput`, `TestbedInput` | adds `osUsername` (trimmed, empty to null, max 200), `osPassword` (not trimmed, empty to null, max 200, refined: needs `osUsername`), `idpApiKeyId` (`z.uuid()` or empty to null), `clients` `.max(20)` | Used by create and update. Field errors keyed `clients.N.osUsername` and so on through `fieldErrors`. |
| `server/catalog/testbeds.ts` `listTestbedsForAdmin` | `(conn) => Promise<readonly AdminTestbedRow[]>` | Replaces `listTestbeds` and `TestbedListRow` (their only users are the Testbeds page and `server/catalog/testbeds.test.ts`, whose `listTestbeds` tests move to it). One query: testbeds joined to type, left joined to the IDP key, with a client count subquery. Row: `id, name, typeName, idpName \| null, clientCount, groupReady`. No client details. |
| `server/catalog/testbeds.ts` `clientLoginsForBooking` (amended 2026-10-20) | `(conn, bookingId) => Promise<readonly ClientLogin[]>` | AC-11. Joins `bookings` to `testbed_clients` on `testbed_id`, keeps rows with `os_username` set, orders by `position`. `ClientLogin` (`lib/booking-email.ts`): `{ name, url, username, password \| null }`; `loginFor(logins, client)` matches by name and URL. Used only by `runSendEmail` (`server/jobs/send-email.ts`). |
| `server/catalog/testbeds.ts` `getTestbedForEdit` | `(conn, id) => Promise<Result<TestbedEditDefaults, 'not_found'>>` | The live testbed plus its clients by `position`, including OS credentials. Used only by `loadTestbedForEdit`. |
| `server/catalog/testbeds.ts` `createTestbed` | `(api, conn, input, actorId)` per spec 0017 and spec 0018 | Duplicate reads (Name, Group Name, Domain), the group lookup, then one transaction. Adds the IDP lock and check, and writes `idp_api_key_id`, `os_username`, `os_password`. The pk store step and its `deleted_at is null` guard went with the saga. |
| `server/catalog/testbeds.ts` `updateTestbed` | `(conn, id, input, actorId) => Promise<Result<void, 'duplicate_name' \| 'duplicate_domain' \| 'domain_locked' \| 'not_found' \| 'type_not_found' \| 'idp_not_found'>>` | AC-3 and AC-5 in one transaction. Compares before and after (the five testbed fields and the ordered client list) to skip a no change save. Client replace is delete all, then insert, so `testbed_clients_position_uq` never trips. Maps `testbeds_name_lower_uq` through `mapConstraintError`. |
| `server/catalog/testbeds.ts` `deleteTestbed` | `(conn, id, actorId) => Promise<Result<void, { kind: 'blocked'; blockers } \| { kind: 'not_found' }>>` | AC-6, the Testbed Types pattern. |
| `server/catalog/api-keys.ts` `listIdpKeyOptions` | `(conn) => Promise<readonly { id, name }[]>` | Live `IDP` keys by `lower(name)`. Never selects the secret. |
| `server/db/delete-blockers.ts` `testbedBlockers` | unchanged signature | Selects status, starts, ends, and the learner name (the `ends_at > now()` filter stays in SQL), reads `dbNow(trx)` in the same transaction, and labels each row with `bookingPhase` (AC-6). |
| `server/worker/release.ts` `releaseDeletedTestbeds` | `(api, conn) => Promise<void>` | AC-7 (spec 0017 AC-9). Replaces `teardown.ts`. Per row try and log; deletes no group. |
| `server/worker/reconcile.ts` `reconcileAccess` | unchanged | Adds `.where("authentik_group_deleted_at", "is", null)`. |
| `worker/index.ts` | | Has the step `testbed release` (`releaseDeletedTestbeds`) right after the access reconciler (replaced the `testbed teardown` step). |
| `components/admin/testbed-fields.tsx` | `({ types, idps, defaults? })` | Adds the IDP select (a `defaults.idpApiKeyId` missing from `idps` shows `None`), the OS username and password inputs (password with a show toggle button, `aria-pressed`, `autocomplete="off"`), the Name, Group Name, and Domain fields, and the Group Name read only in edit mode. Kind options ordered `Wireless`, `Wired` (mock). The edit wrapper calls `loadTestbedForEdit` on open, shows a loading state, then mounts the fields with the result held in `useState`. |

### Value sourcing

| Action | Value | Source |
|---|---|---|
| list | type name | `testbed_types.name` by `testbed_type_id` |
| list | IDP name or `—` | `api_keys.name` by `idp_api_key_id` (left join; a set key is always live, spec 0006 AC-6) |
| list | client count label | count of the row's `testbed_clients`, pluralized like Testbed Types' usage label |
| list | Group Name and Domain columns | `testbeds.group_name` and `testbeds.domain` (no Not ready badge, spec 0017 AC-8) |
| list | search text | `<name> <group name> <type name> <domain> <IDP name>` built per row for `DataTable` (client side); the `—` placeholder is left out |
| add, edit | type options | `listTestbedTypes` (live types) |
| add, edit | IDP options | `listIdpKeyOptions` plus `None` |
| edit | prefilled fields and clients | `loadTestbedForEdit(id)` on dialog open, held in `useState` |
| edit | IDP shown when the saved key went stale | `None` (the saved id is not among `listIdpKeyOptions`) |
| edit | Group Name shown read only | `testbeds.group_name`, loaded by `loadTestbedForEdit` |
| create, update | `idp_api_key_id` | form `idpApiKeyId`, empty to null, rechecked under `FOR SHARE` |
| create, update | `os_username`, `os_password` | form, per client row, empty to null |
| booked, rescheduled, reminder email | each client's login | `clientLoginsForBooking(trx, email_messages.booking_id)` at send time, matched to `details.links.clients` by name and URL (AC-11) |
| create, update | client `position` | form row order from 0 |
| update | success message | `Updated <parsed name>.` |
| update | `testbed.updated` metadata | before row and clients read under the `FOR UPDATE` lock vs the parsed input (AC-5) |
| delete check, remove | blocker label phase | `bookingPhase({ status, startsAt, endsAt }, await dbNow(trx))`, same transaction |
| delete | `testbed.deleted` metadata | `{ slug, groupPk: authentik_group_pk }` read under the `FOR UPDATE` lock |
| delete | `deleted_at` | DB `now()` |
| release | rows to process | `deleted_at is not null and authentik_group_pk is not null and authentik_group_deleted_at is null` |
| release | tagged members left | `testbedGroupMembers` `holLearner` flags (spec 0017 AC-9) |
| release | `authentik_group_deleted_at` | DB `now()`, only `where authentik_group_deleted_at is null` |
| release | audit row | `authentik_group.released`, metadata `{ testbedId, reason }` (spec 0017 AC-9) |
| audit rows | actor | `requireAdmin()` session user; null for the worker |

### Key invariants

- The slug and the Group Name of a testbed never change after create; a rename changes only the learner facing `name` (spec 0018).
- Only the reconciler adds or removes group members (spec 0001). The release step never deletes a group (spec 0017).
- The app never creates, updates, or deletes an Authentik group (spec 0017 AC-4).
- `authentik_group_deleted_at` is set only on a soft deleted row, only once, and only after the group is gone, drained, or held by a live testbed (released).
- A live testbed always has a group pk and a domain (spec 0017 AC-11).
- A testbed's `idp_api_key_id`, when set, names a live `IDP` key (the action's `FOR SHARE` recheck plus spec 0006's blockers close the race both ways).
- Edit, delete, and booking on one testbed serialize: edit and delete take `FOR UPDATE`, booking takes `FOR SHARE` (spec 0002 AC-14).
- OS credentials never reach a learner's browser, an audit row, or a log line. They leave the server only in the admin console and in the learner's booked, rescheduled, and reminder emails (AC-11), and are never copied into an email or job row.

### Security model

- Every page and action here calls `requireAdmin()`; Authentik is read at save time and written only for membership, with the provisioning token through the marker guard (spec 0017). No new Authentik rights.
- Admins can read every client's OS username and password in the edit dialog (they enter them; plain text by the engineer's choice). They are sent only by `loadTestbedForEdit`, one testbed at a time, when an admin opens its edit dialog; the list page never carries them.
- Client OS credentials are stored as **plain text**: a deliberate exception to the AGENTS.md "secrets at rest" rule, because they are shared lab VM logins that the booking email sends in clear to every learner of that testbed. Anyone who can read the database or a `pg_dump` can read them (accepted).
- AC-10's source scan keeps `os_password` out of every module but `server/catalog/testbeds.ts`, so a learner read path cannot pick it up by accident. The booking email reads them through `clientLoginsForBooking` in that same module (AC-11), so the allow list stays one file.
- The ops BCC mailbox (spec 0013) gets a copy of each booked and rescheduled email to a real address, so it receives the OS logins too and should stay a restricted internal mailbox. Reminders carry no Bcc (spec 0015 AC-9). Kept by the engineer on 2026-10-20 (runner up: leave the password out of the Bcc copy).
- A test learner's email (`dev-`, `hol-test-`, and so on) goes to the `GOOGLE` key's dev inbox with no Bcc (spec 0013 AC-16), so that owner controlled mailbox receives the real OS logins of whatever testbed the test booked.
- Audit metadata holds field names, ids, URLs, and counts, never credential values.

### Configuration required

None. Existing settings only (`DATABASE_*`, `AUTHENTIK_*` provisioning token, `WORKER_ENABLED`).

### Critical test scenarios

- Happy path (Playwright, `dev-` names): add a testbed with an IDP and two clients (one with OS credentials), see it in the list with the mock columns; edit it (rename, remove a client, change a password); delete it; it leaves the list. Verifies **AC-1**, **AC-2**, **AC-3**, **AC-6**.
- Search: filters by name, type, and IDP name, ignoring case. Verifies **AC-1**.
- Parse (unit): 21 clients refused; a password without a username refused on `clients.N.osUsername`; empty username and password stored as null; a password with spaces kept as typed; an empty IDP becomes null. Verifies **AC-2**.
- IDP race (DB, rolled back): an IDP key soft deleted, or changed to `AI`, before the save gives `idp_not_found` and writes nothing. Verifies **AC-2**, **AC-3**.
- Edit load: `loadTestbedForEdit` returns the clients with credentials for a live testbed and `not_found` for a deleted one; the list page payload holds no `osPassword`; a stale IDP shows `None`. Verifies **AC-1**, **AC-3**.
- Create (DB plus fake Authentik): replaced by spec 0017's and spec 0018's create scenarios, since the row first saga and its race no longer exist. Verifies **AC-2**.
- Update (DB, rolled back): rename keeps slug and group pk; a clients only change is saved and audited; a type change with a Current booking succeeds and the booking keeps its type and times; a duplicate name maps to the field error; a deleted testbed gives `not_found`; a no change save writes no row and no audit. Verifies **AC-3**.
- Audit (DB, rolled back): a client password change writes `clients` counts and `accessChanged: true` and no credential value anywhere in the row; a name only change has no `accessChanged`. Verifies **AC-5**.
- Delete (DB, rolled back): a Current and an Upcoming booking block it with labels `<name> — Current reservation` and `<name> — Upcoming reservation`; a Past booking does not block; after delete the testbed is not bookable and its name can be reused. Verifies **AC-6**.
- Release (fake Authentik): see spec 0017's Release scenario. A drained or missing group is stamped and never deleted; a tagged member skips the row with a warning; a live testbed with the same pk stamps the old row at once; one failing row does not stop the next; the reconciler ignores a stamped row. Verifies **AC-7**.
- Migration: the four checks refuse bad rows; codegen verify passes. Verifies **AC-8**.
- Auth: a learner session calling each new action gets not authorized and writes nothing; the allow list test passes unchanged. Verifies **AC-9**.
- Source scan: `os_password` appears only in `server/catalog/testbeds.ts` among app files. Verifies **AC-10**.
- Email logins (amended 2026-10-20): the render shows "Username:" and "Password:" under the matching client, no password line for a client without one, no login for a client whose name or URL differs, and none on a cancellation (`server/email/compose.test.ts`, snapshots updated); the jobs step sends a booked email whose text part holds a seeded login while the `email_messages` row, the job rows, and the invite hold none (`server/jobs/jobs.test.ts`, DB, rolled back). Verifies **AC-11**.

The real release runs in the worker container (one host), so `/check verify` confirms it by deleting a `dev-` testbed and watching the row get stamped within a tick or two while its Authentik group stays.

## Build plan

Tracer Bullet: thicken the existing create thread into full CRUD one strand at a time (data and add, then edit, then delete, then the worker teardown), each strand working end to end before the next.

1. [x] Migration `0006_testbed_admin.sql` (four named checks, two client columns, the teardown column), `db:codegen`, and the new audit actions. Satisfies **AC-8**
2. [x] Add strand: extend `TestbedInput` (OS credentials, IDP, at most 20 clients), `createTestbed` (IDP lock, new columns, the `deleted_at is null` pk store), `listIdpKeyOptions`, `listTestbedsForAdmin` (moving the `listTestbeds` tests), the add form fields (IDP select, OS inputs with show toggle, kind order), and the mock list columns with the `Not ready` badge and search. Satisfies **AC-1**, **AC-2**
3. [x] Edit strand: `getTestbedForEdit` and `loadTestbedForEdit`; `updateTestbed` with locks, no change skip, and the AC-5 audit; `updateTestbedAction`; the edit dialog that loads on open, the read only group name, and the disabled edit for not ready rows. Satisfies **AC-3**, **AC-4**, **AC-5**, **AC-9**
4. [x] Delete strand: `testbedBlockers` with phase labels, `deleteTestbed`, `checkTestbedDelete`, `deleteTestbedAction`, and the delete flow wiring on the page. Satisfies **AC-6**, **AC-9**
5. [x] Teardown strand: `server/worker/teardown.ts` (on the existing `podGroupMembers` and `deletePodGroup`), the reconciler filter, and the worker step, with fake Authentik tests. Satisfies **AC-7**
6. [x] Guards and end to end: the `os_password` source scan, the auth tests for the new actions, and the Playwright happy path. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-6**, **AC-9**, **AC-10**
7. [x] Email logins (amended 2026-10-20): `ClientLogin` and `loginFor` in `lib/booking-email.ts`, `clientLoginsForBooking`, the `logins` input through `renderBookingEmail` and `composeBookingEmail`, the Username and Password lines in `lab-access-email.tsx`, the read in `runSendEmail` (skipped for a cancellation), `SAMPLE_CLIENT_LOGINS` in the worker's start up render, and the tests. Satisfies **AC-11**

Amended 2026-10-24: tasks 2, 3, and 5 above are history. Specs 0017 and 0018 later replaced the create saga and the teardown strand with the predefined group lookup and the release step.

## Consequences

**Positive**:
- The catalog becomes fully manageable from the console, matching the mock.
- Group release has one owner (the worker), retries by itself every tick, and reuses the reconciler's session cut off, so no deleted testbed leaves a learner in the lab.
- No new Authentik rights or credentials: the provisioning token already adds and removes members of the owner's marked groups.
- The IDP key relation is now enforced from both sides (spec 0006 follow up closed).

**Negative / tradeoffs**:
- Each booked, rescheduled, and reminder email holds the testbed's OS logins in clear, in the learner's mailbox, the ops BCC mailbox, and the sender's Sent folder, for as long as those messages are kept. A password changed later does not reach emails already sent.
- Client OS passwords sit in plain text in the database and in every `pg_dump`. Anyone with database or backup access can read them. Moving to encryption later needs a migration and either a backfill or admins entering them again.
- An open edit dialog holds that testbed's OS passwords in the admin's browser (masked on screen only), and opening it costs one extra server round trip.
- The owner makes and marks each group in Authentik before a testbed can use it (spec 0017), and still binds it to the Nile tenant SAML app, Moodle, and the Cloudflare Access apps by hand, and unbinds those apps when a testbed is deleted. Until bound, a ready testbed can be booked but its URLs do not let the learner in.
- A URL edit does not change any Authentik or Cloudflare setup; the owner updates those by hand.
- A deleted testbed's group is only released, never deleted, and release waits for the reconciler to remove tagged learners. Nothing can be booked on the testbed meanwhile.
- A type change leaves existing bookings on the old type's duration. Availability stays correct (busy ranges are per testbed), but the admin may see mixed types on one testbed's bookings.
- An edit to URLs or credentials only records `accessChanged`; learners who already booked are not told. Emails still queued pick up the new logins (read at send time), but their links come from the snapshot taken when they were queued.
- Concurrent edits by two admins are last write wins (as in features 7 and 8).

**Neutral**:
- `listTestbeds` and `TestbedListRow` are removed in favor of `listTestbedsForAdmin`; only the Testbeds page and its tests used them.
- Client rows are replaced on every save, so their ids change (nothing references them).
- A release stuck on a tagged learner the reconciler cannot remove logs a warning every tick until it can.

## Follow-up

- [ ] Scope row 9 (`/scope`): reword "protects its URLs with it; editing the URLs updates that protection" and the done line "its URLs are reachable only by members of that group" to "creates its Authentik group, which the owner binds to the lab's apps by hand (spec 0001)"; note the client OS username and password.
- [x] Feature 15: the booking email includes each client's OS username and password, built in the worker, never in a browser (AC-11, 2026-10-20). Read through `clientLoginsForBooking`, so no change to the scan allow list was needed.
- [ ] Calendar invite: decide whether the `.ics` should carry the OS logins. Left out on purpose 2026-10-20, because an invite stays in the learner's calendar (and any calendar it syncs to) indefinitely; needs an owner call before it is built.
- [ ] A `testbed.updated` with `accessChanged: true` sends an updated access email to learners with Upcoming or Current bookings on that testbed (not built).
- [ ] Feature 14: the lab access screens list clients (name, kind, URL) but never OS credentials (engineer call 2026-10-10).
- [ ] Spec 0002: its follow ups "testbed delete saga that removes the Authentik group" and "create saga sets `authentik_group_pk`" are settled here and in spec 0004; its `testbeds` and `testbed_clients` tables gain the columns above.
- [ ] Spec 0006 follow up (IDP select lists live `IDP` keys; save locks the key `FOR SHARE` and rechecks) is built here.
- [ ] `/sync`: record in AGENTS.md that client OS credentials are plain text by design (the exception to "secrets at rest") and guarded by the `os_password` source scan, and that the worker releases (never deletes) groups, per spec 0017.
- [x] Amended 2026-10-24 to match specs 0017 and 0018 (`/architect` update, text only; no code change).
- [ ] Owner runbook: when a testbed is added, bind its Authentik group to its Nile tenant SAML app, Moodle, and its VM Cloudflare Access apps; when deleted, remove those bindings or apps.
