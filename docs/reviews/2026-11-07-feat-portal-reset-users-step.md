# Review, feat/portal-reset-users-step, 2026-11-07

**Reviewed by**: claude-opus-5-5 (author on a different session/model)
**Scope**: 37 files, branch vs main (merge base 4e2edc2); focus on server/portal-engine/, lib/portal-reset/, db/seed/portal-reset-starting-list.json and tests
**Verdict**: Changes requested

## Summary
The branch adds the Users reset step (spec 0027): a method-aware allow list on the deny list, `beforeDelete` on `delete_each`, the `has` rule operator, `guardPost` / `scope: when_touched` / `keepSignedIn` guard options, the signed-in id from `userinfo`, and two Users guards. The layering is careful and well tested: the guard is checked at the skip check and again at the request guard, a run that does not touch Users never reads the Users list, and a write to an allow-listed route whose guards are not loaded is refused (which closes the "path built at run time" bypass). The one significant gap is that the guards protect the two accounts only by their opaque `id`; the allow entries accept any segment (`*`), so a saved step that addresses a user by another identifier (login/email via `idField`, or an alias such as `me`) is not refused if the portal resolves it. Tests pass (39 files, 470 tests in the two folders).

## Major

### 🟠 Users guard matches only the opaque id; an alternate identifier in the path is not refused, `server/portal-engine/guards.ts:198` (with `lib/portal-reset/deny-list.json:10`)
**Problem**: `hitOf` refuses a write only when a path segment, body leaf, or query value equals a protected `id` (lowercased). The allow entries `POST /api/v1/users/*/lifecycle/deactivate` and `DELETE /api/v1/users/*` let any single segment through. A hand-edited `delete_each` on `/api/v2/users` with `idField: "email"` (or `profile.login`) fills `/api/v1/users/nileadmin%40...`; the guard compares `nileadmin@...` against the id set and lets it pass. Likewise a `delete_each` whose delete path is a literal `/api/v1/users/me` (no `{id}` is required in a non-batch delete path, `lib/portal-reset/step-schema.ts:480-500`) passes the guard for every non-kept item. The group id format (`00g...`) and the `lifecycle/deactivate` route are Okta-shaped, and Okta's Users API accepts a login (and in places `me`) in place of the id, so whether this is reachable depends on the portal backend; it is unverified either way.
**Why it matters**: The spec's stated invariant is that a bad saved step "can never lock me out", and that a call reaching `/api/v1/users` "never carries the id of the RootAdmin or the signed in user". Protection that depends on the step using the canonical id is a negative check (deny known ids) where the lockout case needs a positive one.
**Suggested fix**: For routes covered by a Users guard, make the request guard positive: the target segment (and any body id) must be an id that appeared in the guard's list read and is not protected; refuse anything else (aliases, emails, unknown values). Alternatively or additionally, also store each kept record's other identifying fields (email/login) in the protected set, and require `{id}` as a whole segment in a non-batch delete / `beforeDelete` path. Add a test for `idField: "email"` and for a literal `/api/v1/users/me`. Record in the follow-up whether the portal resolves a login in these routes.

## Minor

### 🟡 Spec-mandated 404 change alters three existing guards for every run, `server/portal-engine/guards.ts:40-41`
**Problem**: `strictList` treats a 404 as unreadable for any guard with `expectKept`, so `protected-ssid`, `nile-radius` and `nile-dhcp` now stop every run on a 404 where they previously meant "nothing to protect". AC-6 asks for this, but the same AC also says "every existing guard keeps its behaviour".
**Why it matters**: A tenant whose RADIUS or DHCP list answers 404 when empty would now `guard_stop` every reset, not just Users runs.
**Suggested fix**: Confirm with the owner that this is intended (and that those lists answer 200 with an empty list rather than 404), or limit the 404 rule to `scope: "when_touched"` guards and fix the spec wording.

### 🟡 No test for a protected id carried in the query string of a Users write, `server/portal-engine/guards.test.ts:358`
**Problem**: `queryValues` covers it, but the Users guard tests exercise path and body only; there is also no test for a comma-joined body value (`{"ids": "u-x,u-root"}`), which `stringLeaves` does not split (`server/portal-engine/guards.ts:148`) though `queryValues` does.
**Suggested fix**: Add the query case; split comma strings in body leaves the same way as query values, with a test.

### 🟡 Protected set is fixed at run start, `server/portal-engine/run.ts:225`
**Problem**: The Users guard is read once before step 1; the Users step runs last. A user added to the RootAdmin group during the run is not protected. Not a lockout of the two named accounts, so low risk.
**Suggested fix**: Optionally re-read the Users guards just before the step (or accept and note it in the spec's consequences).

### 🟡 Encoded dot segments: normaliser and portal may disagree, `lib/portal-reset/deny-list.ts:45`
**Problem**: `normalizePortalRoute` decodes once and then resolves `..`, so `/api/v1/users/ROOT/%2e%2e/OTHER` is checked as `.../other` while `new URL` sends the encoded form untouched. The schema refuses `%` in step paths, and template values are encoded, so this is reachable only through a portal-supplied id. Low risk.
**Suggested fix**: Check protected ids against both the raw and the normalised segments (a union), so normalising can only add refusals.

## Nits
- ⚪ `server/portal-engine/connect.ts:231-237`, the `hasBrowser` comment ("A portal that has an open browser...") now sits above `hasUserId`; move it back above `hasBrowser`.
- ⚪ `server/portal-engine/interpret.ts:292`, `before?.path ?? part.delete.path` labels an unresolved delete path failure as `POST`; harmless since `beforeCall` only fails when `before` is set, but the fallback is dead code.

## Strengths
- Defence in depth is real: guarded at the interpreter skip check (both POST and DELETE), at the request guard (path, body leaves, query), and an allow-listed write with unloaded guards is refused, which closes the run-time-built path bypass. Discovery and page routes stay denied with no method.
- Fail-closed choices throughout: strict 404, `totalElements` truncation, `atLeastOne` / `exactlyOne`, and a missing signed-in id all stop the run before any write; a run without the Users step is proven not to read the Users list.
- The fake portal's 400 on a second deactivate proves the `skipWhen` rule is needed, and the per-item order (guard, dry run, deactivate, delete; a failed deactivate blocks that delete) matches AC-4.

## Test coverage
Good. Deny list per method and route (including tags and activate), schema acceptance and refusals for `beforeDelete` and `has`, guard loading (group in second position, missing RootAdmin, missing/unknown signed-in user, truncated list, strict 404), request guard refusals (path, body, uppercase id, unloaded guards, other Users routes), interpreter end to end (happy path and re-run, dry run, failed deactivate, 404 on deactivate, kept users untouched), and run-level guard stops with `guardKey`. Not covered: alternate identifiers (email/login, `me`) in a Users path, protected id in the query string or a comma-joined body value.
