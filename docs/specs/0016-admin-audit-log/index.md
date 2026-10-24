# 0016. Admin audit log

**Date**: 2026-10-20
**Status**: Accepted
**Builds on**: [spec 0002](../0002-data-model/index.md) (the `audit_events` table, its append only and no truncate triggers, AC-7), [spec 0005](../0005-design-system-ui-foundation/index.md) (the admin shell, `PageHeader`, `PageBody`, the nav), [spec 0008](../0008-admin-users/index.md) (the admin timezone, the user detail page). **Settles** spec 0005's deferred "Admin table sorting and pagination" for this one list (server pages, see AC-3); the other admin lists keep client search.

## Summary

The app already writes an audit entry for every action the scope names (API key secrets, catalog changes, testbed group changes in Authentik, deactivation, admin cancels), and Postgres already refuses any edit or delete of those entries. This feature adds the part that's missing: a read only **Audit Log** section in the admin console where every admin can see every entry, newest first, 50 per page, with filters in the URL (who, which area, which admin, a date range, free text). Each entry can be expanded to show what changed. Each admin list row gets a History link, and a learner's detail page gets a short history panel. Nothing changes in how entries are written, and the only migration is one index that makes paging exact.

## Requirements

**User stories**:
- As an admin, I want to see who did what and when across the console, the booking form, and the worker, so that I can answer "who changed this?" without asking around.
- As an admin, I want to narrow the log to one testbed, key, type, learner, or booking, so that I can read one thing's history from start to end.
- As the owner, I want the log to be impossible to edit from the app, so that it can be trusted.

**Acceptance criteria**:

