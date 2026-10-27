# 0022. Admin Nile Portal Reset page

**Date**: 2026-10-26
**Revised**: 2026-10-27 (after the portal research; the step model is new)
**Status**: Accepted
**Builds with**: [spec 0023](0023-nile-portal-reset-engine/index.md) (the engine that runs the saved list). This spec owns the step language and how it is stored, edited, and validated. Spec 0023 owns how each part is executed.
**Research**: [findings D1 to D17](../research/nile-portal-reset-findings.md), the tested calls in `db/seed/portal-reset-starting-list.json`

## Summary

This adds one admin page, Nile Portal Reset. It holds the address that is emailed when a reset goes wrong, a reset mode (off, dry run, live), and one ordered table of steps that clean a Nile Portal, in the order a reset runs them. The first version of this spec stored each step as one list call and one delete call. The research showed that is not enough: a step can skip an item, set a value, branch on what it reads, wait, delete many ids in one body, call a delete with no id, or edit a parent record. So a step is now a small list of typed parts (a closed set, no free form code) stored as validated JSON. The page keeps the same safe flow as before (read only first, Edit plus a confirm, a draft, one atomic Save, an audit row per change). Two things an admin cannot change from the page, because they live in the repo: the deny list (Identity and Users are never touched) and the guards (the protected SSID and the other system items are never deleted). The page never calls a portal.

## Context

Feature 24 resets a workshop's Nile Portal after every lab through the portal's own API. Which calls to make, and in what order, is knowledge the owner holds and keeps extending: a segment cannot be deleted while a policy group still uses it, so the order carries meaning. A list in code means a deploy for every change, and a wrong list deletes the wrong things on a live tenant, so the list needs one owner controlled home that an admin can read and change safely.

The research on a live tenant (Workshop 4, 2026-10-27, decisions D1 to D17) changed what a "step" is. Thirteen steps were tested. Among them: skip the SSID whose `ssid.popTunnelUsed` is true; read a state and branch (turn a switch on, wait 10 seconds, turn it off only when it was off); delete wired entries by sending a list of ids in the body; delete a Wired SSO config that has no id; delete a policy under a policy set (two ids in the path); refuse nothing but expect the portal to refuse system App groups; remove all DHCP scopes by a PUT of the parent record; read a list with a POST search. Table 4 of the findings note lists these needs. One call pair per row cannot say any of them.

Two constraints stay from the first version. The list is configuration, not history, so only the current list matters and audit rows keep what changed. And one slip is costly later, so editing needs friction (Edit plus a confirm), one atomic Save, and shape checks that keep every call inside the portal's own `/api/` space. The research adds a third: some paths must never be called by any list, saved or discovered (D14), and some items must never be deleted whatever the list says (D1, D11, D12). Those two rules are enforced by the engine from files in the repo, and the page checks them again at Save, so an admin cannot weaken them from the page.

The page sits in the existing admin console (Next.js App Router, Server Actions, Kysely, Base UI and shadcn), is admin only, and follows the audit, `Result`, and lock first rules in `AGENTS.md`. The app has no settings table today, so this is the first.

## Requirements

**User stories**:
- As an admin, I want one page that lists every step a reset runs, in order, with a plain words description of what each step does, so I can see what a reset will do.
- As an admin, I want to add, change, disable, remove, and reorder steps safely, so the reset stays correct as the portal grows.
- As an admin, I want to set the reset mode (off, dry run, live), so the first runs on a real portal can be read only.
- As an admin, I want to save the address that is told when a reset aborts or does not go through, so a failed reset is never silent.
- As the owner, I want a fresh install to already hold the full tested list, a later deploy to leave my changes alone, and no admin to be able to point a step at Identity or Users or at a protected item.

**Acceptance criteria** (the contract, each independently checkable). AC-1 to AC-17 keep their numbers from the first version; AC-9, AC-12, AC-14, AC-16, and AC-17 are rewritten for the new step model; AC-18 to AC-26 are new.
- **AC-1**: On a fresh database, after migrations and the seed step, the steps table holds exactly the entries of the starting list file, in file order, numbered 1 to N, with each entry's `enabled` flag and `definition`; the settings row records `seeded_at` and has mode `off`.
- **AC-2**: Running migrate again changes nothing, even after an admin edited, reordered, or deleted rows (including all rows), and even if the file gained entries. The marker `seeded_at`, not an empty table, decides.
- **AC-3**: The page `/admin/nile-portal-reset` and every action it uses call `requireAdmin()`. A learner or a signed out visitor gets the same refusal as any other admin page.
- **AC-4**: The page opens read only: the order numbers, feature names, a "Disabled" badge on a disabled step, the plain words description of each step (AC-24), the notes, the email, and the mode show as text; there are no active drag handles and no add, edit, remove, or Save controls.
- **AC-5**: Clicking Edit opens a confirm pop up. Cancel (or Escape) changes nothing. Confirm enters edit mode, which shows drag handles, Add, Edit and Remove on each row, an email field, a mode control, Save, and Discard. Leaving edit mode (after Save or Discard) returns the page to read only.
- **AC-6**: In edit mode an admin can add a row, edit a row, remove a row, and drag a row to a new place. The numbers on screen renumber at once to 1 to N. None of this is stored until Save.
- **AC-7**: Save writes the email, the mode, and the whole list in one transaction. After a reload the saved order, rows, email, and mode show. Discard throws the draft away and shows the saved list; if the draft has changes, Discard and leaving the page ask first.
- **AC-8**: Reordering works by keyboard and touch: each handle is a focusable button; Space or Enter lifts the row, the arrow keys move it, Space drops it, Escape cancels; every lift, move, and drop is announced to screen readers with the row name and its place ("position 3 of 12"). Dropping updates the numbers.
- **AC-9** (rewritten): Save refuses with a field error keyed by dotted path (for example `steps.2.definition.parts.0.delete.path`, `abortEmail`, `mode`) and writes nothing when any of these hold:
  - the email is not a valid address, or the mode is not `off`, `dry_run`, or `live`;
  - a feature name is empty, over 60 characters, or repeats another (ignoring case); a note is over 300 characters; there are more than 100 rows or no rows;
  - the `definition` does not parse against the step language (AC-18), is over 20 000 characters as JSON, has no parts or more than 12 parts, or has a wait over 60 seconds or waits over 60 seconds in total;
  - any path is not a path under `/api/` (below), or has a host, `..`, `//`, `#`, or a space; a delete path has a query; a list path has a placeholder other than a `{read.NAME.KEY}` one;
  - any path or page route matches the deny list (AC-19); a page route does not start with `/` or has more than 5 entries per step;
  - a method is not allowed in its place (a list reads with `GET` or `POST`; a write is `DELETE` or `PUT`);
  - a placeholder is not supplied where it is used (`{parentId}` with no `nested.parentIdField`; `{ids}` outside a batch delete; `{read.NAME.KEY}` naming a read that does not come earlier in the same step, or a key that read does not pick);
  - a body template holds a key named like a secret (`password`, `token`, `secret`, `authorization`, `cookie`, `key`) or any header name (AC-25).
