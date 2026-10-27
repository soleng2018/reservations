# 0022. Admin Nile Portal Reset page

**Date**: 2026-10-26
**Status**: Proposed

## Summary

This adds one admin page, Nile Portal Reset. It holds one email address (where an aborted reset is reported) and one ordered table of the portal API calls that clean a Nile Portal, in the order a reset runs them. The table starts from a JSON file in the repo on a fresh install, then the database owns it, so a later deploy never overwrites the admin's changes. The page opens read only; an admin clicks Edit, confirms a pop up, edits a draft (add, edit, remove, drag), and presses Save once. The page never calls a portal. Feature 24 reads the saved list and does the deleting.

## Context

Feature 24 resets a workshop's Nile Portal after every lab by calling the portal's own API. Which calls to make, and in what order, is knowledge the owner holds and will keep extending: a segment cannot be deleted while an SSID still uses it, so the order carries meaning. Putting that list in code means a deploy for every change, and a wrong list deletes the wrong things on a live tenant. The list needs one owner controlled home that an admin can read and change safely.

The same page also holds the address that gets an email when a reset is aborted or did not go through. The app has no settings table today, so this is the first. The page sits in the existing admin console (Next.js App Router, Server Actions, Kysely, Base UI and shadcn), is admin only, and must follow the audit, Result, and lock first rules in `AGENTS.md`.

Two facts shape the design. The list is configuration, not history: only the current list matters, and audit rows keep what changed. And the page is a place where one slip is costly later (a bad delete path runs against a real tenant), so editing needs friction (Edit plus a confirm), one atomic Save, and shape checks that keep every call inside the portal's own `/api/` space.

Build gate: the owner has not yet sent the full reset list. This spec is written now, but the build waits for that list so the starting doc is real (see Follow-up).

## Requirements