*The section and the list*
- **AC-1**: A fifth admin section, `audit-log`, is added last in `ADMIN_SECTIONS` and `ADMIN_NAV` (`lib/admin-nav.ts`): label "Audit Log", subtitle "Who changed what, from the console, the booking form, and the worker.", icon `HistoryIcon`, href `/admin/audit-log`. `AdminSection`, `activeSection`, and `PageHeader` pick it up with no other change, and `lib/admin-nav.test.ts` is updated for the new order and label. The page `app/admin/audit-log/page.tsx` calls `requireAdmin()` first and shows every entry to every admin (no per admin scoping). A learner or a signed out visitor gets the same redirect every admin page gives (`requireAdmin`). The console still opens on Testbed Types.
- **AC-2**: The list shows entries newest first, ordered by `created_at desc, id desc`. Each row shows: the time (`formatDateTime(created_at, admin.timezone)`, formatted on the server, with the admin from `requireAdmin()`), the actor (AC-6), the action label and its area (AC-13), the target (AC-7), and the stored `summary`. It is a server rendered table built from `components/ui/table` (not `DataTable`, whose search filters rows in the browser). One row component, `components/admin/audit-row.tsx`, renders a row for both the log and the user detail History section (AC-10). It receives only plain strings and the details lines, and it is a client component only for the disclosure (AC-8).
- **AC-3**: Paging is keyset (a "continue after this row" bookmark rather than a page number). A page holds 50 entries. Two URL params carry the cursor: `before=<cursor>` reads the Older page, `(created_at, id) < (cursor)` newest first; `after=<cursor>` reads the Newer page, `(created_at, id) > (cursor)` in ascending order, then reversed for display. The "Older" link carries the last shown row's cursor as `before`, and "Newer" carries the first shown row's cursor as `after`. The cursor is base64url of `<timestamp>|<id>`. The timestamp is produced by SQL as microsecond UTC text (`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`) and compared as `timestamptz`, never passed through a JS `Date`, which keeps only milliseconds and would skip or repeat rows. A cursor is bad (AC-14) when base64url decoding fails, when it doesn't split on `|` into exactly two parts, when the timestamp fails `z.iso.datetime({ precision: 6 })`, or when the id fails `z.uuid()`. Each read fetches 51 rows to know whether another page exists in its direction. Link rules: with no cursor (the newest page) there is no Newer link, and Older shows if a 51st row came back; on a `before` page, Newer always shows and Older shows if a 51st row came back; on an `after` page, Older always shows, and Newer shows only if a 51st row came back (otherwise this is the newest page). Rows written in one transaction share `created_at` (`now()` is fixed per transaction), and `id` breaks those ties, so a walk through the pages shows every entry committed before it started exactly once. A transaction that commits late with an earlier `now()` can land behind a cursor already passed; it shows on a fresh newest page (accepted).
- **AC-4**: Filters, all in the URL as query params, combined with AND, applied in SQL, and submitted by a plain GET form of native named controls (`<select>`, `<input type="date">`, `<input type="search">`, styled to `design.md`), so it works before hydration. Applying or clearing a filter drops the cursor. A param given more than once uses its first value. Parsing lives in `parseAuditQuery` (`lib/audit-log.ts`), one Zod schema per param.
  - `actor`: one of `admin`, `learner`, `booking_form`, `system`, from the one exported `ActorKind` mapping (AC-6). In SQL: `admin` and `learner` join `users` on `actor_user_id` and match today's `users.role`; `booking_form` is `actor_user_id is null and action in (BOOKING_FORM_ACTIONS)`; `system` is `actor_user_id is null and action not in (BOOKING_FORM_ACTIONS)` (so a legacy action that no longer parses counts as system).
  - `area`: one of the areas in AC-13; it matches `action in (<every action of that area>)`.
  - `admin`: one admin's `users.id` (`z.uuid()`); the picker comes from `listAdmins(db)` in `server/audit-log.ts`, every `users` row with `role = 'admin'`, ordered by `name`.
  - `from`, `to`: dates `YYYY-MM-DD` (`z.iso.date()`), read as whole days in the admin's timezone, which is bound as a text parameter: `created_at >= (from::date)::timestamp at time zone $tz` and `created_at < ((to::date + 1)::timestamp at time zone $tz)`. Either may be given alone. When both are given and `from` is after `to`, both are dropped.
  - `q`: free text, trimmed, then 2 to 100 characters; the trimmed value is what fills the form. It is matched as `ILIKE '%' || $q || '%' ESCAPE '\'`, with `\`, `%`, and `_` in `$q` escaped first, against: `summary`; the action, as the name itself and as its label (the actions whose `AUDIT_ACTION_INFO` label matches, case insensitive, computed in TS and passed as an `action in (...)` list); the actor's `users.name` and `users.email` (a left join, since the actor may be null); and the target's name, through one `(target_type, target_id) in (...)` subquery, a union of `testbed_types`, `testbeds`, and `api_keys` by `name`, `users` by `name` or `email`, `bookings` by their learner's `name` or `email`, and `authentik_group` targets whose testbed (`testbeds.authentik_group_pk = target_id`) matches by `name`. Every id in that union is compared as text (`id::text`), never by casting `target_id` to uuid.
  - `target`, `learner`: the history filters in AC-5.
- **AC-5**: History filters. `target=<type>:<id>` is split on its first colon only. The type must parse as `AuditTargetType`. The id must be a uuid for `testbed_type`, `testbed`, `api_key`, and `booking`; for `user`, a uuid, `authentik:<digits>`, or `unknown`; for `authentik_group`, a string matching `^[A-Za-z0-9-]{1,64}$`. Anything else is dropped (AC-14). It shows entries with exactly that `target_type` and `target_id`. `learner=<users.id>` (`z.uuid()`) shows a learner's history, read as a union of three arms, each served by an existing index and each limited to the page size plus one, then merged and ordered by `created_at desc, id desc`: (1) `actor_user_id = $id`; (2) `target_type = 'user' and target_id = $id::text`; (3) `target_type = 'booking' and target_id in (select id::text from bookings where user_id = $id)`. So it includes access grants (booking target), access revokes (user target), the booking form's rows about this user, admin sign in rows for this user, and the learner's own reschedules and cancels. The other filters and the cursor apply to every arm. When `target` or `learner` is set, a removable chip above the table reads "History for <name>", where the name comes from `resolveTargets` (AC-7), or "<type label> (not found)" when no row matches. Its × link clears just that filter. When both are set, two chips show, and both filters apply (AND). On a `target=booking:<id>` view whose booking row exists, a note under the chip reads "Access removals for this booking are listed in the learner's history." and links to `?learner=<bookings.user_id>`. With no booking row, no note shows.
- **AC-6**: Actor. `lib/audit-log.ts` exports `ActorKind` (a Zod enum `admin | learner | booking_form | system`), `BOOKING_FORM_ACTIONS`, and `actorKind(actorRole, action)`. The SQL filter (AC-4) and the display both use them, so they cannot drift. When `actor_user_id` is set, the actor is that user's `name`, with a small role badge ("Admin" or "Learner") from today's `users.role` (a role change relabels past rows; accepted, since admins and learners never swap in this app). A learner actor links to `/admin/users/<id>`. When it is null, the actor is **"Booking form"** if the action is in `BOOKING_FORM_ACTIONS` (`booking.created`, `booking.refused_admin_email`, `booking.refused_username_taken`, `booking.refused_duplicate_email`, `user.created_in_authentik`, `user.tagged_in_authentik`, the actions the public `/book` saga writes for guests and signed in learners alike), and **"System"** otherwise (worker steps, sweepers, the sign in check, and any action that no longer parses). This is a display mapping, so it is right for old rows too and changes no write path. A unit test lists every action the code writes with `actorUserId: null` and checks each is classified as intended.
- **AC-7**: Target. `resolveTargets(db, refs, timeZone)` in `server/audit-log.ts` resolves names in one batched read per target type after the page loads its rows (a `where id in (...)` per table, ids checked with `z.uuid()` first, never a cast of `target_id`). `listAuditEvents` and `learnerHistory` call it themselves, so every `AuditRow` they return already carries its label.
  - `testbed_type`, `testbed`, `api_key` → the row's `name`, with a "Deleted" badge when `deleted_at` is set.
  - `user` → `name` and `email`, with "(admin)" for an admin. Users are never deleted, so there's no badge.
  - `booking` → "<learner name> · <testbed name> · <start in the admin's timezone>", with "(deleted testbed)" after the testbed name when that testbed is soft deleted. Bookings are never deleted.
  - `authentik_group` → "<testbed name> access group", found by `testbeds.authentik_group_pk = target_id`. With no such testbed (an undone create), it shows "<metadata.name> access group" when the entry's metadata has a string `name`, else "Access group (not found)".
  - Non uuid ids where a uuid is expected: `authentik:<pk>` → "Authentik user <pk>", `unknown` → "Unknown".
  - A well formed id with no row → "<type label> (not found)". That includes a `booking` target that holds a testbed id (the reconciler fallback in Follow-up).

  Every target name, fallbacks included, links to `?target=<type>:<raw target_id>` (URL encoded).
- **AC-8**: Expanding a row (a disclosure button, keyboard reachable, `aria-expanded`) shows its metadata as readable lines from `describeMetadata(metadata)` in `lib/audit-log.ts`. A `{ from, to }` value (the `changedFields` shape) reads "<Field label>: <from> → <to>". Any other value reads "<Field label>: <value>". Each key is shown on its own; related keys are never merged (a testbed type edit reads "Duration value: 2 → 3"). Field labels come from `METADATA_LABELS`: `name` "Name", `durationValue` "Duration value", `durationUnit` "Duration unit", `type` "Type", `baseUrl` "Base URL", `slug` "Slug", `clients` "Clients", `email` "Email", `company` "Company", `timezone` "Timezone", `phase` "Phase", `source` "Source", `fromStartsAt` "Was starting", `toStartsAt` "Now starting", `fromTestbedId` "Was testbed", `toTestbedId` "Now testbed", `testbedId` "Testbed", `userId` "User", `groupPk` "Access group", `authentikUserPk` "Authentik user", `authentikSynced` "Synced to Authentik", `reusedAuthentikUser` "Reused Authentik user", `sessionsEnded` "Sessions ended", `vmRevoke` "Lab session revoke". Any other key falls back to its name split into words in sentence case ("googleMethod" → "Google method"). Values: `null` reads "empty", booleans "yes" or "no", numbers and strings as stored, and objects or arrays as compact JSON. A key matching `/secret|password|token|ciphertext/i` is never rendered, even though no writer stores one (defense in depth). A row with empty metadata (for example `api_key.secret_replaced`, which stores none) shows no expand button.

*History from other pages*
- **AC-9**: Each row's `actions` in `app/admin/testbed-types/page.tsx`, `app/admin/testbeds/page.tsx`, and `app/admin/api-keys/page.tsx` gets a "History" icon link beside edit and delete (`aria-label` "History for <name>"), to `/admin/audit-log?target=<type>:<id>`. Each row's `actions` in `app/admin/users/page.tsx` gets one to `/admin/audit-log?learner=<id>`.
- **AC-10**: The user detail page (`app/admin/users/[id]/page.tsx`, learners only, as today) gains a "History" section after the Emails section: `learnerHistory(db, userId, admin.timezone, 20)`, the learner's 20 newest entries by the AC-5 `learner` rule, shown with `audit-row.tsx` (time, actor, action, target, summary, expand). A "See all" link goes to `/admin/audit-log?learner=<id>`. With no entries it reads "No history yet." Each row of that page's bookings table gets a "History" link to `/admin/audit-log?target=booking:<id>`.

*Trust and coverage*
- **AC-11**: The log is read only from the app. There is no edit, delete, or bulk control, no Server Action, and no route that writes to `audit_events` other than `audit()` in `server/audit.ts`. Opening the log writes no entry. The spec 0002 AC-7 triggers stay as they are. A source scan, `tests/audit-append-only-scan.test.ts`, fails if app code (everything outside `db/migrations/` and generated types) contains `updateTable("audit_events")`, `deleteFrom("audit_events")`, or an SQL `update`, `delete from`, or `truncate` naming `audit_events`.
- **AC-12**: Each action the scope names writes one entry with actor, action, target, and time. A DB test, `server/audit-coverage.test.ts` (inside `inRollback`, with the fake Authentik from `server/authentik/testing.ts`), runs each through its real server function and checks the row's `actor_user_id`, `action`, `target_type`, `target_id`, and that `created_at` is set and not after the test's `now()` (some writers use their own connection, not the caller's transaction, so equality with one `now()` is not claimed): `api_key.created`, `api_key.secret_replaced`; `testbed_type.created`, `.updated`, `.deleted`; `testbed.created`, `.updated`, `.deleted`; `authentik_group.created` (testbed create), `authentik_group.deleted` (teardown); `access.granted`, `access.revoked` (reconciler); `user.deactivated`; `booking.cancelled` by an admin (detail page cancel and deactivation). Admin actions carry the admin's id. Worker actions carry null.
- **AC-13**: `AUDIT_ACTION_INFO` in `lib/audit-log.ts` gives every `AuditAction` a sentence case label written from the action (`testbed_type.updated` → "Testbed type updated", `access.revoked` → "Access revoked", `admin.sign_in_refused` → "Admin sign in refused") and an area, typed `satisfies Record<AuditAction, AuditActionInfo>` so a new action can't compile without one. The areas (`AuditArea`, a Zod enum) and their actions:
  - `admin` "Admin": `admin.signed_in`, `admin.sign_in_refused`, `admin.timezone_set`
  - `api_keys` "API keys": `api_key.*`
  - `testbed_types` "Testbed types": `testbed_type.*`
  - `testbeds` "Testbeds": `testbed.*`
  - `access_groups` "Access groups": `authentik_group.*`, `access.*`
  - `users` "Users": `user.*`, `set_password.resent`
  - `bookings` "Bookings": `booking.*`

  A row whose `action` no longer parses as `AuditAction` shows the raw action name and no area, and never breaks the page. A unit test checks that every area has at least one action.

*States and the index*
- **AC-14**: With no entries at all, the table shows "No audit entries yet." When filters match nothing, it shows "No entries match these filters." with a "Clear filters" link. A param that fails to parse (a bad uuid, an unknown kind or area, a bad date, `from` after `to` (both dropped), a `q` too short or long after trimming, a bad `target` per AC-5, a bad cursor per AC-3, or both `before` and `after` (both dropped)) is dropped and the page shows one notice: "Some filters in this link weren't valid and were ignored." It is never an error page.
- **AC-15**: Migration `db/migrations/0012_audit_keyset_index.sql` creates `audit_events_created_at_id_idx` on `hol_app.audit_events (created_at desc, id desc)` and then drops `audit_events_created_at_idx`. No column, table, constraint, or trigger changes. `npm run db:codegen -- --verify` still passes.
- **AC-16**: Playwright (`e2e/audit-log.spec.ts`): an admin edits a testbed type, opens Audit Log, sees the entry at the top with their name, expands it to see the changed duration, filters by area and by `q`, follows the testbed type's History link, and pages Older and Newer. Axe finds no violations on `/admin/audit-log` and on the user detail page with its History section. Screenshots are taken at desktop and mobile widths.

## Decision

**Chosen option**: Option 1: Server pages over the existing table, names looked up at read time.

A read only Audit Log section that reads `audit_events` as it is, in keyset pages of 50 with URL filters applied in SQL. Actor and target names are resolved when reading (a display mapping for null actors, a batched lookup for targets), plus History links and a learner history panel. Nothing changes on the write side, and one index migration is added.

**Implementation skills**: `kysely` (`mindrally/skills`, `.claude/skills/kysely/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.claude/skills/supabase-postgres-best-practices/`) · `vercel-react-best-practices` (`vercel-labs/agent-skills`, `.claude/skills/vercel-react-best-practices/`) · `shadcn` (`shadcn-ui/ui`, `.claude/skills/shadcn/`) · `shadcn-baseui` (`thunderboltdev/shadcn-baseui`, `.claude/skills/shadcn-baseui/`) · `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`) · `playwright-best-practices` (`currents-dev/playwright-best-practices-skill`, `.claude/skills/playwright-best-practices/`)

## Rationale

Reasoning and options: see [rationale.md](rationale.md).

## Feature design

**Data model sketch**:

No new table or column. The log reads `hol_app.audit_events` (spec 0002, migration `0003`) as it is:

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | uuid PK | no | tie breaker for paging |
| `actor_user_id` | uuid FK → `users.id` | yes | null = booking form or system (AC-6) |
| `action` | text | no | an `AuditAction` (no DB CHECK) |
| `target_type` | text CHECK | no | `AuditTargetType` |
| `target_id` | text | no | usually a uuid; also `authentik:<pk>`, a group pk, or `unknown` |
| `summary` | text | no | shown as stored |
| `metadata` | jsonb | no | changed fields and ids, never secrets |
| `created_at` | timestamptz | no | `now()` of the writing transaction |

Reads join to `users` (actor, and the learner of a booking), `testbed_types`, `testbeds`, `api_keys`, `bookings` (target names). Indexes after `0012`: `audit_events_created_at_id_idx (created_at desc, id desc)` (paging), `audit_events_target_idx (target_type, target_id)` (the `target` and `learner` filters), `audit_events_actor_user_id_idx` (the `admin` and `learner` filters). Retention: entries are kept for the life of the product (owner choice).

**State transitions**: none. An entry is written once and never changes.

**API surface** (pages and server functions; no Server Action, no route handler):

| Surface | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/admin/audit-log` page | GET | `actor`, `area`, `admin`, `from`, `to`, `q`, `target`, `learner`, `before` or `after` (all optional) | 50 rows, Older and Newer cursors, the active filters, a dropped filter notice | `requireAdmin()` | not admin → `requireAdmin` redirect; bad params → dropped with notice (AC-14) |
| `parseAuditQuery(params)` in `lib/audit-log.ts` | pure | the raw `searchParams` | `{ query: AuditQuery, dropped: readonly string[] }` | none | never throws; each param parsed alone with Zod |
| `listAuditEvents(db, query, timeZone)` in `server/audit-log.ts` | read | `AuditQuery`, the admin's IANA zone | `{ rows: AuditRow[], older?: string, newer?: string, chips: TargetLabel[], bookingNoteUserId?: string }` (calls `resolveTargets` itself) | caller checked `requireAdmin` | none expected; DB failure throws to the admin error boundary |
| `learnerHistory(db, userId, timeZone, limit)` in `server/audit-log.ts` | read | learner id, the admin's zone, 20 | `AuditRow[]` (calls `resolveTargets` itself) | caller checked `requireAdmin` | none |
| `resolveTargets(db, refs, timeZone)` in `server/audit-log.ts` | read | `{ type, id, metadata }[]` | `Map<"<type>:<id>", TargetLabel>` | internal | unknown ids → fallback labels (AC-7) |
| `listAdmins(db)` in `server/audit-log.ts` | read | none | `{ id, name }[]`, role admin, by name | caller checked `requireAdmin` | none |
| `describeMetadata(metadata)` in `lib/audit-log.ts` | pure | `unknown` (the jsonb) | `readonly { label, text }[]` | none | non object → empty list |
| `actorKind(role, action)` in `lib/audit-log.ts` | pure | `users.role` or null, the action text | `ActorKind` | none | unknown action with null role → `system` |