- **AC-10**: An empty email is allowed. While it is empty, the page (read only and edit mode) shows "Aborted resets will not be emailed."
- **AC-11**: If the saved version changed after the page loaded (another admin saved), Save writes nothing, returns a `stale` message, keeps the draft on screen, and offers a Reload that drops the draft. Two admins cannot overwrite each other silently.
- **AC-12** (rewritten): A Save with changes writes audit rows in the same transaction: `portal_reset.step_added`, `step_updated` (changed fields only, including `enabled`, `note`, `featureName`, and `definition` with the full before and after JSON, which holds no secret by AC-25), `step_removed` (with the removed row's name and definition), one `steps_reordered` (before and after feature names) when the relative order of surviving rows changed, `email_changed`, `mode_changed` (from and to), and one `saved` row with the version before and after. A Save with no changes writes no audit row and does not raise the version. The email address itself is never in an audit row, a log, or an error (only set, cleared, or changed, and the domain).
- **AC-13**: In edit mode the page shows how many starting list entries are not in the table and not already in the draft (matched by `seed_key`) and lets the admin add any of them to the draft. Nothing is added automatically, and an added row is stored only on Save.
- **AC-14** (rewritten): The page and the configuration side never contact a Nile Portal and handle no portal password or token. A scan test fails if anything under `app/admin/nile-portal-reset/`, `server/portal-reset/`, or `lib/portal-reset/` calls `fetch`, imports an HTTP client, or imports anything from `server/portal-engine/` (where the engine lives, spec 0023).
- **AC-15**: Below the 55rem nav breakpoint, each row shows as a stacked card (handle on the left, number and feature name on top, the description under it). Dragging still works there.
- **AC-16** (rewritten): The engine can read the saved list in order through `server/portal-reset/steps.ts`, with no page code involved. `readResetList(db)` reads the settings row and the steps in one `REPEATABLE READ` transaction and returns `{ version, abortEmail, mode, steps }`, so a Save cannot land between the two reads. Each step's `definition` is parsed with the step language schema on the way out; a row that no longer parses is returned as `{ ok: false }` for that step so the engine can stop loudly (spec 0023 AC-17) instead of skipping it.
- **AC-17** (rewritten): The starting list file (`schemaVersion` 1, then `steps`) is parsed by Zod in the migrate seed step and in a test, with the same step schema a Save uses plus a unique kebab case `key` per entry. An invalid file fails the migrate process before the web container starts, and a test fails if the file has no entries, repeats a key, or holds a path on the deny list.
- **AC-18** (new, the step language): The schema in `lib/portal-reset/step-schema.ts` accepts every shape in the "What a step can say" table below, and a test holds one fixture for each of the 14 needs in the research note's section 4: a skip rule on a field, a set a value call with a body, a branch on a state read, a pause, a delete with a list of ids in the body, a delete with no id, parent ids in the path, a step of several parts, an expected refusal, an update of a parent record, a list read done by POST, an expected end state, a read that keeps only chosen scalar fields, and an item with no label. The 13 starting steps all parse.
- **AC-19** (new, the deny list): `lib/portal-reset/deny-list.json` names the paths no step may use: `/api/*/idps`, `/api/*/users`, and their sub paths, plus the two page routes `/global-settings/identity` and `/network-setup/users`. A path is normalised (lower case, percent decoded once, slashes collapsed, query dropped, placeholders replaced by a plain segment) and matched on whole segments, where `*` stands for one segment (so `/api/v2/idps` matches, `/api/v1/userinfo` does not). The same function `isDenied(path)` is used by Save, by the seed test, and by the engine (spec 0023 AC-25). It refuses every method, not only writes.
- **AC-20** (new, the guards): `lib/portal-reset/guards.json` holds the hard rules about items that are never deleted, as data (spec 0023 AC-26 enforces them): the protected SSID (`ssid.popTunnelUsed` true), system policies (`policyAttribute.isDefault` true) in Trust Engine and Nile RADIUS, Nile RADIUS (the cloud flag), Nile DHCP (`dhcpClient.cloudDHCP` true), and the Default Network Policy. The file is validated by Zod in a test and loaded by the engine. The page shows, on any step whose list or delete route falls under a guard, a read only line such as "SSIDs with ssid.popTunnelUsed = true are never deleted". No Save input can add, remove, or edit a guard, and a step that has no skip rule of its own is still guarded.
- **AC-21** (new): A step has an `enabled` flag. A disabled step is kept, shown with a "Disabled" badge, and skipped by the engine. A starting list entry that lacks evidence (Service Profiles, see Follow-up) ships disabled.
- **AC-22** (new, the mode): The settings row holds `mode` (`off`, `dry_run`, `live`), default `off`. In edit mode the mode is a select. Choosing `live` asks a second confirm titled "Switch to live?" that says "Resets delete things on real Nile Portals after every lab." Cancelling that confirm keeps the previous mode in the draft. The engine reads the mode at the start of each run (spec 0023 AC-1, AC-33).
- **AC-23** (new, the editor): The Add and Edit row dialog edits the feature name, the note, the enabled switch, and the `parts` as formatted JSON in a monospace text area. The text is parsed and validated on every change (debounced), and the errors show next to the text, keyed by the same dotted paths. Invalid text cannot be applied to the draft. Pasting a definition never sends anything to a portal.
- **AC-24** (new, plain words): `describeStep(definition)` is a pure function in `lib/portal-reset/describe.ts` that returns one short sentence per part ("Read GET /api/v1/settings/ssids, delete each item with DELETE /api/v1/settings/ssids/{id}, skipping items where ssid.popTunnelUsed is true"). The page shows it for every row, and a test checks it for the 13 starting steps. It names paths and fields only, never a value read from a portal.
- **AC-25** (new, no secrets in a definition): A definition holds no header, no credential, and no portal data. Body templates may hold only literals and the placeholders listed below; a `read` keeps only the scalar fields it picks (string, number, boolean, or null), never an object or a reply; the schema refuses a key or header named like a secret. A test feeds a definition with each and expects a field error.
- **AC-26** (new, a removal is visible): A row that came from the starting list and is removed shows again under "Add from starting list" (AC-13) with a short note that it can be re-added, so a removed tested step is never lost, only hidden.

## Options considered

### Option 1: Typed parts stored as validated JSON, one atomic Save, seeded once from a repo file

A step is a name, an enabled flag, a note, and a `definition` with an ordered list of parts. Part kinds are a closed set: `read`, `delete_each`, `call`, `update_record`, `wait`, `expect`. A part may have `when` conditions on an earlier read. Zod validates the whole definition at Save, in the seed, and when the engine reads it. Guards and the deny list are repo data the engine always applies.

**Pros**:
- Expresses all 13 tested steps with no free form code, and a new step is data.
- The engine gets exact, typed instructions and never parses free text.
- One schema is the single source of truth for the page, the seed, and the engine.
- Safety rules (deny list, guards) cannot be edited from the page.

**Cons**:
- The editor is a JSON text area, not a form per part kind.
- A larger schema and a describer function to build and test.

### Option 2: Keep one call pair per row and add columns for each new need

Add nullable columns for a skip rule, a body, a wait, a branch, a parent id, and so on.

**Pros**:
- Plain columns and form fields.

**Cons**:
- Each new need is a migration, and steps of several parts (Wired, DHCP, Authentication) still do not fit.
- Nullable columns that only some rows use are easy to leave half set.

### Option 3: Free form scripts per step

Store a small script (JavaScript or a template language) per step.

**Pros**:
- Fits anything.

**Cons**:
- Rejected: an admin edited script runs against a live tenant with delete rights, cannot be validated, and could reach the deny list by construction.

## Decision

**Chosen option**: Option 1: Typed parts stored as validated JSON, one atomic Save, seeded once from a repo file.

One page, two tables (`portal_reset_settings`, `portal_reset_steps`), one Save action guarded by a version, a seed step in the migrate process, a step language schema shared by the page and the engine, two repo data files (deny list, guards), and a read module the engine uses.

**Implementation skills**: `web-dnd-dnd-kit` (`agents-inc/skills`, `.claude/skills/web-dnd-dnd-kit/`) · `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `shadcn-baseui` (`thunderboltdev/shadcn-baseui`, `.claude/skills/shadcn-baseui/`) · `base-ui` (`itechmeat/llm-code`, `.claude/skills/base-ui/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`)

**New dependency**: `@dnd-kit/core` and `@dnd-kit/sortable` (the long standing packages, with a keyboard sensor and screen reader announcements built in). Check the current version and that React 19 is supported when installing; the newer `@dnd-kit/react` package is the runner up.

## Rationale

The list is configuration that is cheap to read and expensive to get wrong, so the design buys safety in four layers. Friction before editing (Edit plus a confirm) stops accidents. A draft with one atomic Save, a version check, and a strict schema stops a bad or partial list being stored. An audit row per change, with the full before and after definition, leaves a trail of who changed which call. And two repo data files, outside the database, hold the rules no admin may weaken: the deny list and the guards. The first three follow the repo's lock first pattern: the Save locks the settings row `FOR UPDATE`, checks the version, then writes, and a refusal rolls everything back through `Refusal` and `refusable()`.

A closed set of part kinds beats both columns and scripts. The research found 14 needs (findings section 4), and every one reduces to five ideas: read something and keep a few scalar values, make a call, delete each item of a list, change a field of a record and put it back, wait. A small `when` condition on a kept value covers every branch seen (the guest switch, Wired SSO) without free form logic. Adding a new step for a new portal feature then needs no code, and a part kind no admin may invent cannot appear, which keeps the schema honest.

JSON in a text area is the smallest editor that is safe: it is validated on every change against the same schema Save uses, with errors keyed by dotted path, and the plain words description (AC-24) shows the admin what the text means. A form per part kind is a larger build for an admin who edits a handful of steps a year; it is the runner up and can follow.

Seeding uses a marker (`seeded_at`) rather than "the table is empty" because an admin may legitimately empty the table later, and a deploy must never bring rows back. A SQL migration cannot read a JSON file, so the seed runs as a TypeScript step in `scripts/migrate.ts` after the migrator, inside one transaction under the settings row lock. Hard delete beats soft delete: the list is current configuration, the audit row keeps what was removed, and the starting list gaps check (AC-13, AC-26) already offers a removed starting entry back.

The guards are data, not code and not database rows, for two reasons. The owner's rule that no type names live in the engine applies to protected items too, and a repo file is reviewed in a pull request like code. And an admin who can edit the database (or this page) must not be able to remove the protection of the protected SSID, so it cannot be a row.

The recommended pick for the other small calls, with the runner up in brackets:
- Paths hold only a path under `/api/`, never a host, so a saved row can never point a portal sign in at another site. (Runner up: allow a full URL and check the host in the engine. Rejected: a second place to get it wrong.)
- Add and Edit use a `FormDialog` (as Testbed Types does) that updates the draft; the email and mode are inline fields. (Runner up: inline cell editing, rejected as harder to validate and to use by keyboard.)
- Order numbers are never typed or sent: the server sets `position` from the array index.
- The page loads every row with no pagination: the list is capped at 100, so it is bounded by construction.
- The mode lives on the settings row, global to all workshops, because the owner runs one rollout for all five. (Runner up: a mode per testbed, kept as a later option.)
- The `enabled` flag on a step is cheaper and safer than asking an admin to remove a row they may want back.

## Feature design

### The step language

A step is `{ featureName, enabled, note?, definition: { parts: Part[], pages?: string[] } }`. `pages` lists the portal page routes (not API paths, for example `/network-setup/wireless`) that the engine's discovery pass visits for this step (spec 0023 AC-35); at most 5 per step, each starting with `/`, each checked against the deny list. The language is one Zod schema, `StepDefinition`, in `lib/portal-reset/step-schema.ts`, used by the page (client and server), the seed, `readResetList`, and the engine.

**Path language** (`lib/portal-reset/portal-path.ts`, pure, no `eval`): dot segments and `[n]` indexes only (`data.content`, `[0].id`, `dhcpClient.servers[0].subnets`). `$` is the root. A path that resolves to nothing is `undefined`, never an error.

**Rules** (`Rule`): `{ field, op, value? }` where `field` is a path relative to the item and `op` is one of `eq`, `ne`, `in`, `exists`, `missing`, `nonEmpty`. A list of rules is a conjunction.

**Conditions** (`Cond`): `{ read, key, op, value? }` against a value kept by an earlier `read` part of the same step. A part's `when` is a list of conditions, all of which must hold, or the part is skipped.

**Placeholders** (in paths and body templates, whole string leaves only): `{id}` (the item's id), `{parentId}` (the parent record's id, for nested lists), `{ids}` (the array of ids of a batch delete), `{read.NAME.KEY}` (a value kept by a read). Nothing else is substituted. An id is URL encoded when placed in a path and left as is inside a JSON body (wired ids hold spaces and slashes, so they go in the body).

**Parts**:

| Part | Fields | Meaning |
|---|---|---|
| `read` | `as`, `method` (`GET` or `POST`), `path`, `body?`, `pick` (name to path, each resolving to a scalar), `emptyOn?` | One read; keeps only the picked scalars under the name `as`. The reply is dropped. Used for state reads and end state checks. |
| `delete_each` | `list`, `delete`, `skipWhen?`, `onlyWhen?`, `expectRefusals?`, `allowLeftover?` | Read a list, then delete each item that passes the rules. `allowLeftover` (default false) says the engine's final re-read must not count items still in the list as a failure (a deleted wired device can reappear as Waiting for Approval, D6). |
| `call` | `method` (`DELETE` or `PUT`), `path`, `body?`, `okStatus?`, `expectRefusals?` | One write call with no list (a switch, a config delete, a restore). |
| `update_record` | `list`, `match`, `set` (path and value), `put` (path, `okStatus?`) | Read a list, find the records that match, change one field of each, and PUT the whole record back (re-read just before each PUT because the record's `version` changes). Skips a record that already holds the value. |
| `wait` | `seconds` (1 to 60) | Pause. Counts against the run's time budget. Skipped in a dry run. |
| `expect` | `read`, `key`, `op`, `value?` | An end state check on a kept value. A failed expect marks the step as not done, which feeds the second pass (spec 0023). |

`list` is `{ method, path, body?, itemsAt, nested?, unwrap?, idField, labelField?, emptyOn? }`. `nested` is `{ at, parentIdField }` for items inside a parent record (policies in a policy set). `unwrap` names a field that holds the real item (`clientConfig`). `labelField` is the only field of an item that may ever appear in an audit row, a run record, or an email; with no `labelField` the item is recorded by id only. `emptyOn` is the list of HTTP statuses that mean "nothing to do" (default `[404]`).

`delete` is `{ path, body?, batch?, okStatus? }`. `okStatus` defaults to `[200, 202, 204]`. `batch: true` sends one call with `{ids}` in the body for all items.

`expectRefusals` is a list of `{ status, messageContains }`: a reply that matches is an expected refusal (silent, spec 0023 AC-21).

Methods are closed sets. A path is `/api/...` with a query allowed only on a list or read (`?size=2000`). Every path is also checked against the deny list (AC-19).

### What a step can say (the 14 needs)

| Need (findings section 4) | How it is said |
|---|---|
| Skip an item by a field value (D1) | `skipWhen: [{ field, op, value }]` on `delete_each` (a soft skip an admin can edit) |
| A guard that cannot be removed (D1) | `guards.json`, not a part (AC-20) |
| A call that sets a value, with a body (D3, D11) | `call` with a body template, or `update_record` |
| A branch on a state read (D3, D6) | `read` then parts with `when` |
| A pause (D3) | `wait` |
| A list response location (SSIDs, guest) | `itemsAt`, `unwrap`, `idField` |
| A delete with a list of ids in the body (D6) | `delete.batch` and `{ids}` in the body |
| A delete with no id (Wired SSO, certificates) | `call` |
| A parent id in the path (D7, D11) | `nested` plus `{parentId}` |
| A step of several parts (D11, D12) | `parts` is an ordered list |
| An expected refusal (D8) | `expectRefusals` |
| Empty or missing is success (D10) | the default, with `emptyOn` for the statuses |
| A delete done as an update of the parent (D12) | `update_record` |
| A list read done by POST (Wired page) | `list.method: "POST"` with `body` |
| A post check (SSIDs, guest, Wired) | `read` then `expect` |
| A read that carries secrets (certificates) | `read.pick` keeps only scalars; the reply is dropped (AC-25) |
| A secret inside a listed record (webhooks) | only `idField` and `labelField` are ever copied |

### Worked examples

SSIDs (D1). The protected SSID is held by the guard file as well, so this `skipWhen` is a second, visible layer:

```json
{
  "key": "ssids",
  "featureName": "SSIDs",
  "pages": ["/network-setup/wireless"],
  "parts": [
    {
      "kind": "delete_each",
      "list": { "method": "GET", "path": "/api/v1/settings/ssids?size=2000", "itemsAt": "data.content", "idField": "id", "labelField": "instanceName" },
      "delete": { "path": "/api/v1/settings/ssids/{id}" },
      "skipWhen": [{ "field": "ssid.popTunnelUsed", "op": "eq", "value": true }]
    }
  ]
}
```

Guest Service Auth and Geo Control (D3, D4). From OFF the sequence is true, wait, false; from ON it is false only:

```json
{
  "key": "guest-service-auth-geo-control",
  "featureName": "Guest Service Auth and Geo Control",
  "parts": [
    { "kind": "read", "as": "state", "method": "GET", "path": "/api/v1/guestpop/advance",
      "pick": { "id": "[0].id", "tenantId": "[0].tenantId", "on": "[0].advanceSettingsEnabled" } },
    { "kind": "call", "method": "PUT", "path": "/api/v1/guestpop/advance/{read.state.id}",
      "body": { "id": "{read.state.id}", "tenantId": "{read.state.tenantId}", "advanceSettingsEnabled": true },
      "when": [{ "read": "state", "key": "on", "op": "eq", "value": false }] },
    { "kind": "wait", "seconds": 10, "when": [{ "read": "state", "key": "on", "op": "eq", "value": false }] },
    { "kind": "call", "method": "PUT", "path": "/api/v1/guestpop/advance/{read.state.id}",
      "body": { "id": "{read.state.id}", "tenantId": "{read.state.tenantId}", "advanceSettingsEnabled": false } },
    { "kind": "read", "as": "after", "method": "GET", "path": "/api/v1/guestpop/advance", "pick": { "on": "[0].advanceSettingsEnabled" } },
    { "kind": "expect", "read": "after", "key": "on", "op": "eq", "value": false }
  ]
}
```

Wired Access Management and Wired SSO (D6): when SSO is enabled, delete every entry except `ALL`, delete the SSO config, then delete `ALL`; when it is not, the same last part deletes everything:

```json
{
  "key": "wired-access-management",
  "featureName": "Wired Access Management and Wired SSO",
  "pages": ["/network-setup/access-management/wired"],
  "parts": [
    { "kind": "read", "as": "sso", "method": "GET", "path": "/api/v1/settings/sso-segment",
      "pick": { "pre": "ssoSegment.preTransactionSegment", "post": "ssoSegment.postTransactionSegment" } },
    { "kind": "delete_each",
      "list": { "method": "GET", "path": "/api/v1/client-configs?size=2000", "itemsAt": "$", "unwrap": "clientConfig", "idField": "id" },
      "delete": { "path": "/api/v1/client-configs", "batch": true, "body": { "ids": "{ids}" } },
      "skipWhen": [{ "field": "ruleType", "op": "eq", "value": "ALL" }],
      "allowLeftover": true,
      "when": [{ "read": "sso", "key": "pre", "op": "exists" }, { "read": "sso", "key": "post", "op": "exists" }] },
    { "kind": "call", "method": "DELETE", "path": "/api/v1/settings/sso-segment",
      "when": [{ "read": "sso", "key": "pre", "op": "exists" }, { "read": "sso", "key": "post", "op": "exists" }] },
    { "kind": "delete_each",
      "list": { "method": "GET", "path": "/api/v1/client-configs?size=2000", "itemsAt": "$", "unwrap": "clientConfig", "idField": "id" },
      "delete": { "path": "/api/v1/client-configs", "batch": true, "body": { "ids": "{ids}" } },
      "allowLeftover": true },
    { "kind": "read", "as": "after", "method": "GET", "path": "/api/v1/settings/sso-segment", "pick": { "pre": "ssoSegment.preTransactionSegment" } },
    { "kind": "expect", "read": "after", "key": "pre", "op": "missing" }
  ]
}
```

Nile DHCP scopes (D12): one update of the parent record with the subnet list emptied:

```json
{ "kind": "update_record",
  "list": { "method": "GET", "path": "/api/v1/settings/dhcp-clients?size=2000", "itemsAt": "data.content", "idField": "id" },
  "match": [{ "field": "dhcpClient.cloudDHCP", "op": "eq", "value": true }, { "field": "dhcpClient.servers[0].subnets", "op": "nonEmpty" }],
  "set": { "at": "dhcpClient.servers[0].subnets", "value": [] },
  "put": { "path": "/api/v1/settings/dhcp-clients/{id}" } }
```

### The 13 starting steps

The file `db/seed/portal-reset-starting-list.json` is rewritten at build (task 2) from the tested research file, which moves to `docs/research/` unchanged as evidence (the image excludes `docs`). The new file is `{ "schemaVersion": 1, "steps": [ ... ] }`, each entry `{ key, featureName, enabled?, note?, parts }` in run order (D17). Parts per step:

| # | Key | Parts (summary) | Enabled |
|---|---|---|---|
| 1 | `integrations` (pages: `/global-settings/integrations`) | Four `delete_each` parts, one per type: webhooks `/api/v1/subscriptions/webhooks/config`, SIEMs `/api/v1/siems`, email subscriptions `/api/v1/subscriptions/email` (no `labelField`, because a row is a recipient), DNS `/api/v1/dhcp/ddns/ddns-servers`. Delete by `DELETE <list>/{id}`. Last part: `read` of each list with `expect` that it is empty. | yes |
| 2 | `ssids` | The example above | yes |
| 3 | `guest-service-auth-geo-control` | The example above | yes |
| 4 | `wired-access-management` | The example above | yes |
| 5 | `policies` | `delete_each` on `/api/v3/policy/policysets` (`itemsAt: content`, `nested: { at: policies, parentIdField: id }`), delete `/api/v3/policy/policysets/{parentId}/rules/{id}` with body `{ "id": "{id}", "policySetId": "{parentId}" }`, `skipWhen` `policyAttribute.isDefault` true | yes |
| 6 | `service-profiles` | `delete_each` on `/api/v3/policy/service-profiles`, delete `/api/v3/policy/service-profiles/{id}` (the delete call and the system marker were never seen) | **no** until evidence (Follow-up) |
| 7 | `policy-groups` | Part 1: `delete_each` on `/api/v3/policy/groups?size=2000` skipping `groupType` `App`. Part 2: the same list with `onlyWhen` `groupType` `App` and `expectRefusals` `400` "Cannot delete, Group belongs to a Policy" (D8) | yes |
| 8 | `segments` | `delete_each` on `/api/v1/settings/segments?size=2000`, delete `/api/v1/settings/segments/{id}`, no body | yes |
| 9 | `authentication-admin-radius-and-guest-portals` | Two `delete_each` parts: RADIUS `/api/v1/settings/radius` (soft skip on the cloud flag, hard guard in the file) and Guest Portals `/api/v1/portalconfig` (`itemsAt: $`) | yes |
| 10 | `nile-radius-policies` | `delete_each` on `/api/v1/cloudradius/policysets` (nested, `isDefault` skipped), then `update_record` that sets `authResult` to `REJECT` on the default policy when it is not (D11) | yes |
| 11 | `nile-radius-certificates` | `call` `DELETE /api/v1/cloudradius/config/demo/keys` (200; 404 means none), then a `read` of `/api/v1/cloudradius/config` that picks only `usable` and `eapTLSConfig.complete` and an `expect` | yes (PEAP is not in the list; Follow-up) |
| 12 | `dhcp` | Part 1: `delete_each` on `/api/v1/settings/dhcp-clients` skipping `dhcpClient.cloudDHCP` true. Part 2: the `update_record` example above | yes |
| 13 | `guest-portal-branding` | `call` `DELETE /api/v1/cloud-profile/value`, always (D15). The body is not known (Follow-up); it ships with no body | yes |

### Guards and deny list (repo data)

`lib/portal-reset/deny-list.json` is `{ "prefixes": ["/api/*/idps", "/api/*/users", "/global-settings/identity", "/network-setup/users"] }`. A path matches when its leading whole segments equal a prefix, `*` matching one segment. The Users API paths are inferred and must be confirmed (Follow-up).

`lib/portal-reset/guards.json` is a list of guards: `{ key, listPath, itemsAt, nested?, idField, keepWhen: Rule[], deleteRoutePrefix, expectKept? }` where `expectKept` is `exactlyOne`, `atLeastOne`, or absent. The starting guards:

| Key | List and field | Delete prefix | Expect |
|---|---|---|---|
| `protected-ssid` | `/api/v1/settings/ssids`, `ssid.popTunnelUsed` true | `/api/v1/settings/ssids` | exactly one |
| `system-policies` | `/api/v3/policy/policysets`, nested, `policyAttribute.isDefault` true | `/api/v3/policy/policysets` | none |
| `nile-radius` | `/api/v1/settings/radius`, the cloud flag true (`cloudRadius`, to confirm) | `/api/v1/settings/radius` | exactly one |
| `nile-radius-policies` | `/api/v1/cloudradius/policysets`, nested, `isDefault` true | `/api/v1/cloudradius/policysets` | none |
| `nile-dhcp` | `/api/v1/settings/dhcp-clients`, `dhcpClient.cloudDHCP` true | `/api/v1/settings/dhcp-clients` | exactly one |

**Data model sketch**:

`hol_app.portal_reset_settings` (exactly one row)

| Column | Type | Rules |
|---|---|---|
| id | boolean, primary key | `check (id)`, so a second row cannot exist |
| abort_email | text, null | `check (abort_email is null or char_length(abort_email) <= 254)`; address shape checked by Zod |
| mode | text, not null, default `'off'` | `check (mode in ('off', 'dry_run', 'live'))`, constraint `portal_reset_settings_mode_check` |
| mode_changed_at | timestamptz, null | set by the Save that changes `mode`; spec 0023 AC-2 uses it so turning the engine on does not reset labs that ended before |
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
| enabled | boolean, not null, default true | |
| definition | jsonb, not null | `check (jsonb_typeof(definition) = 'object')` and `check (octet_length(definition::text) <= 20000)`; shape by Zod |
| note | text, null | `check (note is null or char_length(note) <= 300)` |
| seed_key | text, null | unique where not null (`portal_reset_steps_seed_key_uq`); the starting list entry this row came from |
| created_at, updated_at | timestamptz, not null, default `now()` | database clock |

Relationships: none between the two tables; `updated_by` points to `users` (N to 1). The migration is `0018_portal_reset.sql`. It also extends `audit_events_target_type_check` with `portal_reset_step` and `portal_reset_settings` (spec 0023's migration adds `portal_reset_run`). New CHECK lists get a Zod enum in `lib/db-enums.ts` and an entry in `checkLists` (`portal_reset_settings.mode`), and `server/db/types.ts` is regenerated with `npm run db:codegen`. The new unique names are added to `mapConstraintError` (`duplicate_name` for the feature name) as a backstop to the Zod check.

**Starting list file**: described above. It is imported as a module, so the migrate bundle carries it and the image needs no extra file. It lives under `db/`, not `docs/`, because `.dockerignore` excludes `docs`. The same `StepDefinition` schema validates each entry, plus `key` is unique within the file and `featureName` is unique ignoring case.

**Path rules** (one Zod schema in `lib/portal-reset/step-schema.ts`, used on the client for the editor and on the server for Save): starts with `/api/`; characters limited to letters, digits, `.`, `_`, `~`, `-`, `/`, `{`, `}`, `$`, and, in a list or read only, `?`, `=`, `&` for a query of `name=value` pairs; no `..`, no `//`, no `#`, no spaces; at most 200 characters; every `{...}` is a placeholder from the list above and a whole segment (or a whole string leaf in a body).

**State transitions**: none stored. UI state only: `read only` to (Edit, confirm) to `editing a draft` to (Save succeeds, or Discard) to `read only`. A failed Save stays in `editing`. A stale Save stays in `editing` with a Reload action.

**API surface** (Server Actions in `app/admin/actions.ts`, page at `app/admin/nile-portal-reset/page.tsx`):

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/admin/nile-portal-reset` | page GET | none | settings, steps in order with their description, the guards that apply to each step, the starting list entries (at most 100, passed as props), last saved by and at | `requireAdmin()` | redirect for non admins |
| `savePortalResetAction(expectedVersion, input)` | Server Action | `expectedVersion:int`, `abortEmail:string` (opt), `mode`, `steps[]` in final order, each `{ id?: uuid, seedKey?: string, featureName, enabled, note?, definition }` | new `version`, or field errors keyed by dotted path | `requireAdmin()` | `invalid` (field errors), `stale`, `unknown_step`, `duplicate_step`, `bad_seed_key` |

The page reads, and the engine reads, through `server/portal-reset/steps.ts`: `readResetList(db)` (AC-16), plus thin `listResetSteps(db)` and `getResetSettings(db)` for the page. The write side is `savePortalReset(db, input, adminId)` in the same module, returning a `Result`. The seed is `seedPortalReset(db)` in `server/portal-reset/seed.ts`.

**Normalization** (one pure function in `lib/portal-reset/normalize.ts`, applied before validation, comparison, and storage): trim every text field; an empty `abortEmail` or `note` becomes null; the email is lowercase; `featureName` is compared ignoring case but stored as typed (trimmed); a definition is stored in canonical form (parsed, keys in schema order, defaults not filled in). The "no change" rule (AC-12) and the version bump compare normalized values. The pure change computation lives in `lib/portal-reset/diff.ts` and is unit tested without a database.

Save algorithm, inside `refusable()` and one transaction: (1) lock the settings row `FOR UPDATE`; (2) if `version` differs from `expectedVersion`, throw `Refusal("stale")`; (3) read the current steps; (4) check every submitted `id` exists and appears once, every new row's `seedKey` is a key in the file, appears once in the draft, and is not already a `seed_key` in the table; (5) compute the diff; (6) if there is no change, return ok without writing; (7) delete removed rows; set every row whose name changes to a temporary unique value so a swap or a rename onto a removed name cannot hit the name index; then write the final names, the other updates, and the inserts, setting `position` from the array index plus 1; (8) update the settings row (email, mode, `version + 1`, `updated_by`, `updated_at = now()`); (9) write the audit rows. `refusable()` and `mapConstraintError` wrap the whole `transaction().execute()`, because a deferred constraint fails at commit.

**Seed** (`seedPortalReset`, one transaction): lock the settings row `FOR UPDATE`; if `seeded_at` is set, return. Otherwise, if the steps table is empty, insert the file's entries in order; if it already has rows (a dev database), insert nothing. In both cases set `seeded_at = now()`, leave `version` at 1 and `mode` at `off`, and write one `portal_reset.seeded` audit row (system actor, target `portal_reset_settings:settings`, metadata the count and the keys inserted).

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Page load | Steps and their order numbers | `portal_reset_steps` rows ordered by `position`; the number shown is `position` |
| Page load | The email, the mode, the version bound to Save | `portal_reset_settings.abort_email`, `.mode`, `.version` |
| Page load | A step's plain words description | `describeStep(definition)` (pure) |
| Page load | The guard lines under a step | `guards.json` entries whose `listPath` or `deleteRoutePrefix` equals a path in the step (pure) |
| Page load | "Last saved by NAME on TIME" | shown only when `settings.updated_by` is not null; NAME is `users.name` joined on `updated_by`, or "a removed user"; TIME is `updated_at` in the admin's timezone through `lib/format-time.ts` |
| Page load | Starting list entries not in the table | the file's entries (at most 100) minus keys in `portal_reset_steps.seed_key`, computed on the server and passed as props; the client also hides keys already in the draft |
| Edit confirm | The version the draft will send | the settings `version` read when Edit is confirmed, kept with the draft |
| Draft rows | A unique id for dnd-kit | a client only `clientKey`, never sent as `id` |
| Draft numbers | 1 to N after any add, remove, or move | derived from array index on the client; the server recomputes `position` |
| Save | `updated_by` and the audit actor | `requireAdmin()` session user id |
| Save | `updated_at`, `created_at` | SQL `now()` |
| Save | New row `id` | `gen_random_uuid()` default |
| Save | `seed_key` on a row added from the gaps list | the submitted `seedKey`, checked to be a key in the starting list file |
| Save | Whether a path is denied | `isDenied(path)` over `deny-list.json` |
| Audit rows | Names, definitions, before and after order | the diff of submitted rows against the locked current rows |
| Audit `email_changed` | `{ change: "set" or "cleared" or "changed", domain: the new domain or null }` | derived from old and new normalized `abort_email`; the address is not stored |
| Audit `mode_changed` | `{ mode: { from, to } }` | old and new `mode` |
| Audit `summary` (required text on each row) | one plain sentence per action | built from the diff: "Added step SSIDs at 3", "Updated step SSIDs", "Disabled step Service Profiles", "Removed step SSIDs", "Reordered 5 steps", "Abort email set", "Mode changed from off to dry run", "Saved, version 4 to 5", "Seeded 13 steps from the starting list" |
| Seed step | The rows inserted | the Zod parsed starting list file, in file order |

**Audit** (spec 0016 conventions): new `AuditAction` values `portal_reset.seeded` (system actor), `portal_reset.saved`, `portal_reset.step_added`, `portal_reset.step_updated`, `portal_reset.step_removed`, `portal_reset.steps_reordered`, `portal_reset.email_changed`, `portal_reset.mode_changed`. `step_*` rows use target type `portal_reset_step` and the step id; the others use `portal_reset_settings` with the target id `settings`. `step_updated` metadata comes from `changedFields` over `featureName`, `enabled`, `note`, and `definition` (none is a secret, AC-25). `lib/audit-log.ts` gets labels for each action and a new area `portal_reset` ("Nile Portal Reset") for the filter; the actor kind test table gets `portal_reset.seeded: "system"`. The Audit Log read side also needs a `TARGET_TYPE_LABEL` entry for both target types, a branch in `parseTarget` for `portal_reset_settings:settings`, and a label source in `resolveTargets` (a removed step's label comes from the audit metadata's `featureName`). Spec 0023 adds the run level actions to the same area.

**Key invariants**:
- There is one settings row and its `version` only goes up.
- `position` over all steps is exactly 1 to N with no gap or repeat after every committed Save and after the seed step.
- Every stored definition parses against the step language, and no stored path is on the deny list or outside `/api/`.
- The table never has zero rows after a Save. A database can only be empty before the first seed.
- A Save is all or nothing, and a stale Save writes nothing.
- A deploy never changes steps or settings after `seeded_at` is set.
- Mode is `off` on a fresh install and changes only by a Save.
- No audit row, log line, or error holds the full email address, and no definition holds a secret.

**Security model**:
- Admin only. Every page and Server Action calls `requireAdmin()`; none is on the public allow list in `tests/server-actions-require.test.ts`.
- The Edit and confirm pop up is a safeguard against accidents, not a security boundary. The Save action is enforced on the server whatever the UI state.
- The list is a set of destructive calls that the engine runs with a signed in portal admin. The closed part kinds, the path only rule, the deny list, the guards in the repo, the version check, the audit trail with full definitions, and the mode default of `off` are the controls here. Nothing here holds a portal credential or contacts a portal (AC-14).
- Even a fully compromised admin session cannot make the engine touch Identity or Users, or delete a guarded item, because both checks run in the engine from repo files (spec 0023 AC-25, AC-26). It can, however, add a step that deletes other things on a portal, so the live mode confirm and the audit trail matter.
- The email is plain text, not a secret, but is kept out of audit metadata and logs. Free text is rendered as text by React, never as HTML.
- No compliance scope beyond the project's existing audit practice.

**Configuration required**: none. No new environment variable, secret, or credential for this spec. The starting list, deny list, and guards ship in the repo.

**UX surface** (built to `design.md` and the look of Testbed Types and API Keys, with `PageHeader`, `PageBody`, `FormDialog`, and the existing confirm dialog pattern):
- Route `/admin/nile-portal-reset`, added to `ADMIN_SECTIONS` and `ADMIN_NAV` between Users and Audit Log, title "Nile Portal Reset", subtitle along the lines of "The portal calls a reset makes, in the order it runs them", with a history link to the audit log filtered to the new area. Spec 0023 adds a "Recent resets" link here.
- Top: the abort email (text in read only; an input in edit mode) with the empty warning (AC-10), the mode (text with a badge; a select in edit mode), and the "Last saved by" line. Below, the table: handle, number, feature name with a Disabled badge, the description (one line per part), the guard lines, and the note. In edit mode each row also has Edit and Remove buttons.
- Edit button in the header opens the confirm pop up: "Edit the reset list? Changes apply to every Nile Portal reset after you save." Buttons Cancel and Edit. In edit mode the header shows Save and Discard; Add row and "Add from starting list (N)" sit above the table.
- The draft starts from the props once when Edit is confirmed (`useState`) and does not follow later prop refreshes (the repo rule for edit dialogs). The version is captured at the same moment. Reload (after `stale`) and Discard remount the draft with a new React `key`. While a Save is pending the whole draft is frozen.
- The row dialog: feature name, note, an Enabled switch, and the parts JSON text area (AC-23) with the description of what the parts do shown live beside it.
- Leaving with changes: a `beforeunload` prompt covers reload and closing the tab; the admin nav links and the page's own links check the dirty draft and ask first through one small guard in the admin shell. The browser back button is the accepted gap (Consequences).
- Dragging: `DndContext` and `SortableContext` from dnd-kit with `MouseSensor`, `TouchSensor` (short press delay), and `KeyboardSensor` using `sortableKeyboardCoordinates`; each sortable item uses its `clientKey`; `touch-action: none` on the handle only; `DndContext` mounts only after Edit; custom announcements name the row and place; the handle is a real button with an `aria-label` like "Reorder SSIDs, position 1 of 13". Focus stays on the handle after a drop. Reduced motion is respected.
- Empty, loading, and error states: an empty table (only before seeding) shows a plain message; Save shows a pending state; field errors show next to the field or the JSON text; `stale` shows a top message with a Reload button.

**Critical test scenarios** (each maps to an acceptance criterion):
- Happy path: seed an empty database from the file, open the page, Edit, confirm, add a row, drag it to position 1, change the email, Save, reload, and see the same order and email, verifies **AC-1, AC-5, AC-6, AC-7, AC-12**
- Idempotent seed: run the seed step twice, and again after deleting all rows and adding an entry to the file; nothing changes, verifies **AC-2**
- Failure case: two sessions load version 3; the first saves; the second gets `stale`, nothing is written, the draft stays, verifies **AC-11**
- Failure case: each invalid input (bad email, bad mode, repeated name ignoring case, a path with a host or `..` or `#`, a delete path with a query, a method `PATCH`, `{parentId}` with no `nested`, `{ids}` in a non batch delete, a `when` naming a read that comes later, a body key `password`, 101 rows, 0 rows, 13 parts, a 61 second wait, a 20 001 character definition) returns a field error at the right dotted path and writes nothing, verifies **AC-9, AC-25**
- Deny list: `/api/v1/idps`, `/api/v2/idps/{id}`, `/api/v1/users/x/roles`, `/API/V1/USERS`, and a percent encoded form are refused; `/api/v1/userinfo` is accepted, verifies **AC-19**
- Language: one fixture per need in the findings table parses; the 13 starting steps parse and describe, verifies **AC-18, AC-24**
- Guards: `guards.json` parses, each guard shows on the matching step, no action changes it, verifies **AC-20**
- Failure case: a Save that fails inside the transaction leaves the table, version, and audit rows unchanged, verifies **AC-7, AC-12**
- Failure case: a Save that swaps two feature names, and one that renames onto a removed name, both succeed, verifies **AC-7, AC-9**
- Failure case: the same `id` twice, a repeated or used `seedKey`, and a `seedKey` on an existing row are handled as specified, verifies **AC-9, AC-13**
- Failure case: the seed on a database with rows but no `seeded_at` inserts nothing and sets the marker; two seeds at once insert once, verifies **AC-2**
- Live confirm: choosing `live` asks the second confirm; cancel keeps the old mode, verifies **AC-22**
- Disabled: a disabled step shows the badge and `readResetList` returns it with `enabled: false`, verifies **AC-21**
- Scan: nothing under the page, `server/portal-reset/`, or `lib/portal-reset/` calls `fetch` or imports `server/portal-engine/`, verifies **AC-14**
- Read contract: `readResetList` returns settings and steps from one snapshot, and a row with a broken definition comes back as `{ ok: false }`, verifies **AC-16**
- Pure: the diff over added, updated, removed, reordered, enabled, and definition changes, including a removal that shifts others and a Save that differs only by spaces, verifies **AC-12**
- Audit: the email address text appears in no audit metadata, summary, or log, verifies **AC-12**
- Keyboard: focus a handle, Space, ArrowDown, Space moves a row one place and announces it; Escape cancels, verifies **AC-8**
- Auth/permission: a learner session and no session are refused on the page and on both actions, verifies **AC-3**
- Layout: at a phone width the rows show as cards and the page has no sideways scroll, verifies **AC-15**
- Read only: in the first view there are no handles, inputs, or Save, and Cancel on the confirm changes nothing, verifies **AC-4, AC-5**
- Removed starting entry: remove a starting row, Save, and see it under "Add from starting list" with the re-add note, verifies **AC-13, AC-26**

## Build plan

Build approach: Tracer Bullet (the project default). Slice 1 proves a real thread through every layer (database, seed, server read, admin page). Later slices thicken it one strand at a time. The migration is one file, because the model is small and Slice 1 needs both tables. Spec 0023's engine builds after this spec's read module (task 6) exists.

1. The step language: `lib/portal-reset/portal-path.ts`, `step-schema.ts` (parts, rules, conditions, placeholders, path rules), `deny-list.json` with `isDenied`, `guards.json` with its schema, `describe.ts`, `normalize.ts`, with a fixture test per need, satisfies **AC-9, AC-18, AC-19, AC-20, AC-24, AC-25**
2. The starting list: rewrite `db/seed/portal-reset-starting-list.json` to the new schema from the tested research file (the research file moves to `docs/research/portal-reset-starting-list.research.json`, unchanged), with its Zod test (parses, unique keys, no denied path, describes), satisfies **AC-17, AC-18, AC-21**
3. Migration `0018_portal_reset.sql`: both tables, the one settings row, the constraints and indexes above, the extended audit target type check; Zod enums and `checkLists` entries; `npm run db:codegen`; the `mapConstraintError` names, satisfies **AC-1, AC-9**
4. `server/portal-reset/seed.ts` called from `scripts/migrate.ts` after the migrator, and the bundle check (`build:bundle` and the image carry the JSON), satisfies **AC-1, AC-2, AC-17**
5. Tracer thread: `server/portal-reset/steps.ts` read functions, the nav entry, and the read only page with the table (cards on narrow screens), the description and guard lines, the email and mode text, and the last saved line, behind `requireAdmin()`, satisfies **AC-3, AC-4, AC-10, AC-15, AC-16, AC-20, AC-21**
6. Pure diff `lib/portal-reset/diff.ts` with tests, then Save: `savePortalReset` (lock, version check, diff, rename safe writes, audit rows with summaries) with `refusable()` around the whole transaction, the Server Action with field errors, the audit actions, labels, area, the actor kind table entry, and the Audit Log read side changes, satisfies **AC-7, AC-9, AC-11, AC-12**
7. Edit mode without dragging: Edit button and confirm pop up, the draft (`useState` once), the email field, the mode select with the live confirm, Add, Edit and Remove through a `FormDialog` with the JSON text area and live errors, Save and Discard with the dirty prompts, the stale message and Reload, satisfies **AC-5, AC-6, AC-7, AC-11, AC-22, AC-23**
8. Dragging: install `@dnd-kit/core` and `@dnd-kit/sortable`, the handle, the mouse, touch and keyboard sensors, announcements, live renumbering, satisfies **AC-6, AC-8**
9. Starting list gaps: the "Add from starting list (N)" control fed by props, the re-add note, the `seedKey` checks on Save, satisfies **AC-13, AC-26**
10. Tests: DB integration inside `inRollback` (seed once and concurrently, save, stale, swap and rename, rollback on failure, audit contents, no email in audit, constraints), Server Action auth coverage, the AC-14 scan test, a Playwright flow for edit, drag by keyboard, save, and reload (runs locally against real Authentik; it needs a test admin, which does not exist right now), satisfies **AC-2, AC-3, AC-8, AC-11, AC-12, AC-14**

## Consequences

**Positive**:
- The owner changes the reset list from the page, with a confirm, an audit trail that keeps the full before and after of every change, and no deploy.
- All 13 tested steps, and any step of the same kinds in future, are data.
- A half saved or conflicting list cannot be stored, so the engine never reads a list in the middle of an edit.
- Identity, Users, and the protected items are safe from the page, from the database, and from discovery, because the rules live in the repo and are applied by the engine.
- The seed is safe to redeploy: the database owns the list after the first seed.

**Negative / tradeoffs**:
- A new dependency (dnd-kit), a draft state machine, and a larger schema and describer add code to test and keep.
- The editor is JSON text. An admin who mistypes a path finds out at Save (a field error) or at a dry run, not while typing a form.
- The migrate process does a TypeScript seed step, so a bad starting list file blocks a deploy (on purpose, and a test catches it before then).
- Shape checks cannot tell a right path from a wrong one on the real portal. A wrong path or order is found by a dry run (spec 0023), which is why the mode starts at `off`.
- Hard delete means a removed row is recovered from its audit row or the starting list gaps control.
- The browser back button can leave a dirty draft without a prompt; the nav links and tab close are guarded.
- The rename safe write is extra Save logic that exists only because of the unique name index.

**Neutral**:
- The app gets its first settings table; later settings can follow the same single row pattern.
- The first spec said feature 24 "assumes items with an `id`"; that is now explicit in `list.idField`.
- The `portal_reset` audit area is new, so the Audit Log filter gains one entry.
- The research JSON file moves out of `db/seed/` and a new, smaller file takes its path.

## Follow-up

- [ ] Rewrite the starting list file at build (task 2). Pending evidence: **Service Profiles** ships disabled (no delete call and no system marker were seen; create an admin profile on a scratch tenant to capture both); **PEAP** configuration delete is not in step 11 (never configured on Workshop 4); **Guest Portal branding** ships with no body on `DELETE /api/v1/cloud-profile/value` (capture the body by restoring a customised tenant with full request logging); **device group** deletes are untested; **Splunk, Snowflake, and Generic HTTP SIEMs** are assumed to share `/api/v1/siems`.
- [ ] Confirm the Nile RADIUS cloud flag property path (`cloudRadius` in the research file) with one read at build; a wrong path makes the engine stop loudly (spec 0023 AC-26), never delete.
- [ ] Confirm the Users page API paths with the owner without visiting the page (the deny list uses `/api/*/users` as a safe superset).
- [ ] Spec 0023 reads the list through `readResetList`. Build it after task 6.
- [ ] `web-dnd-dnd-kit` was installed with the first design; add its bullet to `## Agent skills` in `AGENTS.md` (`/sync` owns that edit).
- [ ] Add after the build to `AGENTS.md` (`/sync`): reads of the reset list go through `server/portal-reset/steps.ts`; the draft is saved only by `savePortalReset`; the deny list and guards are repo data in `lib/portal-reset/` and are never read from the database; nothing under the page, `server/portal-reset/`, or `lib/portal-reset/` imports `server/portal-engine/`.
- [ ] Update README "Nile Portal Reset setup (planned)" after both specs ship.
- [ ] The e2e flow needs a test admin. `hol-test-admin` was removed on 2026-10-26, so recreate it before `/check verify` can drive the page.
- [ ] Check the dnd-kit version and React 19 support when installing; switch to `@dnd-kit/react` only if the older packages do not support React 19.2.
- [ ] Later option: a form per part kind in the row dialog instead of JSON, and a mode per testbed.
