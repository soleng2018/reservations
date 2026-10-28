# Review, feat/nile-portal-reset-page, 2026-10-27

**Reviewed by**: claude-opus-5-5 (author on another model)
**Scope**: 75 files, branch vs main (merge base 93744f0)
**Verdict**: Changes requested

## Summary

The branch builds spec 0022: the step language (a closed Zod schema with placeholder, path, deny list, and secret key checks), the guards and deny list as repo data, migration 0018, a seed step in the migrate process keyed on `seeded_at`, the `REPEATABLE READ` read module, one atomic Save with a version check, rename safe writes and audit rows, the Audit Log read side, and the editor page with a draft, a JSON row editor, and dnd-kit reorder. The server side is careful and well tested, and the Save algorithm matches the spec step for step. The headline gap is that the client editor, which holds two of the spec's safety controls (the live mode confirm and the stale Reload), has no test at any level. A few smaller schema holes let text through that the spec says is refused.

## Major

### 🟠 The live mode confirm, the stale Reload, and the leave prompts have no test, `components/admin/portal-reset-editor.tsx:321`
**Problem**: `Editing` holds the branching the spec treats as safety controls: choosing `live` opens "Switch to live?" and Cancel keeps the old mode (AC-22), a `stale` reply keeps the draft and offers Reload (AC-11), Discard with changes asks first, and the nav and History links ask before leaving a dirty draft (AC-7, the `useLeaveGuard` in `components/admin/admin-shell.tsx`). A search of `e2e/` and every `*.test.ts(x)` finds no test that opens the live confirm, gets a stale reply in the UI, or clicks a nav link with a dirty draft. The e2e flow never touches the mode or the email either (line 88 of the spec says so on purpose), so the Save of those two fields through the page is also unpinned. AC-22 is in the spec's Critical test scenarios ("Live confirm: choosing live asks the second confirm; cancel keeps the old mode").
**Why it matters**: the live confirm is the last friction before resets delete things on real tenants. A refactor of `onMode` (for example flipping the `draft.mode !== "live"` check, or calling `change` before the confirm) would ship silently. The same goes for the stale path, where a regression could drop the draft or overwrite another admin's Save view.
**Suggested fix**: add Playwright cases (or a jsdom component test of `PortalResetEditor` with a fake `save`): choose Live, Cancel, expect the select still shows the old mode and Save sends it; choose Live, confirm, Save, reload, expect Live (then put it back); a fake `save` returning `stale` shows the message, keeps the rows, and Reload returns to read only; a dirty draft plus a nav click shows "Leave without saving?" and Stay keeps the draft.

## Minor

### 🟡 An unknown placeholder in a query value is accepted, `lib/portal-reset/step-schema.ts:361`
**Problem**: `QUERY_PAIR` (line 30) lets a query value be any `{...}`, and `checkPlaceholders` only reports `id`, `parentId`, `ids`, and `read.NAME.KEY` names; any other name falls through the `else` with no issue. I checked it: `{"kind":"read","path":"/api/v1/x?q={evil}",...}` parses. The route part is safe (the `badSegment` check runs on the route only).
**Why it matters**: the spec's path rules say every `{...}` is a placeholder from the closed list, and AC-9 says a list path with any other placeholder is refused. The engine "substitutes nothing else", so the literal `{evil}` would be sent to the portal.
**Suggested fix**: in `checkPlaceholders`, add a final branch that reports any name that is not one of the four forms, or test the query value against `PLACEHOLDER` in `portalPathProblem`. Add the case to `step-schema.test.ts`.

### 🟡 `labelField` and pick paths are not checked for secret names, `lib/portal-reset/step-schema.ts:223`
**Problem**: body keys, `set.value` keys, and pick names are refused when they look like a secret, but `list.labelField` and the pick paths are not. `labelField: "config.secret"` and `pick: { v: "[0].password" }` both parse.
**Why it matters**: spec 0022 says `labelField` is the only item field that may reach an audit row, a run record, or an email, and spec 0023 AC-28 writes it to `portal_reset_run_items`. A mistyped or careless label field on a webhook list would copy a signing secret into durable records and emails. AC-25's intent ("no secrets in a definition") is enforced on the template side but not on the fields that copy portal values out.
**Suggested fix**: run `looksSecret` over each segment of `labelField`, `idField`, and every pick path (via `parsePortalPath`), and add a test per field.

### 🟡 A list the schema accepts can be larger than the Server Action body limit, `app/admin/actions.ts:1008`
**Problem**: the schema allows 100 steps of 20 000 bytes each (about 2 MB as JSON), but `next.config.ts` keeps the default Server Action `bodySizeLimit` of 1 MB. A Save over the limit fails before `requireAdmin()` runs and the page shows the generic error.
**Why it matters**: today's 13 steps are about 18 KB, so it is far off, but the two bounds disagree and the admin would get no field error.
**Suggested fix**: either set `experimental.serverActions.bodySizeLimit` to cover the schema's maximum, or lower the caps, and note the choice in the spec.

