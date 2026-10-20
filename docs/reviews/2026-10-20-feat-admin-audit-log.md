# Review, feat/admin-audit-log, 2026-10-20

**Reviewed by**: Sonnet 5.5 (author on Opus 5.5)
**Scope**: 25 files, branch vs main (PR #13, head 12c6a31, merged as 5a4bffb; reviewed after merge)
**Verdict**: Changes requested

## Summary
This adds a read only Audit Log section: keyset paging of 50, URL filters parsed with Zod, expandable detail rows, History links on the admin lists, and a History panel on the learner page. The core is careful. The cursor keeps microseconds, ties break on `id`, every filter and the free text search reach SQL as bound parameters, and the page and the History panel both sit behind `requireAdmin()`. The one real problem is on the user detail page: the "Details" column header was added to the Emails table instead of the History table, so both tables have a misaligned header. The rest are small gaps.

## Major
### 🟠 The Details header is on the wrong table, `app/admin/users/[id]/page.tsx:292`
**Problem**: The diff adds a `<TableHead className="w-12 pr-0">Details</TableHead>` to `EmailsSection`, but the Emails body rows have no matching first cell, so that table now has 6 headers over 5 columns. The new `HistorySection` (line 373) is the opposite: `AuditRow` renders 6 cells (the expand button cell first), but the History header has only 5 headings (When, Who, Action, Target, Summary) and no Details heading.
**Why it matters**: On the learner detail page, every Emails heading sits one column to the right of its data, and every History heading sits one column to the left of its data (the "When" heading is over the expand button, "Summary" over nothing). The axe check will not catch this, and an admin reading the page would see mislabelled columns on both tables. The Playwright journey does not assert header alignment.
**Suggested fix**: Remove the added Details heading from the Emails table and add it as the first heading of the History table. A small test or e2e assertion that the header cell count equals the cell count of the first row would keep the two from drifting again (`AUDIT_COLUMNS` in `audit-row.tsx` is the number to compare).

## Minor
### 🟡 `describeMetadata` filters secret looking keys at the top level only, `lib/audit-log.ts:484`
**Problem**: The `/secret|password|token|ciphertext/i` check runs on the top level keys. A value that is an object or array is turned into compact JSON with `JSON.stringify`, so a nested key such as `{ clients: [{ os_password: "x" }] }` would be printed in full.
**Why it matters**: AC-8 and AGENTS.md say a secret or an `os_password` must never reach the page. No writer stores one today (edits audit client counts only), so this is defense in depth that has a hole, not a live leak.
**Suggested fix**: Apply the same key check while serializing nested objects (drop or mask matching keys at any depth), and add a unit test with a nested secret key.

### 🟡 The auth guard on the new pages has no automated test, `app/admin/audit-log/page.tsx:37`
**Problem**: The spec's "Auth" test scenario (a learner and a signed out visitor get the `requireAdmin` redirect and no rows) appears only as a manual step in `verify.md`. `e2e/audit-log.spec.ts` covers the admin journey, the bad link notice, and axe, but never opens the log as a learner or signed out.
**Why it matters**: The page code is correct today (`requireAdmin()` is the first call, and the data functions assume it). Because the log shows every admin's actions and learner emails, a later refactor that moves a call above the guard would not fail any test.
**Suggested fix**: Add an e2e test, or a unit check that the page module calls `requireAdmin` before any data read, for the signed out and learner cases.

### 🟡 The migration locks the shared audit table while it builds the index, `db/migrations/0012_audit_keyset_index.sql:7`
**Problem**: `create index` (not `concurrently`) takes a lock that blocks inserts into `audit_events` for the build time, and dev and prod share this database. The spec calls it "a short lock on a small table".
**Why it matters**: It is fine at today's size. It is also the only place the plan relies on the table staying small, and nothing re checks that before the migration runs.
**Suggested fix**: Accept it as the spec says, or note in the migration header that it is safe only while the table is small. No code change needed unless the table has grown by the time anyone reruns it elsewhere.

## Nits
- ⚪ `server/audit-log.ts:154`: the module level `cursor` helper is defined after `eventsQuery` and is shadowed by the destructured `cursor` inside it. It works, but a name like `cursorDir` would read clearer.
- ⚪ `lib/audit-log.ts:448`: `SECRET_KEY` will also hide harmless keys such as `tokenCount` or `passwordSet`. That is the safe direction, just worth knowing.
- ⚪ `components/admin/audit-row.tsx:12`: `AUDIT_COLUMNS = 6` is exported but the two tables that use the row hard code their own headings; tying them to one shared header component would prevent the major above.

## Strengths
- Keyset paging is exact: the cursor text is made in SQL at microsecond precision and never passes through a JS `Date`, `(created_at, id)` breaks ties, the Older and Newer link rules match AC-3 including the empty page case, and the 120 row tie walk and the one microsecond test prove it. The index `(created_at desc, id desc)` matches the `ORDER BY`.
- Inputs are parsed alone with Zod, a bad cursor, date, uuid, or `target` is dropped with one notice instead of an error, and `from` after `to` or both cursors drops the pair.
- Free text is bound, escaped for `ILIKE`, length limited to 2 to 100, and target ids are compared as text so no cast can fail on a non uuid id.
- The learner history union reads three indexed arms, each limited, then merges and trims correctly in either direction.
- The append only guarantee has a source scan with planted write cases, and the log adds no write path or Server Action.

## Test coverage
Good for a feature this size. `lib/audit-log.test.ts` covers labels, areas, actor kinds, parsing, the cursor, hrefs, and `describeMetadata`. `server/audit-log.test.ts` runs inside `inRollback` and covers the tie walk, microsecond separation, each filter, Los Angeles day bounds, learner arms and paging, chips, and `learnerHistory`. `server/audit-coverage.test.ts` checks that each scoped action writes its row. The Playwright spec covers the journey, the bad link notice, and axe. Gaps: no test for the signed out or learner redirect, no test that table headers line up with cells (this is how the major got through), and no test with a nested secret key in metadata.
