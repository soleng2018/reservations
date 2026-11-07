# 0027. Portal reset step for Users: deactivate, then delete

**Date**: 2026-11-07
**Status**: In Progress
**Amends**: [spec 0022](0022-nile-portal-reset-page.md) (AC-18 step language, AC-19 deny list, AC-20 guards) and [spec 0023](0023-nile-portal-reset-engine/index.md) (AC-25 to AC-27 the hard guards), in part. Nothing else in them changes.
**Research**: [findings section 3i and D17](../research/nile-portal-reset-findings.md), the calls recorded on Workshop 2 on 2026-11-07, [14-users-ui-capture.mjs](../research/portal-scripts/14-users-ui-capture.mjs)

## Summary

The portal reset gets one more step that removes the portal's users, so the next learner starts on a tenant with no leftover accounts. For each user the engine first deactivates it, then deletes it, and it never touches two accounts: the RootAdmin and the account the reset itself signs in as (`automation@<domain>`). This is the first step on the Users page, which the owner earlier put off limits (D14), so the deny list changes from "never" to "exactly three calls", and the step language and the guards each learn a few new things.

## Context

Feature 24 resets a workshop's Nile Portal after every lab. Learners sign in to the portal as their own federated users, so each lab leaves accounts behind (on Workshop 2 the owner saw `ravi.menon@`, `nora.quinn@`, `kamal@` and others). The owner wants them gone after each lab, except the RootAdmin (`nileadmin@`, the owner's own way in) and the reset's own account.

D14 (2026-10-27) forbade every call on `/api/*/users` because deleting the wrong user can lock the reset out of the portal. That reason still stands, so the answer is a narrow exception plus two hard guards, not a removed rule. The portal walk of 2026-11-07 (Workshop 2, then a read only look at Workshops 3 and 4) found: the list is `GET /api/v2/users`, a deactivate is `POST /api/v1/users/{id}/lifecycle/deactivate` with body `{"id": "{id}"}`, a delete is `DELETE /api/v1/users/{id}` with body `{"id": "{id}"}`, both answer 204, and a multi select on the page is one call per user. The RootAdmin group has the same id on Workshops 2, 3 and 4 (`00ghquj7yiA33Pg5v5d5`) and only `nileadmin@` holds it. Some users are in several groups, and Workshop 3 has a user that is not federated but is not the RootAdmin, so "not federated" is not a safe test.

The engine signs in as `automation@<testbed domain>`, an account the app owns (spec 0023 AC-12 and AC-42). The research scripts used `admin@`, which is only an ordinary user and is deleted like the others.

Not decided before: whether the API refuses a delete of a user that is still active (the page was always used in the order deactivate, then delete). The step deactivates first, as the owner asked, so this does not block the build.

## Requirements

**User stories**:
- As the owner, I want every portal user removed after a lab, so the next learner starts on a clean tenant.
- As the owner, I want the RootAdmin and the reset's own account to be impossible to delete, so a bad saved step or a changed portal can never lock me out.
- As an admin, I want the Users step offered on the Nile Portal Reset page like any other starting step, so I add it when I decide to, not automatically.

