# Review, feat/testbed-group-dropdown, 2026-10-26

**Reviewed by**: claude-opus-5-5 (fresh review agent; author on a separate session)
**Scope**: 26 files, feat/testbed-group-dropdown vs main (merge base d9f2319, committed plus the uncommitted verify.md)
**Verdict**: Changes requested

## Summary
The branch turns the add testbed Group Name into a select fed by a new admin only Server Action, `loadTestbedGroupChoices`, which reads the marked Authentik groups and hides groups behind a live testbed. It also makes Domain read only: the server now takes the domain from the group's `hol_testbed_domain` attribute on create, never from the post, and edit no longer touches the domain at all. The server side is careful and well tested. The order of checks, the race path in `insertTestbed`, the forged field tests, and the pk staying on the server all hold up. One amended acceptance criterion is not built: AC-18's "none of the available groups has a domain" text. The rest are small.

## Major

### 🟠 AC-18 amendment text "None of the available groups has a domain yet" is missing, `components/admin/testbed-add-dialog.tsx:121`
**Problem**: Spec 0017 AC-18 (amended 2026-10-26) says that when choices exist but none has a domain, "the text under it reads 'None of the available groups has a domain yet. Ask the owner to set hol_testbed_domain on one.'". The module table also says `TESTBED_MESSAGES` gains this text. It is not in `lib/testbeds.ts`, and `AddBody` only switches the notice for the empty list (`groupChoicesEmpty`). When every choice lacks a domain, the admin sees the normal create hint ("Choose the Authentik group... Only groups not used by another testbed are listed.") over a list where every option is disabled. A repo wide grep for the text finds nothing. `verify.md` has no step for it either, so `/check verify` would not catch the gap.
**Why it matters**: This is an acceptance criterion the branch claims to meet (scope.md ticks AC-18). In practice the owner's 15 marked groups have no `hol_testbed_domain` yet (scope.md, 2026-10-26), so this is the very first state every admin will see after deploy. The "(no domain set)" labels help, but the hint above them tells the admin to choose a group they cannot choose.
**Suggested fix**: Add a `groupChoicesNoDomain` entry to `TESTBED_MESSAGES` with the spec text. In `AddBody`, pass it as `groupNotice` when `choices.length > 0 && choices.every(c => c.domain === null)`. Add a verify.md step and an e2e or unit check for it.

## Minor

### 🟡 The dialog's client logic has no test, `components/admin/testbed-add-dialog.tsx:45`
**Problem**: The spec's test list asks for dialog tests: loading keeps Save off, the unavailable alert, the empty text, a stale answer from an earlier open being ignored, and the list dropped on close. The repo has no component test setup (no `*.test.tsx`), and Playwright covers only the happy path, the disabled option, and Save off before a choice. The `latest` counter (lines 43 to 58 and 70) is exactly the kind of branching logic that breaks without anyone noticing. Neither the unavailable alert nor the empty notice is exercised anywhere in the browser.
**Why it matters**: A regression in the stale answer guard would show the wrong group list after a quick close and reopen, and no test would fail.
**Suggested fix**: Either pull the open, answer, and close transitions into a small pure reducer in `lib/` and unit test it, or add a Playwright case that routes `loadTestbedGroupChoices` to fail (or uses a down fake) and checks the alert and the disabled Save.

### 🟡 A bad domain attribute is warned on every dialog open, `server/authentik/groups.ts:177`
**Problem**: `toGroupChoice` runs on every `loadTestbedGroupChoices` call and does `console.warn` for each group with an invalid `hol_testbed_domain`. That is one warning per bad group per dialog open (the `findTestbedGroup` path, by contrast, never warns). The module comment and the spec call `toGroupChoice` pure, but it has a logging side effect.
**Why it matters**: This is log noise rather than a bug. It also means the "pure" label in the spec module table is not accurate, which goes against the functional style rule in AGENTS.md (side effects at the edges).
**Suggested fix**: Keep `toGroupChoice` pure and warn once in `listTestbedGroupChoices` (for example, one line naming every group whose attribute is present but invalid). Or accept the noise and drop "pure" from the comment and the spec.