### 🟡 Two seeds at once are not tested, `server/portal-reset/seed.test.ts:109`
**Problem**: the spec's scenario "two seeds at once insert once" (AC-2) is covered only by the `FOR UPDATE` in `seed.ts:24`. No test runs two seeds on two connections.
**Why it matters**: two migrate containers starting together is the case the lock exists for; a later change that reads `seeded_at` before taking the lock would pass every test.
**Suggested fix**: a test with `inRollbackNested` that starts one seed holding the lock, runs a second, and expects one insert and one `seeded` audit row.

### 🟡 Reload after a stale Save can reopen Edit on the old version, `components/admin/portal-reset-editor.tsx:228`
**Problem**: `onReload` calls `router.refresh()` and `onExit()` in the same tick, so read only mode shows the old props until the refresh lands. An admin who clicks Edit at once captures the old `version` again and the next Save is stale again.
**Why it matters**: a confusing loop rather than data loss (the version check still holds).
**Suggested fix**: exit inside a transition that awaits the refresh (`startTransition(() => { router.refresh(); })` and leave edit mode when it settles), or disable Edit while the refresh is pending.

## Nits
- ⚪ `lib/portal-reset/step-schema.ts:437`, `{ids}` is accepted in a batch delete's path, where an array cannot be a segment; only the body needs it.
- ⚪ `server/audit-log.ts:409`, `metadataFeatureName` finds a name only on `step_added` and `step_removed` rows; a `step_updated` row of a later removed step (metadata `featureName: { from, to }`, or no name at all) falls back to the plain label. Reading `to` would cover the rename case.
- ⚪ `components/admin/portal-reset-editor.tsx:310`, an error keyed `expectedVersion` (a tampered call) shows only "Fix the problems marked below" with nothing marked.
- ⚪ `tests/portal-reset-no-portal-scan.test.ts:38`, the HTTP client check matches only static `from "..."` imports; a dynamic `import("undici")` or `require("https")` would pass.
- ⚪ `e2e/isolation.spec.ts:145`, the branch deletes an unrelated admin test (`an admin opens leo ...`) and the `leo` app row; fine if leo is gone from Authentik, but it is outside spec 0022 and worth one line in the PR text.
- ⚪ `lib/portal-reset/deny-list.json:3`, `/api/*/users` does not catch `/api/users` or `/api/v1/settings/users`; the spec accepts this pending the owner's confirmation of the Users paths, so only a reminder.

## Strengths
- The Save in `server/portal-reset/steps.ts` follows the lock first pattern exactly: settings row `FOR UPDATE`, version check, stored row checks, a pure diff, deletes first, temporary names before final names (so swaps and renames onto a removed name work), deferred position uniqueness, and `refusable()` plus `mapConstraintError` around the whole transaction so a commit time failure still becomes a `Result`. The DB tests use `set constraints all immediate` so the deferred constraint is really exercised inside `inRollback`.
- The step language is genuinely closed: `strictObject` everywhere, a discriminated union, reads visible only to later parts, exhaustive `never` switches, and `jsonbTextBytes` measures size the way Postgres does. The pure diff compares canonical JSON, so a Save that differs only by key order or spaces is no change.
- The email address never reaches an audit row (only `set`, `cleared`, or `changed` and the domain), and a test pins that.

## Test coverage
Strong on the server and pure side: the schema has a fixture per research need and a refusal test for each AC-9 rule; the deny list, guards, normalize, diff, draft, reorder, describe, starting list, and view each have plain input and output tests; the DB tests cover seed (AC-1, AC-2 except concurrency), schema constraints, the read contract (AC-16, including a broken row as `{ ok: false }`), Save (AC-7, AC-11, AC-12, swaps, renames, rollback, every stored row check, AC-26), and audit content. e2e covers read only (AC-4, AC-10, AC-20, AC-21, AC-24), the Edit confirm (AC-5), keyboard and mouse reorder with announcements (AC-6, AC-8), the phone layout (AC-15), the starting list count (AC-13), a saved move (AC-7), and the JSON row editor (AC-19, AC-23). Untested: the live confirm (AC-22), the stale reply and Reload in the UI (AC-11), the Discard and leave prompts (AC-7), saving the email and mode through the page, concurrent seeds (AC-2), and the two schema holes above. AC-3 relies on the shared `requireAdmin` pattern and the Server Action scan; no test signs in as a learner on this page, which matches how other admin pages are tested.