**Acceptance criteria** (the contract, each independently checkable):
- **AC-1** (deny list, method aware): `lib/portal-reset/deny-list.json` gains an `allow` list of `{ method, path }` entries, and `isDenied(path, method?)` refuses a path that matches a deny prefix unless an allow entry matches that method and the whole route (the same length, `*` stands for one segment, the same normalising as today). The allow list is exactly: `GET /api/v2/users`, `POST /api/v1/users/*/lifecycle/deactivate`, `DELETE /api/v1/users/*`. With no method given, no allow entry applies, so page routes and discovery stay denied. Still refused: every other method or route under `/api/*/users` (create, edit, tags, reset password, reset MFA, assignment, activate), all of `/api/*/idps`, and the pages `/global-settings/identity` and `/network-setup/users`. Tests cover each, plus `/api/v1/users/x/tags` and `/api/v1/users/x/lifecycle/activate`.
- **AC-2** (which callers pass a method): `portalPathProblem` (a new method parameter), the portal client (`client.ts`, `req.method`), the request guard (`guards.ts`, `req.method`), and the seed test pass the method. Discovery (`dropReason` in `discovery-rules.ts`, the filter in `discovery.ts`) and the page route check in `step-schema.ts` never pass one, so `/api/v2/users` is never a discovery candidate. A `delete_each` list uses its own method, the delete is `DELETE`, a `beforeDelete` is `POST`.
- **AC-3** (step language): a `delete_each` part accepts an optional `beforeDelete` of `{ method: "POST", path, body?, okStatus?, skipWhen? }`. Its path and body may hold `{id}` (and `{parentId}` where the list is nested). `okStatus` defaults to 204. `skipWhen` is a list of item rules (as on the part): when they all hold for an item, the pre call is not sent for it and the delete still is. The path is validated like a delete path (no query, whole segment placeholders, deny list with its method). Every other part is unchanged.
- **AC-4** (per user order and replies): for each item the engine checks the guard first, for the pre call and for the delete (a guarded item is skipped for both, silently, as today). In a dry run it records `would_delete` and sends nothing. Otherwise it sends the `beforeDelete` unless its `skipWhen` holds, and only on success sends the delete. The pre call is classified as a write. A 404 is silent and the delete is skipped (the user is already gone). Any other failure is recorded as a failure of that item with the portal's message (the same audit row and report email as a failed delete) and its delete is not sent, and the run goes on to the next item. A success writes no row of its own, so run counts are not doubled.
- **AC-5** (rule `has`): item rules gain the operator `has`: the field is an array that holds the one scalar value given. It needs a value. A missing or non list field is `false`. It is allowed in item rules (`skipWhen`, `onlyWhen`, `match`, guard `keepWhen`) and refused in `when` and `expect`, whose reads hold only scalars.
- **AC-6** (guard options): a guard may set `guardPost` (a `POST` under its delete route prefix that carries a protected id, in the path, body, or query, is refused like a `DELETE`), `scope: "when_touched"`, and `keepSignedIn: true` (see AC-8). `listPath` may hold a query string (the pattern is widened for `listPath` only, never for `deleteRoutePrefix`). A guard with `expectKept` or `scope: "when_touched"` treats a 404 on its list as unreadable, not as "nothing to protect". Every existing guard keeps its behaviour (`scope` defaults to `"always"`).
- **AC-7** (the two guards): `guards.json` gains `users-root-admin` (list `/api/v2/users?page=0&size=2000`, items at `content`, id `id`, keep when `groupIds` `has` `00ghquj7yiA33Pg5v5d5`, `expectKept` `atLeastOne`) and `users-signed-in` (same list, `keepSignedIn` true, `expectKept` `exactlyOne`). Both set `deleteRoutePrefix` `/api/v1/users`, `guardPost` true, `scope` `when_touched`.
- **AC-8** (the signed in user): `keepSignedIn` keeps the list item whose `id` equals the id of the user the run is signed in as. That id comes from the `GET /api/v1/userinfo` that the tenant check in `connect.ts` already makes; the connected portal carries it, and `computeProtected` receives it. A reply with no id fails the connect as it fails today. No email, placeholder or case rule is involved.
- **AC-9** (when_touched, decided from the step list and again at run time): the engine computes the guards a run needs from its enabled steps with `guardsForDefinition`, where a part's write paths include `beforeDelete.path`, and reads only those that are `always` or touched. In a run that includes the Users step, a guard list that cannot be read, is badly shaped, has `totalElements` larger than the rows returned (more than 2000 users), or fails `expectKept` (no RootAdmin, or the signed in user not found exactly once) ends the run before any write. The guard stop report names the guard key (`GuardNote` gains `guardKey`, also in the audit metadata). In a run without the Users step nothing changes and no Users call is made.
- **AC-10** (the request guard): a `POST` or `DELETE` under `/api/v1/users` that holds the id of the RootAdmin or the signed in user is refused before it is sent, and the run ends `guard_stop`. The same refusal applies to any call that matches an allow entry when that route's guards were not loaded, so a path made at run time from a read (`/api/v1/{read.a.b}/{id}`) cannot reach Users unguarded.
- **AC-11** (the starting list): `db/seed/portal-reset-starting-list.json` gains the entry `users` ("Users: deactivate, then delete") as the last entry (position 15), with the list, a `beforeDelete` that has `skipWhen` `status` `eq` `DEACTIVATED`, and the delete calls of the findings, a note that names the two guards, and no `pages`. It is offered by the page's starting choices and never added by itself (spec 0022 AC-13). The tests that count steps (steps, save, seed, interpret, step schema) count 15.
- **AC-12** (end state and retries): after the step in a live run the list holds only the kept users, and a second run finds nothing to delete. The existing leftover check decides, and a kept user is not a leftover. A user deactivated in an earlier pass is not deactivated again (AC-11 `skipWhen`). A learner who signs in between the delete and the re-read can make the run `incomplete`; that is accepted, and the next run removes the user.
- **AC-13** (the fake portal): `server/portal-engine/testing.ts` serves users (list with `totalElements`, deactivate, delete, a status that changes) and answers a deactivate of an already `DEACTIVATED` user with a 400, so a test proves the skip rule is needed. The engine tests run the step end to end without a real portal.
- **AC-14** (records): a user's email may appear as the item label in run rows and the report email, like other labels. No token, header, password, or reply body is added to any record.
- **AC-15** (docs): findings D17 is marked decided with the automation account named, the Users part of D14 points to it, specs 0022 and 0023 each get one line saying 0027 amends them in part, and the portal scripts README row for step 14 is updated.
- **AC-16** (dry run): a dry run sends no deactivate and no delete, and `beforeDelete` adds nothing to the `hidden` set (its key is the delete path). A dry run of a run that includes the Users step still reads the Users guards and stops on a failed `expectKept`.