### 🟡 Hitting the 500 group cap is silent, `server/authentik/groups.ts:208`
**Problem**: When `pagination.next` still points past page 5, the read stops and returns what it has, with no log. The duplicate name filter (`count(g.name) === 1`, line 218) also only sees the truncated read, so a duplicate on page 6 goes unnoticed. The save would still refuse it.
**Why it matters**: There are 15 marked groups today, so the risk is low. If it ever happens, an admin cannot find a group and nothing tells the operator why.
**Suggested fix**: `console.warn` once when the cap is reached with more pages left. The spec allows the cap, so this is only about making it visible.

## Nits
- ⚪ `server/catalog/testbeds.ts:152`, `group_no_domain` is checked before `group_in_use`. Suppose a group behind a live testbed later loses its attribute. A forged add of that group then says "no valid domain" rather than "Another testbed already uses that group". This matches the spec's lookup order, so it is fine to leave, but checking `group_in_use` first would give the more useful message.
- ⚪ `server/authentik/groups.ts:51`, `parseGroupDomain` reads `TESTBED_GROUP_DOMAIN_ATTRIBUTE`, which is declared about 100 lines later (line 155). This is safe at runtime, but moving the constant up next to the marker import reads better and matches the spec's "next to the marker".
- ⚪ `server/authentik/groups.ts:218`, `count` scans the whole read for each group, which is O(n²) on up to 500 items. That is trivial at this size, but a single `Map` of name counts would be clearer.
- ⚪ `e2e/testbed-group-dropdown.spec.ts:29`, the sort check compares option labels, so a "(no domain set)" suffix can change the order when one name is a prefix of another. Compare names with the suffix removed.
- ⚪ `docs/specs/0017-testbed-domain-predefined-groups/verify.md:34` and `docs/scope/scope.md`, both carry 2026-10-27 dates, which is tomorrow. scope.md also says "Playwright updated but not run, the hol-test fixtures are gone", while the verify notes say the dropdown and testbeds specs passed. Pick one story.
- ⚪ `docs/specs/0021-cleanup-hook-early-end/index.md` and scope feature 24 (the cleanup hook on a normal end) have nothing to do with the testbed dropdown. Consider landing them in their own commit or PR so this branch's history stays about one feature.
- ⚪ `verify.md` is still uncommitted on the branch.

## Strengths
- The domain now has a single source of truth on the server. `TestbedInput` drops the key, `createTestbed` takes `group.domain` from the same lookup that checks the marker, and tests post a forged `domain` through the Zod schema, the catalog function, and the Server Action to prove it is ignored at every layer.
- The race path in `insertTestbed` gains the domain check in the same order as the precheck. The existing "taken between the precheck and the insert" test still covers it, so two admins saving at once get a message and never an exception.
- `loadTestbedGroupChoices` calls `requireAdmin()` first, which the action scan picks up automatically. It keeps the group pk on the server (a test asserts the pk is not in the payload), and it hides used groups with one simple set lookup.
- `listTestbedGroupChoices` reuses `checkGroupWrite(..., "add", ...)`, so the list and the save apply exactly the same marker, superuser, parent, role, and `hol-admins` rules. It uses only `coreGroupsList`, so the group writes scan stays green.
- The dialog's tagged union state with an exhaustive `never` switch, plus the stale answer guard, follows the `testbed-edit-dialog.tsx` reference pattern.

## Test coverage
Server side coverage is strong. `groups.test.ts` covers the filter rules, duplicate names, paging (151 groups, and a cap at 500), the unavailable and garbled body cases, and every domain attribute shape, including that the bad value is never logged. `testbeds.test.ts` covers `group_no_domain` with no row, no audit row, and no Authentik write; the taken domain on `groupName`; the Authentik down ordering; a forged domain on create and on update; and edits under Current, Upcoming, and Pending bookings now saving. `actions.test.ts` covers the action mapping, the hide and unhide of used groups across a soft delete, the auth redirect, and the unavailable answer. The gaps are on the client: the AC-18 "none has a domain" state (not built), the unavailable alert and the empty notice in the browser, and the dialog's stale answer and close handling, which have no automated test.