**User stories**:
- As an admin, I want one page that lists every portal call a reset makes, in order, so I can see what a reset will do.
- As an admin, I want to add, change, remove, and reorder those calls safely, so the reset stays correct as the portal grows.
- As an admin, I want to save the address that is told when a reset aborts, so a failed reset is never silent.
- As the owner, I want a fresh install to already hold the full list, and a later deploy to leave my changes alone.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1**: On a fresh database, after migrations and the seed step, the steps table holds exactly the entries of the starting list file, in file order, numbered 1 to N, and the settings row records `seeded_at`.
- **AC-2**: Running migrate again changes nothing, even after an admin edited, reordered, or deleted rows (including all rows), and even if the file gained entries. The marker `seeded_at`, not an empty table, decides.
- **AC-3**: The page `/admin/nile-portal-reset` and every action it uses call `requireAdmin()`. A learner or a signed out visitor gets the same refusal as any other admin page.
- **AC-4**: The page opens read only: the order numbers, feature names, calls, and notes show as text; the email shows as text; there are no active drag handles and no add, edit, remove, or Save controls.
- **AC-5**: Clicking Edit opens a confirm pop up. Cancel (or Escape) changes nothing. Confirm enters edit mode, which shows drag handles, Add, Edit and Remove on each row, an email field, Save, and Discard. Leaving edit mode (after Save or Discard) returns the page to read only.
- **AC-6**: In edit mode an admin can add a row, edit a row, remove a row, and drag a row to a new place. The numbers on screen renumber at once to 1 to N. None of this is stored until Save.
- **AC-7**: Save writes the email and the whole list in one transaction. After a reload the saved order, rows, and email show. Discard throws the draft away and shows the saved list; if the draft has changes, Discard and leaving the page ask first.
- **AC-8**: Reordering works by keyboard and touch: each handle is a focusable button; Space or Enter lifts the row, the arrow keys move it, Space drops it, Escape cancels; every lift, move, and drop is announced to screen readers with the row name and its place ("position 3 of 12"). Dropping updates the numbers.
- **AC-9**: Save refuses with a field error keyed by dotted path (for example `steps.2.deletePath`, `abortEmail`) and writes nothing when: the email is not a valid address; a feature name is empty, over 60 characters, or repeats another (ignoring case); a list path or delete path is not a valid path under `/api/` (below); a delete path lacks exactly one `{id}` segment; a list path contains `{id}`; the delete method is not `DELETE` or `POST`; a note is over 300 characters; there are more than 100 rows; or there are no rows.
- **AC-10**: An empty email is allowed. While it is empty, the page (read only and edit mode) shows "Aborted resets will not be emailed."
- **AC-11**: If the saved version changed after the page loaded (another admin saved), Save writes nothing, returns a `stale` message, keeps the draft on screen, and offers a Reload that drops the draft. Two admins cannot overwrite each other silently.
- **AC-12**: A Save with changes writes audit rows in the same transaction: `portal_reset.step_added`, `step_updated` (changed fields only), `step_removed` (with the removed row's name and calls), one `steps_reordered` (before and after feature names) when the relative order of surviving rows changed, `email_changed`, and one `saved` row with the version before and after. A Save with no changes writes no audit row and does not raise the version. The email address itself is never in an audit row, a log, or an error (only set, cleared, or changed, and the domain).
- **AC-13**: In edit mode the page shows how many starting list entries are not in the table and not already in the draft (matched by `seed_key`) and lets the admin add any of them to the draft. Nothing is added automatically, and an added row is stored only on Save.
- **AC-14**: The page and its actions never contact a Nile Portal and handle no portal password or token. A scan test fails if anything under `server/portal-reset/` or the page calls `fetch`, imports an HTTP client, or imports a portal client.
- **AC-15**: Below the 55rem nav breakpoint, each row shows as a stacked card (handle on the left, number and feature name on top, the two calls under it). Dragging still works there.
- **AC-16**: Feature 24 can read the saved list in order and the saved email through `server/portal-reset/steps.ts`, with no page code involved. `readResetList(db)` reads the settings row and the steps in one `REPEATABLE READ` transaction and returns `{ version, abortEmail, steps }`, so a Save cannot land between the two reads.
- **AC-17**: The starting list file is parsed by Zod in the migrate seed step and in a test. An invalid file fails the migrate process before the web container starts, and a test fails if the file has no entries.

## Options considered

### Option 1: Structured table, draft in edit mode, one atomic Save, seeded once from a repo file

Rows hold a feature name, a list call, a delete call, and a note. The admin edits a draft and saves the whole page in one transaction guarded by a version number. The repo JSON file seeds an empty install once.

**Pros**:
- A half moved or half edited list is never stored.
- The version check stops two admins overwriting each other.
- The engine in feature 24 gets exact, typed calls and never parses free text.

**Cons**:
- More client state (a draft) than saving each change.
- The seed step is a new piece in the migrate process.

### Option 2: Every change saves at once

Each drop, add, edit, and remove is its own save and its own audit row.

**Pros**:
- No draft state, no Save button.
- Simple per row logic.

**Cons**:
- Two quick drags can race, and a list can be stored mid change, which feature 24 could then run.
- Order numbers must be renumbered in the database on every drop.

### Option 3: The list lives only in the repo file

The file in the repo is the list; changes are a code change and a deploy.

**Pros**:
- Reviewed in a pull request, no admin page needed for the list.

**Cons**:
- Rejected by the owner's requirement: the admin must change the list from the page without a deploy.
- A deploy for each portal change, and no audit of who changed what.

## Decision

**Chosen option**: Option 1: Structured table, draft in edit mode, one atomic Save, seeded once from a repo file.

One page, two tables (`portal_reset_settings`, `portal_reset_steps`), one Save action guarded by a version, a seed step in the migrate process, and a read module that feature 24 uses.

**Implementation skills**: `web-dnd-dnd-kit` (`agents-inc/skills`, `.claude/skills/web-dnd-dnd-kit/`) · `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn-baseui` (`thunderboltdev/shadcn-baseui`, `.claude/skills/shadcn-baseui/`) · `base-ui` (`itechmeat/llm-code`, `.claude/skills/base-ui/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`)

**New dependency**: `@dnd-kit/core` and `@dnd-kit/sortable` (the long standing packages, with a keyboard sensor and screen reader announcements built in). Check the current version and that React 19 is supported when installing; the newer `@dnd-kit/react` package is the runner up.

## Rationale

The list is configuration that is cheap to read and expensive to get wrong, so the design buys safety in three layers. Friction before editing (Edit plus a confirm) stops accidents. A draft with one atomic Save, a version check, and shape checks stops a bad or partial list being stored. An audit row per change leaves a trail of who changed which call. This follows the repo's lock first pattern: the Save locks the settings row `FOR UPDATE`, checks the version, then writes, and a refusal rolls everything back through `Refusal` and `refusable()`.

Seeding uses a marker (`seeded_at`) rather than "the table is empty" because an admin may legitimately empty the table later, and a deploy must never bring rows back. A SQL migration cannot read a JSON file, so the seed runs as a TypeScript step in `scripts/migrate.ts` after the migrator, inside one transaction under the settings row lock. The migrate process already runs once per deploy before web, so the page never opens on an unseeded database. Running it in the worker would be later and optional (`WORKER_ENABLED`); running it on the first page visit would make a read write.

Hard delete beats soft delete here: the list is current configuration, the audit row keeps what was removed, and soft deleted rows would complicate the gap free numbering and the "not yet in the table" check. The cost is that a removed starting list entry shows again as "not in the table" in the gaps check; that is correct, since it is not in the table, and the admin can ignore it.

Dnd-kit wins over native HTML5 drag because native drag has no keyboard path or announcements and is poor on touch, and the owner required keyboard use. The recommended pick for the other small calls, with the runner up in brackets:
- Paths hold only a path under `/api/`, never a host (a full URL), so a saved row can never point a portal sign in at another site. (Runner up: allow a full URL and check the host in feature 24. Rejected: a second place to get it wrong.)
- Add and Edit use a `FormDialog` (as Testbed Types does) that updates the draft; the email is an inline field. (Runner up: inline cell editing, rejected as harder to validate and to use by keyboard.)
- Order numbers are never typed or sent: the server sets `position` from the array index. (Runner up: sending positions, rejected because a client could send a gap or a repeat.)
- The page loads every row with no pagination: the list is capped at 100, so it is bounded by construction.

## Feature design

**Data model sketch**:

`hol_app.portal_reset_settings` (exactly one row)

| Column | Type | Rules |
|---|---|---|
| id | boolean, primary key | `check (id)`, so a second row cannot exist |
| abort_email | text, null | `check (abort_email is null or char_length(abort_email) <= 254)`; address shape checked by Zod |
| version | integer, not null, default 1 | `check (version >= 1)`; raised by 1 on every Save that changes something |
| seeded_at | timestamptz, null | set once by the seed step; never cleared |
| updated_by | uuid, null, foreign key to `users(id)` | the admin who last saved; null before the first save |
| updated_at | timestamptz, not null, default `now()` | the database clock |

The migration inserts the one row (`id = true`).

`hol_app.portal_reset_steps`

| Column | Type | Rules |
|---|---|---|
| id | uuid, primary key, default `gen_random_uuid()` | stable across edits |
| position | integer, not null | `check (position >= 1)`; constraint `portal_reset_steps_position_uq unique (position) deferrable initially deferred` so a reorder inside one transaction cannot trip on itself |
| feature_name | text, not null | `check (char_length(feature_name) between 1 and 60)`; unique index `portal_reset_steps_feature_name_lower_uq` on `lower(feature_name)` |
| list_path | text, not null | `check (char_length(list_path) <= 200)`; shape by Zod |
| delete_method | text, not null | `check (delete_method in ('DELETE', 'POST'))`, constraint `portal_reset_steps_delete_method_check` |
| delete_path | text, not null | `check (char_length(delete_path) <= 200)`; shape by Zod |
| note | text, null | `check (note is null or char_length(note) <= 300)` |
| seed_key | text, null | unique where not null (`portal_reset_steps_seed_key_uq`); the starting list entry this row came from |
| created_at, updated_at | timestamptz, not null, default `now()` | database clock |

Relationships: none between the two tables; `updated_by` points to `users` (N to 1). The list method is always `GET`, so it is not stored. The same migration extends `audit_events_target_type_check` with `portal_reset_step` and `portal_reset_settings`. New CHECK lists get a Zod enum in `lib/db-enums.ts` and an entry in `checkLists` (`portal_reset_steps.delete_method`; the audit target type list is extended), and `server/db/types.ts` is regenerated with `npm run db:codegen`. The new unique names are added to `mapConstraintError` as `duplicate_name` (feature name) as a backstop to the Zod check.

**Starting list file** (`db/seed/portal-reset-starting-list.json`): a JSON array in run order. Each entry: `key` (stable kebab case id, becomes `seed_key`), `featureName`, `listPath`, `deleteMethod`, `deletePath`, optional `note`. It is imported as a module, so the migrate bundle carries it and the image needs no extra file. The same Zod schema that validates a Save entry validates the file, plus `key` is unique within the file. Entry one is already known: `ssids`, list `GET /api/v1/settings/ssids`, delete `DELETE /api/v1/settings/ssids/{id}`. It lives under `db/`, not `docs/`, because `.dockerignore` excludes `docs` and the image build (`next build` and `build:bundle`) could not import it from there. Prettier formats it like any JSON file.

**Path rules** (one Zod schema in `lib/portal-reset-input.ts`, used on the client for the dialog and on the server for Save): starts with `/api/`; characters limited to letters, digits, `.`, `_`, `~`, `-`, `/`, and `{id}`; no `..`, no `//`, no `?` or `#`, no spaces; at most 200 characters. A list path has no `{id}`. A delete path has `{id}` exactly once and only as a whole segment. The `{id}` placeholder is the value feature 24 substitutes with the id it read from the list call.

**State transitions**: none stored. UI state only: `read only` → (Edit, confirm) → `editing a draft` → (Save succeeds, or Discard) → `read only`. A failed Save stays in `editing`. A stale Save stays in `editing` with a Reload action.

**API surface** (Server Actions in `app/admin/actions.ts`, page at `app/admin/nile-portal-reset/page.tsx`):

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/admin/nile-portal-reset` | page GET | none | settings, steps in order, the starting list entries (at most 100, passed as props), last saved by and at | `requireAdmin()` | redirect for non admins |
| `savePortalResetAction(expectedVersion, input)` | Server Action | `expectedVersion:int` (captured when Edit is confirmed and bound to the draft), `abortEmail:string` (opt, may be empty), `steps[]` in final order, each `{ id?: uuid, seedKey?: string, featureName, listPath, deleteMethod, deletePath, note? }` | new `version`, or field errors keyed by dotted path | `requireAdmin()` | `invalid` (field errors), `stale`, `unknown_step` (an `id` not in the table), `duplicate_step` (the same `id` twice), `bad_seed_key` (not a key in the file, repeated in the draft, or already used by another row) |

There is no separate action for the starting list gaps: the page already has the file's entries (at most 100) and passes them down, and the client leaves out keys already in the table or the draft. The server ignores `seedKey` on a row that has an `id`, and checks it only on new rows.

The page reads, and feature 24 reads, through `server/portal-reset/steps.ts`: `readResetList(db)` (settings and steps in order, in one `REPEATABLE READ` transaction), plus the thin `listResetSteps(db)` and `getResetSettings(db)` the page may use. The write side is `savePortalReset(db, input, adminId)` in the same module, returning a `Result`. The seed is `seedPortalReset(db)` in `server/portal-reset/seed.ts`, an importable module (because `scripts/migrate.ts` runs `main()` on import, a test could not call it there); the migrate script calls it after the migrator.

**Normalization** (one pure function in `lib/portal-reset-input.ts`, applied before validation, comparison, and storage): trim every text field; an empty `abortEmail` or `note` becomes null; the email is compared and stored lowercase; `featureName` is compared ignoring case but stored as typed (trimmed). The "no change" rule (AC-12) and the version bump compare normalized values, so a save that only differs by spaces or email case changes nothing. The pure change computation (which rows were added, updated, removed, reordered) lives in `lib/portal-reset-diff.ts` and is unit tested without a database.

Save algorithm, inside `refusable()` and one transaction: (1) lock the settings row `FOR UPDATE` (every writer takes this lock first, so the steps need no lock of their own); (2) if `version` differs from `expectedVersion`, throw `Refusal("stale")`; (3) read the current steps; (4) check every submitted `id` exists and appears once, every new row's `seedKey` is a key in the file, appears once in the draft, and is not already a `seed_key` in the table; (5) compute the diff; (6) if there is no change, return ok without writing; (7) delete removed rows; set every row whose name changes to a temporary unique value (its own id as text) so a swap or a rename onto a removed name cannot hit `portal_reset_steps_feature_name_lower_uq` (an expression index cannot be deferred); then write the final names, the other updates, and the inserts (database ids), setting `position` from the array index plus 1 (the deferred unique constraint checks at commit); (8) update the settings row (email, `version + 1`, `updated_by`, `updated_at = now()`); (9) write the audit rows. `refusable()` and `mapConstraintError` wrap the whole `transaction().execute()`, because a deferred constraint fails at commit, outside the callback. The server computes every position, so a position violation is a bug and throws instead of becoming a `Result`; a name or seed key violation maps to a field error as a backstop to the Zod checks.

**Seed** (`seedPortalReset`, one transaction): lock the settings row `FOR UPDATE`; if `seeded_at` is set, return. Otherwise, if the steps table is empty, insert the file's entries in order with `position` = index plus 1; if it already has rows (a dev database), insert nothing. In both cases set `seeded_at = now()`, leave `version` at 1 and `updated_by` null, and write one `portal_reset.seeded` audit row (system actor, target `portal_reset_settings:settings`, metadata the count and the keys inserted). A second migrate process waits on the lock and then finds `seeded_at` set. The seed is a separate transaction after the migrator, so a failed seed leaves the migrations applied; the process exits 1, the web container stays down, and the next run retries.

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Page load | Steps and their order numbers | `portal_reset_steps` rows ordered by `position`; the number shown is `position` |
| Page load | The email, the version bound to Save | `portal_reset_settings.abort_email`, `.version` |
| Page load | "Last saved by NAME on TIME" | shown only when `settings.updated_by` is not null (`updated_at` defaults to `now()` at migration, so it cannot decide); NAME is `users.name` joined on `updated_by`, or "a removed user" if that row is gone; TIME is `updated_at` in the admin's timezone through `lib/format-time.ts` (already set by `admin-timezone-sync`) |
| Page load | Starting list entries not in the table | the file's entries (at most 100) minus keys in `portal_reset_steps.seed_key`, computed on the server and passed as props; the client also hides keys already in the draft |
| Edit confirm | The version the draft will send | the settings `version` read when Edit is confirmed, kept with the draft (not the page level value, which may be stale after a fast Save then Edit) |
| Draft rows | A unique id for dnd-kit | a client only `clientKey` (a random id made when the row enters the draft), never sent as `id` |
| Draft numbers | 1 to N after any add, remove, or move | derived from array index on the client; the server recomputes `position` from the submitted order and never trusts a client number |
| Save | `updated_by` and the audit actor | `requireAdmin()` session user id |
| Save | `updated_at`, `created_at` | SQL `now()` (the database is the clock) |
| Save | New row `id` | `gen_random_uuid()` default |
| Save | `seed_key` on a row added from the gaps list | the submitted `seedKey`, checked to be a key in the starting list file |
| Save | The version check value | `expectedVersion` bound by the page from the version it showed |
| Audit rows | Names, calls, before and after order | the diff of submitted rows against the locked current rows |
| Audit `email_changed` | `{ change: "set" or "cleared" or "changed", domain: the new domain or null }` | derived from old and new normalized `abort_email`; the address is not stored in the row, and the old domain is not either |
| Audit `steps_reordered` | before and after | the surviving ids (in both old and new) in old order versus new order; changed when the two sequences differ; metadata holds the ids and the feature names as they are after this Save |
| Audit `summary` (required text on each row) | one plain sentence per action | built from the diff: "Added step SSIDs at 3", "Updated step SSIDs", "Removed step SSIDs", "Reordered 5 steps", "Abort email set" (or "cleared", "changed"), "Saved, version 4 to 5", "Seeded 7 steps from the starting list" |
| Seed step | The rows inserted | the Zod parsed starting list file, in file order, `position` = index plus 1 |

**Audit** (spec 0016 conventions): new `AuditAction` values `portal_reset.seeded` (system actor, `actorUserId: null`), `portal_reset.saved`, `portal_reset.step_added`, `portal_reset.step_updated`, `portal_reset.step_removed`, `portal_reset.steps_reordered`, `portal_reset.email_changed`. `step_*` rows use target type `portal_reset_step` and the step id; the others use `portal_reset_settings` with the target id `settings`. `step_updated` metadata comes from `changedFields` over `featureName`, `listPath`, `deleteMethod`, `deletePath`, `note` (none is a secret). `lib/audit-log.ts` gets labels for each action and a new area `portal_reset` ("Nile Portal Reset") for the filter; the test table of actor kinds in `lib/audit-log.test.ts` gets `portal_reset.seeded: "system"`. The Audit Log read side also needs: a `TARGET_TYPE_LABEL` entry for both new target types (it is typed with `satisfies Record<AuditTargetType, ...>`); a branch in `parseTarget` for `portal_reset_settings:settings`, which is not a UUID, user, or group id, so history links are not dropped; and a label source in `resolveTargets` for both types. A removed step no longer exists, so its label comes from the audit metadata's `featureName`, not "(not found)". Retention of these rows follows the existing audit log (kept). The one month retention in the scope text is for feature 24's per delete rows and is settled in that spec.

**Key invariants**:
- There is one settings row and its `version` only goes up.
- `position` over all steps is exactly 1 to N with no gap or repeat after every committed Save and after the seed step.
- No stored path is anything but a path under `/api/`, and every delete path holds `{id}` once.
- The table never has zero rows after a Save (the seed with a file that has entries, and Save refuses zero). A database can only be empty before the first seed.
- A Save is all or nothing, and a stale Save writes nothing.
- A deploy never changes steps or settings after `seeded_at` is set.
- No audit row, log line, or error holds the full email address.

**Security model**:
- Admin only. Every page and Server Action calls `requireAdmin()`; none is on the public allow list in `tests/server-actions-require.test.ts`. A learner and a stranger are refused like on any admin page.
- The Edit and confirm pop up is a safeguard against accidents, not a security boundary. The Save action is enforced on the server whatever the UI state.
- The list is a set of destructive calls that feature 24 will run with a signed in portal admin. The path only rule, the delete method list, the shape checks, the audit trail, and the version check are the controls here. Nothing here holds a portal credential or contacts a portal (AC-14).
- The email is plain text, not a secret, but is kept out of audit metadata and logs. Free text (feature name, note) is rendered as text by React, never as HTML.
- No compliance scope beyond the project's existing audit practice.

**Configuration required**: none. No new environment variable, secret, or credential. The starting list file ships in the repo.

**UX surface** (built to `design.md` and the look of Testbed Types and API Keys, with `PageHeader`, `PageBody`, `FormDialog`, and the existing confirm dialog pattern):
- Route `/admin/nile-portal-reset`, added to `ADMIN_SECTIONS` and `ADMIN_NAV` between Users and Audit Log, title "Nile Portal Reset", subtitle along the lines of "The portal calls a reset makes, in the order it runs them", with a history link to the audit log filtered to the new area.
- Top: the abort email (text in read only; an input in edit mode) with the empty warning (AC-10), and "Last saved by" line. Below it, the table: handle, number, feature name, list call (`GET /path`), delete call (`DELETE /path/{id}`), note. In edit mode each row also has Edit and Remove buttons.
- Edit button in the header opens the confirm pop up: "Edit the reset list? Changes apply to every Nile Portal reset after you save." Buttons Cancel and Edit. In edit mode the header shows Save and Discard; Add row and "Add from starting list (N)" sit above the table.
- The draft starts from the props once when Edit is confirmed (`useState`) and does not follow later prop refreshes (the repo rule for edit dialogs, since `revalidatePath` refreshes props while a dialog is closing). The version is captured at the same moment. The Add and Edit row dialog edits one row and updates the draft only. Reload (after `stale`) and Discard remount the draft with a new React `key`, so it is rebuilt from fresh props. While a Save is pending the whole draft is frozen (drag, add, edit, remove disabled), so field errors keyed by position land on the right row.
- Leaving with changes: a `beforeunload` prompt covers reload and closing the tab. App Router cannot block client navigation, so the admin nav links and the page's own links check the dirty draft and ask first through one small guard in the admin shell; navigation by the browser back button is the accepted gap and is noted in Consequences.
- Dragging: `DndContext` and `SortableContext` from dnd-kit with `MouseSensor`, `TouchSensor` (with a short press delay so scrolling still works), and `KeyboardSensor` using `sortableKeyboardCoordinates` (not `PointerSensor` together with `TouchSensor`, because both can start a drag on touch); each sortable item uses its `clientKey`; `touch-action: none` is set on the handle only; `DndContext` mounts only after Edit, so there is no server render id mismatch (give it a stable `id` if that ever changes); custom announcements name the row and place; the handle is a real button with an `aria-label` like "Reorder SSID, position 1 of 5". Focus stays on the handle after a drop. Reduced motion is respected.
- Empty, loading, and error states: an empty table (only possible before seeding) shows a plain message; Save shows a pending state and disables the controls; field errors show next to the field, a top message handles `stale` with a Reload button; a dirty draft triggers a browser leave warning.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: seed an empty database from the file, open the page, Edit, confirm, add a row, drag it to position 1, change the email, Save, reload, and see the same order and email, verifies **AC-1, AC-5, AC-6, AC-7, AC-12**
- Idempotent seed: run the seed step twice, and again after deleting all rows and adding a new entry to the file; nothing changes, verifies **AC-2**
- Failure case: two sessions load version 3; the first saves; the second saves and gets `stale`, nothing is written, the draft stays, verifies **AC-11**
- Failure case: each invalid input (bad email, repeated name ignoring case, path with a host or `..` or `?`, delete path with no or two `{id}`, method `PUT`, 101 rows, 0 rows) returns a field error at the right dotted path and writes nothing, verifies **AC-9**
- Failure case: a Save that fails inside the transaction (forced constraint error) leaves the table, version, and audit rows unchanged, verifies **AC-7, AC-12**
- Failure case: a Save that swaps two feature names, and one that renames a row to the name of a row removed in the same Save, both succeed (no unique error), verifies **AC-7, AC-9**
- Failure case: the same `id` twice, a repeated or already used `seedKey`, and a `seedKey` on an existing row are handled as specified, verifies **AC-9, AC-13**
- Failure case: the seed on a database with rows but no `seeded_at` inserts nothing and sets the marker; two seeds at once insert once, verifies **AC-2**
- Scan: nothing under `server/portal-reset/` or the page calls `fetch` or imports an HTTP or portal client, verifies **AC-14**
- Read contract: `readResetList` returns settings and steps from one snapshot, verifies **AC-16**
- Pure: the diff function over added, updated, removed, and reordered cases, including a removal that shifts others (no false `steps_reordered`) and a Save that differs only by spaces or email case (no change), verifies **AC-12**
- Pure: the starting list file parses, has entries, has unique keys, and every path passes the path rules, verifies **AC-17**
- Audit: the email address text appears in no audit metadata, summary, or log, verifies **AC-12**
- Keyboard: focus a handle, Space, ArrowDown, Space moves a row one place and announces it; Escape cancels, verifies **AC-8**
- Auth/permission: a learner session and no session are refused on the page and on both actions, verifies **AC-3**
- Read contract: `listResetSteps` and `getResetSettings` return the saved order and email, verifies **AC-16**
- Layout: at a phone width the rows show as cards and the page has no sideways scroll, verifies **AC-15**
- Read only: in the first view there are no handles, inputs, or Save, and Cancel on the confirm changes nothing, verifies **AC-4, AC-5**

## Build plan

Build approach: Tracer Bullet (the project default). Slice 1 proves a real thread through every layer (database, seed, server read, admin page). Later slices thicken it one strand at a time. The migration is one file, because the model is small and Slice 1 needs both tables.

1. Prerequisite: the owner sends the full reset list; write it into `db/seed/portal-reset-starting-list.json` with the Zod schema and its test (parses, unique keys, valid paths, at least one entry), satisfies **AC-17**
2. Migration `0018_portal_reset.sql`: both tables, the one settings row, the constraints and indexes above, the extended audit target type check; Zod enums and `checkLists` entries; `npm run db:codegen`; the `mapConstraintError` names, satisfies **AC-1, AC-9**
3. `server/portal-reset/seed.ts` (`seedPortalReset`, rules as in Seed above) called from `scripts/migrate.ts` after the migrator, and the bundle check (`build:bundle` and the image carry the JSON from `db/seed/`), satisfies **AC-1, AC-2, AC-17**
4. Tracer thread: `server/portal-reset/steps.ts` read functions, the nav entry, and the read only page with the table (cards on narrow screens), the email text with its warning, and the last saved line, behind `requireAdmin()`, satisfies **AC-3, AC-4, AC-10, AC-15, AC-16**
5. Input schemas and the pure diff: `lib/portal-reset-input.ts` (path rules, row, whole save) and `lib/portal-reset-diff.ts`, with tests, satisfies **AC-9, AC-12**
6. Save: `savePortalReset` (lock, version check, diff, rename safe writes, audit rows with summaries) with `refusable()` around the whole transaction, the Server Action with field errors, the audit actions, labels, area, the actor kind table entry, and the Audit Log read side changes (target type labels, `parseTarget`, `resolveTargets`), satisfies **AC-7, AC-9, AC-11, AC-12**
7. Edit mode without dragging: Edit button and confirm pop up, the draft (`useState` once), the email field, Add, Edit and Remove through a `FormDialog`, Save and Discard with the dirty prompts, the stale message and Reload, satisfies **AC-5, AC-6, AC-7, AC-11**
8. Dragging: install `@dnd-kit/core` and `@dnd-kit/sortable`, the handle, the mouse, touch and keyboard sensors, announcements, live renumbering, satisfies **AC-6, AC-8**
9. Starting list gaps: the "Add from starting list (N)" control fed by props, the `seedKey` checks on Save, satisfies **AC-13**
10. Tests: DB integration inside `inRollback` (seed once and concurrently, save, stale, swap and rename, rollback on failure, audit contents, no email in audit, constraints), Server Action auth coverage, the AC-14 scan test, a Playwright flow for edit, drag by keyboard, save, and reload (runs locally against real Authentik; it needs a test admin, which does not exist right now, see Follow-up), satisfies **AC-2, AC-3, AC-8, AC-11, AC-12, AC-14**

## Consequences

**Positive**:
- The owner changes the reset list from the page, with a confirm, an audit trail, and no deploy.
- A half saved or conflicting list cannot be stored, so feature 24 never reads a list in the middle of an edit.
- Feature 24 gets typed, path only calls and an ordered list, and cannot be pointed at another host by a saved row.
- The seed is safe to redeploy: the database owns the list after the first seed.

**Negative / tradeoffs**:
- A new dependency (dnd-kit) and a draft state machine on the client add code to test and keep.
- The migrate process now does a TypeScript seed step, so a bad starting list file blocks a deploy (on purpose, and a test catches it before then).
- A removed starting list entry keeps showing in the gaps check until the admin ignores it.
- Shape checks cannot tell a right path from a wrong one on the real portal. A wrong path or wrong order is only found by a dry run, which is feature 24's job.
- Hard delete means a removed row is recovered only from its audit row.
- The browser back button can leave a dirty draft without a prompt (App Router cannot block it); the nav links and tab close are guarded.
- The rename safe write (temporary names, then final names) is extra Save logic that only exists because of the unique name index.

**Neutral**:
- The app gets its first settings table; later settings can follow the same single row pattern.
- Feature 24 must handle two things this spec leaves to it: how the response of a list call is read (it assumes items with an `id`) and the audit retention for its own delete rows.
- The `portal_reset` audit area is new, so the Audit Log filter gains one entry.

## Follow-up

- [ ] Owner: send the full reset list (feature name, list call, delete call, in run order). The build waits for it (step 1). Known so far: SSIDs, `GET` and `DELETE /api/v1/settings/ssids` (the delete path takes the `{id}` form).
- [ ] Feature 24 (`/architect nile portal reset when a lab ends`) reads the list through `readResetList` (one snapshot). It settles the dry run, how a list answer is read, how the protected SSID is recognised, and the one month retention of its own audit rows.
- [ ] `web-dnd-dnd-kit` was installed with this design; add its bullet to the `## Agent skills` section of `AGENTS.md` (`.claude/skills/web-dnd-dnd-kit/`, `agents-inc/skills`, dnd-kit drag and drop conventions). `/sync` owns that edit.
- [ ] Add one line to `AGENTS.md` after the build: reads of the reset list go through `server/portal-reset/steps.ts`, and the page's draft is saved only by `savePortalReset` (`/sync`).
- [ ] The e2e flow needs a test admin. `hol-test-admin` was removed on 2026-10-26, so recreate it before `/check verify` can drive the page.
- [ ] Check the dnd-kit version and React 19 support when installing (the library moves fast); switch to `@dnd-kit/react` only if the older packages do not support React 19.2.