## Options considered

### Option 1: Method aware allow list, `beforeDelete`, two guards (chosen)

Keep the deny list as the default and add a short allow list of three method and route pairs. Teach `delete_each` one optional pre call. Guard the two accounts with the machinery that already protects the guest SSID and Nile RADIUS.

**Pros**:
- The default stays closed: create, edit, reset password and Identity are still refused everywhere.
- One part, one list read, one place a user's fate is decided.
- Reuses the guard system, so a protected id is refused at the skip check and again at the last line of defence.

**Cons**:
- Touches the shared deny list function, so every caller needs the method.
- Three small additions to guards and rules.

### Option 2: Two passes, like the page

A new `call_each` part deactivates every user, then a second `delete_each` deletes them.

**Pros**: mirrors the clicks.

**Cons**: a new part kind, a second list read, and two places that each need the guard checks. The portal behaves the same either way.

### Option 3: Remove Users from the deny list, rely on guards

**Pros**: the least code.

**Cons**: one bad saved step could create or edit users, and a guard does not cover those calls. Rejected.

## Decision

**Chosen option**: Option 1: Method aware allow list, `beforeDelete`, two guards.

The Users step is one `delete_each` with a `beforeDelete` deactivate, protected by two hard guards, with the deny list narrowed to exactly three calls.

**Implementation skills**: `zod` (`pproenca/dot-skills`, `.claude/skills/zod/`) · `vitest` (`antfu/skills`, `.claude/skills/vitest/`)

## Rationale

The risk D14 named is a lockout, and a lockout needs a write to the wrong user, not a read of the list. So the allow list names the only three calls the step needs, and the guards make the two accounts that matter untouchable, at the same two layers (skip check, request guard) that already protect the guest SSID. Per user deactivate then delete is also the smallest change to a part that exists, and the failure rule (a failed deactivate blocks that delete) keeps a half done user from being deleted by accident.

Two details come from how the engine works today. Guards are read at the start of every run, so a Users guard that stops a run (no RootAdmin found) would stop resets that never touch users; `when_touched` keeps the new guards from changing any run that does not include the step. And the request guard only looks at `DELETE` and `PUT`, but the deactivate is a `POST`, so without `guardPost` the one call that would lock the automation account out could go through.

The signed in user is protected by the id the sign in itself returns (`userinfo`), not by an email rule, so there is no case rule, no placeholder and no second source to agree with. The RootAdmin group id is written in the guard file, not looked up, because it was the same on Workshops 2, 3 and 4 and a lookup adds a call and a failure mode. If it were ever different, the guard finds no RootAdmin, `atLeastOne` fails, and the run stops before any write, which is the safe way to be wrong.

