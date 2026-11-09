# Review, main (uncommitted), 2026-11-09, second pass

**Reviewed by**: claude-opus-5-5 (author on unknown)
**Scope**: 31 files (28 tracked, 3 untracked), uncommitted
**Verdict**: Approve with nits

## Summary
This pass re-checks the fixes for spec 0029 (early lab access) after the first review ([2026-11-09-main.md](2026-11-09-main.md)). The code fixes are correct:
- `wasCurrent()` now applies the 5 minute lead to `was_current` in both `cancelBooking` and `rescheduleBooking`.
- `START_MARGIN` is `ACCESS_LEAD_MS + RESET_SAFETY_MS` (6 minutes) and `TARGET` is 24 minutes.
- The new boundary tests do tell the old margin from the new one.
- The DDL helpers are registered in the scan.

No code issue remains above a nit. What is left is documentation drift. Spec 0029 still describes the rejected first draft (a 5 minute margin and a 20 minute window) in its Summary, Context, Option 1, Decision, Rationale and Build plan. Spec 0023 still says "the code is at 5 until the review fix lands", which is no longer true.

## Status of the first review's findings

| First review finding | Status |
|---|---|
| 🟠 A cancel or move during early access queues no reset and no cleanup hook | **Fixed correctly.** `server/db/bookings.ts:16` holds `wasCurrent()`, which both functions use (lines 117, 193). The tests cover a cancel (reset and cleanup notice) and a move (reset) at 4 and 7 minutes. The learner facing phase (`manage.ts:174`, `bookingPhase`) correctly keeps `starts_at`, as AC-7 says. |
| 🟡 Zero buffer between the reset stop and access opening | **Fixed correctly.** `RESET_SAFETY_MS` is 1 minute and `START_MARGIN` is 6 minutes. AC-8 claims one call is bounded by `CALL_TIMEOUT`. That holds: `send` in `server/portal-engine/interpret.ts:116` runs `beforeWrite` (the stop check) before every write attempt, retries included, so a write in flight is at most 20 s. |
| 🟡 The back to back test does not test back to back | **Fixed.** The first lab ended 26 minutes ago and the next starts in 4, the tightest the 30 minute gap allows. Spec step 7 still says "ended 1 minute ago" (see Minor 1). |
| 🟡 The DDL scan does not see raw `alter table` | **Fixed** by the helper route: `dropHalfHourRule` is registered in `DDL_HELPERS`, and every copy of the raw SQL is gone. The scan still does not match a raw `alter table` (nit). |
| 🟡 Stale "Current" wording in the reconciler docs | **Fixed** in `server/worker/reconcile.ts:38` and in `server/worker/AGENTS.md:23-24`. |
| ⚪ `ACCESS_LEAD` vs `ACCESS_LEAD_MS` in the spec | **Partly.** The ACs use `_MS`. The Feature design table (`0029:74`) still says `ACCESS_LEAD`. |
| ⚪ The Current note repeats "opens 5 minutes before" | **Fixed.** The note now says "Access can take up to a minute to start." |
| ⚪ Loosened copy assertions | **Fixed.** Full sentences are asserted in `page.test.ts:130` and `lab-access-card.test.ts:75`. |
| ⚪ `oneWaitStep` copied into two files | **Not fixed.** It is still duplicated, although spec 0029 Follow-up calls it "worth doing". |
| ⚪ The quoted printable decoder ignores transport padding | **Not fixed.** It is harmless, as noted. |

## Minor

### 🟡 Spec 0029 still describes the rejected first draft in several sections, `docs/specs/0029-early-lab-access.md:36`
**Problem**: AC-3, AC-4 and AC-8 settle on a 6 minute margin and a 19 minute window. Other sections of the spec contradict them:
- Summary (line 8): "finished 5 minutes sooner".
- Context (line 14): "shrinks from 25 to 20 minutes".
- Option 1, the chosen option (line 36): "move the reset stop margin to the same 5 minutes". That is word for word the rejected Option 3.
- Decision heading (line 60): "20 minute reset window".
- Rationale (line 66): "20 available".
- Build plan step 4 (line 85): "a start in 4 minutes aborts, in 6 does not". Under AC-8, a start 6 minutes away must abort.
- Build plan step 6 and the critical scenarios: "at 6 minutes they queue nothing". The tests use 7.
- Build plan step 7 (line 88): "first booking ended 1 minute ago". The gap constraint makes that impossible, so the test uses 26 minutes ago.
- Follow-up (lines 106-107): lists the `server/worker/AGENTS.md` update and the Current note as still to do. Both are done in this diff.
- Amendment log (line 121): "Left: `/sync` for `server/worker/AGENTS.md`, `/check verify`". The next two entries are already past that.
- Status line (line 4): "verify pending". It also lists the amended ACs as "0023 AC-4 and AC-6". Scope says 0023 AC-3, AC-4, AC-6 and AC-14, 0021 AC-2, and 0020 AC-9. The status line also claims to amend the copy of specs 0012, 0013 and 0015, whose text is unchanged.