`AuditRow` = `{ id, time: string, cursor: string, actor: { kind, label, userId?, role? }, action: { name, label, area? }, target: { type, id, label, deleted, href }, summary, details: readonly { label, text }[] }`. Every field is a plain string or array, formatted on the server (`time` through `formatDateTime` in the admin's zone), so the client row component gets no `Date`. The `cursor` is the base64url of `<microsecond UTC text>|<id>` (AC-3).

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| list | entry time | `audit_events.created_at`, shown in `users.timezone` of the admin from `requireAdmin()` (spec 0008) |
| list | actor name and role | `users.name`, `users.role` by `actor_user_id`; null → "Booking form" or "System" by the AC-6 action set |
| list | action label and area | `AUDIT_ACTION_INFO[action]` (AC-13) |
| list | target name and Deleted badge | the target table's `name` and `deleted_at`; booking → learner `users.name`, `testbeds.name`, `bookings.starts_at`; group → `testbeds.authentik_group_pk` (AC-7) |
| list | summary | `audit_events.summary` as stored |
| row detail | changed fields lines | `audit_events.metadata` through `describeMetadata` (AC-8) |
| paging | cursor | SQL `to_char(created_at at time zone 'UTC', …US…)` plus `id` of the boundary row (AC-3) |
| filter `from`, `to` | day bounds | the URL date plus the admin's `users.timezone`, converted in SQL (AC-4) |
| filter `admin` | picker options | `users` where `role = 'admin'`, ordered by `name` |
| filter `learner` | the learner's booking ids | `bookings.user_id` (subquery) |
| booking note | the learner to link to | `bookings.user_id` of the `target` booking |
| chip | target name | `resolveTargets` on the filter's own `<type>:<id>` |
| History links | target type and id | the list row's `id` and its section's `AuditTargetType` |
| History panel | 20 newest | `learnerHistory` (AC-10) |

**Key invariants**:
- No app code updates, deletes, or truncates `audit_events`. Postgres refuses it anyway (spec 0002 AC-7), and the source scan stops it in review (AC-11).
- Paging order is total (`created_at desc, id desc`), and the cursor round trips at microsecond precision, so a walk through every page sees each entry exactly once.
- Reading writes nothing (no audit row, no `rate_limits` row).
- A stored secret never reaches the page: writers never put one in metadata (AGENTS.md), and `describeMetadata` drops secret looking keys anyway.
- Every `AuditAction` has a label and an area at compile time.

**Security model**:
- Admins only: every surface here runs after `requireAdmin()`. Every admin reads every entry; there is no per admin scoping, and nothing here is reachable by a learner, a guest, or a search engine (admin pages are `noindex`, and nothing public names `/admin`).
- Read only by design (AC-11). There are no Server Actions, so `tests/server-actions-require.test.ts` needs no change.
- PII: entries show learner names and emails, and an edit's from and to values (for example an email change). Admins already see this on Users. Kept for the life of the product (spec 0002, owner choice). No compliance regime is named.
- `q` reaches SQL only as a bound parameter, with `%`, `_`, and `\` escaped for `ILIKE`.

**Configuration required**: none. No env var, no API key, no Authentik change.

**Critical test scenarios**:
- Happy path: an admin edits a testbed type, the log shows the entry first with their name, area "Testbed types", the type's name as target, and "Duration value: 2 → 3" when expanded; verifies **AC-1**, **AC-2**, **AC-7**, **AC-8**, **AC-16**.
- Ties: 120 entries in one transaction (equal `created_at`), walked Older page by page and back Newer, give each id exactly once in each direction; verifies **AC-3**.
- Filters: each filter alone and two together, against seeded rows inside `inRollback`; `from` and `to` around midnight in `America/Los_Angeles` include and exclude the right rows; verifies **AC-4**, **AC-5**.
- Learner history: grant (booking target), revoke (user target), learner reschedule (learner actor), and admin edit (user target) all appear for `learner=<id>` once each, and another learner's entries don't; paging Older through a learner with more than 51 entries keeps the union arms in order; verifies **AC-5**, **AC-10**.
- Actor kinds: every action the code writes with a null actor is classified (booking form or system), and the `actor` filter returns the same rows the display labels; verifies **AC-6**.
- Targets: a soft deleted testbed type shows "Deleted", an undone group create shows its metadata name, `authentik:12` shows "Authentik user 12", and a booking target holding a testbed id shows "Booking (not found)"; verifies **AC-7**.
- Bad links: a bad uuid, `from` after `to`, a one letter `q`, a forged cursor, and both `before` and `after` each give the full page with the notice, never a 500; verifies **AC-14**.
- Coverage: each scope action writes its row with actor, action, target, and time; verifies **AC-12**.
- Append only: the source scan passes on the tree and fails on a planted `deleteFrom("audit_events")`; verifies **AC-11**.
- Auth: a signed in learner and a signed out visitor opening `/admin/audit-log` get the `requireAdmin` redirect and no rows; verifies **AC-1**.

## Build plan

Tracer Bullet: the first task puts one real entry on screen through every layer (migration, server read, pure labels, page, nav). The later tasks thicken it one strand at a time.

1. Tracer: migration `0012_audit_keyset_index.sql` and `db:migrate`; `lib/audit-log.ts` with `AuditArea`, `AUDIT_ACTION_INFO`, `ActorKind`, `BOOKING_FORM_ACTIONS`, and `actorKind` (plus their unit tests); `server/audit-log.ts` `listAuditEvents` (first page only, newest 50) and `resolveTargets`; the `audit-log` nav section and `lib/admin-nav.test.ts`; `app/admin/audit-log/page.tsx` rendering rows through `components/admin/audit-row.tsx`. Check it on dev by editing a testbed type and seeing the row. Satisfies **AC-1**, **AC-2**, **AC-6**, **AC-7**, **AC-13**, **AC-15**.
2. Paging and filters: `parseAuditQuery` with its notice, the cursor encode and decode, keyset Older and Newer with the AC-3 link rules, `listAdmins`, the GET filter form (actor, area, admin picker, dates, `q`), the empty and no match states; unit tests for parsing and DB tests for each filter and for the tie walk. Satisfies **AC-3**, **AC-4**, **AC-14**.
3. Row detail: `describeMetadata` with the label map and the secret key drop (unit tests), and the disclosure in the row component. Satisfies **AC-8**.
4. History strand: the `target` parse and the `learner` union with the chips and the booking note; History links in Testbed Types, Testbeds, API Keys, and Users; `learnerHistory` and the History section on the user detail page, with the booking row links. Satisfies **AC-5**, **AC-9**, **AC-10**.
5. Guards and proof: `server/audit-coverage.test.ts`, `tests/audit-append-only-scan.test.ts`, the Playwright journey, axe, screenshots, and `verify.md`. Satisfies **AC-11**, **AC-12**, **AC-16**.

## Consequences

**Positive**:
- Admins can answer "who changed this, and when?" for every scoped action, with no change to any write path.
- History links make one thing's history a single click from where admins already work.
- Exact keyset paging stays fast as grants and revokes pile up, and links to a filtered view can be shared.

**Negative / tradeoffs**:
- A renamed item shows its current name everywhere. Its old name is visible only in the rename entry's changed fields.
- Free text search is an `ILIKE` scan with subqueries. That's fine for tens of thousands of entries and up to about a million, but slower beyond that (see Follow-up).
- A transaction that commits late with an earlier `now()` can land behind a page an admin already passed. It shows on a fresh newest page.
- The actor badge shows today's role, not the role at the time of the entry.
- A booking's history doesn't show its access revoke, because revokes target the learner (the booking can be gone by then). The note in AC-5 points admins to the learner's history.
- "Booking form" and "System" are inferred from the action, not stored. A future null actor action that the booking form writes must be added to the AC-6 set, or it reads "System".
- Keeping entries forever means the table only grows. Rows are small, but nothing ever trims it.

**Neutral**:
- One index migration, a short lock on a small table.
- Spec 0005's deferred paging is settled only for this list. The other admin lists keep client search.
- `AUDIT_ACTION_INFO` becomes the place a new audit action must be labelled, enforced by the type checker.

## Follow-up

- [ ] Add a Deferred scope line: **Audit log export** (CSV of the filtered view, with its own audit entry), deferred by owner choice on 2026-10-20.
- [ ] `server/worker/reconcile.ts` writes `access.granted` with `targetId: booking?.bookingId ?? testbed.id` and `targetType: "booking"`. The fallback would store a testbed id as a booking target. It can't happen today (every desired member has a booking), but the fallback should go. A small fix, outside this spec.
- [ ] If free text search slows down (around a million entries), add a `pg_trgm` index on `summary` before anything else.
- [ ] `/sync`: add `lib/audit-log.ts` (`AUDIT_ACTION_INFO`, the AC-6 booking form set) to the root `AGENTS.md` Audit rule, so a new action gets its label and actor rule in the same change.