## Feature design

**API surface** (the portal's, called by the engine; no new app route or page):

| Call | Method | Body | Reply | Allowed by |
|---|---|---|---|---|
| `/api/v2/users?page=0&size=2000` | GET | none | 200, `content[]` | allow entry 1 |
| `/api/v1/users/{id}/lifecycle/deactivate` | POST | `{"id": "{id}"}` | 204 | allow entry 2 |
| `/api/v1/users/{id}` | DELETE | `{"id": "{id}"}` | 204 | allow entry 3 |

**Step** (seed entry `users`): one `delete_each`, list `GET /api/v2/users?page=0&size=2000`, `itemsAt` `content`, `idField` `id`, `labelField` `email`, `beforeDelete` the POST above with `skipWhen` `status` `eq` `DEACTIVATED`, delete the DELETE above. No `skipWhen` on the part: the guards decide who is kept.

**Value sourcing**:
| Action | Value produced or displayed | Source |
|---|---|---|
| Deactivate, delete | the user id in the path and body | the list item `id` |
| Guard `users-root-admin` | the RootAdmin group id | a literal in `guards.json`, seen on Workshops 2, 3, 4; a wrong value fails safe (AC-9) |
| Guard `users-signed-in` | the signed in user's id | `id` of `GET /api/v1/userinfo`, read by the tenant check in `connect.ts` and carried on the connected portal |
| Step | whether to deactivate an item | the item's `status`, from the list (`beforeDelete.skipWhen`) |
| List and guard read | the page size | `size=2000` in both paths |
| Success check | the status to accept | `okStatus` default 204 |
| Run row and report | the user label | the item `email` (`labelField`) |

**Key invariants**:
- A call that reaches the portal for a user under `/api/v1/users` is one of the three allowed calls and never carries the id of the RootAdmin or the signed in user.
- No existing run (without the Users step) reads or depends on a Users guard.
- A dry run sends no deactivate and no delete.

**Security model**: only the worker calls the portal, as the automation account. An admin on the page cannot edit the deny list, the allow list or the guards (repo data). Adding the step is a deliberate Save by an admin, audited as today. User emails are workshop account names and go into run rows and the report like other labels; no secret is copied.

**Critical test scenarios**:
- Happy path: a fake tenant with the RootAdmin, the automation account and three others; a live run leaves two, each of the three got a deactivate then a delete, verifies **AC-4**, **AC-12**.
- Dry run: same tenant, nothing sent, three `would_delete` rows, verifies **AC-4**.
- Failed deactivate: one user's deactivate answers 500; that user is not deleted, a failure is recorded, the other users are done, verifies **AC-4**.
- Guard stop: a step edited by hand to delete a guarded id, or the fake portal listing no RootAdmin, ends the run before any write or at the request guard, verifies **AC-9**, **AC-10**.
- Deny list: create, edit, tags, activate, the page route and Identity are refused; the three allowed calls pass only with their method, verifies **AC-1**, **AC-2**.
- A run without the Users step on a tenant whose users list answers 500 still completes, verifies **AC-6**, **AC-9**.
- Bypass attempts: a step whose `beforeDelete` is the deactivate route with a list elsewhere, and a path built from a read, are both refused before any call, verifies **AC-9**, **AC-10**.
- A guard list that answers 404 or reports more users than it returned stops the run, verifies **AC-6**, **AC-9**.
- A user already `DEACTIVATED` (an earlier pass) is deleted with no second deactivate, verifies **AC-4**, **AC-12**.
- A user that is gone (404 on the deactivate) is skipped without a failure, verifies **AC-4**.
- A user in two groups with the RootAdmin second is kept, verifies **AC-5**, **AC-7**.

## Build plan

Approach: Tracer Bullet. First one thin thread through every layer on the fake portal (deny list, step language, interpreter, fake users), then the guards that make it safe, then the seed and the live check.

1. Deny list: add `allow` to `deny-list.json`, make `isDenied(path, method?)` method aware with exact length matching, and pass the method from the callers named in AC-2 only, with the fixtures of AC-1. Satisfies **AC-1**, **AC-2**.
2. Step language: add `beforeDelete` (with `skipWhen`) to `delete_each` in `step-schema.ts` with its placeholder and deny list checks, and show it in `describe.ts`. Satisfies **AC-3**.
3. Interpreter: guard check on both calls, dry run, `beforeDelete`, then delete, with the reply rules, in `server/portal-engine/interpret.ts` (the `StepEnv.isGuarded` type takes `POST`). Satisfies **AC-4**, **AC-16**.
4. Fake portal: users with list, deactivate (400 on an already deactivated user), delete and a status in `server/portal-engine/testing.ts`, and an end to end engine test of the happy, dry run, failed deactivate and retry cases, with the guards still off. Satisfies **AC-13**, **AC-4**, **AC-12**.
5. Rules and guards: the `has` operator (item rules only) in `rules.ts` and the step schema; `guardPost`, `scope`, `keepSignedIn`, the widened `listPath`, and the 404 rule in `lib/portal-reset/guards.ts` and `server/portal-engine/guards.ts`; `writePaths` includes `beforeDelete.path`. Satisfies **AC-5**, **AC-6**.
6. Signed in id: read `id` in the `userinfo` schema of `connect.ts`, carry it on the connected portal, pass it to `computeProtected`. Satisfies **AC-8**.
7. Guard data and run wiring: the two guards in `guards.json`, the `when_touched` filter in `run.ts` from `guardsForDefinition` over enabled steps, `totalElements` check, `guardKey` on `GuardNote`, the request guard refusing an allow listed route whose guards are not loaded, and tests for the fail safe, both bypasses, and the multi group user. Satisfies **AC-7**, **AC-9**, **AC-10**.
8. Seed: the `users` entry last in `portal-reset-starting-list.json`, and the step counts in the five tests. Satisfies **AC-11**, **AC-12**, **AC-14**.
9. Docs: findings D17 and D14, the amendment line in specs 0022 and 0023, the portal scripts README. Satisfies **AC-15**.
10. Live check (the owner present, a scratch tenant, Workshop 2 or 4): a dry run, then a live run with the step added on the page; only `nileadmin@` and `automation@` are left, and a second run changes nothing. Record what the portal answers to a deactivate of an already deactivated user and a delete of an active one. Satisfies **AC-12**.

## Consequences

**Positive**:
- A lab no longer leaves portal accounts behind.
- The lockout rule is stronger than before in one way: two named accounts are refused at two layers, and a wrong guard value stops the run before any write.
- The `beforeDelete`, `has` and `guardPost` additions are general; the next "do this, then delete" step needs no new part kind.

**Negative / tradeoffs**:
- The deny list function now needs a method everywhere, and a caller that forgets it gets the strict answer (denied).
- The RootAdmin group id lives in a file. A tenant in another region with a different id would stop every run that includes the step until the file is corrected.
- Every account but two is deleted, including accounts the owner may have made on purpose (for example `wsa@` and `ws3@nilenetwork.org`). That is the owner's decision (2026-11-07).

**Neutral**:
- The step is offered, not applied: production keeps its saved list until an admin adds `users` and saves.
- Users go last in the list, so nothing that depends on them (a webhook's creator, for example) is affected earlier in the run.

## Follow-up

- [x] Review fix (2026-11-07): the Users guards set `onlyListed`, so a write under `/api/v1/users` must name an id the guard's list returned and did not keep (an alias such as `me`, an email, or an unlisted user stops the run). A user who signs in between the guard read and the step is not listed, so that run stops `guard_stop` and the next run removes the user.

- [x] Recorded 2026-11-07 on Workshop 2 with throwaway users: a deactivate of an already deactivated user answers 204 (not the 400 the fake assumes, so `skipWhen` saves a call but is not required), and a delete of a still active user answers 400 "Please deactivate the user ... before you can delete them" (so the pre call is required). The fake keeps its stricter 400 on purpose.
- [ ] `/sync` after merge (the root `AGENTS.md` line is already added): add one line to the root `AGENTS.md` portal rules that `/api/*/users` has three allowed calls and two guards (`guardPost`, `when_touched`), and update the deny list line.
- [x] Add a scope row for this (feature 26).
- [ ] Confirm the RootAdmin group id on Workshop 1 and 5 if either gets a portal tenant (Workshop 5 has none today).