The file also sits at `docs/specs/0029-early-lab-access.md`, not at `NNNN-title/index.md` (AGENTS.md "Specs"). Specs 0027 and 0028 do the same, so this is a minor point.
**Why it matters**: This spec is the contract that `/check verify` and later work read. A reader who takes Option 1 at face value rebuilds the zero buffer design that the review rejected.
**Suggested fix**: Through `/architect`, restate Option 1 and the Decision as "5 minute lead, 1 minute safety margin, 19 minute window". Fix build plan steps 4, 6 and 7 to the real boundaries (5.5 and 7 minutes, 26 minutes ago). Mark the Follow-up items done, and correct the status line's list of amended specs.

### 🟡 Spec 0023 and spec 0021 carry amendment notes that are now false, or no note at all, `docs/specs/0023-nile-portal-reset-engine/index.md:31`
**Problem**: Spec 0023:
- AC-6 (line 31) and AC-14 (line 43) say "the code is at 5 until the review fix lands".
- The constants line (line 128) says "`TARGET` 24 minutes (spec 0029; 25 until its review fix lands)" and "code at 5 until the review fix lands". The fix has landed, so these notes are wrong as of this diff.
- AC-4 (line 29) still says "The target finish is `lab_ended_at + 25 minutes`", with no amendment note.

Spec 0021:
- AC-3 (a move of a Current booking) is not amended, though AC-7 changes it the same way as AC-2.
- The Feature design table (line 121) still gives `(starts_at <= now()) as was_current`.
**Why it matters**: A future change to the reset timing or the cleanup hook will read these specs and see rules that disagree with the code.
**Suggested fix**: Drop the "until the review fix lands" clauses. Add the spec 0029 note to 0023 AC-4 (24 minutes) and to 0021 AC-3. Update the 0021 table row to the lead form.

## Nits
- ⚪ `lib/portal-reset/timing.test.ts:191`: the comment still says the reset "stops at the same moment" and "has 20 minutes". The assertions below it say 6 minutes and 19.
- ⚪ `server/portal-engine/discovery-run.test.ts:23`, `server/portal-engine/sign-in-flow.test.ts:40`: `oneWaitStep` is still copied into both files. Move it to `server/portal-engine/testing.ts`.
- ⚪ `server/portal-engine/run.test.ts:302`, `server/portal-engine/sign-in-flow.test.ts:243`: inline `moveTo` SQL repeats what `startBookingIn` does. Use the helper, which also returns the version.
- ⚪ `server/jobs/cleanup-hook.test.ts:283`: the early window cleanup notice is tested for a cancel only. Spec step 6 also asks for a move (`booking.moved` at 4 minutes). It shares the same `was_current` boolean, so the risk is low.
- ⚪ `tests/ddl-lock-scan.test.ts:10`: the scan matches helper names only, and its `DIRS` leave out `app/` and `components/`, which hold DB tests. A raw `alter table` in plain `inRollback` would still pass. Matching `/alter table/i` as well would close it.
- ⚪ `context/Nile HOL Lab Access Email Standalone.html:382`, `context/reservations_mock.html:8`, `docs/scope/scope.md:22`, `docs/specs/0012-.../index.md:20,25`, `docs/specs/0013-.../index.md:52`, `docs/specs/0015-.../index.md:34`: these still say the links become active "at your start time". The context files and specs are historical references, but spec 0029's status line says it amends 0012, 0013 and 0015. Either add a one line pointer in each, or drop that claim.
- ⚪ `docs/specs/0029-early-lab-access.md:123`: the verify entry says "the three emails render the new wording" under the live observations. Say whether the emails were sent live or checked through the composer and snapshots, so the claim does not read as a live send.
- ⚪ `docs/specs/0029-early-lab-access.md:102`: Consequences mentions the extra reset after a cancel in the early window, but not that the external cleanup automation now also gets `booking.ended_early` for a lab whose `starts_at` is still in the future. The payload carries `oldStartsAt`, so the receiver can tell. Worth one line for the owner, who is building that receiver.

## Strengths
- `wasCurrent()` is one SQL fragment built from the shared constant and used by both write paths. The display phase deliberately stays on `starts_at`, and AC-7 records why.
- The boundary tests are well chosen:
  - The stop and held run checks at 5.5 minutes would pass under the old 5 minute margin and fail under 6. At 7 minutes they bound the margin from above.
  - The reconciler at 4 and 6 minutes brackets the 5 minute lead.
  - The cancel and move tests at 4 and 7 minutes prove AC-7.
- `startBookingIn` correctly returns the version the `bookings_version_bump` trigger set (`RETURNING` reads the trigger's new row), so the cancel and reschedule calls in the tests use the real version rather than a guess.
- Every DDL test is in `inRollbackDdl` and registered in the scan. AGENTS.md documents the pattern.
- The AC-8 rationale checks out against the engine: the stop check runs before every write attempt, retries included.

## Test coverage
Covered:
- The reconciler lead, for the testbed group, the type group, and a real handover.
- The stop check and the held run check at the 6 minute margin.
- A cancel in the early window (reset and cleanup notice) and a move (reset).
- The timing constants and their relations.
- Every copy surface: the units, the banner test, the email snapshots, and e2e.
- The MIME decoder.

Small gaps:
- A move in the early window with a live `CLEANUP` key.
- The cancel and move boundary is tested at 7 minutes, not at the 6 the spec names (the lead itself is pinned by the reconciler tests and the shared constant).
